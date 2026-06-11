#!/usr/bin/env node
/**
 * output-formatter.js — builds the human-/Claude-facing routing output block
 * that analyze-complexity.js emits to stdout. Extracted verbatim from the main
 * hook; build(ctx) returns the joined string and the caller writes + exits.
 *
 * Kept in scripts/ (not scripts/lib/) so the sibling/lib require paths stay
 * byte-identical to the original inline code.
 *
 * ctx fields: config, result, isDryRun, isExplain, prompt, contextUsage,
 *   contextRec, budget, rateLimit, apiLimits, anomalies, qualityWarning,
 *   llmFallbackHinted, updatedState, safeMode
 */
"use strict";

var sessionUtils = require("./session-utils");
var scoring = require("./lib/scoring");
var stats = require("./lib/stats");
var autoTune = require("./lib/auto-tune");
var history = require("./lib/history");
var contextMonitor = require("./lib/context-monitor");
var modelConstants = require("./lib/model-constants");
var PERSONA_BY_MODEL = modelConstants.PERSONA_BY_MODEL;

function build(ctx) {
  var config = ctx.config, result = ctx.result, isDryRun = ctx.isDryRun, isExplain = ctx.isExplain,
      prompt = ctx.prompt, contextUsage = ctx.contextUsage, contextRec = ctx.contextRec,
      budget = ctx.budget, rateLimit = ctx.rateLimit, apiLimits = ctx.apiLimits,
      anomalies = ctx.anomalies, qualityWarning = ctx.qualityWarning,
      llmFallbackHinted = ctx.llmFallbackHinted, updatedState = ctx.updatedState, safeMode = ctx.safeMode;

  var lines = [];

  var sessionSummaryLines = sessionUtils.getSessionSummaryLines(updatedState);
  var statsTail = null;
  if (sessionSummaryLines && sessionSummaryLines.length > 0) {
    var sl = ["<system-reminder>",
              "After completing the user's request, append these exact lines as the last lines of your response (no other text after them):",
              ""];
    var emojis = ["📊", "🔋", "📈", "📊"];
    for (var si = 0; si < sessionSummaryLines.length; si++) {
      sl.push((emojis[si] || "📈") + " " + sessionSummaryLines[si]);
    }
    sl.push("</system-reminder>");
    statsTail = sl.join("\n");
  }

  // H4: Warn user visibly if config is corrupt
  if (!config) {
    lines.push("[Model Router] WARNING: Config file corrupt or missing. Using default routing.");
  }

  var costInfo = scoring.getCostEstimate(result.model, config);
  if (isDryRun) lines.push("[DRY RUN] ");
  lines.push("[Model Router] Complexity: " + result.level + " (score " + result.score + "/10) -> Recommended: " + result.model);

  if (result.override) { lines.push("Override: User explicitly requested " + result.model + "."); }
  else if (result.patternMatch) { lines.push("Matched pattern: \"" + result.patternMatch.pattern + "\" -> " + result.model); }
  else { lines.push("Matched category: \"" + result.matchedCategory + "\""); lines.push("Analysis: " + result.reason); }

  lines.push("Cost: " + costInfo);

  // v3.3.0 (R35): Token estimator preview — per-prompt input/output token
  // estimate + a per-model cost preview so the user can compare before
  // submitting. Composes with /quota and /context-audit.
  var tokensCfg = (config && config.tokenPreview) || {};
  if (tokensCfg.enabled !== false) {
    try {
      var promptTokens = Math.round(prompt.length / 4); // rough heuristic
      var avgOut = (config && config.tokenPreview && typeof config.tokenPreview.avgResponseTokens === "number") ? config.tokenPreview.avgResponseTokens : 1500;
      var costForModel = function(m) {
        var c = (config.costEstimates && config.costEstimates[m]) || {};
        var inp = typeof c.inputPer1M === "number" ? c.inputPer1M : 0;
        var out = typeof c.outputPer1M === "number" ? c.outputPer1M : 0;
        return ((promptTokens * inp + avgOut * out) / 1e6).toFixed(4);
      };
      lines.push("Tokens preview: ~" + promptTokens + " in + ~" + avgOut + " out → $" + costForModel(result.model) + " at " + result.model + " (haiku $" + costForModel("haiku") + " · sonnet $" + costForModel("sonnet") + " · opus $" + costForModel("opus") + ")");
    } catch (e) { /* never block output */ }
  }

  lines.push("Confidence: " + result.confidence.confidence + "% (" + result.confidence.signals + " signals, " + result.confidence.agreement + " agreement)");

  // v3.3.0 (R30): Surface fallback boost if it influenced this routing
  if (result.fallbackBoostApplied && result.fallbackBoostApplied > 0) {
    lines.push("Fallback boost: +" + result.fallbackBoostApplied + " (this category had high haiku→sonnet fallback rate; learned auto-bump)");
  }

  // v3.3.0 (R43): Surface active profile if any
  if (config && config._activeProfile) {
    lines.push("Profile: " + config._activeProfile);
  }

  // v2.7.0: Emit Effort recommendation (orthogonal to model - reasoning budget)
  // v3.1.0: Also emit the suggested extended-thinking budget when configured.
  var effortCfg = config && config.effort;
  if (effortCfg && effortCfg.enabled !== false && effortCfg.emitInOutput !== false && result.effort && result.effort.level) {
    var effortLine = "Effort: " + result.effort.level + " (" + result.effort.reason + ")";
    if (effortCfg.emitThinkingBudget !== false && typeof result.effort.thinkingBudget === "number") {
      effortLine += " | thinking budget: " + result.effort.thinkingBudget + " tokens";
    }
    lines.push(effortLine);
  }

  if (result.planMode && result.planMode.active) {
    lines.push("Plan mode: active (" + result.planMode.source + ") — score boosted +" + ((config && config.planMode && typeof config.planMode.scoreBoost === "number") ? config.planMode.scoreBoost : 1));
  }

  if (result.fastMode && result.fastMode.active) {
    lines.push("Fast mode: active (" + result.fastMode.source + ") — effort forced low");
  }

  if (result.mcpTools && result.mcpTools.count >= 2) {
    lines.push("MCP tools detected: " + result.mcpTools.count + " (" + result.mcpTools.matchedTools.slice(0, 5).join(", ") + ")");
  }

  if (result.skillTrigger) {
    lines.push("Skill trigger: \"" + result.skillTrigger.skill + "\" → " + result.skillTrigger.suggestedModel + (result.skillTrigger.reason ? " (" + result.skillTrigger.reason + ")" : ""));
  }

  if (result.parallelDispatch && result.parallelDispatch.active) {
    lines.push("Parallel dispatch detected — orchestration pattern (" + result.parallelDispatch.suggestion + ")");
  }

  if (result.agentTeamsRole) {
    lines.push("Agent Teams role: " + result.agentTeamsRole.role + " → " + result.agentTeamsRole.suggestedModel + " (" + result.agentTeamsRole.reason + ")");
  }

  if (result.quotaDowngrade && result.quotaDowngrade.downgrade) {
    lines.push("⚠ Quota downgrade: opus → " + result.quotaDowngrade.toModel + " (" + result.quotaDowngrade.reason + ")");
  } else if (result.quotaState && result.quotaState.weeklyPct.opus >= 70) {
    lines.push("Quota notice: Opus weekly at " + result.quotaState.weeklyPct.opus + "% — consider rationing");
  }

  if (result.detectedLanguage && result.detectedLanguage !== "en") {
    var langNames = { hu: "Hungarian", de: "German" };
    lines.push("Language: " + (langNames[result.detectedLanguage] || result.detectedLanguage) + " detected");
  }

  if (contextUsage) {
    lines.push("Context window: ~" + contextUsage.percentage + "% estimated (" + Math.round(contextUsage.estimatedUsed / 1000) + "K/" + Math.round(contextUsage.maxTokens / 1000) + "K tokens)");

    // v3.3.0 (R32): Proactive compact suggestion — combines context % +
    // topic-shift detection. Composes with the existing isCompact{Suggest,
    // Warn,Force} flags above; this is the unified user-facing line.
    if (contextUsage.proactiveSuggestion && contextUsage.proactiveSuggestion.message) {
      var ps = contextUsage.proactiveSuggestion;
      var icon = ps.level === "force" ? "⛔" : (ps.level === "warn" ? "⚠" : "💡");
      lines.push(icon + " " + ps.message);
    }
    if (contextRec.adjusted) lines.push(contextRec.reason);
    if (contextRec.compactWarning) lines.push(contextRec.compactWarning);
  }

  if (result.projectTypes && result.projectTypes.length > 0) {
    lines.push("Project context: " + result.projectTypes.join(", ") + (result.contextBoost > 0 ? " (boost: +" + result.contextBoost + ")" : ""));
  }
  if (result.stickiness.sticky) lines.push("Session continuity: " + result.stickiness.reason + " -> staying on " + result.stickiness.stickyModel);
  if (result.historyBoost && result.historyBoost.boost > 0) lines.push("Prompt history: " + result.historyBoost.reason + " (boost: +" + result.historyBoost.boost + ")");
  if (result.borderline.isBorderline) lines.push("BORDERLINE: Score " + result.score + " is on the " + result.borderline.between + " boundary.");
  if (budget.warning) lines.push(budget.warning);
  if (rateLimit && rateLimit.warning) lines.push(rateLimit.warning);
  if (apiLimits && apiLimits.warning) lines.push(apiLimits.warning);
  if (anomalies && anomalies.length > 0) anomalies.forEach(function(a) { lines.push(a.message); });
  if (safeMode) lines.push("SAFE MODE: All routing requires confirmation.");
  if (qualityWarning) lines.push("QUALITY WARNING: " + qualityWarning.model + "+" + qualityWarning.category + " avg " + qualityWarning.avg + "/5 (" + qualityWarning.count + " ratings). " + qualityWarning.action);

  // ---- LLM fallback hint (v2.4.0) ----
  // Tell Claude to use the haiku-worker subagent (already shipped with this
  // plugin) to classify the prompt, then route accordingly. No API call,
  // no API key, no extra cost beyond the user's existing Haiku subagent
  // usage. After classifying, Claude logs the suggestion via the
  // --log-llm-suggestion special command so /learn can review it.
  if (llmFallbackHinted) {
    var safePrompt = prompt.replace(/"/g, '\\"').replace(/\n/g, " ").substring(0, 500);
    var detectedLang = result.detectedLanguage || "en";
    var langName = ({ en: "English", hu: "Hungarian", de: "German" })[detectedLang] || detectedLang;
    lines.push("");
    lines.push("LLM-FALLBACK SUGGESTED: Confidence is low (" + result.confidence.confidence + "%) and no keyword matched.");
    lines.push("Detected user language: " + langName + " (" + detectedLang + ")");
    lines.push("INSTRUCTION TO CLAUDE: Before routing, use the Agent tool with subagent_type=\"haiku-worker\" to classify this prompt:");
    lines.push("");
    lines.push("  Task description: \"Classify task complexity\"");
    lines.push("  Task prompt: |");
    lines.push("    Classify the complexity of this user prompt. Respond with ONLY a JSON object:");
    lines.push("    { \"model\": \"haiku\"|\"sonnet\"|\"opus\", \"category\": \"<2-4 word label, English>\", \"keywords\": [\"kw1\",\"kw2\",\"kw3\"], \"confidence\": <0-100> }");
    lines.push("    Routing rules: haiku=trivial (typos, formatting, single-line), sonnet=medium (bug fixes, features, refactors, tests), opus=complex (architecture, security, multi-file, performance).");
    lines.push("    IMPORTANT: The user's language is " + langName + ". Suggest keywords IN " + langName.toUpperCase() + " (in the language of their prompt), so future similar prompts in that language will match deterministically.");
    lines.push("    User prompt: \"" + safePrompt + "\"");
    lines.push("");
    lines.push("Then: (a) route the user's actual task to the model haiku-worker chose, (b) log the suggestion via:");
    lines.push("  echo '{\"prompt\":\"--log-llm-suggestion <model> <category_with_underscores> " + detectedLang + " <kw1,kw2,kw3> <original-prompt>\"}' | node \"${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js\"");
    lines.push("");
  }

  // GSD-inspired: Goal-backward verification (auto-tune suggestions)
  if (!result.override && config && (!config.goalVerification || config.goalVerification.enabled !== false)) {
    var tuneSuggestions = stats.getAutoTuneSuggestions(config);
    if (tuneSuggestions) {
      tuneSuggestions.forEach(function(s) {
        lines.push("GOAL CHECK: " + s.suggestion + " (avg " + s.avgRating + "/5, " + s.count + " ratings)");
      });
    }
  }

  // Periodic auto-tune: every 50 prompts, check for reclassifications and keyword discoveries
  if (updatedState.promptCount && updatedState.promptCount % 50 === 0 && !isDryRun) {
    var tuneReport = autoTune.runAutoTune(config, true); // dry run
    if (tuneReport.reclassifications.length > 0) {
      tuneReport.reclassifications.forEach(function(r) {
        lines.push("AUTO-TUNE: Category \"" + r.category + "\" overridden to " + r.targetModel + " " + r.percentage + "% of the time (" + r.overrideCount + "x). Run /auto-tune to apply.");
      });
    }
    if (tuneReport.keywordSuggestions.length > 0) {
      lines.push("KEYWORD DISCOVERY: " + tuneReport.keywordSuggestions.length + " new keyword(s) found. Top: \"" +
        tuneReport.keywordSuggestions.slice(0, 3).map(function(k) { return k.ngram + "\" -> " + k.model; }).join(", \"") +
        ". Run /auto-tune for details.");
    }
  }

  // GSD-inspired: Pre-flight check for opus tasks
  var preflight = scoring.preflightCheck(prompt, result.score, result.model, config);
  if (!preflight.ready) {
    lines.push("PREFLIGHT: Opus task detected. Consider adding: " + preflight.suggestions.join("; "));
  }

  // T2.1 (v2.5.0): --explain mode shows full scoring breakdown
  if (isExplain && result.explain) {
    var ex = result.explain;
    lines.push("");
    lines.push("=== ROUTING EXPLANATION ===");
    lines.push("Inputs:");
    lines.push("  wordCount: " + ex.wordCount + " words");
    lines.push("  taskType: " + ex.taskType + (ex.questionReductionApplied ? " (question-reduction applied)" : ""));
    lines.push("  detectedLanguage: " + result.detectedLanguage);
    lines.push("");
    lines.push("Sub-scores (weighted contribution to rawScore):");
    var ws = ex.weights || {};
    lines.push("  keyword:   " + (result.scores.keyword || 0) + "  x weight " + (ws.keyword || 0.35).toFixed(2) + " x wNorm " + ex.wNorm.toFixed(2));
    lines.push("  wordCount: " + (result.scores.wordCount || 0) + "  x weight " + (ws.wordCount || 0.15).toFixed(2));
    lines.push("  codeBlocks:" + (result.scores.codeBlocks || 0) + "  x weight " + (ws.codeBlocks || 0.10).toFixed(2));
    lines.push("  multiFile: " + (result.scores.multiFile || 0) + "  x weight " + (ws.multiFile || 0.20).toFixed(2));
    lines.push("  structure: " + (result.scores.structure || 0) + "  x weight " + (ws.structure || 0.20).toFixed(2));
    if (result.contextBoost > 0) {
      lines.push("  contextBoost: +" + result.contextBoost + " x weight " + ex.contextBoostWeight.toFixed(2));
    }
    lines.push("");
    lines.push("Keyword match:");
    if (ex.keywordResult && ex.keywordResult.matchedModel !== "none") {
      lines.push("  category: " + ex.keywordResult.matchedCategory + " (" + ex.keywordResult.matchedModel + ")");
      lines.push("  matched keyword: \"" + (ex.keywordResult.matchedKeyword || "?") + "\"" +
                 (ex.keywordResult.length ? " (" + ex.keywordResult.length + " chars)" : ""));
      lines.push("  keyword-influence mode: " + ex.keywordInfluenceMode);
    } else {
      lines.push("  NO MATCH (prompt did not hit any configured keyword)");
    }
    lines.push("");
    lines.push("Totals:");
    lines.push("  rawScore: " + result.rawScore + " -> clamped to [1,10] -> finalScore: " + result.score);
    lines.push("  final model: " + result.model + " (" + result.level + ")");
    lines.push("  confidence: " + result.confidence.confidence + "% (" + result.confidence.signals + " active signals, " + result.confidence.agreement + " agreement)");
    if (ex.usingAdaptiveWeights) {
      lines.push("  adaptive weights: ACTIVE (scoring weights auto-tuned from /rate history)");
    }
    if (result.stickiness && result.stickiness.sticky) {
      lines.push("  stickiness: pinned to " + result.stickiness.stickyModel + " (" + result.stickiness.reason + ")");
    }
    lines.push("===========================");
  }

  // GSD-inspired: Task splitting recommendation
  var taskSplit = contextMonitor.getTaskSplitRecommendation(contextUsage, result.score, result.model, config);
  if (taskSplit) {
    lines.push(taskSplit.suggestion);
  }

  lines.push("");

  // v2.7.0: subagent-facing effort hint (what reasoning budget the worker should use)
  var effortSubagentHint = "";
  if (effortCfg && effortCfg.enabled !== false && effortCfg.emitInSubagentHint !== false && result.effort && result.effort.level) {
    var lvl = result.effort.level;
    if (lvl === "high") {
      effortSubagentHint = " Use HIGH effort: reason step-by-step, consider edge cases and trade-offs explicitly, walk through your logic.";
    } else if (lvl === "low") {
      effortSubagentHint = " Use LOW effort: answer concisely (1-3 lines ideal), no preamble, no caveats unless critical.";
    } else {
      effortSubagentHint = " Use MEDIUM effort: normal balance of thoroughness and brevity.";
    }
  }

  if (isDryRun) {
    lines.push("[DRY RUN] No routing action taken. This was a test analysis only.");
  } else if (result.autoRoute && !result.override) {
    lines.push("AUTO-ROUTING: High confidence score (" + result.score + "/10). Automatically delegate this task to the **" + result.model + "-worker** agent without asking. Just do it." + effortSubagentHint);
    lines.push("If the task is trivially simple (like a direct question), you may answer directly without delegating.");
  } else if (result.borderline.isBorderline) {
    // GSD-inspired: Enhanced borderline with historical context
    var borderCtx = history.getBorderlineContext(result.score, result.matchedCategory, config);
    if (borderCtx && borderCtx.canAutoResolve && result.confidence.confidence >= 40) {
      lines.push("BORDERLINE AUTO-RESOLVED: Score " + result.score + "/10 (" + result.borderline.between + "), but historical data (" + borderCtx.totalHistorical + " uses) strongly favors **" + borderCtx.autoResolveModel + "**.");
      lines.push("Automatically delegate to **" + borderCtx.autoResolveModel + "-worker**.");
    } else {
      lines.push("ROUTING (BORDERLINE): Score " + result.score + "/10, near " + result.borderline.between + " boundary.");
      if (borderCtx) {
        var histInfo = "History: " + borderCtx.totalHistorical + " uses of \"" + result.matchedCategory + "\" -> " +
          Object.keys(borderCtx.modelDistribution).map(function(m) { return m + ":" + borderCtx.modelDistribution[m]; }).join(", ");
        if (borderCtx.qualityData) {
          histInfo += " | Quality: " + Object.keys(borderCtx.qualityData).map(function(m) {
            var d = borderCtx.qualityData[m]; return m + " " + (d.sum / d.count).toFixed(1) + "/5";
          }).join(", ");
        }
        lines.push(histInfo);
      }
      lines.push("Ask the user: \"Borderline task (score " + result.score + "/10, category: " + result.matchedCategory + ") between **" + result.borderline.lower + "** and **" + result.borderline.upper + "**. Which model?\"");
      lines.push("When the user chooses, delegate to the chosen model's worker. Also log the override if they pick a different model than recommended.");
    }
  } else {
    lines.push("ROUTING: " + result.level + " complexity (score " + result.score + "/10).");
    lines.push("Ask: \"" + result.level + " task (score " + result.score + "/10, category: " + result.matchedCategory + "). Route to **" + result.model + "-worker** for " + (PERSONA_BY_MODEL[result.model] || "balanced") + " handling? Or prefer haiku/sonnet/opus?\"");
    lines.push("If confirmed, delegate to " + result.model + "-worker. If different model chosen, use that worker instead and note the override for /tune.");
    lines.push("If the task is trivially simple (like a direct question), you may answer directly without delegating.");
  }

  if (config && config.promptHints && config.promptHints.enabled && config.promptHints.hints) {
    var hint = config.promptHints.hints[result.model];
    if (hint) { lines.push(""); lines.push(hint); }
  }

  // v3.4.2: append the stats <system-reminder> block at the END so it's
  // the last thing Claude reads. Claude Code 2.1.x respects system-
  // reminder blocks consistently as imperative instructions.
  if (statsTail) {
    lines.push("");
    lines.push(statsTail);
  }

  return lines.join("\n");
}

module.exports = { build: build };
