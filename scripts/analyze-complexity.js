#!/usr/bin/env node

// Debug: log hook invocation + rotate debug log
try {
  var _debugFs = require("fs"), _debugPath = require("path");
  var _debugDir = _debugPath.join(__dirname, "..", "logs");
  if (!_debugFs.existsSync(_debugDir)) _debugFs.mkdirSync(_debugDir, { recursive: true });
  _debugFs.appendFileSync(_debugPath.join(_debugDir, "hook-debug.log"),
    new Date().toISOString() + " | hook fired | cwd=" + process.cwd() + " | __dirname=" + __dirname + "\n");
} catch(e) {}

/**
 * Claude Model Changer - Complexity Analyzer v6.0
 *
 * Modular architecture: lib/io, lib/config, lib/scoring, lib/context-monitor,
 * lib/monitors, lib/stats, lib/session
 */

"use strict";

var fs = require("fs");
var path = require("path");

// ---- MODULE IMPORTS ----
var io = require("./lib/io");
var configModule = require("./lib/config");
var scoring = require("./lib/scoring");
var history = require("./lib/history");
var contextMonitor = require("./lib/context-monitor");
var monitors = require("./lib/monitors");
var stats = require("./lib/stats");
var session = require("./lib/session");
var sessionUtils = require("./session-utils");
var health = require("./lib/health");
var autoTune = require("./lib/auto-tune");
var learnLog = require("./lib/learn-log");
var errorLog = require("./lib/error-log");

// Startup cleanup: rotate debug log + trim all JSONL logs
io.rotateDebugLog();
(function startupLogRotation() {
  try {
    var logFiles = [
      { path: io.getLogPath(), max: io.CONSTANTS.MAX_USAGE_ENTRIES },
      { path: io.getOverrideLogPath(), max: io.CONSTANTS.MAX_OVERRIDE_ENTRIES },
      { path: io.getFallbackLogPath(), max: io.CONSTANTS.MAX_FALLBACK_ENTRIES },
      { path: io.getQualityLogPath(), max: io.CONSTANTS.MAX_QUALITY_ENTRIES },
      { path: io.getBenchmarkLogPath(), max: io.CONSTANTS.MAX_BENCHMARK_ENTRIES }
    ];
    logFiles.forEach(function(lf) {
      try {
        if (fs.existsSync(lf.path)) {
          var stat = fs.statSync(lf.path);
          if (stat.size > lf.max * 250) { io.trimLog(lf.path, lf.max); }
        }
      } catch (e) {}
    });
  } catch (e) {}
})();

// ---- VS CODE STATUS FILE (G2a) ----

function writeStatusFile(result, contextUsage, budget, anomalies, apiLimits, sessionState) {
  try {
    io.ensureLogDir();
    var status = {
      timestamp: new Date().toISOString(),
      lastModel: result.model,
      score: result.score,
      level: result.level,
      confidence: result.confidence.confidence,
      category: result.matchedCategory,
      contextUsage: contextUsage ? contextUsage.percentage : null,
      budgetStatus: budget.warning ? "warning" : "ok",
      anomalyCount: anomalies ? anomalies.length : 0,
      anomalies: anomalies ? anomalies.map(function(a) { return a.type; }) : [],
      apiLimitPercent: apiLimits ? apiLimits.maxPercent : null,
      override: result.override,
      autoRouted: result.autoRoute,
      sessionModelCounts: sessionState && sessionState.modelCounts ? sessionState.modelCounts : {},
      sessionPromptCount: sessionState && sessionState.promptCount ? sessionState.promptCount : 0,
      sessionSkillsUsed: sessionState && sessionState.skillsUsed ? sessionState.skillsUsed : {}
    };
    fs.writeFileSync(io.getStatusPath(), JSON.stringify(status, null, 2));
  } catch (err) {}
}

// ---- MAIN ANALYSIS ----

