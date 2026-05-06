#!/usr/bin/env node
/**
 * statusline.js — Custom Claude Code statusline.
 *
 * Wired via ~/.claude/settings.json:
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js\""
 *   }
 *
 * Reads JSON from stdin (Claude Code passes a context blob on every refresh
 * tick) and prints a single status string. Goal: pack model + context% +
 * weekly% + effort + estimated cost into ~40 chars of monospaced text.
 *
 * Output format (default):
 *   🟢 sonnet-med │ ctx 23% │ wk 12% │ ~$0.42/h
 *
 * Customizable via config.statusline:
 *   format:       "compact" (default) | "minimal" | "verbose"
 *   includeCost:  true | false
 *   includeIcon:  true | false (color emoji per model)
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");
var SESSION_FILE = path.join(PLUGIN_ROOT, "logs", "session-state.json");
var USAGE_FILE = path.join(PLUGIN_ROOT, "logs", "usage.jsonl");

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function readJsonl(p) {
  try {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function loadConfig() {
  var c = readJsonSafe(CONFIG_FILE) || {};
  var sl = c.statusline || {};
  return {
    format: sl.format || "compact",
    includeCost: sl.includeCost !== false,
    includeIcon: sl.includeIcon !== false,
    config: c
  };
}

function modelIcon(model) {
  return ({ haiku: "🟢", sonnet: "🟡", opus: "🔴" })[model] || "⚪";
}

function calcSessionCost(state, config) {
  var costs = (config && config.costEstimates) || {};
  var subTokens = 1500; // avg per-prompt response heuristic
  var inputAvg = 800;   // avg user prompt tokens
  var total = 0;
  ["haiku", "sonnet", "opus"].forEach(function(m) {
    var count = (state.modelCounts && state.modelCounts[m]) || 0;
    var c = costs[m];
    if (!c) return;
    var inp = (typeof c.inputPer1M === "number") ? c.inputPer1M : 0;
    var out = (typeof c.outputPer1M === "number") ? c.outputPer1M : 0;
    total += count * (inputAvg * inp + subTokens * out) / 1e6;
  });
  return total;
}

function calcWeeklyPct(config) {
  var entries = readJsonl(USAGE_FILE);
  var weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  var weekly = entries.filter(function(e) {
    return e && e.timestamp && Date.parse(e.timestamp) >= weekAgo;
  }).length;
  var planLimits = (config && config.planLimits) || {};
  var max = planLimits.weeklyAllModels || 200;
  return Math.min(100, Math.round((weekly / max) * 100));
}

function buildStatus(stdinJson, opts) {
  var state = readJsonSafe(SESSION_FILE) || {};
  var lastModel = state.lastModel || "sonnet";
  var icon = opts.includeIcon ? modelIcon(lastModel) + " " : "";

  var ctx = "ctx ?";
  if (state.estimatedTokensUsed && state.estimatedTokensUsed > 0) {
    var maxTokens = 200000;
    var contextWindows = (opts.config && opts.config.contextWindows) || {};
    var modelIds = (opts.config && opts.config.modelIds) || {};
    var lastModelId = modelIds[lastModel] || "";
    var ctxKey = lastModelId.indexOf("[1m]") !== -1 ? lastModel + "-1m" : lastModel;
    if (contextWindows[ctxKey]) maxTokens = contextWindows[ctxKey];
    var pct = Math.round((state.estimatedTokensUsed / maxTokens) * 100);
    ctx = "ctx " + pct + "%";
  }

  var weeklyPct = calcWeeklyPct(opts.config);
  var weekly = "wk " + weeklyPct + "%";

  var parts = [icon + lastModel];

  if (opts.format === "verbose") {
    var promptCount = state.promptCount || 0;
    parts.push(ctx);
    parts.push(weekly);
    parts.push("p=" + promptCount);
    if (opts.includeCost) {
      var cost = calcSessionCost(state, opts.config);
      parts.push("$" + cost.toFixed(2));
    }
  } else if (opts.format === "minimal") {
    parts = [icon + lastModel + " " + ctx];
  } else { // compact (default)
    parts.push(ctx);
    parts.push(weekly);
    if (opts.includeCost) {
      var costC = calcSessionCost(state, opts.config);
      if (costC > 0.001) parts.push("$" + costC.toFixed(2));
    }
  }

  return parts.join(" │ ");
}

function readStdin() {
  return new Promise(function(resolve) {
    var data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function(c) { data += c; });
    process.stdin.on("end", function() { resolve(data); });
    setTimeout(function() { resolve(data); }, 500);
  });
}

if (require.main === module) {
  readStdin().then(function(input) {
    var opts = loadConfig();
    var stdinJson = null;
    try { stdinJson = JSON.parse(input); } catch (e) { /* tolerate */ }
    try {
      var out = buildStatus(stdinJson, opts);
      process.stdout.write(out);
    } catch (e) {
      process.stdout.write("⚪ router");
    }
  });
}

module.exports = { buildStatus: buildStatus };
