#!/usr/bin/env node

/**
 * self-update-session-sync.js — throttled, background-spawned plugin self-update.
 *
 * Wired into runtime-check.js (SessionStart). The hook returns immediately;
 * a detached child runs plugin-self-update.js so a slow network never blocks
 * session start. Throttled via a timestamp file (default 24h).
 *
 * Config (config/task-routing.json -> "selfUpdate"):
 *   { "enabled": true, "intervalHours": 24, "background": true }
 *
 * Set enabled:false to opt out of automatic plugin updates. The external-skills
 * sync (skills/agents/commands) is independent of this and keeps running.
 *
 * Silent on success; errors are swallowed and never block session start.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var STAMP_FILE = path.join(PLUGIN_ROOT, "logs", "self-update-last-check.json");
var UPDATE_SCRIPT = path.join(__dirname, "plugin-self-update.js");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function readConfig() {
  var c = readJsonSafe(CONFIG_FILE) || {};
  var su = c.selfUpdate || {};
  return {
    // Default ON: the user explicitly wants the plugin to stay current.
    enabled: su.enabled !== false,
    intervalHours: typeof su.intervalHours === "number" && su.intervalHours > 0 ? su.intervalHours : 24,
    background: su.background !== false
  };
}

function readStamp() {
  var data = readJsonSafe(STAMP_FILE);
  if (!data || !data.lastCheckIso) return null;
  var t = Date.parse(data.lastCheckIso);
  return isNaN(t) ? null : t;
}

function writeStamp() {
  try {
    var dir = path.dirname(STAMP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STAMP_FILE, JSON.stringify({ lastCheckIso: new Date().toISOString() }), "utf8");
  } catch (e) { /* swallow */ }
}

function shouldCheck(cfg) {
  if (!cfg.enabled) return false;
  var last = readStamp();
  if (last == null) return true;
  return (Date.now() - last) >= cfg.intervalHours * 3600 * 1000;
}

function spawnUpdate(cfg) {
  // Stamp BEFORE spawning so rapid session starts don't double-spawn.
  writeStamp();
  if (cfg.background) {
    var child = cp.spawn(process.execPath, [UPDATE_SCRIPT], {
      detached: true, stdio: "ignore", windowsHide: true
    });
    if (child && typeof child.unref === "function") child.unref();
  } else {
    cp.spawnSync(process.execPath, [UPDATE_SCRIPT], { stdio: "ignore", timeout: 120000 });
  }
}

function main() {
  try {
    var cfg = readConfig();
    if (!shouldCheck(cfg)) return;
    spawnUpdate(cfg);
  } catch (err) {
    try {
      require("./lib/error-log").logHookError({ script: "self-update-session-sync.js", phase: "main", error: err });
    } catch (e) { /* never cascade */ }
  }
}

if (require.main === module) main();

module.exports = { readStamp: readStamp, shouldCheck: shouldCheck, readConfig: readConfig };