function analyzeComplexity(prompt, config, cwd, sessionId) {
  var override = scoring.detectManualOverride(prompt, config);
  if (override) {
    return {
      score: { haiku: 2, sonnet: 5, opus: 9 }[override],
      level: { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" }[override],
      model: override, override: true,
      matchedCategory: "Manual override", reason: "User requested " + override,
      borderline: { isBorderline: false }, autoRoute: false,
      projectTypes: null, contextBoost: 0, stickiness: { sticky: false },
      confidence: { confidence: 100, signals: 1, agreement: "high" },
      patternMatch: null, detectedLanguage: "en", scores: null
    };
  }

  var patterns = stats.loadPatterns();
  var patternMatch = stats.checkPatterns(prompt.toLowerCase(), patterns);
  if (patternMatch) {
    return {
      score: { haiku: 2, sonnet: 5, opus: 9 }[patternMatch.model],
      level: { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" }[patternMatch.model],
      model: patternMatch.model, override: false,
      matchedCategory: patternMatch.label, reason: "Matched saved pattern: \"" + patternMatch.pattern + "\"",
      borderline: { isBorderline: false }, autoRoute: true,
      projectTypes: null, contextBoost: 0, stickiness: { sticky: false },
      confidence: { confidence: 95, signals: 1, agreement: "high" },
      patternMatch: patternMatch, detectedLanguage: "en", scores: null
    };
  }

  var promptLower = prompt.toLowerCase();
  var words = prompt.split(/\s+/).filter(function(w) { return w.length > 0; });
  var wordCount = words.length;

  var detectedLanguage = scoring.detectLanguage(prompt);

  var adaptiveResult = stats.getAdaptiveWeights(config);
  var weights, usingAdaptive = false;
  if (adaptiveResult && adaptiveResult.active) {
    weights = adaptiveResult.weights;
    usingAdaptive = true;
  } else {
    weights = (config && config.scoring && config.scoring.weights)
      ? config.scoring.weights
      : { keyword: 0.35, multiFile: 0.20, structure: 0.20, wordCount: 0.15, codeBlocks: 0.10 };
  }
  var questionReduction = (config && config.scoring && config.scoring.questionReduction) || 0.8;

  var wordScore = scoring.scoreWordCount(wordCount);
  var keywordResult = scoring.scoreKeywordsMultiLang(promptLower, config, detectedLanguage);
  var codeBlockScore = scoring.scoreCodeBlocks(prompt);
  var multiFileScore = scoring.scoreMultiFileIndicators(promptLower, config);
  var structuralScore = scoring.scoreStructuralComplexity(prompt);
  var taskType = scoring.classifyQuestionVsTask(promptLower);

  var projectTypes = session.detectProjectType(cwd);
  var contextBoost = session.getContextBoost(promptLower, projectTypes, config);

  // Prompt history context: boost score if related to recent higher-complexity prompts
  var historyBoost = session.getPromptHistoryBoost(prompt, sessionId, config);
  if (historyBoost.boost > 0) contextBoost += historyBoost.boost;

  var subScores = { keyword: keywordResult.score, wordCount: wordScore, codeBlocks: codeBlockScore, multiFile: multiFileScore, structure: structuralScore };
  var confidence = scoring.calculateConfidence(subScores);

  // Normalize scoring weights: sub-score weights + contextBoost weight must sum to 1.0
  // contextBoost weight is configurable (default 0.10)
  var contextBoostWeight = (config && config.scoring && config.scoring.weights && typeof config.scoring.weights.contextBoost === "number")
    ? config.scoring.weights.contextBoost : 0.10;
  // Clamp to [0, 0.5] and guard against NaN
  if (isNaN(contextBoostWeight) || !isFinite(contextBoostWeight)) contextBoostWeight = 0.10;
  contextBoostWeight = Math.max(0, Math.min(0.5, contextBoostWeight));
  var targetSubScoreSum = 1.0 - contextBoostWeight;
  var weightSum = (weights.keyword || 0) + (weights.wordCount || 0) + (weights.codeBlocks || 0) + (weights.multiFile || 0) + (weights.structure || 0);
  // T1.3 (v2.4.1): weights semantically sum to 1.0 across ALL signals including
  // contextBoost. Accept 1.0-sum weights AND weights-pre-sum-to-target (0.9).
  // Only normalize if the user wrote a non-standard sum (e.g., 1.5 or 0.7).
  // Previously this silently scaled 1.0-sum weights by 0.9, reducing the
  // effective impact of deterministic signals.
  var wNorm = 1.0;
  if (weightSum > 0) {
    // If sum is near 1.0 OR near target (0.9), accept as-is; the contextBoost
    // is purely additive and the slight over-count (10% when weights sum to 1.0)
    // is preferable to silently scaling every sub-score.
    var nearOne = Math.abs(weightSum - 1.0) < 0.01;
    var nearTarget = Math.abs(weightSum - targetSubScoreSum) < 0.01;
    if (!nearOne && !nearTarget) {
      // User wrote a custom sum - normalize to the target to preserve intent.
      wNorm = targetSubScoreSum / weightSum;
    }
  }

  var rawScore = 0;
  rawScore += wordScore * (weights.wordCount || 0.15) * wNorm;
  rawScore += keywordResult.score * (weights.keyword || 0.35) * wNorm;
  rawScore += codeBlockScore * (weights.codeBlocks || 0.10) * wNorm;
  rawScore += multiFileScore * (weights.multiFile || 0.20) * wNorm;
  rawScore += structuralScore * (weights.structure || 0.20) * wNorm;
  rawScore += contextBoost * contextBoostWeight;

  if (taskType === "question" && rawScore > 3) rawScore *= questionReduction;
  // H1: NaN guard — prevent NaN from poisoning the entire pipeline
  if (isNaN(rawScore) || !isFinite(rawScore)) {
    process.stderr.write("[Model Router] ERROR: NaN/Infinity score detected (rawScore=" + rawScore + "), falling back to sonnet\n");
    rawScore = 5;
  }
  var finalScore = Math.max(1, Math.min(10, Math.round(rawScore)));

  var level, model;
  if (config && config.models) {
    if (config.models.haiku && finalScore >= config.models.haiku.scoreRange[0] && finalScore <= config.models.haiku.scoreRange[1]) {
      level = "SIMPLE"; model = "haiku";
    } else if (config.models.sonnet && finalScore >= config.models.sonnet.scoreRange[0] && finalScore <= config.models.sonnet.scoreRange[1]) {
      level = "MEDIUM"; model = "sonnet";
    } else { level = "COMPLEX"; model = "opus"; }
  } else {
    if (finalScore <= 3) { level = "SIMPLE"; model = "haiku"; }
    else if (finalScore <= 7) { level = "MEDIUM"; model = "sonnet"; }
    else { level = "COMPLEX"; model = "opus"; }
  }

  // Keyword category influence — configurable strength
  // "override" (default/legacy): keyword match forces model assignment
  // "boost": keyword nudges score toward target range but doesn't force it
  // "none": keywords only affect scoring weight, no model override
  var keywordInfluence = (config && config.scoring && config.scoring.keywordInfluence) || "override";

  if (keywordResult.matchedModel !== "none" && keywordResult.score > 0 && keywordInfluence !== "none") {
    // Question reduction: cap keyword override at one level below target for questions
    var effectiveMatchedModel = keywordResult.matchedModel;
    if (taskType === "question" && keywordInfluence === "override") {
      if (effectiveMatchedModel === "opus") effectiveMatchedModel = "sonnet";
      else if (effectiveMatchedModel === "sonnet") effectiveMatchedModel = "haiku";
    }
    if (keywordInfluence === "override") {
      model = effectiveMatchedModel;
      if (model === "haiku") { level = "SIMPLE"; if (finalScore > 3) finalScore = Math.max(1, Math.min(3, Math.round(rawScore * 0.5))); }
      else if (model === "sonnet") { level = "MEDIUM"; if (finalScore < 4) finalScore = Math.max(4, Math.round(rawScore + 2)); if (finalScore > 7) finalScore = 7; }
      else { level = "COMPLEX"; if (finalScore < 8) finalScore = Math.max(8, Math.round(rawScore + 4)); }
      finalScore = Math.max(1, Math.min(10, finalScore));
    } else if (keywordInfluence === "boost") {
      // Nudge score by +/-2 toward target range without forcing
      var targetCenter = { haiku: 2, sonnet: 5, opus: 9 }[keywordResult.matchedModel] || 5;
      var nudge = targetCenter > finalScore ? 2 : targetCenter < finalScore ? -2 : 0;
      finalScore = Math.max(1, Math.min(10, finalScore + nudge));
      // Re-derive model from adjusted score
      if (config && config.models) {
        if (config.models.haiku && finalScore >= config.models.haiku.scoreRange[0] && finalScore <= config.models.haiku.scoreRange[1]) { level = "SIMPLE"; model = "haiku"; }
        else if (config.models.sonnet && finalScore >= config.models.sonnet.scoreRange[0] && finalScore <= config.models.sonnet.scoreRange[1]) { level = "MEDIUM"; model = "sonnet"; }
        else { level = "COMPLEX"; model = "opus"; }
      }
    }
  }

  var stickiness = session.getSessionStickiness(prompt, sessionId, model, config);
  // Score delta guard: stickiness should not suppress large upgrades (>3 score difference)
  var stickyModelCenter = { haiku: 2, sonnet: 5, opus: 9 };
  if (stickiness.sticky && !scoring.shouldAutoRoute(finalScore, config, confidence.confidence)) {
    var stickyCenter = stickyModelCenter[stickiness.stickyModel] || 5;
    if (Math.abs(finalScore - stickyCenter) <= 3) {
      model = stickiness.stickyModel;
      level = { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" }[model] || level;
    } else {
      stickiness.sticky = false;
      stickiness.reason = "Score delta too large (" + finalScore + " vs " + stickyCenter + "), overriding stickiness";
    }
  }

  return {
    score: finalScore, rawScore: Math.round(rawScore * 100) / 100, level: level, model: model, override: false,
    matchedCategory: keywordResult.matchedCategory,
    reason: "Words: " + wordCount + " (" + wordScore + "), Keyword: " + keywordResult.matchedCategory +
            " (" + keywordResult.score + "), Code blocks: " + codeBlockScore + ", Multi-file: " + multiFileScore +
            ", Structure: " + structuralScore + ", Type: " + taskType +
            (contextBoost > 0 ? ", Context boost: +" + contextBoost : "") +
            (usingAdaptive ? ", Adaptive weights: active" : "") +
            (detectedLanguage !== "en" ? ", Language: " + detectedLanguage : ""),
    borderline: scoring.detectBorderline(finalScore, config),
    autoRoute: scoring.shouldAutoRoute(finalScore, config, confidence.confidence),
    projectTypes: projectTypes, contextBoost: contextBoost,
    stickiness: stickiness, confidence: confidence,
    patternMatch: null, detectedLanguage: detectedLanguage, scores: subScores,
    historyBoost: historyBoost,
    // T2.1 (v2.5.0): detailed internals exposed for --explain mode
    explain: {
      wordCount: wordCount, taskType: taskType,
      keywordResult: keywordResult,
      weights: weights, weightSum: weightSum, wNorm: wNorm,
      contextBoostWeight: contextBoostWeight,
      questionReductionApplied: (taskType === "question" && rawScore / (questionReduction || 0.8) > 3),
      keywordInfluenceMode: typeof keywordInfluence !== "undefined" ? keywordInfluence : "none",
      usingAdaptiveWeights: usingAdaptive
    }
  };
}

// ---- STDIN READING & OUTPUT ----

var input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function(chunk) { input += chunk; });
process.stdin.on("end", function() {
  try {
    var data = JSON.parse(input);

    // T1.2 (v2.4.1): defensive stdin validation. Previously `data.prompt`
    // silently defaulted to "" if the JSON structure was wrong, hiding
    // malformed hook inputs. Now we exit cleanly and log to stderr so
    // the failure is visible in logs/hook-debug.log.
    if (typeof data !== "object" || data === null) {
      process.stderr.write("[Model Router] Invalid hook input: expected JSON object, got " + typeof data + "\n");
      process.exit(0);
    }
    if (data.prompt !== undefined && typeof data.prompt !== "string") {
      process.stderr.write("[Model Router] Invalid hook input: data.prompt must be string, got " + typeof data.prompt + "\n");
      process.exit(0);
    }

    var prompt = data.prompt || "";
    var cwd = data.cwd || process.cwd();
    var sessionId = data.session_id || "unknown";

    if (prompt.trim().length < 3) { process.exit(0); }
    if (prompt.trim().startsWith("/")) {
      var slashCmd = prompt.trim().split(/\s+/)[0].substring(1);
      if (slashCmd.length > 0) {
        var slashState = session.loadSessionState(sessionId) || { sessionId: sessionId };
        if (!slashState.skillsUsed) slashState.skillsUsed = {};
        slashState.skillsUsed[slashCmd] = (slashState.skillsUsed[slashCmd] || 0) + 1;
        session.saveSessionState(slashState);
        var slashSummary = sessionUtils.getSessionSummaryLine(slashState);
        if (slashSummary) { process.stdout.write("[Model Router] " + slashSummary); }
      }
      process.exit(0);
    }

    // ---- Special commands (dispatch table) ----
    var SPECIAL_COMMANDS = {
      "--stats": function() {
        var cfg = configModule.loadConfig(cwd);
        var s = stats.getStats(cfg);
        return s ? JSON.stringify(s, null, 2) : "No usage data yet.";
      },
      "--tune": function() {
        var t = stats.getTuneAnalysis();
        return t ? JSON.stringify(t, null, 2) : "No override data yet.";
      },
      "--quality-stats": function() {
        var qs = stats.getQualityStats();
        return qs ? JSON.stringify(qs, null, 2) : "No quality data yet. Use /rate <1-5> after tasks.";
      },
      "--fallback-stats": function() {
        try {
          var fbPath = io.getFallbackLogPath();
          if (!fs.existsSync(fbPath)) return "No fallback events logged yet.";
          var fbLines = fs.readFileSync(fbPath, "utf8").trim().split("\n").filter(function(l) { return l.length > 0; });
          return "Fallback events: " + fbLines.length + "\n" + fbLines.slice(-10).join("\n");
        } catch (e) { return "No fallback data."; }
      },
      "--adaptive-stats": function() {
        var adCfg = configModule.loadConfig(cwd);
        return JSON.stringify(stats.getAdaptiveStats(adCfg), null, 2);
      },
      "--health": function() {
        var report = health.getFullHealthReport();
        return JSON.stringify(report, null, 2);
      },
      "--errors": function() {
        // T2.4 (v2.5.0): surface recent hook errors for /health and /errors commands
        var summary = errorLog.summarize();
        return JSON.stringify(summary, null, 2);
      },
      "--auto-tune": function() {
        var cfg = configModule.loadConfig(cwd);
        var report = autoTune.runAutoTune(cfg, false);
        return JSON.stringify(report, null, 2);
      },
      "--auto-tune-dry": function() {
        var cfg = configModule.loadConfig(cwd);
        var report = autoTune.runAutoTune(cfg, true);
        return JSON.stringify(report, null, 2);
      }
    };

    var trimmedPrompt = prompt.trim();
    if (SPECIAL_COMMANDS[trimmedPrompt]) {
      process.stdout.write(SPECIAL_COMMANDS[trimmedPrompt]());
      process.exit(0);
    }
    if (trimmedPrompt === "--session-summary") {
      var sumState = session.loadSessionState(sessionId);
      if (sumState && sumState.modelCounts) {
        var mc = sumState.modelCounts;
        var total = (mc.haiku || 0) + (mc.sonnet || 0) + (mc.opus || 0);
        var subCounts = sumState.subagentCounts || { haiku: 0, sonnet: 0, opus: 0 };
        var totalSub = (subCounts.haiku || 0) + (subCounts.sonnet || 0) + (subCounts.opus || 0);
        process.stdout.write(JSON.stringify({
          sessionId: sessionId, promptCount: total, modelCounts: mc,
          subagentCounts: subCounts, totalSubagents: totalSub,
          modelPercentages: { haiku: total > 0 ? Math.round((mc.haiku || 0) / total * 100) : 0, sonnet: total > 0 ? Math.round((mc.sonnet || 0) / total * 100) : 0, opus: total > 0 ? Math.round((mc.opus || 0) / total * 100) : 0 },
          skillsUsed: sumState.skillsUsed || {}, sessionStart: sumState.sessionStart || null, estimatedTokensUsed: sumState.estimatedTokensUsed || 0
        }, null, 2));
      } else { process.stdout.write("No session data yet."); }
      process.exit(0);
    }

    var overrideMatch = prompt.trim().match(/^--log-override\s+(\w+)\s+(\w+)\s+(.+)$/);
    if (overrideMatch) {
      io.logOverride({ timestamp: new Date().toISOString(), recommendedModel: overrideMatch[1], chosenModel: overrideMatch[2], category: overrideMatch[3] });
      process.stdout.write("Override logged."); process.exit(0);
    }
    var fallbackMatch = prompt.trim().match(/^--log-fallback\s+(\w+)\s+(\w+)\s+(.+)$/);
    if (fallbackMatch) {
      io.logFallback({ timestamp: new Date().toISOString(), fromModel: fallbackMatch[1], toModel: fallbackMatch[2], reason: fallbackMatch[3] });
      process.stdout.write("Fallback logged."); process.exit(0);
    }
    // --log-llm-suggestion <model> <category> <lang> <kw1,kw2,kw3> <originalPrompt>
    // Called by Claude after the haiku-worker subagent classifies a low-confidence prompt.
    //   <model>    : haiku | sonnet | opus
    //   <category> : 2-4 word label, with underscores instead of spaces
    //   <lang>     : en | hu | de  (matches detectLanguage output)
    //   <keywords> : comma-separated, no spaces within each keyword
    //   <prompt>   : the original user prompt (may contain spaces)
    var llmSuggestionMatch = prompt.trim().match(/^--log-llm-suggestion\s+(haiku|sonnet|opus)\s+([^\s]+)\s+(en|hu|de)\s+([^\s]+)\s+(.+)$/);
    if (llmSuggestionMatch) {
      var llmModel = llmSuggestionMatch[1];
      var llmCategory = llmSuggestionMatch[2].replace(/_/g, " ");
      var llmLang = llmSuggestionMatch[3];
      var keywords = llmSuggestionMatch[4].split(",").map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
      var llmOriginalPrompt = llmSuggestionMatch[5];

      var suggestion = {
        prompt: llmOriginalPrompt,
        suggestedCategory: llmCategory,
        suggestedKeywords: keywords,
        suggestedModel: llmModel,
        lang: llmLang,
        llmModel: "haiku-worker (subagent)",
        llmConfidence: null,
        latencyMs: null
      };
      learnLog.appendSuggestion(suggestion);

      // Auto-apply if config says so AND occurrence count hits threshold
      var output = "LLM suggestion logged (lang=" + llmLang + ").";
      try {
        var learnedConfigMod = require("./lib/learned-config");
        var autoCfg = configModule.loadConfig(cwd);
        var applied = learnedConfigMod.tryAutoApply(suggestion, autoCfg);
        if (applied && applied.length > 0) {
          output += " Auto-applied " + applied.length + " keyword(s) to learned-keywords.json: " +
            applied.map(function(a) { return '"' + a.keyword + '" (' + a.count + 'x)'; }).join(", ");
        }
      } catch (e) {
        // Auto-apply is best-effort
      }
      process.stdout.write(output);
      process.exit(0);
    }

    // --learn-promote: emit a diff showing what learned-keywords.json would
    // promote into task-routing.json (manual workflow - user copies into PR)
    if (prompt.trim() === "--learn-promote") {
      try {
        var lcMod = require("./lib/learned-config");
        var bcCfg = configModule.loadConfig(cwd);
        process.stdout.write(lcMod.generatePromoteDiff(bcCfg));
      } catch (e) {
        process.stdout.write("Error generating promote diff: " + e.message);
      }
      process.exit(0);
    }

    // ---- Dry run mode (A6) ----
    var isDryRun = false;
    if (prompt.trim().startsWith("--dry-run ")) { isDryRun = true; prompt = prompt.trim().substring("--dry-run ".length); }

    // ---- T2.1 (v2.5.0): --explain mode ----
    // Adds a structured "ROUTING EXPLANATION" block at the end of the output
    // showing exactly how the score was computed. Useful for /complexity and
    // for debugging misrouted prompts.
    var isExplain = false;
    if (prompt.trim().startsWith("--explain ")) { isExplain = true; prompt = prompt.trim().substring("--explain ".length); }

    // ---- Main analysis ----
    var config = configModule.loadConfig(cwd);
    var safeMode = config && config.safeMode === true;
    var result = analyzeComplexity(prompt, config, cwd, sessionId);

    var contextUsage = contextMonitor.estimateContextUsage(sessionId, prompt, config, session.loadSessionState);
    var contextRec = contextMonitor.getContextRecommendation(contextUsage, result.model, config, session.loadSessionState);
    if (contextRec.adjusted) {
      result.model = contextRec.model;
      result.level = { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" }[result.model];
    }

    var apiLimits = monitors.checkApiRateLimits(config, sessionId, session.loadSessionState);
    if (apiLimits && apiLimits.action === "force_haiku" && result.model !== "haiku") { result.model = "haiku"; result.level = "SIMPLE"; }
    else if (apiLimits && apiLimits.action === "prefer_cheaper" && result.model === "opus") { result.model = "sonnet"; result.level = "MEDIUM"; }

    var budget = monitors.checkBudget(result.model, config);
    var rateLimit = monitors.checkRateLimit(config, sessionId, session.loadSessionState);
    var anomalies = monitors.detectAnomalies(config);
    var qualityWarning = stats.getQualityWarning(result.model, result.matchedCategory);

    // ---- LLM fallback hint (v2.4.0) ----
    // When the deterministic scorer is uncertain (low confidence or no
    // keyword match), suggest that Claude classify with the existing
    // haiku-worker subagent and route accordingly. The hook itself does
    // NOT make any API calls or external network requests - Claude
    // handles the classification using its built-in subagent infrastructure
    // (Haiku is already accessible via the haiku-worker agent that this
    // plugin ships).
    //
    // After Claude gets the haiku-worker classification, it can log the
    // result back via the --log-llm-suggestion special command so /learn
    // can later show keyword suggestions.
    var llmFallbackHinted = false;
    var llmConfig = config && config.autoMode && config.autoMode.llmFallback;
    var deterministicLowConfidence = (result.confidence.confidence < 40) ||
                                     (result.matchedCategory === "none");
    if (!isDryRun && llmConfig && llmConfig.enabled && deterministicLowConfidence && !result.override) {
      llmFallbackHinted = true;
    }
    result.llmFallbackHinted = llmFallbackHinted;

    if (result.confidence.confidence < 40) result.autoRoute = false;
    if (safeMode) result.autoRoute = false;
    if (!budget.withinBudget) result.autoRoute = false;
    if (rateLimit && !rateLimit.allowed) result.autoRoute = false;

    if (!isDryRun && (!config || !config.logging || config.logging.enabled !== false)) {
      io.logUsage({
        timestamp: new Date().toISOString(), score: result.score, rawScore: result.rawScore,
        level: result.level, model: result.model,
        category: result.matchedCategory, override: result.override, borderline: result.borderline.isBorderline,
        autoRouted: result.autoRoute, projectTypes: result.projectTypes, contextBoost: result.contextBoost,
        confidence: result.confidence.confidence, detectedLanguage: result.detectedLanguage,
        scores: result.scores, promptPreview: prompt.substring(0, 80).replace(/\n/g, " ")
      });
    }

    if (!isDryRun) monitors.recordApiCall(sessionId, result.model, config, session.loadSessionState, session.saveSessionState);

    var updatedState = contextMonitor.updateContextTracking(sessionId, prompt, result.model, config, session.loadSessionState) || {};
    updatedState.sessionId = sessionId;
    updatedState.lastModel = result.model;
    updatedState.topicWords = session.extractTopicWords(prompt);
    session.updatePromptHistory(updatedState, prompt, result.model, result.matchedCategory);
    updatedState.timestamp = new Date().toISOString();
    if (result.autoRoute) {
      // v2.5.1: proactive cap. Push then immediately shift if at limit, so the
      // array never grows beyond 20 even transiently. Previous slice(-20) was
      // reactive and allowed brief unbounded growth during save contention.
      if (!updatedState.recentAutoRoutes) updatedState.recentAutoRoutes = [];
      if (updatedState.recentAutoRoutes.length >= 20) updatedState.recentAutoRoutes.shift();
      updatedState.recentAutoRoutes.push({ timestamp: new Date().toISOString(), model: result.model });
    }
    if (!isDryRun) session.saveSessionState(updatedState);
    if (!isDryRun) writeStatusFile(result, contextUsage, budget, anomalies, apiLimits, updatedState);

    // ---- Build output ----
    var lines = [];

    var sessionSummaryLines = sessionUtils.getSessionSummaryLines(updatedState);
    if (sessionSummaryLines && sessionSummaryLines.length > 0) {
      lines.push("========== MANDATORY STATS DISPLAY ==========");
      lines.push("COPY THESE EXACT LINES AS THE LAST LINES OF YOUR RESPONSE:");
      var emojis = ["\ud83d\udcca", "\ud83d\udd0b", "\ud83d\udcc8", "\ud83d\udcca"];
      for (var si = 0; si < sessionSummaryLines.length; si++) {
        lines.push((emojis[si] || "\ud83d\udcc8") + " " + sessionSummaryLines[si]);
      }
      lines.push("==============================================");
      lines.push("");
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
    lines.push("Confidence: " + result.confidence.confidence + "% (" + result.confidence.signals + " signals, " + result.confidence.agreement + " agreement)");

    if (result.detectedLanguage && result.detectedLanguage !== "en") {
      var langNames = { hu: "Hungarian", de: "German" };
      lines.push("Language: " + (langNames[result.detectedLanguage] || result.detectedLanguage) + " detected");
    }

    if (contextUsage) {
      lines.push("Context window: ~" + contextUsage.percentage + "% estimated (" + Math.round(contextUsage.estimatedUsed / 1000) + "K/" + Math.round(contextUsage.maxTokens / 1000) + "K tokens)");
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

    if (isDryRun) {
      lines.push("[DRY RUN] No routing action taken. This was a test analysis only.");
    } else if (result.autoRoute && !result.override) {
      lines.push("AUTO-ROUTING: High confidence score (" + result.score + "/10). Automatically delegate this task to the **" + result.model + "-worker** agent without asking. Just do it.");
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
      lines.push("Ask: \"" + result.level + " task (score " + result.score + "/10, category: " + result.matchedCategory + "). Route to **" + result.model + "-worker** for " + ({ haiku: "fast", sonnet: "balanced", opus: "thorough" }[result.model] || "balanced") + " handling? Or prefer haiku/sonnet/opus?\"");
      lines.push("If confirmed, delegate to " + result.model + "-worker. If different model chosen, use that worker instead and note the override for /tune.");
      lines.push("If the task is trivially simple (like a direct question), you may answer directly without delegating.");
    }

    if (config && config.promptHints && config.promptHints.enabled && config.promptHints.hints) {
      var hint = config.promptHints.hints[result.model];
      if (hint) { lines.push(""); lines.push(hint); }
    }

    process.stdout.write(lines.join("\n"));
    process.exit(0);

  } catch (err) {
    // T2.4 (v2.5.0): log hook errors + surface to user so failures aren't silent
    process.stderr.write("[Model Router] Error: " + (err.message || err) + "\n");
    try {
      errorLog.logHookError({
        script: "analyze-complexity.js",
        phase: "main-handler",
        error: err,
        input: input,
        sessionId: (function() { try { return JSON.parse(input).session_id; } catch (e) { return ""; } })()
      });
    } catch (e) { /* never let error logging cascade */ }
    // Emit a visible warning so Claude Code surfaces the failure in context
    process.stdout.write("[Model Router - ERROR] analyze-complexity.js caught an exception. See logs/hook-errors.jsonl or run /health for details.\n");
    process.exit(0);
  }
});
