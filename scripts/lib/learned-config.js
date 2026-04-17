"use strict";

/**
 * Learned-keywords config: a per-user, gitignored sidecar that the runtime
 * config loader deep-merges INTO task-routing.json.
 *
 * Path: logs/learned-keywords.json
 *
 * Structure mirrors task-routing.json so deepMerge works:
 *   {
 *     "_generated": "auto-applied keywords from LLM-fallback /learn suggestions",
 *     "_lastUpdated": "<iso>",
 *     "models": {
 *       "<model>": {
 *         "categories": {
 *           "<categoryKey>": {
 *             "label": "<Display Label>",
 *             "keywords": ["kw1", "kw2", ...]
 *           }
 *         }
 *       }
 *     },
 *     "translations": {
 *       "hu": { "<categoryKey>": ["szó1", "szó2"] },
 *       "de": { "<categoryKey>": ["wort1"] }
 *     }
 *   }
 *
 * Used by:
 *   - lib/config.js   (deep-merges learned into base config at load time)
 *   - lib/learn-log.js (auto-apply: appends keywords when occurrence threshold met)
 *   - show-learn-suggestions.js (/learn --promote: emits diff vs base)
 */

var fs = require("fs");
var io = require("./io");

function load() {
  var p = io.getLearnedConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    var raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function save(data) {
  try {
    io.ensureLogDir();
    data._lastUpdated = new Date().toISOString();
    if (!data._generated) {
      data._generated = "Auto-applied keywords from LLM-fallback /learn suggestions. Per-user, gitignored. Edit task-routing.json to make changes shareable.";
    }
    fs.writeFileSync(io.getLearnedConfigPath(), JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Add a keyword to the learned config.
 *  - lang === "en"  -> models[model].categories[categoryKey].keywords
 *  - lang === "hu"  -> translations.hu[categoryKey]
 *  - lang === "de"  -> translations.de[categoryKey]
 *
 * Returns true if a NEW keyword was added, false if already present.
 */
function addKeyword(model, categoryKey, lang, label, keyword) {
  if (!model || !categoryKey || !keyword) return false;
  var data = load() || {};
  var added = false;

  if (lang === "en" || !lang) {
    if (!data.models) data.models = {};
    if (!data.models[model]) data.models[model] = { categories: {} };
    if (!data.models[model].categories) data.models[model].categories = {};
    if (!data.models[model].categories[categoryKey]) {
      data.models[model].categories[categoryKey] = {
        label: label || categoryKey,
        keywords: []
      };
    }
    var arr = data.models[model].categories[categoryKey].keywords;
    if (arr.indexOf(keyword) === -1) {
      arr.push(keyword);
      added = true;
    }
  } else {
    if (!data.translations) data.translations = {};
    if (!data.translations[lang]) data.translations[lang] = {};
    if (!Array.isArray(data.translations[lang][categoryKey])) {
      data.translations[lang][categoryKey] = [];
    }
    var tarr = data.translations[lang][categoryKey];
    if (tarr.indexOf(keyword) === -1) {
      tarr.push(keyword);
      added = true;
    }
  }

  if (added) save(data);
  return added;
}

/**
 * Count how many times a (model, category, lang, keyword) combination has
 * appeared in logs/learn-suggestions.jsonl.
 */
function countOccurrences(model, categoryKey, lang, keyword) {
  var learnLog;
  try {
    learnLog = require("./learn-log");
  } catch (e) {
    return 0;
  }
  var entries = learnLog.readAll();
  var lc = (keyword || "").toLowerCase();
  return entries.filter(function(e) {
    if (e.suggestedModel !== model) return false;
    var catKey = (e.suggestedCategory || "").toLowerCase().replace(/\s+/g, "_");
    if (catKey !== categoryKey) return false;
    if ((e.lang || "en") !== (lang || "en")) return false;
    return (e.suggestedKeywords || []).some(function(k) { return (k || "").toLowerCase() === lc; });
  }).length;
}

/**
 * Auto-apply a single suggestion if it meets the configured threshold.
 *
 * Returns array of {keyword, applied} for each keyword in the suggestion.
 */
function tryAutoApply(suggestion, baseConfig) {
  var autoCfg = baseConfig && baseConfig.learn && baseConfig.learn.autoApply;
  if (!autoCfg || !autoCfg.enabled) return [];
  var minOccur = autoCfg.minOccurrences || 5;
  var lang = suggestion.lang || "en";
  var categoryKey = (suggestion.suggestedCategory || "").toLowerCase().replace(/\s+/g, "_");
  if (!categoryKey) return [];

  var results = [];
  (suggestion.suggestedKeywords || []).forEach(function(kw) {
    var count = countOccurrences(suggestion.suggestedModel, categoryKey, lang, kw);
    if (count >= minOccur) {
      var added = addKeyword(suggestion.suggestedModel, categoryKey, lang, suggestion.suggestedCategory, kw);
      if (added) results.push({ keyword: kw, lang: lang, count: count, applied: true });
    }
  });
  return results;
}

/**
 * Generate a human-readable diff showing what /learn-promote would write
 * into task-routing.json. Returns multi-line string or empty.
 *
 * IMPORTANT: ignores the passed-in config (which has learned merged in
 * already) and reads task-routing.json directly to compute a true diff.
 */
function generatePromoteDiff(_ignoredConfig) {
  var learned = load();
  if (!learned) return "(no learned-keywords.json yet)";

  // Load the RAW task-routing.json (not the merged runtime config)
  var baseConfig = null;
  try {
    var rawPath = io.getConfigPath();
    baseConfig = JSON.parse(fs.readFileSync(rawPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return "(could not read task-routing.json: " + e.message + ")";
  }

  var lines = [];
  lines.push("# Diff: keywords learned-keywords.json -> task-routing.json");
  lines.push("# Add these manually (or via PR) to make them shareable.");
  lines.push("");

  if (learned.models) {
    Object.keys(learned.models).forEach(function(model) {
      var cats = (learned.models[model] && learned.models[model].categories) || {};
      Object.keys(cats).forEach(function(catKey) {
        var entry = cats[catKey];
        var existingKeywords = [];
        if (baseConfig && baseConfig.models && baseConfig.models[model] &&
            baseConfig.models[model].categories && baseConfig.models[model].categories[catKey]) {
          existingKeywords = baseConfig.models[model].categories[catKey].keywords || [];
        }
        var newKws = (entry.keywords || []).filter(function(k) { return existingKeywords.indexOf(k) === -1; });
        if (newKws.length === 0) return;
        lines.push('models.' + model + '.categories.' + catKey + ':');
        if (existingKeywords.length === 0) {
          lines.push('  + label: "' + (entry.label || catKey) + '"  (NEW CATEGORY)');
        }
        newKws.forEach(function(k) { lines.push('  + keyword: "' + k + '"'); });
        lines.push('');
      });
    });
  }

  if (learned.translations) {
    Object.keys(learned.translations).forEach(function(lang) {
      var langData = learned.translations[lang] || {};
      Object.keys(langData).forEach(function(catKey) {
        var existing = (baseConfig && baseConfig.translations && baseConfig.translations[lang] && baseConfig.translations[lang][catKey]) || [];
        var newKws = (langData[catKey] || []).filter(function(k) { return existing.indexOf(k) === -1; });
        if (newKws.length === 0) return;
        lines.push('translations.' + lang + '.' + catKey + ':');
        newKws.forEach(function(k) { lines.push('  + "' + k + '"'); });
        lines.push('');
      });
    });
  }

  if (lines.length <= 3) {
    return "(learned keywords are already in task-routing.json - nothing to promote)";
  }
  return lines.join("\n");
}

module.exports = {
  load: load,
  save: save,
  addKeyword: addKeyword,
  countOccurrences: countOccurrences,
  tryAutoApply: tryAutoApply,
  generatePromoteDiff: generatePromoteDiff
};
