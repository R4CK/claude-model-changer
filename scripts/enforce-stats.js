#!/usr/bin/env node
/**
 * enforce-stats.js - Stop hook to remind Claude to display session stats
 */

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
process.exit(0);
