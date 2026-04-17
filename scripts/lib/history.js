#!/usr/bin/env node
/**
 * history.js - Historical usage & quality context for borderline decisions
 *
 * Separated from scoring.js to break the scoring <-> io circular-dependency
 * pattern. scoring.js stays a pure function module; any query that needs
 * historical logs lives here.
 */
"use strict";

var fs = require("fs");
var io = require("./io");
var search = require("./search");

function getBorderlineContext(score, category, config) {
  try {
    var qPath = io.getQualityLogPath();
    var logPath = io.getLogPath();

    if (!fs.existsSync(logPath)) return null;
    var usageEntries = io.readLogCached(logPath);

    var catEntries = usageEntries.filter(function(e) { return e.category === category; });
    if (catEntries.length < 3) return null;

    var modelCounts = {};
    catEntries.forEach(function(e) {
      modelCounts[e.model] = (modelCounts[e.model] || 0) + 1;
    });

    var qualityData = null;
    if (fs.existsSync(qPath)) {
      var qualityEntries = io.readLogCached(qPath);
      var catIndex = search.prepareTimestampIndex(catEntries, function(u) { return !!u.timestamp; });

      var catQuality = {};
      qualityEntries.forEach(function(q) {
        var match = search.findClosestByTimestamp(catIndex.sorted, catIndex.timestamps, new Date(q.timestamp).getTime(), 120000);
        if (match) {
          var m = match.model;
          if (!catQuality[m]) catQuality[m] = { sum: 0, count: 0 };
          catQuality[m].sum += q.rating;
          catQuality[m].count++;
        }
      });
      if (Object.keys(catQuality).length > 0) qualityData = catQuality;
    }

    var bestModel = null, bestCount = 0;
    Object.keys(modelCounts).forEach(function(m) {
      if (modelCounts[m] > bestCount) { bestCount = modelCounts[m]; bestModel = m; }
    });

    var autoResolve = (config && config.autoMode && config.autoMode.borderlineAutoResolve) || {};
    var canAutoResolve = false;
    var autoResolveModel = null;

    if (autoResolve.enabled && bestModel && bestCount >= (autoResolve.minHistory || 5)) {
      if (qualityData && qualityData[bestModel] && qualityData[bestModel].count >= 3) {
        var avgRating = qualityData[bestModel].sum / qualityData[bestModel].count;
        if (avgRating >= (autoResolve.minAvgRating || 3.5)) {
          canAutoResolve = true;
          autoResolveModel = bestModel;
        }
      }
    }

    return {
      totalHistorical: catEntries.length,
      modelDistribution: modelCounts,
      qualityData: qualityData,
      bestHistoricalModel: bestModel,
      canAutoResolve: canAutoResolve,
      autoResolveModel: autoResolveModel
    };
  } catch (e) {
    process.stderr.write("[history] getBorderlineContext failed: " + e.message + "\n");
    return null;
  }
}

module.exports = { getBorderlineContext: getBorderlineContext };
