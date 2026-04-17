"use strict";

/**
 * Hook error log: append-only JSONL capturing exceptions caught by hook
 * scripts. Used by analyze-complexity.js, enforce-stats.js, detect-fallback.js,
 * runtime-check.js, and any other hook to surface failures that would
 * otherwise be silent.
 *
 * Wired up in T2.4 (v2.5.0 audit follow-up). Previously hook failures were
 * caught and ignored, leaving users with no signal when the plugin misbehaved.
 *
 * Path: logs/hook-errors.jsonl
 * Auto-trimmed to 200 entries.
 *
 * Read via `/health` or `--errors` special command.
 */

var fs = require("fs");
var path = require("path");

var MAX_ENTRIES = 200;
var MAX_MSG_LEN = 500;
var MAX_INPUT_PREVIEW = 200;
var MAX_STACK_LEN = 2000;

function getLogPath() {
  return path.join(__dirname, "..", "..", "logs", "hook-errors.jsonl");
}

function ensureLogsDir() {
  var dir = path.dirname(getLogPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Append a hook error entry. Never throws. Safe to call from inside a
 * `catch` block in any hook script.
 *
 * @param {object} entry
 * @param {string} entry.script    e.g. "analyze-complexity.js"
 * @param {string} entry.phase     e.g. "stdin-parse", "main-analysis", "output-build"
 * @param {Error|string} entry.error
 * @param {string} [entry.input]   the raw stdin (or prompt) the hook was processing
 * @param {string} [entry.sessionId]
 */
function logHookError(entry) {
  try {
    ensureLogsDir();
    var errObj = entry.error || new Error("unknown");
    var msg = (typeof errObj === "string") ? errObj : (errObj.message || String(errObj));
    var stack = (typeof errObj === "object" && errObj.stack) ? errObj.stack : "";
    var record = {
      timestamp: new Date().toISOString(),
      script: entry.script || "unknown",
      phase: entry.phase || "unknown",
      message: msg.substring(0, MAX_MSG_LEN),
      stack: stack ? stack.substring(0, MAX_STACK_LEN) : "",
      inputPreview: entry.input ? String(entry.input).substring(0, MAX_INPUT_PREVIEW).replace(/\n/g, " ") : "",
      sessionId: entry.sessionId || ""
    };
    fs.appendFileSync(getLogPath(), JSON.stringify(record) + "\n", "utf8");
    trim();
  } catch (e) {
    // Silent fail - error logging itself must never cascade a failure.
  }
}

function trim() {
  try {
    var p = getLogPath();
    if (!fs.existsSync(p)) return;
    var lines = fs.readFileSync(p, "utf8").split("\n").filter(function(l) { return l.length > 0; });
    if (lines.length > MAX_ENTRIES) {
      fs.writeFileSync(p, lines.slice(lines.length - MAX_ENTRIES).join("\n") + "\n", "utf8");
    }
  } catch (e) { /* ignore */ }
}

function readAll() {
  try {
    var p = getLogPath();
    if (!fs.existsSync(p)) return [];
    var lines = fs.readFileSync(p, "utf8").split("\n").filter(function(l) { return l.length > 0; });
    return lines.map(function(l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(function(e) { return e !== null; });
  } catch (e) {
    return [];
  }
}

function summarize() {
  var entries = readAll();
  if (entries.length === 0) {
    return { totalErrors: 0, byScript: {}, byPhase: {}, recent: [] };
  }
  var byScript = {};
  var byPhase = {};
  entries.forEach(function(e) {
    byScript[e.script] = (byScript[e.script] || 0) + 1;
    byPhase[e.phase] = (byPhase[e.phase] || 0) + 1;
  });
  return {
    totalErrors: entries.length,
    byScript: byScript,
    byPhase: byPhase,
    recent: entries.slice(-10)
  };
}

module.exports = {
  logHookError: logHookError,
  readAll: readAll,
  summarize: summarize,
  getLogPath: getLogPath
};
