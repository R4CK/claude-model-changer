#!/usr/bin/env node
/**
 * stats.js - Usage stats, quality feedback, adaptive weights, savings, tune analysis
 */
"use strict";

var fs = require("fs");
var io = require("./io");
var search = require("./search");

// ---- PATTERNS (B2) ----

function loadPatterns() {
  try {
    var pPath = io.getPatternsPath();
    if (!fs.existsSync(pPath)) return [];
    var data = JSON.parse(fs.readFileSync(pPath, "utf8").replace(/^\uFEFF/, ""));
    return data.patterns || [];
  } catch (err) { return []; }
}

function checkPatterns(promptLower, patterns) {
  if (!patterns || patterns.length === 0) return null;
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    if (p.pattern && typeof p.pattern === "string" && promptLower.includes(p.pattern.toLowerCase())) {
      return { model: p.model, label: p.label || p.pattern, pattern: p.pattern };
    }
  }
  return null;
}

// ---- STATS ----

function calculateSavings(entries, config) {
  var costs = (config && config.costEstimates) ? config.costEstimates : io.CONSTANTS.DEFAULT_COSTS;
  var avgTokens = (config && config.savingsTracking && config.savingsTracking.avgTokensPerTask)
    ? config.savingsTracking.avgTokensPerTask : io.CONSTANTS.AVG_TOKENS;

  var actualCost = 0, opusCost = 0;
  entries.forEach(function(e) {
    var model = e.model || "sonnet";
    var tokens = avgTokens[model] || 3000;
    var mc = costs[model] || costs.sonnet;
    var oc = costs.opus;
    var inp = tokens * io.CONSTANTS.TOKEN_INPUT_RATIO, outp = tokens * io.CONSTANTS.TOKEN_OUTPUT_RATIO;
    actualCost += (inp / 1000000) * mc.inputPer1M + (outp / 1000000) * mc.outputPer1M;
    opusCost += (inp / 1000000) * oc.inputPer1M + (outp / 1000000) * oc.outputPer1M;
  });

  return {
    estimatedActualCost: "$" + actualCost.toFixed(4),
    ifAllOpusCost: "$" + opusCost.toFixed(4),
    savedAmount: "$" + (opusCost - actualCost).toFixed(4),
    savedPercentage: opusCost > 0 ? Math.round((1 - actualCost / opusCost) * 100) + "%" : "0%"
  };
}

