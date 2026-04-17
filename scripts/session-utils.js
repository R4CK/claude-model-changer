#!/usr/bin/env node
/**
 * session-utils.js - Shared session state utilities
 * Used by analyze-complexity.js and enforce-stats.js
 */

"use strict";

var fs = require("fs");
var path = require("path");
var io = require("./lib/io");
var sleep = require("./lib/sleep");

// Consolidated: path constants imported from io.js (single source of truth)
var LOGS_DIR = path.join(io.BASE_DIR, "logs");
var SESSION_PATH = io.getSessionPath();
var LOCK_PATH = SESSION_PATH + ".lock";
var USAGE_LOG_PATH = io.getLogPath();
var CONFIG_PATH = io.getConfigPath();

// C1: File lock for session-state.json to prevent race conditions with log-subagent.js
var LOCK_TIMEOUT_MS = 3000;
var LOCK_RETRY_MS = 30;

function acquireSessionLock() {
  var start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      var stat;
      try { stat = fs.statSync(LOCK_PATH); }
      catch (e) { sleep.sleepSync(LOCK_RETRY_MS); continue; }

      if (Date.now() - stat.mtimeMs > 10000) {
        // Only force-remove if the owning PID is verifiably dead
        var pidDead = false;
        var pidKnown = false;
        try {
          var raw = fs.readFileSync(LOCK_PATH, "utf8");
          var lockPid = parseInt(raw, 10);
          if (lockPid && !isNaN(lockPid)) {
            pidKnown = true;
            try { process.kill(lockPid, 0); } catch (e) { pidDead = true; }
          }
        } catch (e) { /* unreadable; wait another cycle rather than force-remove */ }
        if (pidDead || !pidKnown) {
          try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
        }
        continue;
      }
      sleep.sleepSync(LOCK_RETRY_MS);
    }
  }
  return false;
}

function releaseSessionLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
}

function ensureLogDir() {
  if (!fs.existsSync(LOGS_DIR)) { fs.mkdirSync(LOGS_DIR, { recursive: true }); }
}

function loadSessionState() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return null;
    return JSON.parse(fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) { return null; }
}

function saveSessionState(state) {
  var locked = acquireSessionLock();
  try {
    ensureLogDir();
    // Merge with current file contents to prevent lost updates from concurrent writes
    try {
      if (fs.existsSync(SESSION_PATH)) {
        var current = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, ""));
        // Preserve counter fields from disk if they are higher (another process may have incremented)
        if (current && typeof current === "object") {
          ["modelCounts", "subagentCounts"].forEach(function(key) {
            if (current[key] && state[key]) {
              ["haiku", "sonnet", "opus"].forEach(function(m) {
                if (typeof current[key][m] === "number" && typeof state[key][m] === "number") {
                  state[key][m] = Math.max(state[key][m], current[key][m]);
                }
              });
            }
          });
          // Keep skills merged from both sources with Math.max for counters
          if (current.skillsUsed && state.skillsUsed) {
            Object.keys(current.skillsUsed).forEach(function(k) {
              if (!state.skillsUsed[k]) {
                state.skillsUsed[k] = current.skillsUsed[k];
              } else if (typeof current.skillsUsed[k] === "number" && typeof state.skillsUsed[k] === "number") {
                state.skillsUsed[k] = Math.max(state.skillsUsed[k], current.skillsUsed[k]);
              }
            });
          }
        }
      }
    } catch (mergeErr) {
      // If merge fails, proceed with the state as-is
    }
    var tmpPath = SESSION_PATH + "." + process.pid + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(state));
    fs.renameSync(tmpPath, SESSION_PATH);
  } catch (err) {
    process.stderr.write("[Model Router] Session save error: " + err.message + "\n");
    try { fs.unlinkSync(SESSION_PATH + "." + process.pid + ".tmp"); } catch (e) {}
  } finally {
    if (locked) releaseSessionLock();
  }
}

// Config cache: loaded once per process invocation
var _configCache = null;
function loadConfig() {
  if (_configCache !== null) return _configCache;
  try {
    _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
    return _configCache;
  } catch (e) { _configCache = null; return null; }
}

