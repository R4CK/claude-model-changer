#!/usr/bin/env node
/**
 * context-monitor.js - Context window monitoring, token estimation, handoff, session reset
 */
"use strict";

var fs = require("fs");
var path = require("path");
var io = require("./io");

// ---- TOKEN ESTIMATION ----

function estimateTokens(text) {
  if (!text) return 0;
  var len = text.length;
  var codeChars = 0;
  var codePatterns = text.match(/[{}\[\]"\\/:=<>(),.;`~!@#$%^&*|]+/g);
  if (codePatterns) {
    for (var i = 0; i < codePatterns.length; i++) codeChars += codePatterns[i].length;
  }
  var proseChars = len - codeChars;
  return Math.ceil(proseChars / 4 + codeChars / 3);
}

// ---- SESSION RESET DETECTION ----

function detectNewSession(state, sessionId) {
  if (!state) return true;
  if (state.sessionId && state.sessionId !== sessionId && sessionId !== "unknown") return true;

  // Detect stale session: if last activity was > 30 minutes ago, treat as new session
  if (state.timestamp) {
    var lastActivity = new Date(state.timestamp).getTime();
    var now = Date.now();
    var thirtyMinutes = 30 * 60 * 1000;
    if (now - lastActivity > thirtyMinutes) return true;
  }

  return false;
}

function resetSessionState(sessionId) {
  return {
    sessionId: sessionId,
    cumulativeTokens: 0,
    estimatedTokensUsed: 0,
    promptCount: 0,
    avgResponseTokens: 2000,
    avgToolCallsPerTurn: 1,
    systemOverhead: 20000,
    sessionStart: new Date().toISOString(),
    modelCounts: { haiku: 0, sonnet: 0, opus: 0 },
    subagentCounts: { haiku: 0, sonnet: 0, opus: 0 },
    skillsUsed: {}
  };
}

// ---- CONTEXT USAGE ESTIMATION ----

function estimateContextUsage(sessionId, prompt, config, loadSessionState) {
  if (!config || !config.contextMonitor || !config.contextMonitor.enabled) return null;

  var maxTokens = config.contextMonitor.maxContextTokens || 200000;
  var thresholds = config.contextMonitor.thresholds || { compactSuggest: 55, compactWarn: 65, compactForce: 75, forceCheaper: 90 };

  try {
    var state = loadSessionState(sessionId) || {};

    // Detect and handle new session
    if (detectNewSession(state, sessionId)) {
      state = resetSessionState(sessionId);
    }

    var promptTokens = estimateTokens(prompt);
    var promptCount = (state.promptCount || 0) + 1;
    var systemOverhead = state.systemOverhead || 20000;
    var priorTokens = state.cumulativeTokens || 0;
    var avgResponse = state.avgResponseTokens || 2000;
    var currentTurnTokens = promptTokens + avgResponse;
    var toolMultiplier = state.avgToolCallsPerTurn || 1;
    var toolOverhead = toolMultiplier * 800;

    var estimatedUsed = systemOverhead + priorTokens + currentTurnTokens + toolOverhead;
    var percentage = Math.round((estimatedUsed / maxTokens) * 100);

    return {
      estimatedUsed: estimatedUsed,
      maxTokens: maxTokens,
      percentage: percentage,
      promptCount: promptCount,
      systemOverhead: systemOverhead,
      priorTokens: priorTokens,
      currentTurnTokens: currentTurnTokens,
      thresholds: thresholds,
      isCritical: percentage >= thresholds.forceCheaper,
      isCompactForce: percentage >= (thresholds.compactForce || 75),
      isCompactWarn: percentage >= (thresholds.compactWarn || 65),
      isCompactSuggest: percentage >= (thresholds.compactSuggest || 55)
    };
  } catch (err) { return null; }
}

// ---- HANDOFF SUMMARY ----

function writeHandoffSummary(contextUsage, sessionState) {
  try {
    io.ensureLogDir();
    var mc = (sessionState && sessionState.modelCounts) || {};
    var ts = new Date().toISOString();
    var total = (mc.haiku || 0) + (mc.sonnet || 0) + (mc.opus || 0);

    // Build model distribution bars
    function progressBar(pct, w) {
      w = w || 10;
      var filled = Math.round(Math.min(100, Math.max(0, pct)) / 100 * w);
      var bar = "";
      for (var i = 0; i < filled; i++) bar += "\u2588";
      for (var j = 0; j < w - filled; j++) bar += "\u2591";
      return bar;
    }

    var modelLines = "";
    if (total > 0) {
      ["haiku", "sonnet", "opus"].forEach(function(m) {
        var count = mc[m] || 0;
        var pct = Math.round(count / total * 100);
        modelLines += "- " + m + ": " + count + " (" + pct + "%) " + progressBar(pct) + "\n";
      });
    }

    // Read recent routing history from usage log
    var routingHistory = "";
    try {
      var logPath = path.join(io.BASE_DIR, "logs", "usage.jsonl");
      if (fs.existsSync(logPath)) {
        var entries = io.readLogCached(logPath);
        // Get entries from current session timeframe
        var sessionStart = (sessionState && sessionState.sessionStart) ? new Date(sessionState.sessionStart).getTime() : 0;
        var sessionEntries = entries.filter(function(e) {
          return new Date(e.timestamp).getTime() >= sessionStart;
        }).slice(-15); // Last 15 entries max

        if (sessionEntries.length > 0) {
          var catSummary = {};
          sessionEntries.forEach(function(e) {
            var key = (e.category || "unknown");
            if (!catSummary[key]) catSummary[key] = { model: e.model, count: 0 };
            catSummary[key].count++;
            catSummary[key].model = e.model; // last used model
          });
          Object.keys(catSummary).forEach(function(cat) {
            var s = catSummary[cat];
            routingHistory += "- " + cat + " -> " + s.model + " (" + s.count + "x)\n";
          });
        }
      }
    } catch (e) {}

    // Check for quality data
    var qualityInfo = "";
    try {
      var qPath = path.join(io.BASE_DIR, "logs", "quality.jsonl");
      if (fs.existsSync(qPath)) {
        var qEntries = io.readLogCached(qPath);
        var sessionQuality = qEntries.filter(function(q) {
          return sessionState && sessionState.sessionStart &&
            new Date(q.timestamp).getTime() >= new Date(sessionState.sessionStart).getTime();
        });
        if (sessionQuality.length > 0) {
          var qSum = 0;
          sessionQuality.forEach(function(q) { qSum += q.rating; });
          qualityInfo = "- Ratings this session: " + sessionQuality.length + " (avg: " + (qSum / sessionQuality.length).toFixed(1) + "/5)\n";
        }
      }
    } catch (e) {}

    var content = "# Session Handoff \u2014 auto-generated at " + (contextUsage ? contextUsage.percentage : "?") + "% context\n\n" +
      "## Session Info\n" +
      "- Generated: " + ts + "\n" +
      "- Started: " + ((sessionState && sessionState.sessionStart) || "unknown") + "\n" +
      "- Prompts: " + total + "\n" +
      "- Context: ~" + (contextUsage ? contextUsage.percentage : "?") + "%\n\n" +
      "## Model Distribution\n" +
      (modelLines || "- No routing data yet\n") + "\n" +
      "## Routing History (categories)\n" +
      (routingHistory || "- No routing history available\n") + "\n" +
      (qualityInfo ? "## Quality Feedback\n" + qualityInfo + "\n" : "") +
      "## Task Context\n(Fill in: What was the original request? What is the current goal?)\n\n" +
      "## Completed Steps\n(Fill in: What has been accomplished so far?)\n\n" +
      "## Modified Files\n(Fill in: Which files were created or changed?)\n\n" +
      "## Next Steps\n(Fill in: What remains to be done?)\n\n" +
      "## Key Decisions\n(Fill in: Any architectural or design decisions made?)\n";

    var handoffPath = path.join(io.BASE_DIR, "logs", "session-handoff.md");
    fs.writeFileSync(handoffPath, content, "utf8");
    return handoffPath;
  } catch (err) {
    process.stderr.write("[Model Router] Handoff write error: " + err.message + "\n");
    return null;
  }
}

// ---- CONTEXT RECOMMENDATION ----

function getContextRecommendation(contextUsage, requestedModel, config, loadSessionState) {
  if (!contextUsage) return { model: requestedModel, adjusted: false };

  var result = { model: requestedModel, adjusted: false, compactWarning: null, handoffPath: null };

  if (contextUsage.isCritical) {
    result.model = "haiku";
    result.adjusted = requestedModel !== "haiku";
    result.reason = "CONTEXT CRITICAL (" + contextUsage.percentage + "%): Forcing haiku to preserve context window.";
  }

  if (contextUsage.isCompactForce) {
    // H5: Pass a valid fallback instead of null to avoid incorrect session load
    var handoffState = null;
    try { handoffState = loadSessionState("__handoff__"); } catch (e) {}
    var handoffPath = writeHandoffSummary(contextUsage, handoffState);
    result.handoffPath = handoffPath;
    result.compactWarning = "\ud83d\udea8 CONTEXT CRITICAL (" + contextUsage.percentage + "%) \u2014 AUTO-COMPACT REQUIRED\n" +
      "A session handoff file has been created at: " + (handoffPath || "logs/session-handoff.md") + "\n" +
      "YOU MUST NOW:\n" +
      "1. Read the handoff file and fill in the Task context, Completed steps, Modified files, Next steps, Key decisions sections\n" +
      "2. Run: /compact with the filled-in summary content\n" +
      "DO NOT continue with the user's request until compact is complete.";
    if (!result.adjusted && requestedModel === "opus") {
      result.model = "sonnet";
      result.adjusted = true;
      result.reason = "Context " + contextUsage.percentage + "%: Downgrading opus->sonnet.";
    }
  } else if (contextUsage.isCompactWarn) {
    result.compactWarning = "\u26a0\ufe0f Context " + contextUsage.percentage + "% \u2014 Quality degrading. Run /compact soon!\n" +
      "Summarize: original task, completed steps, modified files, next steps.\n" +
      "Run: /compact \"<your summary here>\"";
  } else if (contextUsage.isCompactSuggest) {
    result.compactWarning = "\ud83d\udca1 Context " + contextUsage.percentage + "% \u2014 Consider /compact to maintain quality.\n" +
      "\"Lost in the middle\" effect starts around 60%.";
  }

  return result;
}

// ---- CONTEXT TRACKING UPDATE ----

function updateContextTracking(sessionId, prompt, model, config, loadSessionState) {
  try {
    var state = loadSessionState(sessionId) || { sessionId: sessionId };

    // Detect and handle new session
    if (detectNewSession(state, sessionId)) {
      state = resetSessionState(sessionId);
    }

    var promptTokens = estimateTokens(prompt);
    var baseResponseTokens = { haiku: 1500, sonnet: 3000, opus: 6000 };
    var responseEstimate = (baseResponseTokens[model] || 3000);

    // M4: Use else-if to prevent double multiplication (was 1.5 * 1.3 = 1.95x for >1000 tokens)
    if (promptTokens > 1000) responseEstimate = Math.round(responseEstimate * 1.8);
    else if (promptTokens > 500) responseEstimate = Math.round(responseEstimate * 1.5);

    var toolCallEstimate = model === "opus" ? 4 : model === "sonnet" ? 2.5 : 1;
    var prevAvgTools = state.avgToolCallsPerTurn || toolCallEstimate;
    state.avgToolCallsPerTurn = Math.round((prevAvgTools * 0.7 + toolCallEstimate * 0.3) * 10) / 10;

    var turnTokens = promptTokens + responseEstimate + (state.avgToolCallsPerTurn * 800);
    state.cumulativeTokens = (state.cumulativeTokens || 0) + turnTokens;

    if (!state.systemOverhead) state.systemOverhead = 20000;

    state.estimatedTokensUsed = state.systemOverhead + state.cumulativeTokens;
    state.promptCount = (state.promptCount || 0) + 1;
    state.avgResponseTokens = responseEstimate;
    if (!state.sessionStart) state.sessionStart = new Date().toISOString();
    if (!state.modelCounts) state.modelCounts = { haiku: 0, sonnet: 0, opus: 0 };
    state.modelCounts[model] = (Number(state.modelCounts[model]) || 0) + 1;
    return state;
  } catch (err) { return null; }
}

// ---- TASK SPLITTING RECOMMENDATION (GSD-inspired) ----

function getTaskSplitRecommendation(contextUsage, score, model, config) {
  if (!contextUsage) return null;

  var cmConfig = (config && config.contextMonitor) || {};
  var splitThreshold = cmConfig.taskSplitThreshold || 40;
  var minScore = cmConfig.taskSplitMinScore || 6;

  if (contextUsage.percentage < splitThreshold || score < minScore) return null;

  var severity = contextUsage.percentage >= 55 ? "strong" : "mild";
  var reason, suggestion;

  if (severity === "strong") {
    reason = "Context at " + contextUsage.percentage + "% with " +
      (model === "opus" ? "complex" : "moderate") + " task (score " + score + "/10)";
    suggestion = "TASK SPLIT RECOMMENDED: Break this into smaller subtasks.\n" +
      "  1. Run /compact with current progress first\n" +
      "  2. Split into independent subtasks (each can use fresh context)\n" +
      "  3. Simple subtasks -> haiku, moderate -> sonnet, only complex parts -> opus";
  } else {
    reason = "Context at " + contextUsage.percentage + "% with score " + score + "/10";
    suggestion = "Consider splitting: complex parts separately, simple cleanup with haiku";
  }

  return {
    shouldSplit: true,
    severity: severity,
    reason: reason,
    suggestion: suggestion
  };
}

module.exports = {
  estimateTokens: estimateTokens,
  detectNewSession: detectNewSession,
  resetSessionState: resetSessionState,
  estimateContextUsage: estimateContextUsage,
  writeHandoffSummary: writeHandoffSummary,
  getContextRecommendation: getContextRecommendation,
  updateContextTracking: updateContextTracking,
  getTaskSplitRecommendation: getTaskSplitRecommendation
};
