#!/usr/bin/env node
/**
 * Zero-dependency test runner.
 *
 * Discovers *.test.js files in this directory, requires each, and tracks
 * pass/fail counts. Each test file exposes a `describe(name, cases, fn)`
 * function via the shared `./harness` module.
 *
 * Exit code: 0 if all pass, 1 if any fail.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var harness = require("./harness");

var TESTS_DIR = __dirname;
var testFiles = fs.readdirSync(TESTS_DIR)
  .filter(function(f) { return /\.test\.js$/.test(f); })
  .sort();

if (testFiles.length === 0) {
  console.log("No *.test.js files found in " + TESTS_DIR);
  process.exit(0);
}

console.log("Running " + testFiles.length + " test file(s):\n");

testFiles.forEach(function(f) {
  console.log("=== " + f + " ===");
  harness.resetCounters();
  require(path.join(TESTS_DIR, f));
  var summary = harness.getSummary();
  console.log("  " + summary.passed + " passed, " + summary.failed + " failed, " + summary.total + " total\n");
});

var overall = harness.getOverallTotals();
console.log("==========================================");
console.log("TOTAL: " + overall.passed + " passed, " + overall.failed + " failed, " + overall.total + " total");
console.log("==========================================");

process.exit(overall.failed > 0 ? 1 : 0);
