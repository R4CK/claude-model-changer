#!/usr/bin/env node

/**
 * Runtime integrity check for the plugin.
 *
 * Wired to SessionStart in hooks/hooks.json. Runs once per session start (NOT
 * per prompt) to keep latency low. If preflight detects a problem, this script
 * emits a warning that Claude surfaces in the session context. On success it
 * stays silent.
 *
 * Strategy: shell out to scripts/preflight.js --runtime --json and parse the
 * result. preflight.js never touches anything destructive in --runtime mode.
 */

"use strict";

var path = require("path");
var cp = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var PREFLIGHT = path.join(__dirname, "preflight.js");

try {
  var result = cp.spawnSync(process.execPath, [PREFLIGHT, "--runtime", "--json", "--quiet"], {
    encoding: "utf8",
    timeout: 8000
  });

  if (!result.stdout) {
    // Silent on failure to read - never block session start
    process.exit(0);
  }

  var parsed;
  try { parsed = JSON.parse(result.stdout); } catch (e) { process.exit(0); }

  if (parsed && parsed.passed && !parsed.anyFailed) {
    // All clear. Stay silent.
    process.exit(0);
  }

  var problems = [];
  for (var i = 0; i < parsed.results.length; i++) {
    var r = parsed.results[i];
    if (!r.ok) {
      problems.push((r.fatal ? "[FATAL] " : "[warn] ") + r.name + " - " + r.detail);
    }
  }

  if (problems.length === 0) process.exit(0);

  var lines = [];
  lines.push("=== claude-model-changer: runtime integrity check ===");
  lines.push("Plugin root: " + PLUGIN_ROOT);
  for (var j = 0; j < problems.length; j++) lines.push("  " + problems[j]);
  lines.push("");
  lines.push("Re-run installer to repair: install.sh / install.ps1 / install.bat");
  lines.push("Or run preflight standalone: node scripts/preflight.js");

  process.stdout.write(lines.join("\n"));
  process.exit(0);
} catch (err) {
  // Never break session start
  process.exit(0);
}
