#!/usr/bin/env node
/**
 * auto-benchmark.js — Periodic benchmark suite for the routing engine.
 *
 * Runs a fixed set of canonical prompts through the analyzer and verifies
 * the routing decisions stay consistent. Tracks score drift over time so
 * the user knows if config tuning broke something.
 *
 * Usage:
 *   node scripts/auto-benchmark.js                    # full run
 *   node scripts/auto-benchmark.js --quiet            # only print summary
 *   node scripts/auto-benchmark.js --json             # machine-readable
 *   node scripts/auto-benchmark.js --append           # also write to logs/
 *
 * Designed to be run weekly via /loop or the scheduled-tasks MCP. The
 * benchmark suite is data-only (no actual API calls), so it's free to run.
 *
 * Output: a per-prompt routing breakdown + drift report comparing to the
 * last benchmark. Drift > 1 score point on any case raises a warning.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var ANALYZER = path.join(__dirname, "analyze-complexity.js");
var BENCH_LOG = path.join(PLUGIN_ROOT, "logs", "benchmarks.jsonl");
var MAX_BENCH_HISTORY = 50;

// Canonical benchmark suite — covers every routing tier.
var SUITE = [
  // haiku tier (simple)
  { id: "h1", prompt: "fix the typo in README.md", expectedModel: "haiku", expectedRange: [1, 2] },
  { id: "h2", prompt: "rename calculateTotal to calcTotal", expectedModel: "haiku", expectedRange: [1, 2] },
  { id: "h3", prompt: "list files in src/", expectedModel: "haiku", expectedRange: [1, 2] },
  { id: "h4-hu", prompt: "javítsd ki az elgépelést a kódban", expectedModel: "haiku", expectedRange: [1, 2] },
  // sonnet tier (medium)
  { id: "s1", prompt: "add input validation to the login form", expectedModel: "sonnet", expectedRange: [3, 6] },
  { id: "s2", prompt: "write unit tests for the auth module", expectedModel: "sonnet", expectedRange: [3, 6] },
  { id: "s3", prompt: "investigate why the request times out at 30s", expectedModel: "sonnet", expectedRange: [3, 6] },
  // opus tier (complex)
  { id: "o1", prompt: "redesign the authentication architecture across all microservices", expectedModel: "opus", expectedRange: [7, 10] },
  { id: "o2", prompt: "perform a security audit on the OAuth implementation", expectedModel: "opus", expectedRange: [7, 10] },
  { id: "o3", prompt: "create a migration plan for the database schema change", expectedModel: "opus", expectedRange: [7, 10] }
];

function runOne(prompt) {
  try {
    var input = JSON.stringify({ prompt: prompt, session_id: "bench-" + Date.now(), cwd: PLUGIN_ROOT });
    var r = cp.spawnSync(process.execPath, [ANALYZER], {
      input: input, encoding: "utf8", timeout: 5000
    });
    if (!r.stdout) return { error: "no stdout" };
    var out = r.stdout;
    var modelMatch = out.match(/Recommended:\s*(\w+)/);
    var scoreMatch = out.match(/score\s+(\d+)\/10/);
    var catMatch = out.match(/Matched category:\s*"([^"]+)"/);
    var effortMatch = out.match(/Effort:\s*(\w+)/);
    return {
      model: modelMatch ? modelMatch[1] : "unknown",
      score: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
      category: catMatch ? catMatch[1] : "none",
      effort: effortMatch ? effortMatch[1] : null
    };
  } catch (e) {
    return { error: e.message };
  }
}

function lastBenchmark() {
  try {
    if (!fs.existsSync(BENCH_LOG)) return null;
    var lines = fs.readFileSync(BENCH_LOG, "utf8").trim().split("\n").filter(function(l) { return l.length > 0; });
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) { return null; }
}

function appendBenchmark(entry) {
  try {
    var dir = path.dirname(BENCH_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var existing = [];
    if (fs.existsSync(BENCH_LOG)) {
      existing = fs.readFileSync(BENCH_LOG, "utf8").trim().split("\n").filter(function(l) { return l.length > 0; });
    }
    existing.push(JSON.stringify(entry));
    if (existing.length > MAX_BENCH_HISTORY) existing = existing.slice(-MAX_BENCH_HISTORY);
    fs.writeFileSync(BENCH_LOG, existing.join("\n") + "\n", "utf8");
  } catch (e) { /* swallow */ }
}

