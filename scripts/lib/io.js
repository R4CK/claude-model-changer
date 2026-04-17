#!/usr/bin/env node
/**
 * io.js - File I/O, caching, path getters, logging
 */
"use strict";

var fs = require("fs");
var path = require("path");

var CONSTANTS = {
  WEEK_MS: 7 * 86400000,
  TOKEN_INPUT_RATIO: 0.4,
  TOKEN_OUTPUT_RATIO: 0.6,
  MAX_USAGE_ENTRIES: 1000,
  MAX_OVERRIDE_ENTRIES: 500,
  MAX_FALLBACK_ENTRIES: 500,
  MAX_QUALITY_ENTRIES: 500,
  MAX_BENCHMARK_ENTRIES: 200,
  CONFIDENCE: { LOW: 25, MEDIUM: 50, HIGH: 70 }
};

var BASE_DIR = path.join(__dirname, "..", "..");

// ---- FILE I/O CACHE ----
var _fileCache = {};
function readLogCached(logPath) {
  if (_fileCache[logPath]) return _fileCache[logPath];
  try {
    var content = fs.readFileSync(logPath, "utf8").replace(/^\uFEFF/, "").trim();
    var entries = content.split("\n").filter(function(l) { return l.length > 0; }).map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean);
    _fileCache[logPath] = entries;
    return entries;
  } catch(e) { return []; }
}

function clearCache() { _fileCache = {}; }

// ---- FILE PATHS ----
function getLogPath() { return path.join(BASE_DIR, "logs", "usage.jsonl"); }
function getOverrideLogPath() { return path.join(BASE_DIR, "logs", "overrides.jsonl"); }
function getFallbackLogPath() { return path.join(BASE_DIR, "logs", "fallbacks.jsonl"); }
function getQualityLogPath() { return path.join(BASE_DIR, "logs", "quality.jsonl"); }
function getSessionPath() { return path.join(BASE_DIR, "logs", "session-state.json"); }
function getPatternsPath() { return path.join(BASE_DIR, "config", "patterns.json"); }
function getStatusPath() { return path.join(BASE_DIR, "logs", "status.json"); }
function getBenchmarkLogPath() { return path.join(BASE_DIR, "logs", "benchmarks.jsonl"); }
function getConfigPath() { return path.join(BASE_DIR, "config", "task-routing.json"); }
function getLearnedConfigPath() { return path.join(BASE_DIR, "logs", "learned-keywords.json"); }

function ensureLogDir() {
  var logDir = path.join(BASE_DIR, "logs");
  if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }
}

// ---- LOGGING ----
// Track approximate line counts to avoid re-reading file on every append
var _lineCountCache = {};

function trimLog(logPath, maxEntries) {
  try {
    var content = fs.readFileSync(logPath, "utf8");
    var lines = content.trim().split("\n").filter(function(l) { return l.length > 0; });
    _lineCountCache[logPath] = lines.length;
    if (lines.length > maxEntries) {
      var trimmed = lines.slice(lines.length - maxEntries);
      // Atomic write: temp file + rename to prevent corruption on disk-full/crash
      var tmpPath = logPath + ".trim.tmp";
      fs.writeFileSync(tmpPath, trimmed.join("\n") + "\n");
      fs.renameSync(tmpPath, logPath);
      _lineCountCache[logPath] = trimmed.length;
      delete _fileCache[logPath];
    }
  } catch (err) {
    process.stderr.write("[Model Router] Trim error: " + err.message + "\n");
    // Clean up temp file if it exists
    try { fs.unlinkSync(logPath + ".trim.tmp"); } catch (e) {}
  }
}