// Process-level cache for weekly usage (avoids re-reading full log on every call)
var _weeklyUsageCache = null;

function getWeeklyUsage() {
  if (_weeklyUsageCache) return _weeklyUsageCache;
  try {
    if (!fs.existsSync(USAGE_LOG_PATH)) return null;
    var content = fs.readFileSync(USAGE_LOG_PATH, "utf8").trim();
    if (!content) return null;

    var now = new Date();
    var dayOfWeek = now.getDay();
    var daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    var monday = new Date(now);
    monday.setDate(monday.getDate() - daysSinceMonday);
    monday.setHours(0, 0, 0, 0);
    var weekStart = monday.getTime();

    var counts = { all: 0, haiku: 0, sonnet: 0, opus: 0 };
    var lines = content.split("\n").filter(function(l) { return l.length > 0; });
    for (var i = 0; i < lines.length; i++) {
      try {
        var entry = JSON.parse(lines[i]);
        if (new Date(entry.timestamp).getTime() >= weekStart) {
          counts.all++;
          var model = entry.model || "sonnet";
          counts[model] = (counts[model] || 0) + 1;
        }
      } catch (e) {}
    }

    // NOTE: fallbacks.jsonl is NOT counted here because detect-fallback.js
    // already appends subagent entries to usage.jsonl, which we already counted above.
    // Adding fallbacks.jsonl would double-count those events.

    _weeklyUsageCache = counts;
    return counts;
  } catch (e) { return null; }
}

// ---- Visual progress bar ----

function progressBar(pct, width) {
  var w = (typeof width === "number" && width > 0) ? width : 10;
  var safePct = (typeof pct === "number" && isFinite(pct)) ? pct : 0;
  var filled = Math.round(Math.min(100, Math.max(0, safePct)) / 100 * w);
  var empty = w - filled;
  var bar = "";
  for (var i = 0; i < filled; i++) bar += "\u2588";   // █ filled
  for (var j = 0; j < empty; j++) bar += "\u2591";    // ░ empty
  return bar;
}

// ---- Multi-line session summary with visual design ----

