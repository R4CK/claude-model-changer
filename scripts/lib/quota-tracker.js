#!/usr/bin/env node
/**
 * quota-tracker.js — Weekly + 5-hour rolling quota tracking.
 *
 * Claude Code Pro/Max plans enforce two limits:
 *   1. A 5-hour rolling burst window (auto-resets every 5h)
 *   2. A 7-day weekly ceiling (auto-resets weekly)
 *
 * The plugin can't read Anthropic's actual quota state (no API for it), but
 * it CAN track its own routing decisions over the past 5h / 7d windows and
 * compare against the user-configured `planLimits` block. When pressure
 * crosses a threshold, we downgrade opus → sonnet automatically and surface
 * a warning.
 *
 * Source of truth: logs/usage.jsonl (already populated by analyze-complexity).
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
var USAGE_FILE = path.join(PLUGIN_ROOT, "logs", "usage.jsonl");

function readJsonl(p) {
  try {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// Window-bounded counts, separated by model.
function windowCounts(entries, windowMs) {
  var cutoff = Date.now() - windowMs;
  var counts = { haiku: 0, sonnet: 0, opus: 0, all: 0 };
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || !e.timestamp) continue;
    var t = Date.parse(e.timestamp);
    if (isNaN(t) || t < cutoff) continue;
    var m = e.model || "unknown";
    if (counts[m] !== undefined) counts[m]++;
    counts.all++;
  }
  return counts;
}

// Returns:
//  {
//    weekly: { haiku, sonnet, opus, all }, weeklyPct: 0..100,
//    burst:  { haiku, sonnet, opus, all }, burstPct: 0..100,
//    pressure: { opus: 0..1, sonnet: 0..1, all: 0..1 },
//    overWeeklyOpus: bool, overBurstAll: bool
//  }
// Hot-path cache: getQuotaState runs on every prompt and otherwise re-reads +
// fully parses usage.jsonl (up to MAX_USAGE_ENTRIES lines) each time. Cache the
// computed state keyed by the usage file's mtime+size signature so repeated
// calls within a prompt — and across prompts until the log changes — are free.
// The window math uses Date.now(), so we also expire after a short TTL to keep
// the rolling 5h/weekly cutoffs honest even when the file hasn't changed.
var _quotaCache = null; // { sig, planSig, state, at }
var _QUOTA_TTL_MS = 60 * 1000;

function _usageSignature() {
  try {
    var st = fs.statSync(USAGE_FILE);
    return st.mtimeMs + ":" + st.size;
  } catch (e) {
    return "missing";
  }
}

function getQuotaState(config) {
  var planLimits = (config && config.planLimits) || {};
  var weeklyAll = planLimits.weeklyAllModels || 200;
  var weeklyOpus = planLimits.weeklyOpus || 30;
  var weeklySonnet = planLimits.weeklySonnet || 50;
  var weeklyHaiku = planLimits.weeklyHaiku || 100;
  var burstAll = planLimits.burst5hAllModels || planLimits.sessionLimit || 50;

  // Cache check: same usage file + same plan limits + within TTL → reuse.
  var sig = _usageSignature();
  var planSig = weeklyAll + "/" + weeklyOpus + "/" + weeklySonnet + "/" + weeklyHaiku + "/" + burstAll;
  if (_quotaCache && _quotaCache.sig === sig && _quotaCache.planSig === planSig &&
      (Date.now() - _quotaCache.at) < _QUOTA_TTL_MS) {
    return _quotaCache.state;
  }

  var entries = readJsonl(USAGE_FILE);
  var weekly = windowCounts(entries, 7 * 24 * 3600 * 1000);
  var burst  = windowCounts(entries, 5 * 3600 * 1000);

  function pct(n, d) { return d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0; }

  var pressure = {
    opus: weeklyOpus > 0 ? Math.min(1, weekly.opus / weeklyOpus) : 0,
    sonnet: weeklySonnet > 0 ? Math.min(1, weekly.sonnet / weeklySonnet) : 0,
    haiku: weeklyHaiku > 0 ? Math.min(1, weekly.haiku / weeklyHaiku) : 0,
    all: weeklyAll > 0 ? Math.min(1, weekly.all / weeklyAll) : 0
  };

  var state = {
    weekly: weekly,
    weeklyLimits: { haiku: weeklyHaiku, sonnet: weeklySonnet, opus: weeklyOpus, all: weeklyAll },
    weeklyPct: {
      haiku: pct(weekly.haiku, weeklyHaiku),
      sonnet: pct(weekly.sonnet, weeklySonnet),
      opus: pct(weekly.opus, weeklyOpus),
      all: pct(weekly.all, weeklyAll)
    },
    burst: burst,
    burstLimits: { all: burstAll },
    burstPct: { all: pct(burst.all, burstAll) },
    pressure: pressure,
    overWeeklyOpus: pressure.opus >= 1,
    overWeeklyAll: pressure.all >= 1,
    overBurstAll: burstAll > 0 && burst.all >= burstAll
  };

  _quotaCache = { sig: sig, planSig: planSig, state: state, at: Date.now() };
  return state;
}

// Decide if an opus recommendation should be downgraded based on quota pressure.
// Returns { downgrade: bool, toModel: "sonnet"|"haiku"|null, reason: string }.
function shouldDowngrade(recommendedModel, quotaState, config) {
  if (recommendedModel !== "opus") return { downgrade: false, toModel: null, reason: "" };
  var qa = (config && config.quotaAware) || {};
  if (qa.enabled === false) return { downgrade: false, toModel: null, reason: "quotaAware disabled" };
  var threshold = typeof qa.opusDowngradeThreshold === "number" ? qa.opusDowngradeThreshold : 0.8;
  var fallback = qa.opusFallbackModel || "sonnet";

  if (quotaState.overWeeklyOpus) {
    return { downgrade: true, toModel: fallback, reason: "Opus weekly quota exhausted (" + quotaState.weeklyPct.opus + "%)" };
  }
  if (quotaState.pressure.opus >= threshold) {
    return { downgrade: true, toModel: fallback, reason: "Opus weekly usage at " + quotaState.weeklyPct.opus + "% (threshold " + Math.round(threshold * 100) + "%)" };
  }
  if (quotaState.overBurstAll && qa.respectBurstLimit !== false) {
    return { downgrade: true, toModel: fallback, reason: "5-hour burst limit exceeded (" + quotaState.burstPct.all + "%)" };
  }
  return { downgrade: false, toModel: null, reason: "" };
}

module.exports = {
  getQuotaState: getQuotaState,
  shouldDowngrade: shouldDowngrade,
  windowCounts: windowCounts
};
