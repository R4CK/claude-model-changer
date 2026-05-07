#!/usr/bin/env node
/**
 * enforce-stats.js - Stop hook for session stats display.
 *
 * IMPORTANT (v3.3.2 architectural note):
 *   Stop hook stdout is NOT injected into the assistant turn that just
 *   ended \u2014 Claude Code only feeds it back into the NEXT user turn via
 *   `hookSpecificOutput.additionalContext`. So this hook can only do two
 *   things:
 *     1. Log usage/state for debugging
 *     2. Inject the stats reminder for the NEXT prompt's UserPromptSubmit
 *
 *   For real-time display use the **statusline** (scripts/statusline.js)
 *   wired into ~/.claude/settings.json. That's the only display-on-every-
 *   turn mechanism Claude Code provides.
 *
 *   The stats display in routing output (UserPromptSubmit hook) is the
 *   "best effort" reminder shown to Claude before the response \u2014 it's a
 *   soft instruction that Claude usually but not always follows.
 */

"use strict";

try {
  var sessionUtils = require("./session-utils");

  var state = sessionUtils.loadSessionState();
  var summaryLines = sessionUtils.getSessionSummaryLines(state);
  if (summaryLines && summaryLines.length > 0) {
    var emojis = ["\ud83d\udcca", "\ud83d\udd0b", "\ud83d\udcc8", "\ud83d\udcca"];
    var lines = ["\ud83d\udcca Session stats (after last response):"];
    for (var i = 0; i < summaryLines.length; i++) {
      lines.push((emojis[i] || "\ud83d\udcc8") + " " + summaryLines[i]);
    }
    var combined = lines.join("\n");
    // v3.3.2: Use hookSpecificOutput so the stats appear at the start of
    // the NEXT user turn (additional context). This is the only reliable
    // way to surface stats given Claude Code's hook architecture.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: combined
      }
    }));
  }
} catch (err) {
  try {
    require("./lib/error-log").logHookError({
      script: "enforce-stats.js",
      phase: "main",
      error: err
    });
  } catch (e) { /* never cascade */ }
}
process.exit(0);
