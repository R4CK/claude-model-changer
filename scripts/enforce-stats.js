#!/usr/bin/env node
/**
 * enforce-stats.js - Stop hook to remind Claude to display session stats
 */

"use strict";

try {
  var sessionUtils = require("./session-utils");

  var state = sessionUtils.loadSessionState();
  var summaryLines = sessionUtils.getSessionSummaryLines(state);
  if (summaryLines && summaryLines.length > 0) {
    var emojis = ["\ud83d\udcca", "\ud83d\udd0b", "\ud83d\udcc8", "\ud83d\udcca"];
    process.stdout.write("REMINDER: Append these stats lines at the end of your response:\n");
    for (var i = 0; i < summaryLines.length; i++) {
      process.stdout.write((emojis[i] || "\ud83d\udcc8") + " " + summaryLines[i] + "\n");
    }
  }
} catch (err) {
  // T2.4 (v2.5.0): log hook errors instead of silent failure
  try {
    require("./lib/error-log").logHookError({
      script: "enforce-stats.js",
      phase: "main",
      error: err
    });
  } catch (e) { /* never cascade */ }
}
process.exit(0);
