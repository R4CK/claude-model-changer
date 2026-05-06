#!/usr/bin/env node
/**
 * export-prometheus.js — Export plugin telemetry as Prometheus text-format metrics.
 *
 * Usage: node scripts/export-prometheus.js [output-file]
 *   Default output: stdout
 *
 * Reads:
 *   logs/usage.jsonl         — routing decisions
 *   logs/quality.jsonl       — user ratings
 *   logs/fallbacks.jsonl     — subagent fallback events
 *   logs/session-state.json  — current session counters
 *
 * Emits:
 *   model_routing_total{model="haiku|sonnet|opus",auto="true|false"}
 *   model_routing_score_bucket{le="..."}
 *   subagent_fallback_total{from,to}
 *   user_quality_rating_avg{model="..."}
 *   session_tokens_estimated_used
 *   session_prompt_count
 *   effort_distribution{level="low|medium|high"}
 *
 * Designed for periodic scraping or one-shot snapshots into Pushgateway.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var BASE_DIR = path.join(__dirname, "..");
var LOGS_DIR = path.join(BASE_DIR, "logs");

function readJsonl(file) {
  try {
    var p = path.join(LOGS_DIR, file);
    if (!fs.existsSync(p)) return [];
    var raw = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
    return raw.trim().split("\n").filter(function(l) { return l.length > 0; }).map(function(l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

function readJson(file) {
  try {
    var p = path.join(LOGS_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function emit(out, name, help, type, samples) {
  out.push("# HELP " + name + " " + help);
  out.push("# TYPE " + name + " " + type);
  samples.forEach(function(s) { out.push(s); });
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ");
}

function buildMetrics() {
  var usage = readJsonl("usage.jsonl");
  var quality = readJsonl("quality.jsonl");
  var fallbacks = readJsonl("fallbacks.jsonl");
  var session = readJson("session-state.json") || {};

  var out = [];

  // Routing counts by model + auto/manual
  var routingCounts = {};
  usage.forEach(function(e) {
    var key = (e.model || "unknown") + "|" + (e.autoRoute ? "true" : "false");
    routingCounts[key] = (routingCounts[key] || 0) + 1;
  });
  var routingSamples = Object.keys(routingCounts).map(function(k) {
    var parts = k.split("|");
    return "model_routing_total{model=\"" + escapeLabel(parts[0]) + "\",auto=\"" + parts[1] + "\"} " + routingCounts[k];
  });
  if (routingSamples.length === 0) routingSamples.push("model_routing_total 0");
  emit(out, "model_routing_total", "Total routing decisions per model and auto-route flag", "counter", routingSamples);

  // Score histogram (rough buckets)
  var buckets = [1, 3, 5, 7, 10];
  var histo = {};
  buckets.forEach(function(b) { histo[b] = 0; });
  var totalScored = 0;
  usage.forEach(function(e) {
    var s = typeof e.score === "number" ? e.score : null;
    if (s == null) return;
    totalScored++;
    for (var i = 0; i < buckets.length; i++) {
      if (s <= buckets[i]) histo[buckets[i]]++;
    }
  });
  var scoreSamples = buckets.map(function(b) {
    return "model_routing_score_bucket{le=\"" + b + "\"} " + histo[b];
  });
  scoreSamples.push("model_routing_score_bucket{le=\"+Inf\"} " + totalScored);
  scoreSamples.push("model_routing_score_count " + totalScored);
  emit(out, "model_routing_score_bucket", "Distribution of complexity scores", "histogram", scoreSamples);

  // Effort distribution
  var effortCounts = { low: 0, medium: 0, high: 0, none: 0 };
  usage.forEach(function(e) {
    var lv = e.effort || "none";
    if (effortCounts[lv] === undefined) effortCounts[lv] = 0;
    effortCounts[lv]++;
  });
  var effortSamples = Object.keys(effortCounts).map(function(k) {
    return "effort_distribution{level=\"" + k + "\"} " + effortCounts[k];
  });
  emit(out, "effort_distribution", "Distribution of effort levels emitted", "counter", effortSamples);

  // Fallbacks
  var fbCounts = {};
  fallbacks.forEach(function(e) {
    var key = (e.fromModel || e.from || "unknown") + "|" + (e.toModel || e.to || e.targetModel || "unknown");
    fbCounts[key] = (fbCounts[key] || 0) + 1;
  });
  var fbSamples = Object.keys(fbCounts).map(function(k) {
    var parts = k.split("|");
    return "subagent_fallback_total{from=\"" + escapeLabel(parts[0]) + "\",to=\"" + escapeLabel(parts[1]) + "\"} " + fbCounts[k];
  });
  if (fbSamples.length === 0) fbSamples.push("subagent_fallback_total 0");
  emit(out, "subagent_fallback_total", "Subagent fallback events between models", "counter", fbSamples);

  // Quality ratings (avg per model)
  var qSums = {}, qCounts = {};
  quality.forEach(function(e) {
    var m = e.model || "unknown";
    var r = typeof e.rating === "number" ? e.rating : null;
    if (r == null) return;
    qSums[m] = (qSums[m] || 0) + r;
    qCounts[m] = (qCounts[m] || 0) + 1;
  });
  var qSamples = Object.keys(qCounts).map(function(m) {
    return "user_quality_rating_avg{model=\"" + escapeLabel(m) + "\"} " + (qSums[m] / qCounts[m]).toFixed(3);
  });
  if (qSamples.length === 0) qSamples.push("user_quality_rating_avg 0");
  emit(out, "user_quality_rating_avg", "Average user quality rating (1-5) per model", "gauge", qSamples);

  // Session counters
  emit(out, "session_tokens_estimated_used", "Estimated tokens used in current session", "gauge",
    ["session_tokens_estimated_used " + (session.estimatedTokensUsed || 0)]);
  emit(out, "session_prompt_count", "Prompts handled in current session", "gauge",
    ["session_prompt_count " + (session.promptCount || 0)]);

  // Per-model session counts
  var mc = session.modelCounts || {};
  emit(out, "session_model_count", "Session prompts routed per model", "gauge", [
    "session_model_count{model=\"haiku\"} " + (mc.haiku || 0),
    "session_model_count{model=\"sonnet\"} " + (mc.sonnet || 0),
    "session_model_count{model=\"opus\"} " + (mc.opus || 0)
  ]);

  return out.join("\n") + "\n";
}

if (require.main === module) {
  var output = buildMetrics();
  if (process.argv[2]) {
    fs.writeFileSync(process.argv[2], output, "utf8");
    process.stderr.write("Wrote Prometheus metrics to " + process.argv[2] + "\n");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { buildMetrics: buildMetrics };
