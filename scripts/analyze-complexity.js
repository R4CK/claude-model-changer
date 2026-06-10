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
var contextMonitor = require("./lib/context-monitor");
var monitors = require("./lib/monitors");
var stats = require("./lib/stats");
var session = require("./lib/session");
var sessionUtils = require("./session-utils");
var errorLog = require("./lib/error-log");
var memory = require("./lib/memory");
var quotaTracker = require("./lib/quota-tracker");
var ccVersion = require("./lib/cc-version");
var fallbackLearn = require("./lib/fallback-learn");
var lastRouting = require("./lib/last-routing");
var modelConstants = require("./lib/model-constants");
var specialCommands = require("./special-commands");
var outputFormatter = require("./output-formatter");
var LEVEL_BY_MODEL = modelConstants.LEVEL_BY_MODEL;
var SCORE_BY_MODEL = modelConstants.SCORE_BY_MODEL;

// Startup cleanup: rotate debug log + trim all JSONL logs.
// This hook runs as a fresh process on EVERY prompt, so module-level state does
// not persist across invocations. The unconditional version below stat'd 5 log
// files on every single prompt (10 sync FS ops) just to find that none needed
// trimming — the logs are self-correcting (trimLog brings a file back under the
// threshold), so a size check every prompt is wasteful. Throttle via a single
// on-disk marker: skip the whole sweep unless ~10 min have elapsed since the
// last one. Common path is now 1 statSync instead of 10.
io.rotateDebugLog();
(function startupLogRotation() {
  var THROTTLE_MS = 10 * 60 * 1000;
  try {
    var markerPath = path.join(__dirname, "..", "logs", ".last-rotation");
    try {
      var mst = fs.statSync(markerPath);
      if (Date.now() - mst.mtimeMs < THROTTLE_MS) return; // checked recently — skip sweep
    } catch (e) { /* no marker yet — proceed with sweep */ }

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

    // Touch the marker so the next ~10 min of prompts skip the sweep.
    try { io.ensureLogDir(); fs.writeFileSync(markerPath, ""); } catch (e) {}
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

// v3.1.0: detect Claude Code fast mode. The harness either passes fast_mode in
// the hook input, or it's persisted in ~/.claude/settings.json under "fastMode".
// In fast mode we override effort to "low" so the routing hint matches the user's
// "I want speed" intent regardless of category.
function detectFastMode(hookInput, config) {
  if (!config || !config.fastMode || config.fastMode.enabled === false) return { active: false, source: "disabled" };
  if (hookInput) {
    var fm = hookInput.fast_mode || hookInput.fastMode;
    if (fm === true || fm === "true") return { active: true, source: "hook input fast_mode" };
  }
  if (config.fastMode.detectFromUserSettings !== false) {
    try {
      var path = require("path");
      var fs = require("fs");
      var home = process.env.USERPROFILE || process.env.HOME || "";
      if (home) {
        var settingsPath = path.join(home, ".claude", "settings.json");
        if (fs.existsSync(settingsPath)) {
          var raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
          var s = JSON.parse(raw);
          if (s && s.fastMode === true) return { active: true, source: "~/.claude/settings.json fastMode" };
        }
      }
    } catch (e) {}
  }
  return { active: false, source: "not detected" };
}

// v3.1.0: detect plan mode from hook input (Claude Code passes permission_mode)
// or fall back to plan-mode keywords in the prompt. Plan mode is intrinsically
// more complex than straight execution - we surface a small contextBoost so a
// plan-mode prompt at the haiku/sonnet boundary nudges toward sonnet/opus.
function detectPlanMode(prompt, hookInput, config) {
  if (!config || !config.planMode || config.planMode.enabled === false) return { active: false, source: "disabled" };
  if (hookInput) {
    var pm = hookInput.permission_mode || hookInput.permissionMode || hookInput.plan_mode;
    if (pm === "plan" || pm === true) return { active: true, source: "hook input permission_mode" };
  }
  if (config.planMode.detectFromKeywords !== false) {
    var planKeywords = (config.planMode.keywords) || [
      "tervezd meg", "készíts tervet", "design plan", "make a plan", "create a plan",
      "plan the implementation", "tervezzük meg", "plan the migration", "step-by-step plan",
      "architecture plan", "implementation plan"
    ];
    var lower = String(prompt || "").toLowerCase();
    for (var i = 0; i < planKeywords.length; i++) {
      if (lower.indexOf(planKeywords[i].toLowerCase()) !== -1) return { active: true, source: "prompt keyword: '" + planKeywords[i] + "'" };
    }
  }
  return { active: false, source: "not detected" };
}

function analyzeComplexity(prompt, config, cwd, sessionId, hookInput) {
  var override = scoring.detectManualOverride(prompt, config);
  if (override) {
    return {
      score: SCORE_BY_MODEL[override],
      level: LEVEL_BY_MODEL[override],
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
    // v3.2.1: Pattern match no longer fully short-circuits. We compute the
    // quota state and a basic effort decision so saved patterns can still
    // be downgraded under quota pressure and emit a thinking-budget hint.
    var pmModel = patternMatch.model;
    var pmLevel = LEVEL_BY_MODEL[pmModel];
    var pmQuotaState = null, pmQuotaDowngrade = null;
    try {
      pmQuotaState = quotaTracker.getQuotaState(config);
      pmQuotaDowngrade = quotaTracker.shouldDowngrade(pmModel, pmQuotaState, config);
      if (pmQuotaDowngrade && pmQuotaDowngrade.downgrade) {
        pmModel = pmQuotaDowngrade.toModel;
        pmLevel = LEVEL_BY_MODEL[pmModel] || pmLevel;
      }
    } catch (e) {}
    var pmEffortLevel = pmModel === "haiku" ? "low" : (pmModel === "opus" ? "high" : "medium");
    var pmThinkingBudget = (config && config.effort && config.effort.thinkingBudgets && typeof config.effort.thinkingBudgets[pmEffortLevel] === "number")
      ? config.effort.thinkingBudgets[pmEffortLevel]
      : ({ low: 0, medium: 5000, high: 16000 })[pmEffortLevel];
    return {
      score: SCORE_BY_MODEL[patternMatch.model],
      level: pmLevel, model: pmModel, override: false,
      matchedCategory: patternMatch.label, reason: "Matched saved pattern: \"" + patternMatch.pattern + "\"",
      borderline: { isBorderline: false }, autoRoute: true,
      projectTypes: null, contextBoost: 0, stickiness: { sticky: false },
      confidence: { confidence: 95, signals: 1, agreement: "high" },
      patternMatch: patternMatch, detectedLanguage: "en", scores: null,
      quotaState: pmQuotaState, quotaDowngrade: pmQuotaDowngrade,
      effort: { level: pmEffortLevel, reason: "from saved pattern '" + patternMatch.pattern + "'", thinkingBudget: pmThinkingBudget }
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

  // v3.3.0 (R30): Fallback learning boost. If a category has an elevated
  // fallback rate (haiku-worker emitting [FALLBACK:sonnet] frequently),
  // bump the keyword score so the next routing skips ahead. Reads from
  // logs/fallback-learn.json (cached, recomputed every 6h).
  // Source: keyword category key (from scoreKeywords) — we look it up in
  // the config to get the matched category key, not just label.
  var fallbackBoostApplied = 0;
  try {
    if (keywordResult.matchedModel !== "none" && config && config.models) {
      var md = config.models[keywordResult.matchedModel];
      if (md && md.categories) {
        var catKeys = Object.keys(md.categories);
        for (var cki = 0; cki < catKeys.length; cki++) {
          if (md.categories[catKeys[cki]].label === keywordResult.matchedCategory) {
            fallbackBoostApplied = fallbackLearn.applyBoost(catKeys[cki], keywordResult, config);
            break;
          }
        }
      }
    }
  } catch (e) { /* never break routing */ }

  var projectTypes = session.detectProjectType(cwd);
  var contextBoost = session.getContextBoost(promptLower, projectTypes, config);

  // Prompt history context: boost score if related to recent higher-complexity prompts
  var historyBoost = session.getPromptHistoryBoost(prompt, sessionId, config);
  if (historyBoost.boost > 0) contextBoost += historyBoost.boost;

  // v3.1.0: Plan-mode signal — additive contextBoost so plan-mode prompts
  // nudge toward sonnet/opus even at the boundary score.
  var planMode = detectPlanMode(prompt, hookInput, config);
  var planModeBoost = (config && config.planMode && typeof config.planMode.scoreBoost === "number") ? config.planMode.scoreBoost : 1;
  if (planMode.active) contextBoost += planModeBoost;

  // v3.1.0: MCP tool density — multiple external integrations imply higher
  // complexity than keyword/multifile alone capture.
  var mcpResult = scoring.scoreMcpToolDensity(promptLower, config);
  if (mcpResult.score > 0) contextBoost += mcpResult.score;

  // v3.1.0: Skill trigger detection (explicit skill names in the prompt).
  var skillTrigger = scoring.detectSkillTrigger(promptLower, config);

  // v3.1.0: Parallel subagent dispatch detection (orchestrator pattern).
  var parallelDispatch = scoring.detectParallelDispatch(promptLower);

  // v3.2.0: Agent Teams role detection (Claude Code 2.1+).
  var agentTeamsRole = scoring.detectAgentTeamsRole(promptLower);

  // v3.2.1: Avoid double-counting. Both `parallelDispatch` and `agentTeamsRole`
  // detect orchestration patterns. If Agent Teams already fires (it's the
  // strictly stronger signal — it directly assigns the model later), skip
  // the parallelDispatch contextBoost to keep the score clean.
  if (parallelDispatch.active && !(agentTeamsRole && agentTeamsRole.role === "lead")) {
    contextBoost += 2;
  }

  // v3.2.0: Claude Code version awareness — used to inform downstream output
  // (e.g., emit thinking budget hints in CC2.1 inline format).
  var ccVer = null;
  try { ccVer = ccVersion.detect(); } catch (e) { ccVer = null; }

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

  // v3.2.1: Skill trigger and Agent Teams override moved AFTER keywordInfluence
  // (see below). Pre-v3.2.1 they were applied here, but keywordInfluence ===
  // "override" reverted them, making both features no-ops in many cases.
  // We track them for reporting up-front but apply the override later.

  // v3.2.0: Quota state is computed eagerly so /stats and statusline can read
  // it, but the actual downgrade is applied LATER (after all other model-
  // assignment logic) so we don't get re-overwritten by keywordInfluence.
  var quotaState = null, quotaDowngrade = null;
  try { quotaState = quotaTracker.getQuotaState(config); } catch (e) {}

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
      var targetCenter = SCORE_BY_MODEL[keywordResult.matchedModel] || 5;
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

  // v3.2.1: Skill trigger override applied AFTER keywordInfluence so the
  // skill trigger always wins. Without this, the keywordInfluence "override"
  // mode reverted the skill decision, making the skill rules ineffective.
  if (skillTrigger && skillTrigger.suggestedModel) {
    var allowSkillOverride = !(config && config.skillIntegration && config.skillIntegration.overrideRouting === false);
    if (allowSkillOverride) {
      model = skillTrigger.suggestedModel;
      level = (LEVEL_BY_MODEL)[model] || level;
    }
  }

  // v3.2.1: Agent Teams role override applied AFTER skill trigger and
  // keywordInfluence — orchestrator → opus, teammate → sonnet. This is the
  // last "explicit user-intent" override before stickiness/quota.
  if (agentTeamsRole && agentTeamsRole.suggestedModel) {
    model = agentTeamsRole.suggestedModel;
    level = (LEVEL_BY_MODEL)[model] || level;
  }

  var stickiness = session.getSessionStickiness(prompt, sessionId, model, config);
  // Score delta guard: stickiness should not suppress large upgrades (>3 score difference)
  var stickyModelCenter = SCORE_BY_MODEL;
  if (stickiness.sticky && !scoring.shouldAutoRoute(finalScore, config, confidence.confidence)) {
    var stickyCenter = stickyModelCenter[stickiness.stickyModel] || 5;
    if (Math.abs(finalScore - stickyCenter) <= 3) {
      model = stickiness.stickyModel;
      level = LEVEL_BY_MODEL[model] || level;
    } else {
      stickiness.sticky = false;
      stickiness.reason = "Score delta too large (" + finalScore + " vs " + stickyCenter + "), overriding stickiness";
    }
  }

  // v2.7.0: determine Effort (reasoning budget suggestion)
  // Extract categoryKey from keywordResult (if available) for per-category override lookup
  var effortCategoryKey = null;
  if (keywordResult && keywordResult.matchedCategory && keywordResult.matchedModel !== "none" && config && config.models) {
    var md = config.models[keywordResult.matchedModel];
    if (md && md.categories) {
      var catKeys = Object.keys(md.categories);
      for (var cki = 0; cki < catKeys.length; cki++) {
        if (md.categories[catKeys[cki]].label === keywordResult.matchedCategory) {
          effortCategoryKey = catKeys[cki];
          break;
        }
      }
    }
  }
  var effortDecision = scoring.determineEffort(subScores, confidence.confidence, keywordResult.matchedCategory, config, effortCategoryKey);

  // v3.1.0: Memory hint — read the auto-memory directory for terse/thorough
  // preferences and let them nudge the effort decision (without overriding HIGH
  // on architecturally complex tasks).
  var memoryPrefs = null;
  try { memoryPrefs = memory.readUserPreferences(cwd, config); } catch (e) { memoryPrefs = null; }
  if (memoryPrefs && memoryPrefs.available && effortDecision && !(config && config.memoryIntegration && config.memoryIntegration.influenceEffort === false)) {
    var hint = memory.effortHintFromMemory(memoryPrefs);
    // Only apply if it's a softening, not an override on HIGH categories
    if (hint && hint.level === "low" && effortDecision.level === "medium") {
      var lowBudget = (config.effort && config.effort.thinkingBudgets && typeof config.effort.thinkingBudgets.low === "number") ? config.effort.thinkingBudgets.low : 0;
      effortDecision = { level: "low", reason: hint.reason, thinkingBudget: lowBudget, fromMemory: true };
    } else if (hint && hint.level === "high" && effortDecision.level === "medium") {
      var highBudget = (config.effort && config.effort.thinkingBudgets && typeof config.effort.thinkingBudgets.high === "number") ? config.effort.thinkingBudgets.high : 16000;
      effortDecision = { level: "high", reason: hint.reason, thinkingBudget: highBudget, fromMemory: true };
    }
  }

  // v3.1.0: Fast mode override — the user explicitly opted in to speed, so we
  // pin effort to low regardless of category. This complements the model
  // recommendation: if Claude Code has fast mode on, it's already using a
  // faster model variant, and the plugin should not request expensive thinking.
  // (Fast mode runs LAST so it can override even memory-driven HIGH hints.)
  var fastMode = detectFastMode(hookInput, config);
  if (fastMode.active && effortDecision) {
    var fastBudget = (config.effort && config.effort.thinkingBudgets && typeof config.effort.thinkingBudgets.low === "number") ? config.effort.thinkingBudgets.low : 0;
    effortDecision = {
      level: "low",
      reason: "fast mode active (" + fastMode.source + ") — effort forced low",
      thinkingBudget: fastBudget,
      forcedByFastMode: true
    };
  }

  // v3.2.0: Quota-aware downgrade — applied LAST so it takes precedence over
  // keyword-influence override and any other model-assignment branch.
  try {
    quotaDowngrade = quotaTracker.shouldDowngrade(model, quotaState, config);
    if (quotaDowngrade && quotaDowngrade.downgrade) {
      model = quotaDowngrade.toModel;
      level = (LEVEL_BY_MODEL)[model] || level;
    }
  } catch (e) { /* never break routing */ }

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
    planMode: planMode,  // v3.1.0: { active: bool, source: "..." }
    fastMode: fastMode,  // v3.1.0: { active: bool, source: "..." }
    mcpTools: mcpResult,  // v3.1.0: { score, matchedTools, count }
    skillTrigger: skillTrigger,  // v3.1.0: { skill, suggestedModel, ... } or null
    parallelDispatch: parallelDispatch,  // v3.1.0: { active, suggestion }
    agentTeamsRole: agentTeamsRole,  // v3.2.0: { role, suggestedModel, suggestedEffort, reason } or null
    quotaState: quotaState,  // v3.2.0: full quota snapshot or null
    quotaDowngrade: quotaDowngrade,  // v3.2.0: { downgrade, toModel, reason } or null
    ccVersion: ccVer,  // v3.2.0: { version, features, detectedFrom } or null
    fallbackBoostApplied: fallbackBoostApplied,  // v3.3.0 (R30)
    effort: effortDecision,  // v2.7.0: { level: "low"|"medium"|"high", reason: "..." } or null
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
    // Strip a leading UTF-8 BOM before parsing. Some callers (e.g. a Windows
    // PowerShell `... | node`) prepend a BOM to the piped stdin, which makes
    // JSON.parse throw and drops the whole hook into the outer error handler.
    // The config/log readers already strip BOM the same way; stdin did not.
    var data = JSON.parse(input.replace(/^\uFEFF/, ""));

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

    // ---- Special commands (terminal --xxx handlers, extracted to special-commands.js) ----
    var scResult = specialCommands.handle(prompt, { cwd: cwd, sessionId: sessionId });
    if (scResult) { process.stdout.write(scResult.output); process.exit(0); }

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
    var result = analyzeComplexity(prompt, config, cwd, sessionId, data);

    var contextUsage = contextMonitor.estimateContextUsage(sessionId, prompt, config, session.loadSessionState);
    var contextRec = contextMonitor.getContextRecommendation(contextUsage, result.model, config, session.loadSessionState);
    if (contextRec.adjusted) {
      result.model = contextRec.model;
      result.level = LEVEL_BY_MODEL[result.model];
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
        scores: result.scores, promptPreview: prompt.substring(0, 80).replace(/\n/g, " "),
        prompt: prompt.substring(0, 500),  // v3.3.0 (R31): full(ish) prompt for /whatif replay
        effort: result.effort ? result.effort.level : null  // v2.7.0
      });
    }

    // v3.3.0 (R33): persist last routing for /undo
    if (!isDryRun) {
      try {
        lastRouting.save({
          timestamp: new Date().toISOString(),
          sessionId: sessionId,
          prompt: prompt.substring(0, 1000),
          model: result.model,
          level: result.level,
          score: result.score,
          category: result.matchedCategory,
          effort: result.effort ? result.effort.level : null
        });
      } catch (e) { /* never block */ }
    }

    if (!isDryRun) monitors.recordApiCall(sessionId, result.model, config, session.loadSessionState, session.saveSessionState);

    var updatedState = contextMonitor.updateContextTracking(sessionId, prompt, result.model, config, session.loadSessionState) || {};
    updatedState.sessionId = sessionId;
    updatedState.lastModel = result.model;
    updatedState.topicWords = session.extractTopicWords(prompt);
    session.updatePromptHistory(updatedState, prompt, result.model, result.matchedCategory, config);
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

    // ---- Build + emit output (extracted to output-formatter.js) ----
    var output = outputFormatter.build({
      config: config, result: result, isDryRun: isDryRun, isExplain: isExplain,
      prompt: prompt, contextUsage: contextUsage, contextRec: contextRec,
      budget: budget, rateLimit: rateLimit, apiLimits: apiLimits,
      anomalies: anomalies, qualityWarning: qualityWarning,
      llmFallbackHinted: llmFallbackHinted, updatedState: updatedState, safeMode: safeMode
    });
    process.stdout.write(output);
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
