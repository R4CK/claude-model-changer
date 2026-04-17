#!/usr/bin/env node

/**
 * Claude Model Changer - Dashboard Generator v4.0
 * Generates an HTML dashboard with inline SVG charts from usage logs.
 */

"use strict";

var fs = require("fs");
var path = require("path");

var logsDir = path.join(__dirname, "..", "logs");
var configDir = path.join(__dirname, "..", "config");

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (e) { return null; }
}

// ---- Data collection ----

var usageEntries = readJsonl(path.join(logsDir, "usage.jsonl"));
var qualityEntries = readJsonl(path.join(logsDir, "quality.jsonl"));
var overrideEntries = readJsonl(path.join(logsDir, "overrides.jsonl"));
var fallbackEntries = readJsonl(path.join(logsDir, "fallbacks.jsonl"));
var config = readJson(path.join(configDir, "task-routing.json"));

// ---- Calculations ----

var total = usageEntries.length;
var modelCounts = { haiku: 0, sonnet: 0, opus: 0 };
var categoryCounts = {};
var dailyCounts = {};
var scoreDist = {};
var scoreSum = 0;
var autoRouted = 0, borderline = 0;

usageEntries.forEach(function(e) {
  modelCounts[e.model] = (modelCounts[e.model] || 0) + 1;
  if (e.category) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
  scoreSum += (e.score || 0);
  if (e.autoRouted) autoRouted++;
  if (e.borderline) borderline++;

  var day = (e.timestamp || "").substring(0, 10);
  if (day) dailyCounts[day] = (dailyCounts[day] || 0) + 1;

  var s = e.score || 0;
  scoreDist[s] = (scoreDist[s] || 0) + 1;
});

var topCategories = Object.entries(categoryCounts)
  .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 8);

var qualityByModel = {};
qualityEntries.forEach(function(e) {
  var m = e.model || "unknown";
  if (!qualityByModel[m]) qualityByModel[m] = { sum: 0, count: 0 };
  qualityByModel[m].sum += e.rating;
  qualityByModel[m].count++;
});

// ---- Savings calculation ----

var costs = (config && config.costEstimates) || {
  haiku: { inputPer1M: 0.25, outputPer1M: 1.25 },
  sonnet: { inputPer1M: 3.00, outputPer1M: 15.00 },
  opus: { inputPer1M: 15.00, outputPer1M: 75.00 }
};
var avgTokens = (config && config.savingsTracking && config.savingsTracking.avgTokensPerTask) || { haiku: 2000, sonnet: 4000, opus: 8000 };

var actualCost = 0, opusCost = 0;
usageEntries.forEach(function(e) {
  var model = e.model || "sonnet";
  var tokens = avgTokens[model] || 4000;
  var mc = costs[model] || costs.sonnet;
  var oc = costs.opus;
  actualCost += (tokens * 0.4 / 1e6) * mc.inputPer1M + (tokens * 0.6 / 1e6) * mc.outputPer1M;
  opusCost += (tokens * 0.4 / 1e6) * oc.inputPer1M + (tokens * 0.6 / 1e6) * oc.outputPer1M;
});
var savedPct = opusCost > 0 ? Math.round((1 - actualCost / opusCost) * 100) : 0;

// ---- SVG Helpers ----

function pieChart(data, colors, size) {
  var total = data.reduce(function(s, d) { return s + d.value; }, 0);
  if (total === 0) return '<text x="' + size / 2 + '" y="' + size / 2 + '" text-anchor="middle" fill="#999">No data</text>';

  var cx = size / 2, cy = size / 2, r = size / 2 - 10;
  var startAngle = 0;
  var paths = [];

  data.forEach(function(d, i) {
    var pct = d.value / total;
    var endAngle = startAngle + pct * Math.PI * 2;
    var largeArc = pct > 0.5 ? 1 : 0;
    var x1 = cx + r * Math.cos(startAngle);
    var y1 = cy + r * Math.sin(startAngle);
    var x2 = cx + r * Math.cos(endAngle);
    var y2 = cy + r * Math.sin(endAngle);

    if (pct > 0.001) {
      paths.push('<path d="M ' + cx + ' ' + cy + ' L ' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
        ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) +
        ' Z" fill="' + colors[i % colors.length] + '" stroke="white" stroke-width="2"/>');
    }
    startAngle = endAngle;
  });

  return paths.join("");
}

