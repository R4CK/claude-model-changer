#!/usr/bin/env node
/**
 * detect-fallback.js - Post-response hook to detect [FALLBACK:model] markers
 *
 * Scans the assistant's response for fallback markers emitted by agent workers.
 * If detected, logs the fallback event and outputs a re-routing instruction.
 *
 * Reads from stdin: { "response": "...", "session_id": "..." }
 * Used as a SubagentComplete or Stop hook.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var atomicIo = require("./lib/atomic-io");

var LOGS_DIR = path.join(__dirname, "..", "logs");
var FALLBACK_LOG = path.join(LOGS_DIR, "fallbacks.jsonl");
var SESSION_PATH = path.join(LOGS_DIR, "session-state.json");
var USAGE_LOG_PATH = path.join(LOGS_DIR, "usage.jsonl");
var FALLBACK_PATTERN = /\[FALLBACK:(\w+)\]/;

function ensureLogDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

var input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function(chunk) { input += chunk; });
process.stdin.on("end", function() {
  try {
    var data = JSON.parse(input);
    var response = data.response || data.content || "";
    var sessionId = data.session_id || "unknown";

    // ---- Auto-log subagent model from agent name ----
    var agentName = data.agent_name || data.agentName || data.subagent_type || "";
    var detectedModel = null;
    // Use word-boundary matching to avoid false positives (e.g. "philosophiku" matching "haiku")
    var AGENT_MODEL_PATTERNS = [
      { pattern: /\bhaiku\b/i, model: "haiku" },
      { pattern: /\bsonnet\b/i, model: "sonnet" },
      { pattern: /\bopus\b/i, model: "opus" }
    ];
    for (var pi = 0; pi < AGENT_MODEL_PATTERNS.length; pi++) {
      if (AGENT_MODEL_PATTERNS[pi].pattern.test(agentName)) {
        detectedModel = AGENT_MODEL_PATTERNS[pi].model;
        break;
      }
    }

    if (detectedModel) {
      try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

        // v3.6.2: route the counter increment through atomic-io read-modify-
        // write instead of a bespoke lockfile. mergeFn increments from
        // `current` (freshest disk state); on a concurrent-write retry it
        // re-runs against the new state, so the +1 is never lost. Previously
        // this used its own SESSION_PATH.lock spin-lock that the analyze-
        // complexity writer (session-utils.saveSessionState) did NOT honor,
        // so an interleave could silently drop a subagent counter increment.
        var mergeResult = atomicIo.atomicMergeJson(SESSION_PATH, function(current) {
          var state = (current && typeof current === "object") ? current : {};
          if (!state.modelCounts || typeof state.modelCounts !== "object") state.modelCounts = { haiku: 0, sonnet: 0, opus: 0 };
          if (!state.subagentCounts || typeof state.subagentCounts !== "object") state.subagentCounts = { haiku: 0, sonnet: 0, opus: 0 };
          state.modelCounts[detectedModel] = (Number(state.modelCounts[detectedModel]) || 0) + 1;
          state.subagentCounts[detectedModel] = (Number(state.subagentCounts[detectedModel]) || 0) + 1;
          // NOTE: subagent completions are not user prompts, so promptCount is left unchanged.
          return state;
        }, {});

        if (!mergeResult.ok) {
          process.stderr.write("[detect-fallback] Session merge failed: " + (mergeResult.error || "unknown") + "\n");
        }

        var subEntry = { timestamp: new Date().toISOString(), model: detectedModel, source: "subagent",
          category: "delegated-task", score: detectedModel === "haiku" ? 2 : detectedModel === "sonnet" ? 5 : 9,
          level: detectedModel === "haiku" ? "SIMPLE" : detectedModel === "sonnet" ? "MEDIUM" : "COMPLEX", autoRouted: true };
        fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(subEntry) + "\n");

        process.stderr.write("[detect-fallback] Auto-logged " + detectedModel + " subagent from agent: " + agentName + "\n");
      } catch (logErr) {
        process.stderr.write("[detect-fallback] Subagent log error: " + logErr.message + "\n");
      }
    }

    if (!response || response.length < 5) { process.exit(0); }

    var match = response.match(FALLBACK_PATTERN);
    if (!match) { process.exit(0); }

    var targetModel = match[1].toLowerCase();
    var validModels = ["haiku", "sonnet", "opus"];
    if (validModels.indexOf(targetModel) === -1) { process.exit(0); }

    // Detect source model from context
    var sourceModel = "unknown";
    if (response.includes("[FALLBACK:sonnet]")) sourceModel = "haiku";
    else if (response.includes("[FALLBACK:opus]")) sourceModel = "sonnet";

    // Log the fallback event
    ensureLogDir();
    var entry = {
      timestamp: new Date().toISOString(),
      fromModel: sourceModel,
      toModel: targetModel,
      reason: "Agent emitted FALLBACK marker",
      sessionId: sessionId,
      autoDetected: true
    };
    fs.appendFileSync(FALLBACK_LOG, JSON.stringify(entry) + "\n");

    // Feedback loop: check if this model has fallen back 3+ times recently
    var upgradeWarning = "";
    try {
      var fbContent = fs.readFileSync(FALLBACK_LOG, "utf8").trim();
      var fbLines = fbContent.split("\n").filter(function(l) { return l.length > 0; });
      var recentWindow = Date.now() - 7 * 86400000; // last 7 days
      var fromModelFallbacks = 0;
      for (var i = 0; i < fbLines.length; i++) {
        try {
          var fb = JSON.parse(fbLines[i]);
          if (fb.fromModel === sourceModel && new Date(fb.timestamp).getTime() > recentWindow) {
            fromModelFallbacks++;
          }
        } catch (e) {}
      }
      if (fromModelFallbacks >= 3) {
        var upgradeTarget = sourceModel === "haiku" ? "sonnet" : "opus";
        upgradeWarning = "\nAUTO-UPGRADE SUGGESTION: " + sourceModel + " has fallen back " + fromModelFallbacks + " times in 7 days. " +
          "Consider upgrading default routing for this category to " + upgradeTarget + ". Use /tune for detailed analysis.";
      }
    } catch (e) {}

    // Output re-routing instruction
    process.stdout.write("[Model Router] FALLBACK DETECTED: " + sourceModel + " -> " + targetModel + "\n");
    process.stdout.write("The previous agent could not handle this task. Automatically re-routing to **" + targetModel + "-worker**.\n");
    process.stdout.write("Delegate the SAME task to " + targetModel + "-worker now.\n");
    if (upgradeWarning) process.stdout.write(upgradeWarning + "\n");

  } catch (err) {
    // T2.4 (v2.5.0): log hook errors so failures are visible via /health
    try {
      require("./lib/error-log").logHookError({
        script: "detect-fallback.js",
        phase: "main",
        error: err,
        input: input
      });
    } catch (e) { /* never cascade */ }
  }
  process.exit(0);
});
