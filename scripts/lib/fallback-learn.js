#!/usr/bin/env node
/**
 * fallback-learn.js — Auto-learn from subagent fallback events.
 *
 * When a haiku-worker emits `[FALLBACK:sonnet]`, the v3.0.0 detect-fallback
 * hook logs the event to `logs/fallbacks.jsonl`. Pre-v3.3.0 that log was
 * write-only and never fed back into routing. v3.3.0 closes the loop:
 *
 *   - Read fallbacks.jsonl + usage.jsonl from the last 30 days
 *   - Compute per-category fallback rate (fallback_count / total_count)
 *   - If a category exceeds `fallbackRateThreshold` (default 30%) AND has
 *     enough samples (default ≥ 5), emit a categoryBoost that nudges
 *     scoring upward by `boostPoints` (default 2).
 *   - Cache the result in `logs/fallback-learn.json` for fast lookup.
 *
 * Result: if you find that your "bug_fixing" haiku routes consistently
 * fall back to sonnet, the plugin starts routing them straight to sonnet
 * within a few days, without you touching config.
 *
 * Configurable via `config.fallbackLearning`.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
var FALLBACKS_LOG = path.join(PLUGIN_ROOT, "logs", "fallbacks.jsonl");
var USAGE_LOG = path.join(PLUGIN_ROOT, "logs", "usage.jsonl");
var CACHE_FILE = path.join(PLUGIN_ROOT, "logs", "fallback-learn.json");
var DEFAULT_WINDOW_DAYS = 30;
var DEFAULT_RATE_THRESHOLD = 0.3;
var DEFAULT_MIN_SAMPLES = 5;
var DEFAULT_BOOST_POINTS = 2;
var CACHE_TTL_MS = 6 * 3600 * 1000; // 6h — recompute at most every 6 hours

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

function writeJsonAtomic(file, data) {
  try {
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) { /* swallow */ }
}

function getConfig(config) {
  var fl = (config && config.fallbackLearning) || {};
  return {
    enabled: fl.enabled !== false,
    windowDays: typeof fl.windowDays === "number" ? fl.windowDays : DEFAULT_WINDOW_DAYS,
    rateThreshold: typeof fl.rateThreshold === "number" ? fl.rateThreshold : DEFAULT_RATE_THRESHOLD,
    minSamples: typeof fl.minSamples === "number" ? fl.minSamples : DEFAULT_MIN_SAMPLES,
    boostPoints: typeof fl.boostPoints === "number" ? fl.boostPoints : DEFAULT_BOOST_POINTS
  };
}

// Compute per-category fallback rates over the configured window.
function compute(config) {
  var cfg = getConfig(config);
  if (!cfg.enabled) return { boosts: {}, summary: { reason: "disabled" } };

  var cutoff = Date.now() - cfg.windowDays * 24 * 3600 * 1000;
  var fallbacks = readJsonl(FALLBACKS_LOG).filter(function(e) {
    return e && e.timestamp && Date.parse(e.timestamp) >= cutoff;
  });
  var usage = readJsonl(USAGE_LOG).filter(function(e) {
    return e && e.timestamp && Date.parse(e.timestamp) >= cutoff;
  });

  // Group fallbacks by category
  var fbByCat = {};
  fallbacks.forEach(function(e) {
    var cat = e.category || e.fromCategory || "unknown";
    fbByCat[cat] = (fbByCat[cat] || 0) + 1;
  });

  // Group all usage by category
  var usageByCat = {};
  usage.forEach(function(e) {
    var cat = e.category || "unknown";
    usageByCat[cat] = (usageByCat[cat] || 0) + 1;
  });

  // Compute rates and decide boosts
  var boosts = {};
  var summary = { categories: {}, totalBoosted: 0, threshold: cfg.rateThreshold };
  Object.keys(fbByCat).forEach(function(cat) {
    if (cat === "unknown") return;
    var total = usageByCat[cat] || fbByCat[cat];
    var rate = fbByCat[cat] / total;
    var samples = total;
    var detail = { rate: rate, fallbacks: fbByCat[cat], total: samples };
    summary.categories[cat] = detail;
    if (samples >= cfg.minSamples && rate >= cfg.rateThreshold) {
      boosts[cat] = cfg.boostPoints;
      detail.boosted = true;
      summary.totalBoosted++;
    }
  });

  return { boosts: boosts, summary: summary, computedAt: new Date().toISOString() };
}

// Cached read with TTL: if the cache is fresh (< 6h old), use it; otherwise
// recompute. The hook calls this on every prompt, so caching matters.
function getBoosts(config) {
  var cfg = getConfig(config);
  if (!cfg.enabled) return {};
  var cached = readJsonSafe(CACHE_FILE);
  if (cached && cached.computedAt) {
    var age = Date.now() - Date.parse(cached.computedAt);
    if (age < CACHE_TTL_MS) return cached.boosts || {};
  }
  var fresh = compute(config);
  writeJsonAtomic(CACHE_FILE, fresh);
  return fresh.boosts || {};
}

// For /tune and similar commands — full report (not cached).
function getReport(config) {
  return compute(config);
}

// Apply a boost to a sub-score result. Returns the boost applied (0 if none).
function applyBoost(matchedCategoryKey, scoreObject, config) {
  if (!matchedCategoryKey) return 0;
  var boosts = getBoosts(config);
  var boost = boosts[matchedCategoryKey] || 0;
  if (boost > 0 && scoreObject && typeof scoreObject.score === "number") {
    scoreObject.score = Math.min(10, scoreObject.score + boost);
    scoreObject.fallbackBoost = boost;
  }
  return boost;
}

module.exports = {
  compute: compute,
  getBoosts: getBoosts,
  getReport: getReport,
  applyBoost: applyBoost,
  getConfig: getConfig
};
