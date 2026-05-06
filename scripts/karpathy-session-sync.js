#!/usr/bin/env node

/**
 * karpathy-session-sync.js — Throttled, background-spawned karpathy skill sync.
 *
 * Wired into runtime-check.js (SessionStart). The hook itself returns
 * immediately (exit 0); a detached child does the actual `git fetch` so a slow
 * network never blocks session start.
 *
 * Throttling: a timestamp file in logs/ records the last successful sync. We
 * skip the spawn if the last sync was within `intervalHours` (default 24h).
 *
 * Config (in config/task-routing.json):
 *
 *   "karpathySync": {
 *     "enabled": true,
 *     "intervalHours": 24,
 *     "background": true
 *   }
 *
 * Set `enabled: false` to disable. Set `background: false` to run synchronously
 * (useful for testing — adds a few seconds to session start over a fresh
 * network, no-op when cache is up to date).
 *
 * Silent on success. Errors are swallowed and never block session start; they
 * land in logs/hook-errors.jsonl via error-log.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var STAMP_FILE = path.join(PLUGIN_ROOT, "logs", "karpathy-last-sync.json");
var SYNC_SCRIPT = path.join(__dirname, "sync-karpathy-skills.js");
var SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function readConfig() {
  var c = readJsonSafe(CONFIG_FILE) || {};
  var ks = c.karpathySync || {};
  return {
    enabled: ks.enabled !== false,
    intervalHours: typeof ks.intervalHours === "number" && ks.intervalHours > 0 ? ks.intervalHours : 24,
    background: ks.background !== false
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
  } catch (e) { /* swallow — never block session start */ }
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
  // Update stamp BEFORE spawning so a slow sync doesn't trigger duplicate runs
  // on rapid session starts. A failed sync is fine: we'll retry next interval.
  writeStamp();

  var args = [SYNC_SCRIPT, SKILLS_DIR];
  if (cfg.background) {
    var child = cp.spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    if (child && typeof child.unref === "function") child.unref();
  } else {
    cp.spawnSync(process.execPath, args, { stdio: "ignore", timeout: 30000 });
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
        script: "karpathy-session-sync.js",
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
