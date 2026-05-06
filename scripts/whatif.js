#!/usr/bin/env node
/**
 * whatif.js — Replay recent prompts under a hypothetical config change to
 * see what would have changed, before you actually commit the edit.
 *
 * Usage:
 *   node scripts/whatif.js move <keyword> <fromModel> <toModel>
 *   node scripts/whatif.js threshold <model> <newRange>
 *   node scripts/whatif.js add-keyword <model> <category> <keyword>
 *   node scripts/whatif.js disable <feature>
 *   node scripts/whatif.js --json                   (machine-readable)
 *
 * Examples:
 *   node scripts/whatif.js move "refactor" sonnet opus
 *   node scripts/whatif.js threshold opus "[7,10]"
 *   node scripts/whatif.js add-keyword sonnet bug_fixing "investigate timeout"
 *   node scripts/whatif.js disable quotaAware
 *
 * The simulator:
 *   1. Loads the current config + last N prompts from logs/usage.jsonl
 *   2. Mutates a deep-copy of the config per the requested change
 *   3. Replays each prompt's text through analyze-complexity (in-process,
 *      not via spawn) under both the current and modified configs
 *   4. Reports: count of routing changes, predicted cost delta, sample
 *      changed prompts
 *
 * NEVER writes to the actual config — strictly read-only preview.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");
var USAGE_LOG = path.join(PLUGIN_ROOT, "logs", "usage.jsonl");
var DEFAULT_REPLAY_LIMIT = 500;

var configMod = require("./lib/config");
var scoring = require("./lib/scoring");

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

// Deep clone via JSON round-trip — fine for config (no functions/dates).
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Apply a change spec to a cloned config. Returns { config, description }.
function applyChange(config, args) {
  var op = args[0];
  if (op === "move") {
    var keyword = args[1], fromModel = args[2], toModel = args[3];
    if (!keyword || !fromModel || !toModel) throw new Error("Usage: move <keyword> <fromModel> <toModel>");
    var moved = false;
    Object.keys((config.models[fromModel] || {}).categories || {}).forEach(function(catKey) {
      var kws = config.models[fromModel].categories[catKey].keywords || [];
      var idx = kws.indexOf(keyword);
      if (idx !== -1) {
        kws.splice(idx, 1);
        // Add to first category of toModel
        var toCats = config.models[toModel].categories || {};
        var firstCat = Object.keys(toCats)[0];
        if (firstCat) {
          toCats[firstCat].keywords = toCats[firstCat].keywords || [];
          toCats[firstCat].keywords.push(keyword);
          moved = true;
        }
      }
    });
    if (!moved) throw new Error("Keyword '" + keyword + "' not found in " + fromModel + " categories");
    return "Moved '" + keyword + "' from " + fromModel + " to " + toModel;
  } else if (op === "threshold") {
    var model = args[1], rangeStr = args[2];
    if (!model || !rangeStr) throw new Error("Usage: threshold <model> '[low,high]'");
    var range = JSON.parse(rangeStr);
    if (!Array.isArray(range) || range.length !== 2) throw new Error("Range must be [low, high]");
    config.models[model].scoreRange = range;
    return "Set " + model + " scoreRange to " + JSON.stringify(range);
  } else if (op === "add-keyword") {
    var modelA = args[1], catA = args[2], kw = args.slice(3).join(" ");
    if (!modelA || !catA || !kw) throw new Error("Usage: add-keyword <model> <category> <keyword>");
    config.models[modelA].categories[catA] = config.models[modelA].categories[catA] || { keywords: [] };
    config.models[modelA].categories[catA].keywords = config.models[modelA].categories[catA].keywords || [];
    config.models[modelA].categories[catA].keywords.push(kw);
    return "Added '" + kw + "' to " + modelA + "." + catA;
  } else if (op === "disable") {
    var feature = args[1];
    if (!feature) throw new Error("Usage: disable <featureName>");
    if (!config[feature]) throw new Error("Unknown feature block: " + feature);
    config[feature].enabled = false;
    return "Disabled " + feature;
  } else if (op === "enable") {
    var feature2 = args[1];
    if (!feature2) throw new Error("Usage: enable <featureName>");
    config[feature2] = config[feature2] || {};
    config[feature2].enabled = true;
    return "Enabled " + feature2;
  }
  throw new Error("Unknown op '" + op + "'. Try: move | threshold | add-keyword | disable | enable");
}

// Approximate the routing decision for a single prompt under the given
// config. We use scoring.scoreKeywordsMultiLang + the model.scoreRange map
// — this is the v3.x core path without all the side-effect-laden override
// stack (skill triggers, agent teams, quota, etc. depend on session state
// that we can't simulate reliably in batch mode).
function quickRoute(prompt, config) {
  if (!prompt) return { model: "unknown", score: 0 };
  var promptLower = prompt.toLowerCase();
  var lang = scoring.detectLanguage(prompt);
  var kw = scoring.scoreKeywordsMultiLang(promptLower, config, lang);
  var score = kw.score;
  if (score === 0) score = 4; // default-ish for unmatched
  // Resolve model from scoreRange
  var model = "sonnet", level = "MEDIUM";
  if (config.models) {
    if (config.models.haiku && score >= config.models.haiku.scoreRange[0] && score <= config.models.haiku.scoreRange[1]) { model = "haiku"; level = "SIMPLE"; }
    else if (config.models.sonnet && score >= config.models.sonnet.scoreRange[0] && score <= config.models.sonnet.scoreRange[1]) { model = "sonnet"; level = "MEDIUM"; }
    else { model = "opus"; level = "COMPLEX"; }
  }
  return { model: model, score: score, category: kw.matchedCategory || "none", level: level };
}

// Cost per prompt — rough estimate: 800 input + 1500 output tokens.
function costFor(model, config) {
  var c = (config && config.costEstimates && config.costEstimates[model]) || {};
  var inp = typeof c.inputPer1M === "number" ? c.inputPer1M : 0;
  var out = typeof c.outputPer1M === "number" ? c.outputPer1M : 0;
  return (800 * inp + 1500 * out) / 1e6;
}

function run(args, opts) {
  opts = opts || {};
  var cwd = opts.cwd || process.cwd();
  var baseConfig = configMod.loadConfig(cwd);
  if (!baseConfig) throw new Error("Could not load base config");
  var modConfig = clone(baseConfig);
  var description = applyChange(modConfig, args);

  // Replay against last N usage entries (ones with `prompt` field — older
  // entries pre-v2 don't store the prompt, only the category, so they're
  // excluded).
  var entries = readJsonl(USAGE_LOG)
    .filter(function(e) { return e && e.prompt && e.prompt.length > 5; })
    .slice(-DEFAULT_REPLAY_LIMIT);

  if (entries.length === 0) {
    return {
      description: description,
      replayCount: 0,
      message: "No replay-able prompts in usage.jsonl (need entries with `prompt` field). Cast a few prompts and try again."
    };
  }

  var changes = [];
  var costDeltaTotal = 0;
  var beforeCount = { haiku: 0, sonnet: 0, opus: 0 };
  var afterCount = { haiku: 0, sonnet: 0, opus: 0 };
  entries.forEach(function(e) {
    var before = quickRoute(e.prompt, baseConfig);
    var after = quickRoute(e.prompt, modConfig);
    beforeCount[before.model] = (beforeCount[before.model] || 0) + 1;
    afterCount[after.model] = (afterCount[after.model] || 0) + 1;
    if (before.model !== after.model) {
      var costBefore = costFor(before.model, baseConfig);
      var costAfter = costFor(after.model, baseConfig);
      var delta = costAfter - costBefore;
      costDeltaTotal += delta;
      changes.push({
        prompt: e.prompt.slice(0, 80),
        before: before,
        after: after,
        costDelta: delta
      });
    }
  });

  var verdict = costDeltaTotal > 0 ? ("+$" + costDeltaTotal.toFixed(4)) : ("-$" + Math.abs(costDeltaTotal).toFixed(4));

  return {
    description: description,
    replayCount: entries.length,
    changedCount: changes.length,
    changedPercent: Math.round((changes.length / entries.length) * 100),
    distributionBefore: beforeCount,
    distributionAfter: afterCount,
    costDeltaPerReplay: costDeltaTotal.toFixed(4),
    costDeltaWeeklyEstimate: (costDeltaTotal * (entries.length > 0 ? 200 / entries.length : 0)).toFixed(2),
    verdict: verdict,
    sampleChanges: changes.slice(0, 10)
  };
}

function formatReport(report) {
  var lines = [];
  lines.push("=== /whatif simulator ===");
  lines.push("Change: " + report.description);
  lines.push("");
  if (report.message) {
    lines.push("⚠ " + report.message);
    return lines.join("\n");
  }
  lines.push("Replayed: " + report.replayCount + " prompts");
  lines.push("Changed:  " + report.changedCount + " (" + report.changedPercent + "%)");
  lines.push("Cost delta: " + report.verdict + " across replay (≈ $" + report.costDeltaWeeklyEstimate + " / week extrapolated)");
  lines.push("");
  lines.push("Distribution:");
  ["haiku", "sonnet", "opus"].forEach(function(m) {
    var b = report.distributionBefore[m] || 0;
    var a = report.distributionAfter[m] || 0;
    var arrow = a > b ? "↑" : (a < b ? "↓" : "·");
    lines.push("  " + m + ": " + b + " → " + a + " " + arrow);
  });
  if (report.sampleChanges.length > 0) {
    lines.push("");
    lines.push("Sample changed routings (top 10):");
    report.sampleChanges.forEach(function(c, i) {
      lines.push("  " + (i + 1) + ". \"" + c.prompt + "...\"");
      lines.push("     " + c.before.model + " (score " + c.before.score + ", " + c.before.category + ") → " + c.after.model + " (score " + c.after.score + ", " + c.after.category + ")");
    });
  }
  return lines.join("\n");
}

if (require.main === module) {
  var argv = process.argv.slice(2);
  var jsonOut = argv.indexOf("--json") !== -1;
  argv = argv.filter(function(a) { return a !== "--json"; });
  if (argv.length === 0) {
    console.log("Usage: node whatif.js <op> [args...]");
    console.log("  move <keyword> <fromModel> <toModel>");
    console.log("  threshold <model> '[low,high]'");
    console.log("  add-keyword <model> <category> <keyword>");
    console.log("  disable <featureName>");
    console.log("  enable <featureName>");
    process.exit(1);
  }
  try {
    var report = run(argv);
    if (jsonOut) process.stdout.write(JSON.stringify(report, null, 2));
    else process.stdout.write(formatReport(report) + "\n");
  } catch (e) {
    console.error("ERROR: " + e.message);
    process.exit(1);
  }
}

module.exports = { run: run, formatReport: formatReport, applyChange: applyChange, quickRoute: quickRoute };