function appendLog(getPathFn, entry, maxEntries) {
  try {
    ensureLogDir();
    var p = getPathFn();
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
    delete _fileCache[p];
    // Check actual file size to trigger trim (fixes multi-process dead code issue)
    // File size check is cheap (~1 syscall) vs reading entire file
    var needsTrim = false;
    try {
      var stat = fs.statSync(p);
      // ~200 bytes per entry, so maxEntries * 250 is a safe threshold
      if (stat.size > maxEntries * 250) {
        needsTrim = true;
      }
    } catch (e) {}
    // Also track approximate line count for within-process trimming
    var approxLines = (_lineCountCache[p] || 0) + 1;
    _lineCountCache[p] = approxLines;
    if (needsTrim || approxLines > maxEntries) {
      trimLog(p, maxEntries);
    }
  } catch (err) {
    process.stderr.write("[Model Router] Log error: " + err.message + "\n");
  }
}

function logUsage(entry) {
  // H1: Sanitize numeric fields before logging to prevent NaN poisoning historical data
  if (entry && typeof entry.score === "number" && (isNaN(entry.score) || !isFinite(entry.score))) {
    entry.score = 5; entry._nanCorrected = true;
  }
  if (entry && typeof entry.confidence === "number" && (isNaN(entry.confidence) || !isFinite(entry.confidence))) {
    entry.confidence = 50; entry._nanCorrected = true;
  }
  appendLog(getLogPath, entry, CONSTANTS.MAX_USAGE_ENTRIES);
}
function logOverride(entry) { appendLog(getOverrideLogPath, entry, CONSTANTS.MAX_OVERRIDE_ENTRIES); }
function logFallback(entry) { appendLog(getFallbackLogPath, entry, CONSTANTS.MAX_FALLBACK_ENTRIES); }

// ---- HOOK DEBUG LOG ROTATION ----
var MAX_DEBUG_LOG_LINES = 500;

function rotateDebugLog() {
  try {
    var debugPath = path.join(BASE_DIR, "logs", "hook-debug.log");
    if (!fs.existsSync(debugPath)) return;
    var stat = fs.statSync(debugPath);
    // Only rotate if > 50KB
    if (stat.size < 50000) return;
    var content = fs.readFileSync(debugPath, "utf8");
    var lines = content.split("\n").filter(function(l) { return l.length > 0; });
    if (lines.length > MAX_DEBUG_LOG_LINES) {
      fs.writeFileSync(debugPath, lines.slice(lines.length - MAX_DEBUG_LOG_LINES).join("\n") + "\n");
    }
  } catch (e) {}
}

function estimateModelCost(model, tokens, config) {
  var costs = (config && config.costEstimates) ? config.costEstimates : {
    haiku: { inputPer1M: 0.25, outputPer1M: 1.25 },
    sonnet: { inputPer1M: 3.00, outputPer1M: 15.00 },
    opus: { inputPer1M: 15.00, outputPer1M: 75.00 }
  };
  var mc = costs[model] || costs.sonnet;
  var inp = tokens * CONSTANTS.TOKEN_INPUT_RATIO;
  var outp = tokens * CONSTANTS.TOKEN_OUTPUT_RATIO;
  return (inp / 1e6) * mc.inputPer1M + (outp / 1e6) * mc.outputPer1M;
}

module.exports = {
  CONSTANTS: CONSTANTS,
  BASE_DIR: BASE_DIR,
  readLogCached: readLogCached,
  clearCache: clearCache,
  getLogPath: getLogPath,
  getOverrideLogPath: getOverrideLogPath,
  getFallbackLogPath: getFallbackLogPath,
  getQualityLogPath: getQualityLogPath,
  getSessionPath: getSessionPath,
  getPatternsPath: getPatternsPath,
  getStatusPath: getStatusPath,
  getBenchmarkLogPath: getBenchmarkLogPath,
  getConfigPath: getConfigPath,
  getLearnedConfigPath: getLearnedConfigPath,
  ensureLogDir: ensureLogDir,
  logUsage: logUsage,
  logOverride: logOverride,
  logFallback: logFallback,
  trimLog: trimLog,
  rotateDebugLog: rotateDebugLog,
  estimateModelCost: estimateModelCost
};
