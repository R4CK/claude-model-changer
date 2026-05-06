#!/usr/bin/env node
/**
 * pre-tool-router.js — Single PreToolUse hook that delegates to feature-specific
 * detectors. Replaces the v3.2.0 dual-hook setup (context-bloat-detect.js +
 * git-commit-hook.js) where Bash commands were processed twice.
 *
 * Routes:
 *   - Read tool   → context-bloat-detect logic
 *   - Bash tool   → context-bloat-detect logic + git-commit-hook logic
 *
 * Outputs are merged: if both detectors emit a systemMessage, they're joined
 * with newlines into a single hookSpecificOutput.additionalContext.
 *
 * Backward compatibility: the original two scripts (context-bloat-detect.js,
 * git-commit-hook.js) are retained for direct invocation but no longer wired
 * into hooks.json.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");

var bloatDetect = require("./context-bloat-detect");
var gitHook = require("./git-commit-hook");

function readJsonSafe(p) {
  try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); }
  catch (e) { return null; }
}

function runBloat(data, cfg) {
  if (cfg && cfg.contextBloat && cfg.contextBloat.enabled === false) return null;
  var target = bloatDetect.extractTarget(data);
  if (!target.kind) return null;
  var historyFile = path.join(PLUGIN_ROOT, "logs", "tool-history.jsonl");
  var history = [];
  try {
    if (fs.existsSync(historyFile)) {
      history = fs.readFileSync(historyFile, "utf8").trim().split("\n")
        .filter(function(l) { return l.length > 0; })
        .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean);
    }
  } catch (e) {}
  var bloatCfg = (cfg && cfg.contextBloat) || {};
  var bloat = bloatDetect.checkBloat(target, history, {
    duplicateThreshold: bloatCfg.duplicateThreshold || 2,
    windowMs: (bloatCfg.windowMinutes || 30) * 60 * 1000
  });
  bloatDetect.appendHistory({
    timestamp: new Date().toISOString(),
    kind: target.kind,
    target: target.target,
    tool: data.tool_name || "unknown"
  });
  return bloat ? bloat.message : null;
}

function runGit(data, cfg) {
  if (data.tool_name !== "Bash") return null;
  if (cfg && cfg.gitHooks && cfg.gitHooks.enabled === false) return null;
  var cmd = (data.tool_input && data.tool_input.command) || "";
  var op = gitHook.classify(cmd);
  if (!op) return null;
  var msgs = [];
  var gitCfg = (cfg && cfg.gitHooks) || {};
  if (op === "commit") {
    // We can't easily import getDiffSize without re-spawning git; just emit
    // a routing reminder and let the user decide. The dedicated git-commit-hook
    // (still callable directly) handles diff stats when invoked standalone.
    msgs.push("[Git Router] Commit detected. For diff-aware model routing, see /git-router-stats.");
  } else if (op === "push") {
    var fp = (gitCfg.warnForcePush !== false) ? gitHook.checkForcePush(cmd) : null;
    if (fp) msgs.push(fp.warning);
  }
  if (gitCfg.trackStats !== false) {
    try {
      var statsFile = path.join(PLUGIN_ROOT, "logs", "git-router-stats.jsonl");
      var dir = path.dirname(statsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(statsFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        op: op,
        cmd: cmd.slice(0, 120)
      }) + "\n", "utf8");
    } catch (e) {}
  }
  return msgs.length > 0 ? msgs.join("\n") : null;
}

function main() {
  var input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function(c) { input += c; });
  process.stdin.on("end", function() {
    try {
      if (!input || input.trim().length === 0) { process.stdout.write(JSON.stringify({})); return; }
      var data = null;
      try { data = JSON.parse(input); } catch (e) { process.stdout.write(JSON.stringify({})); return; }
      if (!data || !data.tool_name) { process.stdout.write(JSON.stringify({})); return; }

      var cfg = readJsonSafe(CONFIG_FILE) || {};

      // Run feature detectors (each guarded by its own config block)
      var bloatMsg = null, gitMsg = null;
      try { bloatMsg = runBloat(data, cfg); } catch (e) {}
      try { gitMsg = runGit(data, cfg); } catch (e) {}

      var msgs = [bloatMsg, gitMsg].filter(Boolean);
      if (msgs.length === 0) { process.stdout.write(JSON.stringify({})); return; }

      var combined = msgs.join("\n");
      process.stdout.write(JSON.stringify({
        systemMessage: combined,
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: combined
        }
      }));
    } catch (err) {
      try { require("./lib/error-log").logHookError({ script: "pre-tool-router.js", phase: "main", error: err }); }
      catch (e) { /* never cascade */ }
      process.stdout.write(JSON.stringify({}));
    }
  });
}

if (require.main === module) main();

module.exports = { runBloat: runBloat, runGit: runGit };
