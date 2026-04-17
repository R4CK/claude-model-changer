#!/usr/bin/env node
/**
 * benchmark-cache.js - Cache and query benchmark results per category
 *
 * Stores model performance data from /benchmark runs so future routing
 * can consider which model performed best for a given category.
 */
"use strict";

var fs = require("fs");
var io = require("./io");

var CACHE_PATH = io.getBenchmarkLogPath();

/**
 * Save a benchmark result for a category.
 * @param {string} category - Task category
 * @param {Object} results - { haiku: {time, quality, tokens}, sonnet: {...}, opus: {...} }
 */
function saveBenchmarkResult(category, results) {
  try {
    io.ensureLogDir();
    var entry = {
      timestamp: new Date().toISOString(),
      category: category,
      results: results
    };
    fs.appendFileSync(CACHE_PATH, JSON.stringify(entry) + "\n");
  } catch (e) {}
}

/**
 * Get the best model for a category based on cached benchmark data.
 * Returns null if no benchmark data exists for this category.
 * @param {string} category
 * @returns {{ model: string, reason: string, benchmarkCount: number }|null}
 */
function getBestModelForCategory(category) {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    var entries = io.readLogCached(CACHE_PATH);
    var categoryEntries = entries.filter(function(e) { return e.category === category; });
    if (categoryEntries.length === 0) return null;

    // Aggregate scores: quality * 0.7 + speed * 0.3 (lower time = better)
    var modelScores = {};
    var models = ["haiku", "sonnet", "opus"];

    categoryEntries.forEach(function(entry) {
      if (!entry.results) return;
      models.forEach(function(m) {
        var r = entry.results[m];
        if (!r) return;
        if (!modelScores[m]) modelScores[m] = { qualitySum: 0, timeSum: 0, count: 0 };
        modelScores[m].qualitySum += (r.quality || 3);
        modelScores[m].timeSum += (r.time || 5000);
        modelScores[m].count++;
      });
    });

    var bestModel = null, bestScore = -1;
    models.forEach(function(m) {
      var ms = modelScores[m];
      if (!ms || ms.count === 0) return;
      var avgQuality = ms.qualitySum / ms.count;
      var avgTime = ms.timeSum / ms.count;
      // Normalize: quality 1-5 -> 0-1, time inverted (max 30s) -> 0-1
      var qualityNorm = (avgQuality - 1) / 4;
      var timeNorm = 1 - Math.min(avgTime / 30000, 1);
      var combined = qualityNorm * 0.7 + timeNorm * 0.3;
      if (combined > bestScore) { bestScore = combined; bestModel = m; }
    });

    if (!bestModel) return null;
    return {
      model: bestModel,
      reason: "Benchmark data (" + categoryEntries.length + " runs) favors " + bestModel,
      benchmarkCount: categoryEntries.length
    };
  } catch (e) { return null; }
}

module.exports = {
  saveBenchmarkResult: saveBenchmarkResult,
  getBestModelForCategory: getBestModelForCategory
};
