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

// v3.1.1: kick off karpathy skill sync (throttled, backgrounded by default).
// This is fire-and-forget — spawn a detached child that returns immediately
// so it never adds latency to session start. See scripts/karpathy-session-sync.js.
try {
  var syncChild = cp.spawn(process.execPath, [path.join(__dirname, "karpathy-session-sync.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  if (syncChild && typeof syncChild.unref === "function") syncChild.unref();
} catch (e) { /* never block session start */ }

// v3.5.0: external skills sync (open-design, ui-ux-pro-max, awesome-claude-skills,
// everything-claude-code) — same throttled background pattern. Config in
// config/external-skills.json. The downstream script does a cheap `git ls-remote`
// per repo and only fetches/copies when the remote HEAD actually changed.
try {
  var extChild = cp.spawn(process.execPath, [path.join(__dirname, "external-skills-session-sync.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  if (extChild && typeof extChild.unref === "function") extChild.unref();
} catch (e) { /* never block session start */ }

// v3.7.0: plugin self-update — keeps the plugin's OWN code current with GitHub
// (distinct from the skills sync above). Throttled (default 24h), backgrounded,
// and a no-op unless GitHub's main package.json version is newer than the
// running install. Only acts on an installed cache copy, never a dev checkout.
// Config in config/task-routing.json -> "selfUpdate".
try {
  var updChild = cp.spawn(process.execPath, [path.join(__dirname, "self-update-session-sync.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  if (updChild && typeof updChild.unref === "function") updChild.unref();
} catch (e) { /* never block session start */ }

// v3.7.0: one-time "plugin updated" notice. The self-update writes a marker
// into the NEW version dir's logs/; the first session running that version
// surfaces it once, then deletes it. Guarded so a stale marker from a
// different version never shows.
try {
  var fsU = require("fs");
  var markerPath = path.join(PLUGIN_ROOT, "logs", "self-update-applied.json");
  if (fsU.existsSync(markerPath)) {
    var marker = JSON.parse(fsU.readFileSync(markerPath, "utf8").replace(/^﻿/, ""));
    var pkgU = JSON.parse(fsU.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8").replace(/^﻿/, ""));
    if (marker && marker.to && pkgU && pkgU.version === marker.to) {
      process.stdout.write("[claude-model-changer] ✓ Plugin self-updated " +
        (marker.from || "?") + " → " + marker.to + " (now active).\n");
    }
    try { fsU.unlinkSync(markerPath); } catch (e) {}
  }
} catch (e) { /* never block session start */ }

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
  // T2.4 (v2.5.0): log runtime-check failures; never break session start
  try {
    require("./lib/error-log").logHookError({
      script: "runtime-check.js",
      phase: "main",
      error: err
    });
  } catch (e) { /* never cascade */ }
  process.exit(0);
}
