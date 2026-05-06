#!/usr/bin/env node
/**
 * context-audit.js — Build a "what's eating my context window" report.
 *
 * Reads logs/tool-history.jsonl (populated by context-bloat-detect) and
 * produces a token-weighted heatmap of file reads, bash commands, and
 * MCP tool calls within the current session window.
 *
 * Returns { topFiles, topCommands, recommendations } so /context-audit
 * can render a clear "what to /clear" list.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
var HISTORY_FILE = path.join(PLUGIN_ROOT, "logs", "tool-history.jsonl");

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// Estimate per-call token cost (rough heuristic).
function estimateTokens(entry) {
  if (entry.kind === "read") return 3000;     // typical file read
  if (entry.kind === "bash-read") return 1500; // smaller (tail/head usually)
  if (entry.kind === "bash-grep") return 500;
  return 200;
}

function buildAudit(opts) {
  opts = opts || {};
  var windowMs = (opts.windowMinutes || 60) * 60 * 1000;
  var cutoff = Date.now() - windowMs;
  var entries = readHistory().filter(function(e) {
    return e && e.timestamp && Date.parse(e.timestamp) >= cutoff;
  });

  var byTarget = {};
  var byKind = { read: 0, "bash-read": 0, "bash-grep": 0, "bash-other": 0 };
  var totalCalls = 0;
  var totalTokens = 0;

  entries.forEach(function(e) {
    var t = e.target || "(unknown)";
    if (!byTarget[t]) byTarget[t] = { target: t, kind: e.kind, count: 0, tokens: 0 };
    byTarget[t].count++;
    var tokens = estimateTokens(e);
    byTarget[t].tokens += tokens;
    if (byKind[e.kind] !== undefined) byKind[e.kind]++;
    totalCalls++;
    totalTokens += tokens;
  });

  var sorted = Object.values(byTarget).sort(function(a, b) { return b.tokens - a.tokens; });
  var topFiles = sorted.filter(function(x) { return x.kind === "read" || x.kind === "bash-read"; }).slice(0, 10);
  var topCommands = sorted.filter(function(x) { return x.kind === "bash-grep" || x.kind === "bash-other"; }).slice(0, 10);

  var recommendations = [];
  topFiles.forEach(function(f) {
    if (f.count >= 3) {
      recommendations.push("Consider extracting '" + f.target + "' into a pinned skill (read " + f.count + "x = ~" + f.tokens + " tokens wasted)");
    }
  });
  if (totalCalls >= 30) {
    recommendations.push("Session is heavy on tool use (" + totalCalls + " calls, ~" + totalTokens + " tokens) — consider /clear if switching tasks");
  }
  if (Object.keys(byTarget).length > 0 && totalTokens > 50000) {
    recommendations.push("Estimated bloat ~" + totalTokens + " tokens. Top file alone: " + (topFiles[0] ? topFiles[0].tokens : 0) + " tokens");
  }

  return {
    windowMinutes: opts.windowMinutes || 60,
    totalCalls: totalCalls,
    totalEstimatedTokens: totalTokens,
    byKind: byKind,
    topFiles: topFiles,
    topCommands: topCommands,
    recommendations: recommendations
  };
}

module.exports = { buildAudit: buildAudit, estimateTokens: estimateTokens };
