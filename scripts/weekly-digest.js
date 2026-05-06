#!/usr/bin/env node
/**
 * weekly-digest.js — Generate a narrative weekly cost + usage report.
 *
 * Usage:
 *   node scripts/weekly-digest.js                # generate + write to logs/
 *   node scripts/weekly-digest.js --stdout       # print to stdout instead
 *   node scripts/weekly-digest.js --json         # machine-readable
 *   node scripts/weekly-digest.js --week N       # N=0 (this week), 1 (last), ...
 *
 * Reads:
 *   logs/usage.jsonl
 *   logs/quality.jsonl
 *   logs/fallbacks.jsonl
 *   logs/git-router-stats.jsonl
 *
 * Writes:
 *   logs/weekly-digest-YYYY-MM-DD.md   (one per Monday)
 *
 * Designed for /loop 7d use, or weekly cron via scheduled-tasks MCP.
 * Compares current week to previous week for trend analysis.
 *
 * Composes WITH /stats (real-time JSON) and /metrics (Prometheus) — this is
 * the narrative-format counterpart for humans.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var USAGE_LOG = path.join(PLUGIN_ROOT, "logs", "usage.jsonl");
var QUALITY_LOG = path.join(PLUGIN_ROOT, "logs", "quality.jsonl");
var FALLBACKS_LOG = path.join(PLUGIN_ROOT, "logs", "fallbacks.jsonl");
var GIT_LOG = path.join(PLUGIN_ROOT, "logs", "git-router-stats.jsonl");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");

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

function weekRange(weekOffset) {
  weekOffset = weekOffset || 0;
  var now = new Date();
  // Find Monday of the week
  var dow = now.getUTCDay() || 7;
  var monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - dow + 1 - weekOffset * 7);
  monday.setUTCHours(0, 0, 0, 0);
  var sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 7);
  return { start: monday, end: sunday };
}

function filterByWindow(entries, start, end) {
  return entries.filter(function(e) {
    if (!e || !e.timestamp) return false;
    var t = Date.parse(e.timestamp);
    return t >= start.getTime() && t < end.getTime();
  });
}

function calcCost(model, count, config) {
  var c = (config && config.costEstimates && config.costEstimates[model]) || {};
  var inp = typeof c.inputPer1M === "number" ? c.inputPer1M : 0;
  var out = typeof c.outputPer1M === "number" ? c.outputPer1M : 0;
  return count * (800 * inp + 1500 * out) / 1e6;
}

function buildDigest(opts) {
  opts = opts || {};
  var weekOffset = typeof opts.week === "number" ? opts.week : 0;
  var range = weekRange(weekOffset);
  var prevRange = weekRange(weekOffset + 1);

  var config = readJsonSafe(CONFIG_FILE) || {};
  var allUsage = readJsonl(USAGE_LOG);
  var allQuality = readJsonl(QUALITY_LOG);
  var allFb = readJsonl(FALLBACKS_LOG);
  var allGit = readJsonl(GIT_LOG);

  var cur = filterByWindow(allUsage, range.start, range.end);
  var prev = filterByWindow(allUsage, prevRange.start, prevRange.end);

  // Distribution
  function distrib(entries) {
    var d = { haiku: 0, sonnet: 0, opus: 0 };
    entries.forEach(function(e) {
      if (e.model && d[e.model] !== undefined) d[e.model]++;
    });
    return d;
  }
  var curD = distrib(cur);
  var prevD = distrib(prev);
  var totalCur = curD.haiku + curD.sonnet + curD.opus;
  var totalPrev = prevD.haiku + prevD.sonnet + prevD.opus;

  // Cost
  function totalCost(d) {
    return calcCost("haiku", d.haiku, config) + calcCost("sonnet", d.sonnet, config) + calcCost("opus", d.opus, config);
  }
  var costCur = totalCost(curD);
  var costPrev = totalCost(prevD);
  // Hypothetical all-opus cost
  var costAllOpus = calcCost("opus", totalCur, config);
  var savedVsAllOpus = costAllOpus - costCur;

  // Effort distribution
  var effortCur = { low: 0, medium: 0, high: 0, none: 0 };
  cur.forEach(function(e) {
    var lv = e.effort || "none";
    if (effortCur[lv] !== undefined) effortCur[lv]++;
  });

  // Categories - top 5
  var catCounts = {};
  cur.forEach(function(e) {
    var c = e.category || "unknown";
    catCounts[c] = (catCounts[c] || 0) + 1;
  });
  var topCats = Object.keys(catCounts).map(function(k) { return [k, catCounts[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);

  // Quality
  var curQ = filterByWindow(allQuality, range.start, range.end);
  var qSum = 0, qCount = 0;
  curQ.forEach(function(e) { if (typeof e.rating === "number") { qSum += e.rating; qCount++; } });
  var qAvg = qCount > 0 ? (qSum / qCount).toFixed(2) : "n/a";

  // Fallbacks
  var curFb = filterByWindow(allFb, range.start, range.end);
  var fbCount = curFb.length;

  // Git stats
  var curGit = filterByWindow(allGit, range.start, range.end);
  var commits = curGit.filter(function(e) { return e.op === "commit"; }).length;
  var pushes = curGit.filter(function(e) { return e.op === "push"; }).length;
  var forcePushes = curGit.filter(function(e) { return e.forcePush; }).length;

  // Anomalies — naive: any day with > 2x daily-average opus calls
  var dailyOpus = {};
  cur.forEach(function(e) {
    if (e.model !== "opus" || !e.timestamp) return;
    var day = e.timestamp.slice(0, 10);
    dailyOpus[day] = (dailyOpus[day] || 0) + 1;
  });
  var opusDays = Object.keys(dailyOpus);
  var avgOpus = opusDays.length > 0 ? curD.opus / opusDays.length : 0;
  var spikes = opusDays.filter(function(d) { return dailyOpus[d] > avgOpus * 2; });

  return {
    week: { start: range.start.toISOString().slice(0, 10), end: range.end.toISOString().slice(0, 10) },
    totalPrompts: totalCur,
    totalPromptsPrevWeek: totalPrev,
    distribution: curD,
    distributionPrevWeek: prevD,
    distributionPercent: totalCur > 0 ? {
      haiku: Math.round(curD.haiku / totalCur * 100),
      sonnet: Math.round(curD.sonnet / totalCur * 100),
      opus: Math.round(curD.opus / totalCur * 100)
    } : null,
    costEstimate: costCur.toFixed(2),
    costPrevWeek: costPrev.toFixed(2),
    costAllOpusEstimate: costAllOpus.toFixed(2),
    savedVsAllOpus: savedVsAllOpus.toFixed(2),
    savingsPercent: costAllOpus > 0 ? Math.round((savedVsAllOpus / costAllOpus) * 100) : 0,
    effortDistribution: effortCur,
    topCategories: topCats,
    avgQualityRating: qAvg,
    qualityRatingsCount: qCount,
    fallbackEvents: fbCount,
    git: { commits: commits, pushes: pushes, forcePushes: forcePushes },
    opusSpikes: spikes,
    activeProfile: config._activeProfile || null
  };
}

function formatMarkdown(d) {
  var lines = [];
  lines.push("# Weekly cost digest — " + d.week.start + " → " + d.week.end);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("- **" + d.totalPrompts + " prompts** this week" + (d.totalPromptsPrevWeek > 0 ? " (was " + d.totalPromptsPrevWeek + " last week, " + (d.totalPrompts > d.totalPromptsPrevWeek ? "+" : "") + (d.totalPrompts - d.totalPromptsPrevWeek) + ")" : ""));
  lines.push("- **Cost estimate:** $" + d.costEstimate + (d.costPrevWeek !== "0.00" ? " (was $" + d.costPrevWeek + " last week)" : ""));
  lines.push("- **Saved vs all-opus baseline:** $" + d.savedVsAllOpus + " (" + d.savingsPercent + "% reduction)");
  if (d.activeProfile) lines.push("- **Active profile:** `" + d.activeProfile + "`");
  lines.push("");
  if (d.distributionPercent) {
    lines.push("## Model distribution");
    lines.push("");
    lines.push("| Model | Count | % |");
    lines.push("|---|---|---|");
    ["haiku", "sonnet", "opus"].forEach(function(m) {
      lines.push("| " + m + " | " + d.distribution[m] + " | " + d.distributionPercent[m] + "% |");
    });
    lines.push("");
  }
  lines.push("## Effort breakdown");
  lines.push("");
  ["low", "medium", "high", "none"].forEach(function(lv) {
    if (d.effortDistribution[lv] > 0) lines.push("- " + lv + ": " + d.effortDistribution[lv]);
  });
  lines.push("");
  if (d.topCategories.length > 0) {
    lines.push("## Top categories");
    lines.push("");
    d.topCategories.forEach(function(c, i) {
      lines.push((i + 1) + ". `" + c[0] + "` × " + c[1]);
    });
    lines.push("");
  }
  lines.push("## Quality");
  lines.push("");
  lines.push("- Avg rating: **" + d.avgQualityRating + "** (" + d.qualityRatingsCount + " ratings via /rate)");
  lines.push("- Fallback events: " + d.fallbackEvents + (d.fallbackEvents > 5 ? " ⚠ — see /tune for category suggestions" : ""));
  lines.push("");
  if (d.git.commits > 0 || d.git.pushes > 0) {
    lines.push("## Git activity");
    lines.push("");
    lines.push("- Commits: " + d.git.commits);
    lines.push("- Pushes: " + d.git.pushes);
    if (d.git.forcePushes > 0) lines.push("- Force pushes: " + d.git.forcePushes + " ⚠");
    lines.push("");
  }
  if (d.opusSpikes.length > 0) {
    lines.push("## Anomalies");
    lines.push("");
    d.opusSpikes.forEach(function(day) {
      lines.push("- " + day + ": opus usage spike (>2× daily avg)");
    });
    lines.push("");
  }
  return lines.join("\n");
}

function writeReport(report, md) {
  try {
    var dir = path.join(PLUGIN_ROOT, "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var fname = "weekly-digest-" + report.week.start + ".md";
    var dest = path.join(dir, fname);
    fs.writeFileSync(dest, md, "utf8");
    return dest;
  } catch (e) { return null; }
}

if (require.main === module) {
  var argv = process.argv.slice(2);
  var stdout = argv.indexOf("--stdout") !== -1;
  var asJson = argv.indexOf("--json") !== -1;
  var weekIdx = argv.indexOf("--week");
  var week = weekIdx !== -1 ? parseInt(argv[weekIdx + 1], 10) : 0;
  var report = buildDigest({ week: isNaN(week) ? 0 : week });
  if (asJson) { process.stdout.write(JSON.stringify(report, null, 2)); process.exit(0); }
  var md = formatMarkdown(report);
  if (stdout) {
    process.stdout.write(md + "\n");
  } else {
    var dest = writeReport(report, md);
    if (dest) process.stderr.write("[weekly-digest] Wrote " + dest + "\n");
    process.stdout.write(md + "\n");
  }
}

module.exports = { buildDigest: buildDigest, formatMarkdown: formatMarkdown, writeReport: writeReport };
