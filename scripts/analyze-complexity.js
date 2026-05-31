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
var memory = require("./lib/memory");
var quotaTracker = require("./lib/quota-tracker");
var ccVersion = require("./lib/cc-version");
var contextAudit = require("./lib/context-audit");
var fallbackLearn = require("./lib/fallback-learn");
var lastRouting = require("./lib/last-routing");
var profileManager = require("./lib/profile-manager");

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
          var raw = fs.readFileSync(settingsPath, "utf8").replace(/^﻿/, "");
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
    // v3.2.1: Pattern match no longer fully short-circuits. We compute the
    // quota state and a basic effort decision so saved patterns can still
    // be downgraded under quota pressure and emit a thinking-budget hint.
    var pmModel = patternMatch.model;
    var pmLevel = { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" }[pmModel];
    var pmQuotaState = null, pmQuotaDowngrade = null;
    try {
      pmQuotaState = quotaTracker.getQuotaState(config);
      pmQuotaDowngrade = quotaTracker.shouldDowngrade(pmModel, pmQuotaState, config);
      if (pmQuotaDowngrade && pmQuotaDowngrade.downgrade) {
        pmModel = pmQuotaDowngrade.toModel;
        pmLevel = { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" }[pmModel] || pmLevel;
      }
    } catch (e) {}
    var pmEffortLevel = pmModel === "haiku" ? "low" : (pmModel === "opus" ? "high" : "medium");
    var pmThinkingBudget = (config && config.effort && config.effort.thinkingBudgets && typeof config.effort.thinkingBudgets[pmEffortLevel] === "number")
      ? config.effort.thinkingBudgets[pmEffortLevel]
      : ({ low: 0, medium: 5000, high: 16000 })[pmEffortLevel];
    return {
      score: { haiku: 2, sonnet: 5, opus: 9 }[patternMatch.model],
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

  // v3.2.1: Skill trigger override applied AFTER keywordInfluence so the
  // skill trigger always wins. Without this, the keywordInfluence "override"
  // mode reverted the skill decision, making the skill rules ineffective.
  if (skillTrigger && skillTrigger.suggestedModel) {
    var allowSkillOverride = !(config && config.skillIntegration && config.skillIntegration.overrideRouting === false);
    if (allowSkillOverride) {
      model = skillTrigger.suggestedModel;
      level = ({ haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" })[model] || level;
    }
  }

  // v3.2.1: Agent Teams role override applied AFTER skill trigger and
  // keywordInfluence — orchestrator → opus, teammate → sonnet. This is the
  // last "explicit user-intent" override before stickiness/quota.
  if (agentTeamsRole && agentTeamsRole.suggestedModel) {
    model = agentTeamsRole.suggestedModel;
    level = ({ haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" })[model] || level;
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
      level = ({ haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" })[model] || level;
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
      },
      "--metrics": function() {
        // v3.1.0: Prometheus text-format metrics export
        try {
          var exporter = require("./export-prometheus");
          return exporter.buildMetrics();
        } catch (e) {
          return "# error generating metrics: " + e.message + "\n";
        }
      },
      "--skills-status": function() {
        // v3.8.0: external skills sync status (per-repo inventory + context cost)
        try {
          var ss = require("./skills-status");
          return JSON.stringify(ss.buildStatus(), null, 2);
        } catch (e) {
          return "skills-status error: " + e.message;
        }
      },
      "--quota": function() {
        // v3.2.0: Quota state report
        var qaCfg = configModule.loadConfig(cwd);
        var qs = quotaTracker.getQuotaState(qaCfg);
        return JSON.stringify(qs, null, 2);
      },
      "--context-audit": function() {
        // v3.2.0: Context bloat audit
        var audit = contextAudit.buildAudit({ windowMinutes: 60 });
        return JSON.stringify(audit, null, 2);
      },
      "--undo": function() {
        // v3.3.0 (R33): /undo last routing
        var cfg = configModule.loadConfig(cwd);
        var payload = lastRouting.buildUndoPayload(cfg);
        if (payload.ok) {
          // Auto-rate the previous decision as quality 1 (poor)
          try {
            var qFs = require("fs");
            var qPath = require("path").join(__dirname, "..", "logs", "quality.jsonl");
            qFs.appendFileSync(qPath, JSON.stringify({
              timestamp: new Date().toISOString(),
              sessionId: sessionId,
              model: payload.previousModel,
              category: payload.category,
              rating: 1,
              source: "undo"
            }) + "\n", "utf8");
          } catch (e) {}
        }
        return JSON.stringify(payload, null, 2);
      },
      "--fallback-learn": function() {
        // v3.3.0 (R30): full fallback-learn report (not cached)
        var cfg = configModule.loadConfig(cwd);
        return JSON.stringify(fallbackLearn.getReport(cfg), null, 2);
      },
      "--profile-list": function() {
        // v3.3.0 (R43)
        var profiles = profileManager.listProfiles();
        var active = profileManager.getActiveProfileName();
        return JSON.stringify({ profiles: profiles, active: active, count: profiles.length }, null, 2);
      },
      "--profile-current": function() {
        // v3.3.0 (R43)
        var byCwd = profileManager.getProfileForCwd(cwd);
        var active = profileManager.getActiveProfileName();
        return JSON.stringify({
          activeViaCwd: byCwd,
          activeGlobal: active,
          resolved: byCwd || active || null,
          cwd: cwd
        }, null, 2);
      },
      "--weekly-digest": function() {
        // v3.3.0 (R36)
        try {
          var digestMod = require("./weekly-digest");
          var report = digestMod.buildDigest({});
          return digestMod.formatMarkdown(report);
        } catch (e) {
          return "Weekly digest error: " + e.message;
        }
      },
      "--git-router-stats": function() {
        // v3.2.0: Git commit/push routing stats
        try {
          var fs2 = require("fs"), path2 = require("path");
          var statsFile = path2.join(__dirname, "..", "logs", "git-router-stats.jsonl");
          if (!fs2.existsSync(statsFile)) return JSON.stringify({ totalCommits: 0, totalPushes: 0, message: "No git router activity yet" }, null, 2);
          var entries = fs2.readFileSync(statsFile, "utf8").trim().split("\n")
            .filter(function(l) { return l.length > 0; })
            .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
          var thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
          entries = entries.filter(function(e) { return Date.parse(e.timestamp) >= thirtyDaysAgo; });
          var commits = entries.filter(function(e) { return e.op === "commit"; });
          var pushes = entries.filter(function(e) { return e.op === "push"; });
          var byModel = { haiku: 0, sonnet: 0, opus: 0 };
          var totalLines = 0, maxDiff = 0;
          commits.forEach(function(c) {
            if (byModel[c.recommended] !== undefined) byModel[c.recommended]++;
            if (c.diff) {
              var lines = (c.diff.insertions || 0) + (c.diff.deletions || 0);
              totalLines += lines;
              if (lines > maxDiff) maxDiff = lines;
            }
          });
          return JSON.stringify({
            totalCommits: commits.length,
            totalPushes: pushes.length,
            forcePushes: pushes.filter(function(p) { return p.forcePush; }).length,
            commitsByRecommendedModel: byModel,
            avgDiffLines: commits.length > 0 ? Math.round(totalLines / commits.length) : 0,
            largestDiffLines: maxDiff
          }, null, 2);
        } catch (e) {
          return JSON.stringify({ error: e.message }, null, 2);
        }
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

    // v3.3.0 (R43): --profile-switch <name>
    var profileSwitchMatch = prompt.trim().match(/^--profile-switch\s+([a-z0-9_-]+)$/i);
    if (profileSwitchMatch) {
      var pn = profileSwitchMatch[1];
      var ok = profileManager.setActiveProfile(pn);
      process.stdout.write(ok ? "Active profile set to: " + pn : "Profile not found: " + pn + " (create at ~/.claude/profiles/" + pn + ".json first)");
      process.exit(0);
    }
    if (prompt.trim() === "--profile-clear") {
      profileManager.clearActiveProfile();
      process.stdout.write("Active profile cleared (using base config).");
      process.exit(0);
    }

    // v3.3.0 (R31): --whatif <op> <args...>
    var whatifMatch = prompt.trim().match(/^--whatif\s+(.+)$/);
    if (whatifMatch) {
      try {
        var whatifMod = require("./whatif");
        // Split args on whitespace, but preserve quoted strings
        var argParts = whatifMatch[1].match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        argParts = argParts.map(function(a) { return a.replace(/^"|"$/g, ""); });
        var report = whatifMod.run(argParts, { cwd: cwd });
        process.stdout.write(whatifMod.formatReport(report));
      } catch (e) {
        process.stdout.write("ERROR: " + e.message);
      }
      process.exit(0);
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
    var result = analyzeComplexity(prompt, config, cwd, sessionId, data);

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

    // ---- Build output ----
    // v3.4.2: Output structure changed. The stats block was at the TOP of
    // the output pre-v3.4.2, but Claude often forgot to append it after a
    // long response (the "MANDATORY STATS DISPLAY" instruction was buried
    // beneath the routing analysis). Moving it to the END so it's the LAST
    // thing Claude reads before composing the reply \u2014 empirically much more
    // reliable in 2.1.x. We also wrap it in a <system-reminder>-style block
    // and use clearer "Append at end of your response" phrasing.
    var lines = [];

    var sessionSummaryLines = sessionUtils.getSessionSummaryLines(updatedState);
    var statsTail = null;
    if (sessionSummaryLines && sessionSummaryLines.length > 0) {
      var sl = ["<system-reminder>",
                "After completing the user's request, append these exact lines as the last lines of your response (no other text after them):",
                ""];
      var emojis = ["\ud83d\udcca", "\ud83d\udd0b", "\ud83d\udcc8", "\ud83d\udcca"];
      for (var si = 0; si < sessionSummaryLines.length; si++) {
        sl.push((emojis[si] || "\ud83d\udcc8") + " " + sessionSummaryLines[si]);
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
      lines.push("Ask: \"" + result.level + " task (score " + result.score + "/10, category: " + result.matchedCategory + "). Route to **" + result.model + "-worker** for " + ({ haiku: "fast", sonnet: "balanced", opus: "thorough" }[result.model] || "balanced") + " handling? Or prefer haiku/sonnet/opus?\"");
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