function compareToLast(current, previous) {
  if (!previous || !previous.results) return { driftedCount: 0, drifts: [] };
  var prevById = {};
  previous.results.forEach(function(r) { prevById[r.id] = r; });
  var drifts = [];
  current.results.forEach(function(r) {
    var p = prevById[r.id];
    if (!p) return;
    var modelChanged = p.model !== r.model;
    var scoreDiff = Math.abs((r.score || 0) - (p.score || 0));
    if (modelChanged || scoreDiff >= 2) {
      drifts.push({
        id: r.id,
        prompt: r.prompt,
        before: { model: p.model, score: p.score },
        after: { model: r.model, score: r.score },
        modelChanged: modelChanged,
        scoreDiff: scoreDiff
      });
    }
  });
  return { driftedCount: drifts.length, drifts: drifts };
}

function runBenchmark(opts) {
  opts = opts || {};
  var results = [];
  var passed = 0, failed = 0;
  SUITE.forEach(function(item) {
    var r = runOne(item.prompt);
    var ok = false;
    if (!r.error) {
      var inRange = r.score >= item.expectedRange[0] && r.score <= item.expectedRange[1];
      var modelOk = r.model === item.expectedModel;
      ok = inRange && modelOk;
    }
    if (ok) passed++; else failed++;
    results.push({
      id: item.id, prompt: item.prompt,
      expectedModel: item.expectedModel, expectedRange: item.expectedRange,
      model: r.model, score: r.score, category: r.category, effort: r.effort,
      pass: ok, error: r.error
    });
  });

  var entry = {
    timestamp: new Date().toISOString(),
    suiteSize: SUITE.length,
    passed: passed, failed: failed,
    passRate: Math.round((passed / SUITE.length) * 100),
    results: results
  };

  var prev = lastBenchmark();
  var drift = compareToLast(entry, prev);
  entry.drift = drift;

  if (opts.append !== false) appendBenchmark(entry);

  return entry;
}

function formatHuman(entry) {
  var lines = [];
  lines.push("=== Auto-Benchmark Report ===");
  lines.push("Pass: " + entry.passed + "/" + entry.suiteSize + " (" + entry.passRate + "%)");
  lines.push("");
  lines.push("Per-prompt:");
  entry.results.forEach(function(r) {
    var mark = r.pass ? "✓" : "✗";
    lines.push("  " + mark + " " + r.id + " score=" + r.score + " model=" + r.model + " (expected: " + r.expectedModel + " " + r.expectedRange.join("-") + ") cat=" + r.category);
    if (r.error) lines.push("      ERROR: " + r.error);
  });
  if (entry.drift && entry.drift.driftedCount > 0) {
    lines.push("");
    lines.push("⚠ Drift since last benchmark: " + entry.drift.driftedCount + " case(s)");
    entry.drift.drifts.forEach(function(d) {
      lines.push("  - " + d.id + ": " + d.before.model + "(" + d.before.score + ") → " + d.after.model + "(" + d.after.score + ")");
    });
  }
  return lines.join("\n");
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var opts = {
    quiet: args.indexOf("--quiet") !== -1,
    json: args.indexOf("--json") !== -1,
    append: args.indexOf("--append") !== -1 || args.indexOf("--no-append") === -1
  };
  var entry = runBenchmark(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(entry, null, 2));
  } else if (opts.quiet) {
    process.stdout.write(entry.passed + "/" + entry.suiteSize + " passed (" + entry.passRate + "%)" + (entry.drift.driftedCount ? ", " + entry.drift.driftedCount + " drifts" : "") + "\n");
  } else {
    process.stdout.write(formatHuman(entry) + "\n");
  }
  process.exit(entry.failed > 0 ? 1 : 0);
}

module.exports = { runBenchmark: runBenchmark, SUITE: SUITE, formatHuman: formatHuman };
