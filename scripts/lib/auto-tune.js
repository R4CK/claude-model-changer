#!/usr/bin/env node
/**
 * auto-tune.js - Automated routing logic refinement
 *
 * Two self-learning mechanisms:
 *   1. Category auto-reclassification: If a category is consistently overridden
 *      to a different model (80%+ of overrides in the same direction), automatically
 *      move the category to the dominant model in the config.
 *   2. Keyword auto-discovery: Analyze prompt history to find frequently occurring
 *      words/phrases that consistently route to a specific model but aren't yet
 *      in the keyword config. Suggests adding them.
 */
"use strict";

var fs = require("fs");
var io = require("./io");

// ---- CATEGORY AUTO-RECLASSIFICATION ----

/**
 * Analyze override history and return categories that should be reclassified.
 * A category qualifies when:
 *   - It has 5+ overrides total
 *   - 80%+ of overrides point to the same target model
 *   - The target model differs from the current config assignment
 *
 * @param {Object} config - Current task-routing config
 * @returns {Array<{category, currentModel, targetModel, overrideCount, percentage, applied}>}
 */
function getCategoryReclassifications(config) {
  try {
    var overridePath = io.getOverrideLogPath();
    if (!fs.existsSync(overridePath)) return [];
    var entries = io.readLogCached(overridePath);
    if (entries.length < 5) return [];

    // Build override map per category
    var catMap = {};
    entries.forEach(function(e) {
      var cat = e.category || "unknown";
      if (cat === "unknown" || cat === "Manual override") return;
      if (!catMap[cat]) catMap[cat] = { total: 0, toModel: {} };
      catMap[cat].total++;
      var target = e.chosenModel || "sonnet";
      catMap[cat].toModel[target] = (catMap[cat].toModel[target] || 0) + 1;
    });

    // Find current model assignment for each category
    var currentAssignment = {};
    if (config && config.models) {
      ["haiku", "sonnet", "opus"].forEach(function(model) {
        var modelDef = config.models[model];
        if (modelDef && modelDef.categories) {
          Object.keys(modelDef.categories).forEach(function(catKey) {
            var label = modelDef.categories[catKey].label || catKey;
            currentAssignment[label] = model;
            currentAssignment[catKey] = model;
          });
        }
      });
    }

    var reclassifications = [];
    Object.keys(catMap).forEach(function(cat) {
      var data = catMap[cat];
      if (data.total < 5) return;

      // Find dominant target model
      var bestTarget = null, bestCount = 0;
      Object.keys(data.toModel).forEach(function(m) {
        if (data.toModel[m] > bestCount) { bestCount = data.toModel[m]; bestTarget = m; }
      });

      if (!bestTarget) return;
      var pct = Math.round((bestCount / data.total) * 100);
      if (pct < 80) return;

      var current = currentAssignment[cat] || "unknown";
      if (current === bestTarget) return; // already correct

      reclassifications.push({
        category: cat,
        currentModel: current,
        targetModel: bestTarget,
        overrideCount: data.total,
        percentage: pct,
        applied: false
      });
    });

    return reclassifications;
  } catch (e) { return []; }
}

/**
 * Apply category reclassifications to the config.
 * Moves category definitions from one model to another.
 *
 * @param {Object} config - Mutable config object
 * @param {Array} reclassifications - From getCategoryReclassifications
 * @returns {number} Number of categories moved
 */
function applyReclassifications(config, reclassifications) {
  if (!config || !config.models || !reclassifications || reclassifications.length === 0) return 0;

  var moved = 0;
  reclassifications.forEach(function(r) {
    // Find the category key in the source model
    var sourceModel = config.models[r.currentModel];
    if (!sourceModel || !sourceModel.categories) return;

    var catKey = null;
    Object.keys(sourceModel.categories).forEach(function(key) {
      var label = sourceModel.categories[key].label || key;
      if (label === r.category || key === r.category) catKey = key;
    });

    if (!catKey) return;

    // Move category to target model
    var targetModel = config.models[r.targetModel];
    if (!targetModel) return;
    if (!targetModel.categories) targetModel.categories = {};

    targetModel.categories[catKey] = sourceModel.categories[catKey];
    delete sourceModel.categories[catKey];
    r.applied = true;
    moved++;
  });

  return moved;
}

// ---- KEYWORD AUTO-DISCOVERY ----

/**
 * Analyze prompt history to discover frequently-used words/phrases
 * that consistently map to a specific model but aren't yet in the config keywords.
 *
 * Algorithm:
 *   1. Collect all prompt previews from usage.jsonl
 *   2. Extract 2-3 word ngrams from each prompt
 *   3. Group ngrams by model assignment
 *   4. Filter: ngram appears 5+ times, 80%+ for one model
 *   5. Exclude ngrams already in config keywords
 *   6. Return as suggestions
 *
 * @param {Object} config - Current task-routing config
 * @returns {Array<{ngram, model, count, percentage, suggestedCategory}>}
 */
