#!/usr/bin/env node
/**
 * memory.js - Read user feedback signals from Claude Code's auto-memory system.
 *
 * The auto-memory directory holds per-project user/feedback/project/reference
 * memories. We use it (read-only) to influence routing in two ways:
 *   1. Detect "concise responses preferred" / "terse" feedback memories — if
 *      present, default-effort tilts toward LOW.
 *   2. Detect "thorough" / "step-by-step" feedback memories — tilts toward HIGH.
 *
 * The integration is best-effort and silent: if the memory directory is missing
 * or unreadable, we return null. Auto-memory may be disabled via
 * config.autoMemoryEnabled = false in user settings.
 */
"use strict";

var fs = require("fs");
var path = require("path");

// Match Claude Code's project-directory sanitization. Empirically the harness
// replaces any character that isn't a letter or digit (slashes, colons, dots,
// spaces) with a single hyphen — observed: "C:/Users/deutsch.peter/Desktop/X"
// → "C--Users-deutsch-peter-Desktop-X". We do NOT collapse repeated hyphens
// (the harness keeps them, e.g. the leading "C--" from "C:/").
function sanitizeCwd(cwd) {
  if (!cwd) return "";
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function getMemoryDir(cwd) {
  var home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return null;
  var sanitized = sanitizeCwd(cwd || process.cwd());
  return path.join(home, ".claude", "projects", sanitized, "memory");
}

function readMemoryIndex(memoryDir) {
  try {
    var indexPath = path.join(memoryDir, "MEMORY.md");
    if (!fs.existsSync(indexPath)) return "";
    return fs.readFileSync(indexPath, "utf8").replace(/^﻿/, "");
  } catch (e) { return ""; }
}

var TERSE_HINTS = [
  "concise", "terse", "short", "brief", "no preamble",
  "tömör", "rövid", "lényegre törő", "ne írj sokat"
];
var THOROUGH_HINTS = [
  "step-by-step", "thorough", "detailed", "verbose",
  "lépésről lépésre", "részletes", "alapos"
];

function readUserPreferences(cwd, config) {
  var memCfg = (config && config.memoryIntegration) || {};
  if (memCfg.enabled === false) return null;
  var dir = (typeof memCfg.path === "string" && memCfg.path) ? memCfg.path : getMemoryDir(cwd);
  if (!dir) return null;
  var content = readMemoryIndex(dir);
  if (!content) return { available: false, terse: false, thorough: false, dir: dir };
  var lower = content.toLowerCase();
  var terse = TERSE_HINTS.some(function(h) { return lower.indexOf(h) !== -1; });
  var thorough = THOROUGH_HINTS.some(function(h) { return lower.indexOf(h) !== -1; });
  return {
    available: true,
    terse: terse,
    thorough: thorough,
    indexLength: content.length,
    dir: dir
  };
}

// Map memory preferences to an effort hint. Returns null if no preference,
// or { level, reason } to nudge the effort decision.
function effortHintFromMemory(prefs) {
  if (!prefs || !prefs.available) return null;
  if (prefs.thorough && !prefs.terse) return { level: "high", reason: "memory: user prefers thorough/step-by-step responses" };
  if (prefs.terse && !prefs.thorough) return { level: "low", reason: "memory: user prefers concise/terse responses" };
  return null;
}

module.exports = {
  sanitizeCwd: sanitizeCwd,
  getMemoryDir: getMemoryDir,
  readUserPreferences: readUserPreferences,
  effortHintFromMemory: effortHintFromMemory
};
