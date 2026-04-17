#!/usr/bin/env node
/**
 * monitors.js - Budget tracking, rate limiting, API limits, anomaly detection
 */
"use strict";

var fs = require("fs");
var io = require("./io");

// ---- BUDGET TRACKING (A4) ----

function checkBudget(model, config) {
  if (!config || !config.budgets || !config.budgets.enabled) return { withinBudget: true };

  var limits = config.budgets.limits;
  if (!limits || !limits[model]) return { withinBudget: true };

  var limit = limits[model];
  var period = config.budgets.period || "daily";
  var warnAt = config.budgets.warnAt || 80;
  var blockAt = config.budgets.blockAutoRouteAt || 100;

  try {
    var logPath = io.getLogPath();
    if (!fs.existsSync(logPath)) return { withinBudget: true, used: 0, limit: limit, percentage: 0 };

    var entries = io.readLogCached(logPath);
    var periodStart;
    if (period === "daily") { periodStart = new Date(); periodStart.setHours(0, 0, 0, 0); }
    else { periodStart = new Date(Date.now() - io.CONSTANTS.WEEK_MS); }

    var avgTokens = (config.savingsTracking && config.savingsTracking.avgTokensPerTask)
      ? config.savingsTracking.avgTokensPerTask : { haiku: 1500, sonnet: 3000, opus: 6000 };

    var usedTokens = 0;
    entries.forEach(function(e) {
      if (e.model === model && new Date(e.timestamp) >= periodStart) {
        usedTokens += avgTokens[model] || 3000;
      }
    });

    var percentage = Math.round((usedTokens / limit) * 100);
    var warning = null;
    if (percentage >= blockAt) warning = "BUDGET EXCEEDED: " + model + " at " + percentage + "% of " + period + " limit. Auto-routing disabled.";
    else if (percentage >= warnAt) warning = "BUDGET WARNING: " + model + " at " + percentage + "% of " + period + " limit (" + usedTokens + "/" + limit + " tokens).";

    return { withinBudget: percentage < blockAt, used: usedTokens, limit: limit, percentage: percentage, warning: warning };
  } catch (err) { return { withinBudget: true }; }
}

// ---- RATE LIMITING (A5) ----

function checkRateLimit(config, sessionId, loadSessionState) {
  if (!config || !config.rateLimit) return { allowed: true };

  var maxPerMinute = config.rateLimit.maxAutoRoutesPerMinute || 5;
  var cooldown = config.rateLimit.cooldownSeconds || 60;

  try {
    var state = loadSessionState(sessionId);
    if (!state || !state.recentAutoRoutes) return { allowed: true };

    var now = Date.now();
    var cutoff = now - (cooldown * 1000);
    var recentCount = state.recentAutoRoutes.filter(function(r) {
      return new Date(r.timestamp).getTime() > cutoff;
    }).length;

    if (recentCount >= maxPerMinute) {
      return { allowed: false, count: recentCount, limit: maxPerMinute,
        warning: "RATE LIMIT: Auto-routing paused (" + recentCount + "/" + maxPerMinute + " per " + cooldown + "s). Falling back to suggest+ask." };
    }
    return { allowed: true, count: recentCount };
  } catch (err) { return { allowed: true }; }
}

function recordAutoRoute(sessionId, model, loadSessionState, saveSessionState) {
  try {
    var state = loadSessionState(sessionId) || { sessionId: sessionId, recentAutoRoutes: [] };
    if (!state.recentAutoRoutes) state.recentAutoRoutes = [];
    state.recentAutoRoutes.push({ timestamp: new Date().toISOString(), model: model });
    if (state.recentAutoRoutes.length > 20) state.recentAutoRoutes = state.recentAutoRoutes.slice(-20);
    saveSessionState(state);
  } catch (err) {}
}

// ---- API RATE LIMIT MONITOR (F4) ----

function checkApiRateLimits(config, sessionId, loadSessionState) {
  if (!config || !config.apiLimits || !config.apiLimits.enabled) return null;

  var limits = config.apiLimits;
  var rpmLimit = limits.requestsPerMinute || 60;
  var tpmLimit = limits.tokensPerMinute || 100000;
  var warnAt = limits.warnAtPercent || 80;
  var forceHaikuAt = limits.forceHaikuAtPercent || 95;

  try {
    var state = loadSessionState(sessionId) || {};
    var apiCalls = state.apiCallsThisMinute || [];
    var now = Date.now();
    apiCalls = apiCalls.filter(function(c) { return (now - new Date(c.timestamp).getTime()) < 60000; });

    var currentRPM = apiCalls.length;
    var currentTPM = 0;
    apiCalls.forEach(function(c) { currentTPM += (c.estimatedTokens || 0); });

    var rpmPct = Math.round((currentRPM / rpmLimit) * 100);
    var tpmPct = Math.round((currentTPM / tpmLimit) * 100);
    var maxPct = Math.max(rpmPct, tpmPct);

    var result = { rpm: currentRPM, rpmLimit: rpmLimit, rpmPercent: rpmPct, tpm: currentTPM, tpmLimit: tpmLimit, tpmPercent: tpmPct, maxPercent: maxPct };

    if (maxPct >= forceHaikuAt) {
      result.action = "force_haiku";
      result.warning = "API LIMIT CRITICAL (" + maxPct + "%): Forcing haiku to avoid rate limits. Cooldown recommended.";
    } else if (maxPct >= warnAt) {
      result.action = "prefer_cheaper";
      result.warning = "API LIMIT WARNING (" + maxPct + "%): Preferring cheaper models to avoid rate limits.";
    } else {
      result.action = "none";
    }

    return result;
  } catch (err) { return null; }
}

