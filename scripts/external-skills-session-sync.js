#!/usr/bin/env node

/**
 * external-skills-session-sync.js — Throttled, background-spawned external
 * skill sync. Mirrors the karpathy-session-sync.js pattern, but drives
 * sync-external-skills.js (which reads config/external-skills.json).
 *
 * Wired into runtime-check.js (SessionStart). The hook itself returns
 * immediately (exit 0); a detached child does the actual git work so a slow
 * network never blocks session start.
 *
 * Throttling: a timestamp file in logs/ records the last successful sync. We
 * skip the spawn entirely if the last sync was within `intervalHours`
 * (default 24h). The downstream sync script ALSO does a per-repo remote-HEAD
 * check, so even when the timer fires we only do real work for repos that
 * actually changed.
 *
 * Config (in config/external-skills.json -> "sync" block):
 *
 *   "sync": {
 *     "enabled": true,
 *     "intervalHours": 24,
 *     "background": true
 *   }
 *
 * Silent on success. Errors are swallowed and never block session start; they
 * land in logs/hook-errors.jsonl via error-log.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var STAMP_FILE = path.join(PLUGIN_ROOT, "logs", "external-skills-last-sync.json");
var SYNC_SCRIPT = path.join(__dirname, "sync-external-skills.js");
// v3.6.0: pass the plugin root (not just skills/). The syncer routes items
// into skills/, agents/, commands/, or hooks/ depending on each source's
// `kind`. Trailing /skills is still auto-stripped by the syncer for
// backward compatibility with v3.5.0 callers.
var DEST_ARG = PLUGIN_ROOT;
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "external-skills.json");

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function readConfig() {
  var c = readJsonSafe(CONFIG_FILE) || {};
  var s = c.sync || {};
  return {
    enabled: s.enabled !== false,
    intervalHours: typeof s.intervalHours === "number" && s.intervalHours > 0 ? s.intervalHours : 24,
    background: s.background !== false
  };
}

function readStamp() {
  var data = readJsonSafe(STAMP_FILE);
  if (!data || !data.lastSyncIso) return null;
  var t = Date.parse(data.lastSyncIso);
  return isNaN(t) ? null : t;
}

function writeStamp() {
  try {
    var dir = path.dirname(STAMP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STAMP_FILE, JSON.stringify({ lastSyncIso: new Date().toISOString() }), "utf8");
  } catch (e) { /* swallow */ }
}

function shouldSync(cfg) {
  if (!cfg.enabled) return false;
  var last = readStamp();
  if (last == null) return true;
  var ageMs = Date.now() - last;
  var thresholdMs = cfg.intervalHours * 3600 * 1000;
  return ageMs >= thresholdMs;
}

function spawnSync(cfg) {
  // Update stamp BEFORE spawning so a slow sync doesn't trigger duplicate
  // runs on rapid session starts. A failed sync is fine: per-repo remote-HEAD
  // check will retry actual work next interval.
  writeStamp();

  var args = [SYNC_SCRIPT, DEST_ARG];
  if (cfg.background) {
    var child = cp.spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    if (child && typeof child.unref === "function") child.unref();
  } else {
    cp.spawnSync(process.execPath, args, { stdio: "ignore", timeout: 120000 });
  }
}

function main() {
  try {
    var cfg = readConfig();
    if (!shouldSync(cfg)) return;
    spawnSync(cfg);
  } catch (err) {
    try {
      require("./lib/error-log").logHookError({
        script: "external-skills-session-sync.js",
        phase: "main",
        error: err
      });
    } catch (e) { /* never cascade */ }
  }
}

if (require.main === module) main();

module.exports = {
  readStamp: readStamp,
  shouldSync: shouldSync,
  readConfig: readConfig
};
