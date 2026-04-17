"use strict";

/**
 * Minimal test harness - zero dependencies, uses Node's built-in assert.
 *
 * Usage inside *.test.js:
 *   var h = require("./harness");
 *   var assert = require("assert");
 *
 *   h.describe("scoreWordCount", function(it) {
 *     it("tiny prompt returns low score", function() {
 *       assert.strictEqual(scoring.scoreWordCount(3), 1);
 *     });
 *   });
 */

var _fileTotals = { passed: 0, failed: 0, total: 0 };
var _overallTotals = { passed: 0, failed: 0, total: 0 };

function resetCounters() {
  _fileTotals = { passed: 0, failed: 0, total: 0 };
}

function getSummary() {
  return { passed: _fileTotals.passed, failed: _fileTotals.failed, total: _fileTotals.total };
}

function getOverallTotals() {
  return { passed: _overallTotals.passed, failed: _overallTotals.failed, total: _overallTotals.total };
}

/**
 * Run a named suite. The callback receives an `it(name, fn)` function.
 * Each `it` runs synchronously; any thrown error marks the test as failed.
 */
function describe(suiteName, suiteFn) {
  console.log("  " + suiteName);

  function it(testName, testFn) {
    _fileTotals.total++;
    _overallTotals.total++;
    try {
      testFn();
      _fileTotals.passed++;
      _overallTotals.passed++;
      console.log("    \u2713 " + testName);
    } catch (err) {
      _fileTotals.failed++;
      _overallTotals.failed++;
      console.log("    \u2717 " + testName);
      console.log("      " + (err.message || err));
      if (err.stack) {
        var firstStackLine = err.stack.split("\n")[1];
        if (firstStackLine) console.log("      " + firstStackLine.trim());
      }
    }
  }

  try {
    suiteFn(it);
  } catch (err) {
    console.log("    [suite error] " + (err.message || err));
    _fileTotals.failed++;
    _overallTotals.failed++;
    _fileTotals.total++;
    _overallTotals.total++;
  }
}

module.exports = {
  describe: describe,
  resetCounters: resetCounters,
  getSummary: getSummary,
  getOverallTotals: getOverallTotals
};