function recordApiCall(sessionId, model, config, loadSessionState, saveSessionState) {
  try {
    var avgTokens = (config && config.savingsTracking && config.savingsTracking.avgTokensPerTask)
      ? config.savingsTracking.avgTokensPerTask : { haiku: 1500, sonnet: 3000, opus: 6000 };

    var state = loadSessionState(sessionId) || { sessionId: sessionId };
    if (!state.apiCallsThisMinute) state.apiCallsThisMinute = [];

    var now = Date.now();
    state.apiCallsThisMinute = state.apiCallsThisMinute.filter(function(c) { return (now - new Date(c.timestamp).getTime()) < 60000; });
    state.apiCallsThisMinute.push({ timestamp: new Date().toISOString(), model: model, estimatedTokens: avgTokens[model] || 3000 });
    saveSessionState(state);
  } catch (err) {}
}

// ---- ANOMALY DETECTION (F1) ----

function detectAnomalies(config) {
  if (!config || !config.anomalyDetection || !config.anomalyDetection.enabled) return [];

  var thresholds = config.anomalyDetection.thresholds || { opusSpike: 2.0, costSpike: 2.0, scoreDrift: 3 };

  try {
    var logPath = io.getLogPath();
    if (!fs.existsSync(logPath)) return [];
    var entries = io.readLogCached(logPath);
    if (entries.length < 7) return [];

    var now = new Date();
    var todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    var weekStart = new Date(now.getTime() - io.CONSTANTS.WEEK_MS);

    var todayEntries = [], weekEntries = [];
    entries.forEach(function(e) {
      var ts = new Date(e.timestamp);
      if (ts >= todayStart) todayEntries.push(e);
      else if (ts >= weekStart) weekEntries.push(e);
    });

    if (weekEntries.length === 0) return [];
    var anomalies = [];
    var daysInWeek = 7;

    var todayOpus = todayEntries.filter(function(e) { return e.model === "opus"; }).length;
    var weekOpusAvg = weekEntries.filter(function(e) { return e.model === "opus"; }).length / daysInWeek;
    if (weekOpusAvg > 0 && todayOpus > weekOpusAvg * thresholds.opusSpike) {
      anomalies.push({ type: "opus_spike", severity: "warning",
        message: "ANOMALY: Opus usage today (" + todayOpus + ") is " + (todayOpus / weekOpusAvg).toFixed(1) + "x the 7-day average (" + weekOpusAvg.toFixed(1) + "/day)" });
    }

    var todayScoreSum = 0, weekScoreSum = 0;
    todayEntries.forEach(function(e) { todayScoreSum += (e.score || 0); });
    weekEntries.forEach(function(e) { weekScoreSum += (e.score || 0); });
    var todayAvgScore = todayEntries.length > 0 ? todayScoreSum / todayEntries.length : 0;
    var weekAvgScore = weekEntries.length > 0 ? weekScoreSum / weekEntries.length : 0;
    if (todayEntries.length >= 3 && Math.abs(todayAvgScore - weekAvgScore) > thresholds.scoreDrift) {
      anomalies.push({ type: "score_drift", severity: "info",
        message: "ANOMALY: Avg score today (" + todayAvgScore.toFixed(1) + ") drifted " + (todayAvgScore > weekAvgScore ? "up" : "down") + " from 7-day avg (" + weekAvgScore.toFixed(1) + ")" });
    }

    var costs = (config && config.costEstimates) || { haiku: { inputPer1M: 0.25, outputPer1M: 1.25 }, sonnet: { inputPer1M: 3.00, outputPer1M: 15.00 }, opus: { inputPer1M: 15.00, outputPer1M: 75.00 } };
    var avgTokens = (config && config.savingsTracking && config.savingsTracking.avgTokensPerTask) || { haiku: 1500, sonnet: 3000, opus: 6000 };

    function estimateCost(entryList) {
      var c = 0;
      entryList.forEach(function(e) {
        var m = e.model || "sonnet";
        var t = avgTokens[m] || 3000;
        var mc = costs[m] || costs.sonnet;
        c += (t * io.CONSTANTS.TOKEN_INPUT_RATIO / 1e6) * mc.inputPer1M + (t * io.CONSTANTS.TOKEN_OUTPUT_RATIO / 1e6) * mc.outputPer1M;
      });
      return c;
    }

    var todayCost = estimateCost(todayEntries);
    var weekDailyAvgCost = estimateCost(weekEntries) / daysInWeek;
    if (weekDailyAvgCost > 0 && todayCost > weekDailyAvgCost * thresholds.costSpike) {
      anomalies.push({ type: "cost_spike", severity: "warning",
        message: "ANOMALY: Estimated cost today ($" + todayCost.toFixed(4) + ") is " + (todayCost / weekDailyAvgCost).toFixed(1) + "x the 7-day daily avg ($" + weekDailyAvgCost.toFixed(4) + ")" });
    }

    return anomalies;
  } catch (err) { return []; }
}

module.exports = {
  checkBudget: checkBudget,
  checkRateLimit: checkRateLimit,
  recordAutoRoute: recordAutoRoute,
  checkApiRateLimits: checkApiRateLimits,
  recordApiCall: recordApiCall,
  detectAnomalies: detectAnomalies
};
