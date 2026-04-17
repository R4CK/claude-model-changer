"use strict";

/**
 * Learn-suggestions log: append-only JSONL file storing every LLM-fallback
 * classification, so /learn can review them and propose config additions.
 *
 * Each line: { timestamp, prompt, suggestedCategory, suggestedKeywords,
 *              suggestedModel, llmConfidence, llmModel, latencyMs }
 *
 * Reviewed via the /learn slash command.
 */

var fs = require("fs");
var path = require("path");

var LOG_FILENAME = "learn-suggestions.jsonl";
var MAX_ENTRIES = 500;
var MAX_PROMPT_PREVIEW = 200;

function getLogPath() {
  return path.join(__dirname, "..", "..", "logs", LOG_FILENAME);
}

function ensureLogsDir() {
  var dir = path.dirname(getLogPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendSuggestion(entry) {
  try {
    ensureLogsDir();
    var record = {
      timestamp: new Date().toISOString(),
      prompt: (entry.prompt || "").substring(0, MAX_PROMPT_PREVIEW).replace(/\n/g, " "),
      suggestedCategory: entry.suggestedCategory || "",
      suggestedKeywords: Array.isArray(entry.suggestedKeywords) ? entry.suggestedKeywords : [],
      suggestedModel: entry.suggestedModel || "",
      lang: entry.lang || "en",
      llmConfidence: typeof entry.llmConfidence === "number" ? entry.llmConfidence : null,
      llmModel: entry.llmModel || "",
      latencyMs: typeof entry.latencyMs === "number" ? entry.latencyMs : null
    };
    fs.appendFileSync(getLogPath(), JSON.stringify(record) + "\n", "utf8");
    trim();
  } catch (e) {
    // Silent fail; this is logging, not critical
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
    return { totalSuggestions: 0, byModel: {}, byCategory: {}, topKeywords: [], recent: [] };
  }

  var byModel = { haiku: 0, sonnet: 0, opus: 0 };
  var byCategory = {};
  var keywordCounts = {};

  entries.forEach(function(e) {
    if (e.suggestedModel) byModel[e.suggestedModel] = (byModel[e.suggestedModel] || 0) + 1;
    if (e.suggestedCategory) {
      var key = e.suggestedModel + ":" + e.suggestedCategory;
      byCategory[key] = (byCategory[key] || 0) + 1;
    }
    (e.suggestedKeywords || []).forEach(function(kw) {
      var k = e.suggestedModel + ":" + kw;
      keywordCounts[k] = (keywordCounts[k] || 0) + 1;
    });
  });

  var topKeywords = Object.entries(keywordCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 20)
    .map(function(pair) {
      var parts = pair[0].split(":");
      return { model: parts[0], keyword: parts.slice(1).join(":"), count: pair[1] };
    });

  var topCategories = Object.entries(byCategory)
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 10)
    .map(function(pair) {
      var parts = pair[0].split(":");
      return { model: parts[0], category: parts.slice(1).join(":"), count: pair[1] };
    });

  return {
    totalSuggestions: entries.length,
    byModel: byModel,
    topCategories: topCategories,
    topKeywords: topKeywords,
    recent: entries.slice(-10)
  };
}

module.exports = {
  appendSuggestion: appendSuggestion,
  readAll: readAll,
  summarize: summarize,
  getLogPath: getLogPath
};
