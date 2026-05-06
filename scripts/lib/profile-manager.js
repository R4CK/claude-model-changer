#!/usr/bin/env node
/**
 * profile-manager.js — Multi-account / multi-profile config switching.
 *
 * Use cases:
 *   - Personal vs work Claude account with different `planLimits`
 *   - Solo dev vs team-shared config
 *   - Cost-saver vs quality-first profile that you toggle by mood
 *   - Per-project profile auto-switch (e.g., Hungarian project uses
 *     Hungarian-aware profile)
 *
 * Storage:
 *   ~/.claude/profiles/<name>.json     — partial config that overrides base
 *   ~/.claude/profiles/active.txt      — name of current profile (1 line)
 *   ~/.claude/profiles/.project-map.json — { "/path/to/project": "profile" }
 *
 * Profile JSON is deep-merged on top of `config/task-routing.json` at runtime.
 * Empty/missing → no overlay (vanilla base config wins).
 *
 * Auto-switch: if the current cwd matches a path-prefix in
 * `.project-map.json`, that profile is used instead of `active.txt`.
 *
 * Safe with file system race conditions (atomic write, read-on-error returns
 * default profile).
 */
"use strict";

var fs = require("fs");
var path = require("path");

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

var PROFILES_DIR = path.join(getHomeDir(), ".claude", "profiles");
var ACTIVE_FILE = path.join(PROFILES_DIR, "active.txt");
var PROJECT_MAP_FILE = path.join(PROFILES_DIR, ".project-map.json");

function ensureDir() {
  if (!fs.existsSync(PROFILES_DIR)) {
    try { fs.mkdirSync(PROFILES_DIR, { recursive: true }); } catch (e) {}
  }
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function writeJsonAtomic(file, data) {
  try {
    ensureDir();
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

function listProfiles() {
  ensureDir();
  try {
    return fs.readdirSync(PROFILES_DIR)
      .filter(function(f) { return f.endsWith(".json") && !f.startsWith("."); })
      .map(function(f) { return f.slice(0, -5); });
  } catch (e) { return []; }
}

function profileFile(name) {
  return path.join(PROFILES_DIR, name + ".json");
}

function loadProfile(name) {
  if (!name) return null;
  return readJsonSafe(profileFile(name));
}

function saveProfile(name, data) {
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) return false;
  return writeJsonAtomic(profileFile(name), data);
}

function deleteProfile(name) {
  if (!name) return false;
  try { fs.unlinkSync(profileFile(name)); return true; }
  catch (e) { return false; }
}

function getActiveProfileName() {
  try {
    if (!fs.existsSync(ACTIVE_FILE)) return null;
    var n = fs.readFileSync(ACTIVE_FILE, "utf8").trim();
    return /^[a-z0-9_-]+$/i.test(n) ? n : null;
  } catch (e) { return null; }
}

function setActiveProfile(name) {
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) return false;
  if (!fs.existsSync(profileFile(name))) return false;
  try { ensureDir(); fs.writeFileSync(ACTIVE_FILE, name, "utf8"); return true; }
  catch (e) { return false; }
}

function clearActiveProfile() {
  try { if (fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE); return true; }
  catch (e) { return false; }
}

// Path-prefix match: longest matching prefix wins.
function getProfileForCwd(cwd) {
  var map = readJsonSafe(PROJECT_MAP_FILE) || {};
  var keys = Object.keys(map);
  var match = null;
  for (var i = 0; i < keys.length; i++) {
    var p = path.normalize(keys[i]).toLowerCase();
    var c = path.normalize(cwd || "").toLowerCase();
    if (c.indexOf(p) === 0 && (match == null || p.length > match.length)) {
      match = p;
    }
  }
  if (match) return map[Object.keys(map).filter(function(k) { return path.normalize(k).toLowerCase() === match; })[0]] || null;
  return null;
}

function setProjectMapping(cwd, profileName) {
  var map = readJsonSafe(PROJECT_MAP_FILE) || {};
  if (profileName == null) {
    delete map[cwd];
  } else {
    map[cwd] = profileName;
  }
  return writeJsonAtomic(PROJECT_MAP_FILE, map);
}

// Resolve which profile to use for a given cwd. Project mapping wins over
// the global active.txt, which wins over null.
function resolveActiveProfile(cwd) {
  var byCwd = getProfileForCwd(cwd);
  if (byCwd) return byCwd;
  return getActiveProfileName();
}

// Deep-merge utility — profile values OVERRIDE base values (object-merge for
// objects, replace for primitives/arrays).
function deepMerge(base, overlay) {
  if (overlay == null) return base;
  if (typeof overlay !== "object" || Array.isArray(overlay)) return overlay;
  var out = Object.assign({}, base || {});
  Object.keys(overlay).forEach(function(k) {
    if (typeof overlay[k] === "object" && overlay[k] !== null && !Array.isArray(overlay[k]) &&
        typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], overlay[k]);
    } else {
      out[k] = overlay[k];
    }
  });
  return out;
}

// Apply the active profile (if any) on top of the base config.
function applyProfile(baseConfig, cwd) {
  var name = resolveActiveProfile(cwd);
  if (!name) return { config: baseConfig, profile: null };
  var overlay = loadProfile(name);
  if (!overlay) return { config: baseConfig, profile: null };
  return { config: deepMerge(baseConfig, overlay), profile: name };
}

module.exports = {
  PROFILES_DIR: PROFILES_DIR,
  listProfiles: listProfiles,
  loadProfile: loadProfile,
  saveProfile: saveProfile,
  deleteProfile: deleteProfile,
  getActiveProfileName: getActiveProfileName,
  setActiveProfile: setActiveProfile,
  clearActiveProfile: clearActiveProfile,
  getProfileForCwd: getProfileForCwd,
  setProjectMapping: setProjectMapping,
  resolveActiveProfile: resolveActiveProfile,
  applyProfile: applyProfile,
  deepMerge: deepMerge
};