function barChart(data, color, maxWidth, barHeight) {
  if (data.length === 0) return '';
  var maxVal = Math.max.apply(null, data.map(function(d) { return d.value; }));
  if (maxVal === 0) return '';
  var bars = [];
  data.forEach(function(d, i) {
    var w = Math.max(2, (d.value / maxVal) * maxWidth);
    var y = i * (barHeight + 6);
    bars.push('<rect x="120" y="' + y + '" width="' + w.toFixed(0) + '" height="' + barHeight + '" fill="' + color + '" rx="3"/>');
    bars.push('<text x="115" y="' + (y + barHeight - 3) + '" text-anchor="end" font-size="12" fill="#ccc">' + escHtml(d.label.substring(0, 18)) + '</text>');
    bars.push('<text x="' + (125 + w) + '" y="' + (y + barHeight - 3) + '" font-size="12" fill="#999">' + d.value + '</text>');
  });
  return bars.join("");
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Generate HTML ----

var modelColors = ["#10b981", "#3b82f6", "#8b5cf6"]; // haiku=green, sonnet=blue, opus=purple

var pieData = [
  { label: "Haiku", value: modelCounts.haiku },
  { label: "Sonnet", value: modelCounts.sonnet },
  { label: "Opus", value: modelCounts.opus }
];

var catBarData = topCategories.map(function(c) { return { label: c[0], value: c[1] }; });

var scoreBarData = [];
for (var s = 1; s <= 10; s++) {
  scoreBarData.push({ label: "" + s, value: scoreDist[s] || 0 });
}

// Daily trend (last 30 days)
var days = Object.keys(dailyCounts).sort().slice(-30);
var maxDaily = Math.max.apply(null, days.map(function(d) { return dailyCounts[d]; }).concat([1]));

var qualityRows = Object.keys(qualityByModel).map(function(m) {
  var q = qualityByModel[m];
  return '<tr><td>' + m + '</td><td>' + (q.sum / q.count).toFixed(1) + '/5</td><td>' + q.count + '</td></tr>';
}).join("");

var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Model Router Dashboard</title>\n<style>\n' +
  'body{margin:0;padding:20px;background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}\n' +
  'h1{text-align:center;color:#f8fafc;margin-bottom:30px;font-size:28px;}\n' +
  '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:20px;max-width:1400px;margin:0 auto;}\n' +
  '.card{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155;}\n' +
  '.card h2{margin:0 0 15px;color:#94a3b8;font-size:16px;text-transform:uppercase;letter-spacing:1px;}\n' +
  '.stat{font-size:36px;font-weight:bold;color:#f8fafc;}\n' +
  '.stat-label{font-size:14px;color:#64748b;margin-top:4px;}\n' +
  '.stat-row{display:flex;gap:30px;flex-wrap:wrap;}\n' +
  '.stat-item{flex:1;min-width:100px;}\n' +
  '.legend{display:flex;gap:15px;margin-top:10px;flex-wrap:wrap;}\n' +
  '.legend-item{display:flex;align-items:center;gap:6px;font-size:13px;color:#94a3b8;}\n' +
  '.legend-dot{width:12px;height:12px;border-radius:50%;}\n' +
  'table{width:100%;border-collapse:collapse;}\n' +
  'th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #334155;}\n' +
  'th{color:#64748b;font-size:12px;text-transform:uppercase;}\n' +
  'td{color:#cbd5e1;font-size:14px;}\n' +
  '.savings{color:#10b981;font-size:24px;font-weight:bold;}\n' +
  '.trend-bar{fill:#3b82f6;}\n' +
  '</style>\n</head>\n<body>\n<h1>Claude Model Router Dashboard</h1>\n<div class="grid">\n';

// Summary card
html += '<div class="card"><h2>Summary</h2><div class="stat-row">' +
  '<div class="stat-item"><div class="stat">' + total + '</div><div class="stat-label">Total Prompts</div></div>' +
  '<div class="stat-item"><div class="stat">' + (total > 0 ? (scoreSum / total).toFixed(1) : "0") + '</div><div class="stat-label">Avg Score</div></div>' +
  '<div class="stat-item"><div class="stat">' + autoRouted + '</div><div class="stat-label">Auto-Routed</div></div>' +
  '<div class="stat-item"><div class="stat">' + borderline + '</div><div class="stat-label">Borderline</div></div>' +
  '</div></div>\n';

// Model distribution pie
html += '<div class="card"><h2>Model Distribution</h2>' +
  '<svg width="200" height="200" viewBox="0 0 200 200">' + pieChart(pieData, modelColors, 200) + '</svg>' +
  '<div class="legend">' +
  '<div class="legend-item"><div class="legend-dot" style="background:#10b981"></div>Haiku: ' + modelCounts.haiku + ' (' + (total > 0 ? Math.round(modelCounts.haiku / total * 100) : 0) + '%)</div>' +
  '<div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div>Sonnet: ' + modelCounts.sonnet + ' (' + (total > 0 ? Math.round(modelCounts.sonnet / total * 100) : 0) + '%)</div>' +
  '<div class="legend-item"><div class="legend-dot" style="background:#8b5cf6"></div>Opus: ' + modelCounts.opus + ' (' + (total > 0 ? Math.round(modelCounts.opus / total * 100) : 0) + '%)</div>' +
  '</div></div>\n';

// Cost savings
html += '<div class="card"><h2>Cost Savings</h2>' +
  '<div class="savings">' + savedPct + '% saved</div>' +
  '<div class="stat-label">$' + actualCost.toFixed(4) + ' actual vs $' + opusCost.toFixed(4) + ' if all opus</div>' +
  '<div class="stat-label" style="margin-top:8px">Saved: $' + (opusCost - actualCost).toFixed(4) + '</div>' +
  '</div>\n';

// Top categories bar chart
html += '<div class="card"><h2>Top Categories</h2>' +
  '<svg width="100%" height="' + (catBarData.length * 26 + 10) + '" viewBox="0 0 500 ' + (catBarData.length * 26 + 10) + '">' +
  barChart(catBarData, "#3b82f6", 300, 20) + '</svg></div>\n';

// Score distribution
var scoreMax = Math.max.apply(null, scoreBarData.map(function(d) { return d.value; }).concat([1]));
var scoreBars = scoreBarData.map(function(d, i) {
  var h = Math.max(2, (d.value / scoreMax) * 120);
  var x = i * 35 + 15;
  var color = i <= 2 ? "#10b981" : i <= 6 ? "#3b82f6" : "#8b5cf6";
  return '<rect x="' + x + '" y="' + (140 - h) + '" width="28" height="' + h + '" fill="' + color + '" rx="3"/>' +
    '<text x="' + (x + 14) + '" y="155" text-anchor="middle" font-size="11" fill="#94a3b8">' + (i + 1) + '</text>' +
    '<text x="' + (x + 14) + '" y="' + (135 - h) + '" text-anchor="middle" font-size="10" fill="#64748b">' + (d.value || '') + '</text>';
}).join("");
html += '<div class="card"><h2>Score Distribution</h2>' +
  '<svg width="100%" height="170" viewBox="0 0 370 170">' + scoreBars + '</svg></div>\n';

// Daily trend
if (days.length > 0) {
  var trendW = 500, trendH = 120;
  var dayW = days.length > 1 ? trendW / days.length : trendW / 2;
  var trendBars = days.map(function(d, i) {
    var h = Math.max(2, (dailyCounts[d] / maxDaily) * (trendH - 20));
    var bw = Math.max(4, dayW - 4);
    return '<rect x="' + (i * dayW).toFixed(0) + '" y="' + (trendH - h - 5) + '" width="' + bw.toFixed(0) + '" height="' + h + '" class="trend-bar" rx="2"/>';
  }).join("");
  html += '<div class="card"><h2>Daily Trend (Last 30 Days)</h2>' +
    '<svg width="100%" height="' + trendH + '" viewBox="0 0 ' + trendW + ' ' + trendH + '">' + trendBars + '</svg>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-top:4px;">' +
    '<span>' + days[0] + '</span><span>' + days[days.length - 1] + '</span></div></div>\n';
}

// Quality ratings
if (qualityRows) {
  html += '<div class="card"><h2>Quality Ratings</h2>' +
    '<table><tr><th>Model</th><th>Avg Rating</th><th>Count</th></tr>' + qualityRows + '</table></div>\n';
}

// Override & fallback stats
html += '<div class="card"><h2>Override & Fallback Stats</h2>' +
  '<div class="stat-row">' +
  '<div class="stat-item"><div class="stat">' + overrideEntries.length + '</div><div class="stat-label">Overrides</div></div>' +
  '<div class="stat-item"><div class="stat">' + fallbackEntries.length + '</div><div class="stat-label">Fallbacks</div></div>' +
  '</div></div>\n';

html += '</div>\n<p style="text-align:center;color:#475569;margin-top:30px;font-size:12px;">Generated by Claude Model Changer v4.0 on ' + new Date().toISOString().substring(0, 19) + '</p>\n</body>\n</html>';

// Write output
var outputPath = path.join(logsDir, "dashboard.html");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(outputPath, html);
console.log("Dashboard generated: " + outputPath);
