#!/usr/bin/env node
"use strict";

/**
 * Backing script for the /learn slash command.
 *
 * Reads logs/learn-suggestions.jsonl and produces a human-friendly summary
 * of LLM-fallback suggestions: top categories per model, top keywords per
 * model, and the most recent 10 entries. The user reviews these and decides
 * what to add to config/task-routing.json (typically via a small PR).
 *
 * Usage: node scripts/show-learn-suggestions.js [--json]
 */

var path = require("path");
var learnLog = require("./lib/learn-log");
var learnedConfig = require("./lib/learned-config");
var configModule = require("./lib/config");

var JSON_OUT = process.argv.indexOf("--json") !== -1;
var PROMOTE = process.argv.indexOf("--promote") !== -1;

// --promote mode: emit a diff of what learned-keywords.json would add to
// task-routing.json. The user reviews and applies via PR.
if (PROMOTE) {
  var bc = configModule.loadConfig(process.cwd());
  process.stdout.write(learnedConfig.generatePromoteDiff(bc) + "\n");
  process.exit(0);
}

var summary = learnLog.summarize();

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (summary.totalSuggestions === 0) {
  process.stdout.write([
    "No LLM-fallback suggestions yet.",
    "",
    "The LLM fallback is opt-in. To enable it:",
    "  1. Set ANTHROPIC_API_KEY in your environment",
    "  2. In config/task-routing.json: autoMode.llmFallback.enabled = true",
    "  3. Restart Claude Code",
    "",
    "Once enabled, every prompt that the deterministic scorer can't",
    "classify confidently will be sent to Claude Haiku. The classifications",
    "land in logs/learn-suggestions.jsonl for /learn to review.",
    ""
  ].join("\n"));
  process.exit(0);
}

var lines = [];
lines.push("=== LLM-fallback learn suggestions ===");
lines.push("");
lines.push("Total suggestions logged: " + summary.totalSuggestions);
lines.push("By model: haiku=" + summary.byModel.haiku +
           ", sonnet=" + summary.byModel.sonnet +
           ", opus=" + summary.byModel.opus);

// Show how many keywords have been auto-applied to learned-keywords.json
var learned = learnedConfig.load();
if (learned) {
  var totalLearned = 0;
  if (learned.models) {
    Object.values(learned.models).forEach(function(m) {
      if (m.categories) Object.values(m.categories).forEach(function(c) {
        totalLearned += (c.keywords || []).length;
      });
    });
  }
  if (learned.translations) {
    Object.values(learned.translations).forEach(function(langCats) {
      Object.values(langCats).forEach(function(arr) {
        if (Array.isArray(arr)) totalLearned += arr.length;
      });
    });
  }
  lines.push("Auto-applied to learned-keywords.json: " + totalLearned + " keyword(s)");
  lines.push("  (run with --promote to see what would migrate to task-routing.json)");
}
lines.push("");

if (summary.topCategories.length > 0) {
  lines.push("Top categories suggested by LLM (consider adding to task-routing.json):");
  summary.topCategories.forEach(function(c) {
    lines.push("  [" + c.model + "] " + c.category + " - seen " + c.count + "x");
  });
  lines.push("");
}

if (summary.topKeywords.length > 0) {
  lines.push("Top keywords suggested (consider adding to category keyword lists):");
  summary.topKeywords.forEach(function(k) {
    lines.push("  [" + k.model + "] " + k.keyword + " - seen " + k.count + "x");
  });
  lines.push("");
}

lines.push("Most recent 10 suggestions:");
summary.recent.forEach(function(e) {
  var promptShort = (e.prompt || "").substring(0, 60);
  lines.push("  " + e.timestamp + " -> " + e.suggestedModel + " (" + e.suggestedCategory + ")");
  lines.push("    \"" + promptShort + (e.prompt && e.prompt.length > 60 ? "..." : "") + "\"");
  if (e.suggestedKeywords && e.suggestedKeywords.length) {
    lines.push("    keywords: " + e.suggestedKeywords.join(", "));
  }
});
lines.push("");
lines.push("Log file: " + learnLog.getLogPath());
lines.push("To incorporate suggestions: edit config/task-routing.json and add the keywords");
lines.push("under the matching model.categories.<category>.keywords array.");

process.stdout.write(lines.join("\n"));