function discoverKeywords(config) {
  try {
    var logPath = io.getLogPath();
    if (!fs.existsSync(logPath)) return [];
    var entries = io.readLogCached(logPath);
    if (entries.length < 20) return []; // need enough data

    // Collect existing keywords for exclusion
    var existingKeywords = {};
    if (config && config.models) {
      ["haiku", "sonnet", "opus"].forEach(function(model) {
        var modelDef = config.models[model];
        if (modelDef && modelDef.categories) {
          Object.values(modelDef.categories).forEach(function(catDef) {
            if (catDef.keywords) {
              catDef.keywords.forEach(function(kw) {
                existingKeywords[kw.toLowerCase()] = true;
              });
            }
          });
        }
      });
    }

    // Stop words to exclude from ngrams
    var stopWords = {
      "the": 1, "a": 1, "an": 1, "is": 1, "are": 1, "was": 1, "were": 1,
      "in": 1, "on": 1, "at": 1, "to": 1, "for": 1, "of": 1, "with": 1,
      "and": 1, "or": 1, "but": 1, "not": 1, "this": 1, "that": 1,
      "it": 1, "its": 1, "my": 1, "i": 1, "me": 1, "we": 1, "you": 1,
      "from": 1, "by": 1, "as": 1, "be": 1, "do": 1, "if": 1, "so": 1
    };

    // Extract ngrams from prompt previews
    var ngramModelCounts = {}; // ngram -> { haiku: N, sonnet: N, opus: N }

    entries.forEach(function(e) {
      if (!e.promptPreview || !e.model) return;
      var words = e.promptPreview.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter(function(w) { return w.length > 2 && !stopWords[w]; });

      // Generate 2-grams and 3-grams
      for (var i = 0; i < words.length - 1; i++) {
        var bigram = words[i] + " " + words[i + 1];
        if (!ngramModelCounts[bigram]) ngramModelCounts[bigram] = { haiku: 0, sonnet: 0, opus: 0, total: 0 };
        ngramModelCounts[bigram][e.model] = (ngramModelCounts[bigram][e.model] || 0) + 1;
        ngramModelCounts[bigram].total++;

        if (i < words.length - 2) {
          var trigram = bigram + " " + words[i + 2];
          if (!ngramModelCounts[trigram]) ngramModelCounts[trigram] = { haiku: 0, sonnet: 0, opus: 0, total: 0 };
          ngramModelCounts[trigram][e.model] = (ngramModelCounts[trigram][e.model] || 0) + 1;
          ngramModelCounts[trigram].total++;
        }
      }
    });

    // Filter: 5+ occurrences, 80%+ for one model, not already a keyword
    var suggestions = [];
    Object.keys(ngramModelCounts).forEach(function(ngram) {
      if (existingKeywords[ngram]) return;
      var counts = ngramModelCounts[ngram];
      if (counts.total < 5) return;

      var bestModel = null, bestCount = 0;
      ["haiku", "sonnet", "opus"].forEach(function(m) {
        if (counts[m] > bestCount) { bestCount = counts[m]; bestModel = m; }
      });

      if (!bestModel) return;
      var pct = Math.round((bestCount / counts.total) * 100);
      if (pct < 80) return;

      // Suggest a category based on the closest existing keyword
      var suggestedCategory = bestModel === "haiku" ? "Quick tasks"
        : bestModel === "sonnet" ? "Feature work"
        : "Complex tasks";

      suggestions.push({
        ngram: ngram,
        model: bestModel,
        count: counts.total,
        percentage: pct,
        suggestedCategory: suggestedCategory
      });
    });

    // Sort by count descending, limit to top 10
    suggestions.sort(function(a, b) { return b.count - a.count; });
    return suggestions.slice(0, 10);
  } catch (e) { return []; }
}

/**
 * Run the full auto-tune cycle. Returns a report of what was found/applied.
 *
 * @param {Object} config - Current config
 * @param {boolean} dryRun - If true, don't apply changes
 * @returns {Object} Report with reclassifications, keywords, and applied status
 */
function runAutoTune(config, dryRun) {
  var reclassifications = getCategoryReclassifications(config);
  var keywords = discoverKeywords(config);

  var applied = 0;
  if (!dryRun && reclassifications.length > 0) {
    applied = applyReclassifications(config, reclassifications);
    if (applied > 0) {
      // Save updated config
      try {
        fs.writeFileSync(io.getConfigPath(), JSON.stringify(config, null, 2) + "\n");
      } catch (e) {
        process.stderr.write("[Auto-Tune] Config save failed: " + e.message + "\n");
      }
    }
  }

  return {
    reclassifications: reclassifications,
    reclassificationsApplied: applied,
    keywordSuggestions: keywords,
    summary: (reclassifications.length > 0 ? reclassifications.length + " categories eligible for reclassification" + (applied > 0 ? " (" + applied + " applied)" : " (dry run)") : "No reclassifications needed") +
      "; " + (keywords.length > 0 ? keywords.length + " keyword suggestions found" : "No new keywords discovered")
  };
}

module.exports = {
  getCategoryReclassifications: getCategoryReclassifications,
  applyReclassifications: applyReclassifications,
  discoverKeywords: discoverKeywords,
  runAutoTune: runAutoTune
};