function getStats(config) {
  try {
    var logPath = io.getLogPath();
    if (!fs.existsSync(logPath)) return null;
    var entries = io.readLogCached(logPath);
    if (entries.length === 0) return null;

    var KNOWN_MODELS = { haiku: true, sonnet: true, opus: true };
    var total = 0;
    var modelCounts = { haiku: 0, sonnet: 0, opus: 0 };
    // v2.7.0: track effort distribution
    var effortCounts = { low: 0, medium: 0, high: 0, none: 0 };
    var categoryCounts = {};
    var autoRouted = 0, borderline = 0, overrides = 0, scoreSum = 0;
    var todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    var weekStart = new Date(Date.now() - io.CONSTANTS.WEEK_MS);
    var todayCount = 0, weekCount = 0;

    entries.forEach(function(e) {
      // Only count entries with a recognized model so percentages always sum to ~100%.
      if (!KNOWN_MODELS[e.model]) return;
      total++;
      modelCounts[e.model]++;
      if (e.category) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
      if (e.autoRouted) autoRouted++;
      if (e.borderline) borderline++;
      if (e.override) overrides++;
      scoreSum += (e.score || 0);
      var ef = e.effort;
      if (ef === "low" || ef === "medium" || ef === "high") effortCounts[ef]++;
      else effortCounts.none++;
      var ts = new Date(e.timestamp);
      if (ts >= todayStart) todayCount++;
      if (ts >= weekStart) weekCount++;
    });

    var topCategories = Object.entries(categoryCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
    var savings = calculateSavings(entries, config);
    var quality = getQualityStats();

    // Percentage of entries where effort was emitted (any level)
    var effortEmitted = effortCounts.low + effortCounts.medium + effortCounts.high;

    return {
      total: total, today: todayCount, thisWeek: weekCount,
      models: modelCounts,
      modelPercentages: {
        haiku: total > 0 ? Math.round(modelCounts.haiku / total * 100) : 0,
        sonnet: total > 0 ? Math.round(modelCounts.sonnet / total * 100) : 0,
        opus: total > 0 ? Math.round(modelCounts.opus / total * 100) : 0
      },
      effortCounts: effortCounts,
      effortPercentages: {
        low: effortEmitted > 0 ? Math.round(effortCounts.low / effortEmitted * 100) : 0,
        medium: effortEmitted > 0 ? Math.round(effortCounts.medium / effortEmitted * 100) : 0,
        high: effortEmitted > 0 ? Math.round(effortCounts.high / effortEmitted * 100) : 0
      },
      avgScore: total > 0 ? (scoreSum / total).toFixed(1) : "0.0",
      autoRouted: autoRouted, borderline: borderline, overrides: overrides,
      topCategories: topCategories, savings: savings, quality: quality
    };
  } catch (err) { return null; }
}

// ---- TUNE ANALYSIS ----

function getTuneAnalysis() {
  try {
    var overridePath = io.getOverrideLogPath();
    if (!fs.existsSync(overridePath)) return null;
    var entries = io.readLogCached(overridePath);
    if (entries.length < 3) return { message: "Need at least 3 override records. Currently: " + entries.length };

    var categoryOverrides = {};
    entries.forEach(function(e) {
      var key = e.category || "unknown";
      if (!categoryOverrides[key]) { categoryOverrides[key] = { upCount: 0, downCount: 0, fromModel: {}, toModel: {} }; }
      var fromScore = { haiku: 1, sonnet: 2, opus: 3 }[e.recommendedModel] || 2;
      var toScore = { haiku: 1, sonnet: 2, opus: 3 }[e.chosenModel] || 2;
      // v3.6.2: ignore same-tier overrides (toScore === fromScore). Previously
      // an equal-score override (e.g. a sonnet→sonnet re-log) was lumped into
      // downCount, inflating the downgrade signal and skewing /tune suggestions.
      if (toScore > fromScore) categoryOverrides[key].upCount++;
      else if (toScore < fromScore) categoryOverrides[key].downCount++;
      categoryOverrides[key].fromModel[e.recommendedModel] = (categoryOverrides[key].fromModel[e.recommendedModel] || 0) + 1;
      categoryOverrides[key].toModel[e.chosenModel] = (categoryOverrides[key].toModel[e.chosenModel] || 0) + 1;
    });

    var suggestions = [];
    Object.entries(categoryOverrides).forEach(function(pair) {
      var cat = pair[0], data = pair[1];
      var totalOverrides = data.upCount + data.downCount;
      if (totalOverrides < 2) return;
      var sortedModels = Object.entries(data.toModel).sort(function(a, b) { return b[1] - a[1]; });
      var topModel = sortedModels.length > 0 ? sortedModels[0][0] : null;
      if (!topModel) return;
      if (data.upCount > data.downCount * 2) {
        suggestions.push({ category: cat, action: "UPGRADE", reason: "Overridden upward " + data.upCount + "/" + totalOverrides + " times", suggestion: "Move \"" + cat + "\" to " + topModel });
      } else if (data.downCount > data.upCount * 2) {
        suggestions.push({ category: cat, action: "DOWNGRADE", reason: "Overridden downward " + data.downCount + "/" + totalOverrides + " times", suggestion: "Move \"" + cat + "\" to " + topModel });
      }
    });

    return {
      totalOverrides: entries.length, categoryBreakdown: categoryOverrides, suggestions: suggestions,
      message: suggestions.length > 0
        ? suggestions.length + " tuning suggestion(s) from " + entries.length + " overrides"
        : "No strong patterns from " + entries.length + " overrides"
    };
  } catch (err) { return null; }
}

// ---- QUALITY FEEDBACK (B3) ----

function getQualityStats() {
  try {
    var qPath = io.getQualityLogPath();
    if (!fs.existsSync(qPath)) return null;
    var entries = io.readLogCached(qPath);
    if (entries.length === 0) return null;

    var modelRatings = {}, categoryRatings = {};
    entries.forEach(function(e) {
      // v3.6.2: guard against malformed ratings. A single non-numeric rating
      // (undefined/string/null in the quality log) would otherwise make
      // sum = NaN and poison every downstream average via toFixed().
      var rating = Number(e.rating);
      if (!isFinite(rating)) return;
      var m = e.model || "unknown";
      if (!modelRatings[m]) modelRatings[m] = { sum: 0, count: 0 };
      modelRatings[m].sum += rating;
      modelRatings[m].count++;
      var key = m + ":" + (e.category || "unknown");
      if (!categoryRatings[key]) categoryRatings[key] = { sum: 0, count: 0, model: m, category: e.category };
      categoryRatings[key].sum += rating;
      categoryRatings[key].count++;
    });

    var modelAvg = {};
    Object.keys(modelRatings).forEach(function(m) {
      var r = modelRatings[m];
      modelAvg[m] = { avg: r.count > 0 ? (r.sum / r.count).toFixed(1) : "0.0", count: r.count };
    });

    var warnings = [];
    Object.values(categoryRatings).forEach(function(cr) {
      if (cr.count < 3) return;
      var avg = cr.count > 0 ? cr.sum / cr.count : 0;
      if (avg < 2.5) {
        warnings.push({ model: cr.model, category: cr.category, avg: avg.toFixed(1), count: cr.count, action: "Consider upgrading to a higher model" });
      }
    });

    return { modelAverages: modelAvg, warnings: warnings, totalRatings: entries.length };
  } catch (err) { return null; }
}

function getQualityWarning(model, category) {
  var stats = getQualityStats();
  if (!stats || !stats.warnings) return null;
  for (var i = 0; i < stats.warnings.length; i++) {
    var w = stats.warnings[i];
    if (w.model === model && w.category === category) return w;
  }
  return null;
}

// ---- ADAPTIVE WEIGHTS (D1) ----

function getAdaptiveWeights(config) {
  var adaptiveConfig = config && config.adaptiveWeights;
  if (!adaptiveConfig || !adaptiveConfig.enabled) return null;

  var minRatings = (adaptiveConfig && adaptiveConfig.minRatings) || 10;
  var minWeight = (adaptiveConfig && adaptiveConfig.minWeight) || 0.05;
  var maxWeight = (adaptiveConfig && adaptiveConfig.maxWeight) || 0.60;

  try {
    var qPath = io.getQualityLogPath();
    if (!fs.existsSync(qPath)) return null;
    var qualityEntries = io.readLogCached(qPath);
    if (qualityEntries.length < minRatings) return null;

    var logPath = io.getLogPath();
    if (!fs.existsSync(logPath)) return null;
    var usageEntries = io.readLogCached(logPath);

    var signalCorrelations = {
      keyword: { goodSum: 0, badSum: 0, goodCount: 0, badCount: 0 },
      wordCount: { goodSum: 0, badSum: 0, goodCount: 0, badCount: 0 },
      codeBlocks: { goodSum: 0, badSum: 0, goodCount: 0, badCount: 0 },
      multiFile: { goodSum: 0, badSum: 0, goodCount: 0, badCount: 0 },
      structure: { goodSum: 0, badSum: 0, goodCount: 0, badCount: 0 }
    };

    // Pre-index usage entries by timestamp using shared utility
    var scoredIndex = search.prepareTimestampIndex(usageEntries, function(u) { return u.scores && u.timestamp; });

    var matchedCount = 0;
    qualityEntries.forEach(function(q) {
      var qTime = new Date(q.timestamp).getTime();
      var bestMatch = search.findClosestByTimestamp(scoredIndex.sorted, scoredIndex.timestamps, qTime, 60000);
      if (!bestMatch || !bestMatch.scores) return;
      matchedCount++;
      var isGood = q.rating >= 4, isBad = q.rating <= 2;
      Object.keys(signalCorrelations).forEach(function(signal) {
        var val = bestMatch.scores[signal] || 0;
        if (isGood) { signalCorrelations[signal].goodSum += val; signalCorrelations[signal].goodCount++; }
        else if (isBad) { signalCorrelations[signal].badSum += val; signalCorrelations[signal].badCount++; }
      });
    });

    if (matchedCount < minRatings) return null;

    var baseWeights = (config && config.scoring && config.scoring.weights)
      ? config.scoring.weights
      : { keyword: 0.35, multiFile: 0.20, structure: 0.20, wordCount: 0.15, codeBlocks: 0.10 };

    var adjustedWeights = {};
    var totalWeight = 0;

    Object.keys(baseWeights).forEach(function(signal) {
      var corr = signalCorrelations[signal];
      var goodAvg = corr.goodCount > 0 ? corr.goodSum / corr.goodCount : 0;
      var badAvg = corr.badCount > 0 ? corr.badSum / corr.badCount : 0;
      var factor = 1.0;
      if (goodAvg > 0 && badAvg > 0) { factor = 1.0 + ((goodAvg - badAvg) / Math.max(goodAvg, badAvg)) * 0.3; }
      else if (goodAvg > 0) { factor = 1.15; }
      else if (badAvg > 0) { factor = 0.85; }
      adjustedWeights[signal] = Math.max(minWeight, Math.min(maxWeight, baseWeights[signal] * factor));
      totalWeight += adjustedWeights[signal];
    });

    // M5: Normalize then clamp, then re-normalize to ensure sum = 1.0
    // Guard: if totalWeight is 0 or NaN, adaptive weights are unusable
    if (!totalWeight || !isFinite(totalWeight) || totalWeight <= 0) return null;
    if (totalWeight > 0) {
      Object.keys(adjustedWeights).forEach(function(k) {
        adjustedWeights[k] = Math.max(minWeight, Math.min(maxWeight, adjustedWeights[k] / totalWeight));
      });
      // Re-normalize after clamping to guarantee sum = 1.0
      var finalTotal = 0;
      Object.keys(adjustedWeights).forEach(function(k) { finalTotal += adjustedWeights[k]; });
      if (finalTotal > 0 && Math.abs(finalTotal - 1.0) > 0.01) {
        Object.keys(adjustedWeights).forEach(function(k) { adjustedWeights[k] /= finalTotal; });
      }
    }

    return { weights: adjustedWeights, matchedRatings: matchedCount, totalRatings: qualityEntries.length, active: true };
  } catch (err) { return null; }
}

function getAdaptiveStats(config) {
  var adaptive = getAdaptiveWeights(config);
  var baseWeights = (config && config.scoring && config.scoring.weights)
    ? config.scoring.weights
    : { keyword: 0.35, multiFile: 0.20, structure: 0.20, wordCount: 0.15, codeBlocks: 0.10 };

  if (!adaptive) {
    var qPath = io.getQualityLogPath();
    var ratingCount = 0;
    try {
      if (fs.existsSync(qPath)) {
        ratingCount = fs.readFileSync(qPath, "utf8").trim().split("\n").filter(function(l) { return l.length > 0; }).length;
      }
    } catch (e) {}
    var minRequired = (config && config.adaptiveWeights && config.adaptiveWeights.minRatings) || 10;
    return {
      active: false,
      reason: ratingCount < minRequired
        ? "Need " + minRequired + " quality ratings (currently: " + ratingCount + "). Use /rate <1-5> after tasks."
        : "Need usage entries with sub-scores. New entries after v5 upgrade will include them.",
      baseWeights: baseWeights
    };
  }

  var changes = {};
  Object.keys(baseWeights).forEach(function(k) {
    var diff = adaptive.weights[k] - baseWeights[k];
    changes[k] = { base: baseWeights[k].toFixed(3), adaptive: adaptive.weights[k].toFixed(3), change: (diff > 0 ? "+" : "") + diff.toFixed(3) };
  });

  return { active: true, matchedRatings: adaptive.matchedRatings, totalRatings: adaptive.totalRatings, baseWeights: baseWeights, adaptiveWeights: adaptive.weights, changes: changes };
}

// ---- GOAL-BACKWARD VERIFICATION (GSD-inspired) ----

function getAutoTuneSuggestions(config) {
  try {
    var qPath = io.getQualityLogPath();
    if (!fs.existsSync(qPath)) return null;
    var qualityEntries = io.readLogCached(qPath);
    if (qualityEntries.length < 5) return null;

    var logPath = io.getLogPath();
    if (!fs.existsSync(logPath)) return null;
    var usageEntries = io.readLogCached(logPath);

    // Pre-index usage entries using shared utility
    var tuneIndex = search.prepareTimestampIndex(usageEntries, function(u) { return !!u.timestamp; });

    // Build category+model pairs from quality ratings matched to usage entries
    var pairs = {};
    qualityEntries.forEach(function(q) {
      // v3.6.2: skip malformed ratings so a bad log line can't NaN the average.
      var qRating = Number(q.rating);
      if (!isFinite(qRating)) return;
      var qTime = new Date(q.timestamp).getTime();
      var bestMatch = search.findClosestByTimestamp(tuneIndex.sorted, tuneIndex.timestamps, qTime, 120000);
      if (!bestMatch) return;
      var key = (bestMatch.model || "unknown") + ":" + (bestMatch.category || "unknown");
      if (!pairs[key]) pairs[key] = { model: bestMatch.model, category: bestMatch.category, ratings: [], sum: 0 };
      pairs[key].ratings.push(qRating);
      pairs[key].sum += qRating;
    });

    var minRatings = (config && config.goalVerification && config.goalVerification.minRatingsPerPair) || 5;
    var poorThreshold = (config && config.goalVerification && config.goalVerification.poorThreshold) || 2.5;

    var suggestions = [];
    Object.keys(pairs).forEach(function(key) {
      var pair = pairs[key];
      if (pair.ratings.length < minRatings) return;
      var avg = pair.sum / pair.ratings.length;
      if (avg < poorThreshold) {
        var upgrade = pair.model === "haiku" ? "sonnet" : pair.model === "sonnet" ? "opus" : null;
        suggestions.push({
          model: pair.model,
          category: pair.category,
          avgRating: parseFloat(avg.toFixed(1)),
          count: pair.ratings.length,
          suggestion: upgrade
            ? "Consider upgrading \"" + pair.category + "\" from " + pair.model + " to " + upgrade
            : "\"" + pair.category + "\" on " + pair.model + " has low satisfaction (" + avg.toFixed(1) + "/5)"
        });
      }
    });

    return suggestions.length > 0 ? suggestions : null;
  } catch (e) { return null; }
}

module.exports = {
  loadPatterns: loadPatterns,
  checkPatterns: checkPatterns,
  getStats: getStats,
  calculateSavings: calculateSavings,
  getTuneAnalysis: getTuneAnalysis,
  getQualityStats: getQualityStats,
  getQualityWarning: getQualityWarning,
  getAdaptiveWeights: getAdaptiveWeights,
  getAdaptiveStats: getAdaptiveStats,
  getAutoTuneSuggestions: getAutoTuneSuggestions
};
