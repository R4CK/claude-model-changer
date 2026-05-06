#!/usr/bin/env node
/**
 * cc-version.js — Detect the host Claude Code version and infer feature flags.
 *
 * v2.1 (Q1 2026) introduced: native CLI binary, persistent model selection,
 * inline thinking progress, faster MCP startup, /resume rewrite. The plugin
 * uses these flags to:
 *   - Skip redundant model recommendation when the user has pinned a model
 *     via persistent selection (claudeFeatures.persistentModelSelection)
 *   - Emit thinking-budget hints in a CC2.1-compatible inline format
 *   - Trust faster MCP startup as a reason NOT to penalize MCP-tool prompts
 *
 * Resolution order:
 *   1. CC_VERSION env var (explicit override; useful in tests)
 *   2. `claude --version` (primary)
 *   3. settings.json `forceVersion` field (escape hatch)
 *   4. null (unknown — feature flags fall back to "conservative" defaults)
 *
 * Cached for the lifetime of the Node process. Detection is lazy: nothing runs
 * until detect() is called.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var _cache = null;

function compareSemver(a, b) {
  var pa = String(a || "0").replace(/[^\d.]/g, "").split(".").map(function(x) { return parseInt(x, 10) || 0; });
  var pb = String(b || "0").replace(/[^\d.]/g, "").split(".").map(function(x) { return parseInt(x, 10) || 0; });
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function tryClaudeVersion() {
  try {
    var r = cp.spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 3000 });
    if (r.status !== 0 || !r.stdout) return null;
    var m = r.stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function tryEnv() {
  return process.env.CC_VERSION || null;
}

function tryUserSettings() {
  try {
    var home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    var p = path.join(home, ".claude", "settings.json");
    if (!fs.existsSync(p)) return null;
    var s = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    return (s && s.forceVersion) || null;
  } catch (e) { return null; }
}

function inferFeatures(version) {
  // Conservative defaults when version is unknown.
  var f = {
    nativeBinary: false,
    persistentModelSelection: false,
    inlineThinkingProgress: false,
    fastMcpStartup: false,
    resumeRewrite: false
  };
  if (!version) return f;
  // CC 2.1 release line: every flag turns on at 2.1.0+.
  if (compareSemver(version, "2.1.0") >= 0) {
    f.nativeBinary = true;
    f.persistentModelSelection = true;
    f.inlineThinkingProgress = true;
    f.fastMcpStartup = true;
    f.resumeRewrite = true;
  }
  return f;
}

function detect() {
  if (_cache !== null) return _cache;
  var version = tryEnv() || tryClaudeVersion() || tryUserSettings();
  _cache = {
    version: version,
    features: inferFeatures(version),
    detectedFrom: tryEnv() ? "env" : (tryClaudeVersion() ? "cli" : (tryUserSettings() ? "settings" : "unknown"))
  };
  return _cache;
}

function clearCache() { _cache = null; }

module.exports = {
  detect: detect,
  clearCache: clearCache,
  compareSemver: compareSemver,
  inferFeatures: inferFeatures
};