function getSessionSummaryLines(sessionState) {
  if (!sessionState || !sessionState.modelCounts) return null;
  var mc = sessionState.modelCounts;
  var total = (mc.haiku || 0) + (mc.sonnet || 0) + (mc.opus || 0);
  if (total === 0) return null;

  var sc = sessionState.subagentCounts || {};
  var totalSub = (sc.haiku || 0) + (sc.sonnet || 0) + (sc.opus || 0);

  var config = loadConfig();
  var planLimits = (config && config.planLimits) ? config.planLimits : null;
  var lines = [];

  // Line 1: Model distribution with progress bars + subagent counts
  var modelParts = [];
  ["haiku", "sonnet", "opus"].forEach(function(m) {
    var count = mc[m] || 0;
    var pct = total > 0 ? Math.round(count / total * 100) : 0;
    var subCount = sc[m] || 0;
    var subTag = subCount > 0 ? "(" + subCount + "\ud83e\udd16)" : "";
    modelParts.push(m + " " + pct + "%" + subTag + " " + progressBar(pct));
  });
  var promptSuffix = totalSub > 0 ? " (" + totalSub + "\ud83e\udd16)" : "";
  lines.push(modelParts.join(" | ") + " | " + total + " prompts" + promptSuffix);

  // Line 2: Context + Session usage
  var line2Parts = [];

  // Context window
  try {
    var statusPath = path.join(LOGS_DIR, "status.json");
    if (fs.existsSync(statusPath)) {
      var status = JSON.parse(fs.readFileSync(statusPath, "utf8").replace(/^\uFEFF/, ""));
      if (status.contextUsage !== null && status.contextUsage !== undefined) {
        line2Parts.push("Context " + progressBar(status.contextUsage) + " " + status.contextUsage + "%");
      }
    }
  } catch (e) {}

  // Session budget
  if (planLimits && planLimits.sessionLimit && planLimits.sessionLimit > 0) {
    var sessionPct = Math.round(total / planLimits.sessionLimit * 100);
    var remaining = Math.max(0, planLimits.sessionLimit - total);
    line2Parts.push("Session " + progressBar(sessionPct) + " " + sessionPct + "% (" + remaining + " left)");
  }

  // Skills
  if (sessionState.skillsUsed && Object.keys(sessionState.skillsUsed).length > 0) {
    var skillList = Object.keys(sessionState.skillsUsed)
      .sort(function(a, b) { return (sessionState.skillsUsed[b] || 0) - (sessionState.skillsUsed[a] || 0); });
    line2Parts.push("Skills: " + skillList.join(", "));
  }

  if (line2Parts.length > 0) {
    lines.push(line2Parts.join(" | "));
  }

  // Line 3: Weekly per-model breakdown
  if (planLimits) {
    var weekly = getWeeklyUsage();
    if (weekly) {
      var weekParts = [];
      var models = [
        { key: "haiku", limit: "weeklyHaiku" },
        { key: "sonnet", limit: "weeklySonnet" },
        { key: "opus", limit: "weeklyOpus" }
      ];
      for (var mi = 0; mi < models.length; mi++) {
        var m = models[mi];
        var limit = planLimits[m.limit];
        if (limit && typeof limit === "number" && isFinite(limit) && limit > 0) {
          var count = weekly[m.key] || 0;
          var pct = Math.round(count / limit * 100);
          weekParts.push(m.key.charAt(0).toUpperCase() + m.key.slice(1) + " " + progressBar(pct) + " " + pct + "%");
        }
      }
      if (weekParts.length > 0) {
        lines.push("Weekly: " + weekParts.join(" | "));
      }

      // Line 4: Weekly total (all models combined)
      if (planLimits.weeklyAllModels && typeof planLimits.weeklyAllModels === "number" && isFinite(planLimits.weeklyAllModels) && planLimits.weeklyAllModels > 0) {
        var allPct = Math.min(999, Math.round(weekly.all / planLimits.weeklyAllModels * 100));
        lines.push("Total: " + progressBar(allPct, 20) + " " + allPct + "% (" + weekly.all + "/" + planLimits.weeklyAllModels + ")");
      }

    }
  }

  return lines;
}

// Legacy single-line function (backward compatibility)
function getSessionSummaryLine(sessionState) {
  var lines = getSessionSummaryLines(sessionState);
  if (!lines || lines.length === 0) return null;
  return lines[0];
}

// ---- SESSION ROUTING HISTORY ----

function getSessionRoutingHistory(sessionState) {
  try {
    if (!fs.existsSync(USAGE_LOG_PATH)) return null;
    var content = fs.readFileSync(USAGE_LOG_PATH, "utf8").trim();
    if (!content) return null;

    var sessionStartDate = (sessionState && sessionState.sessionStart) ? new Date(sessionState.sessionStart) : null;
    var sessionStart = (sessionStartDate && !isNaN(sessionStartDate.getTime())) ? sessionStartDate.getTime() : 0;
    var lines = content.split("\n").filter(function(l) { return l.length > 0; });
    var entries = [];

    for (var i = 0; i < lines.length; i++) {
      try {
        var entry = JSON.parse(lines[i]);
        if (new Date(entry.timestamp).getTime() >= sessionStart) {
          entries.push({
            model: entry.model,
            category: entry.category || "unknown",
            score: entry.score,
            autoRouted: entry.autoRouted || false,
            timestamp: entry.timestamp
          });
        }
      } catch (e) {}
    }

    return entries.length > 0 ? entries : null;
  } catch (e) { return null; }
}

module.exports = {
  ensureLogDir: ensureLogDir,
  loadSessionState: loadSessionState,
  saveSessionState: saveSessionState,
  getSessionSummaryLine: getSessionSummaryLine,
  getSessionSummaryLines: getSessionSummaryLines,
  getWeeklyUsage: getWeeklyUsage,
  progressBar: progressBar,
  getSessionRoutingHistory: getSessionRoutingHistory,
  LOGS_DIR: LOGS_DIR,
  SESSION_PATH: SESSION_PATH
};
