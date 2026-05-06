#!/usr/bin/env node
/**
 * context-bloat-detect.js — PreToolUse hook for Read|Bash.
 *
 * Tracks every Read tool call and Bash command (cat/head/tail/grep style)
 * to detect:
 *   - Repeated reads of the same file (duplicate token waste)
 *   - Large files being read whole when a slice would do
 *   - MCP tool responses likely to balloon context
 *
 * Stores recent history in logs/tool-history.jsonl (capped at 200 lines).
 * On detection of bloat, emits a system-reminder to the model via stdout
 * JSON. Never blocks the tool call.
 *
 * Hook input (stdin JSON):
 *   { tool_name: "Read", tool_input: { file_path: "..." } }
 *   { tool_name: "Bash", tool_input: { command: "..." } }
 *
 * Output (stdout JSON):
 *   {} (silent, normal case) — OR
 *   { "systemMessage": "...bloat warning...", "continue": true }
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var HISTORY_FILE = path.join(PLUGIN_ROOT, "logs", "tool-history.jsonl");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");
var MAX_HISTORY = 200;

function readJsonSafe(p) {
  try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); }
  catch (e) { return null; }
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function appendHistory(entry) {
  try {
    var dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var existing = readHistory();
    existing.push(entry);
    if (existing.length > MAX_HISTORY) existing = existing.slice(-MAX_HISTORY);
    var atomicTmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(atomicTmp, existing.map(function(e) { return JSON.stringify(e); }).join("\n") + "\n", "utf8");
    fs.renameSync(atomicTmp, HISTORY_FILE);
  } catch (e) { /* swallow — never block */ }
}

function extractTarget(input) {
  if (!input || !input.tool_input) return { kind: null, target: null };
  if (input.tool_name === "Read") {
    return { kind: "read", target: input.tool_input.file_path || null };
  }
  if (input.tool_name === "Bash") {
    var cmd = input.tool_input.command || "";
    // pull file path-like tokens out of common viewer commands
    var m = cmd.match(/^(?:cat|head|tail|less|more|bat)\s+(\S+)/);
    if (m) return { kind: "bash-read", target: m[1] };
    if (/grep|rg|ack/.test(cmd)) return { kind: "bash-grep", target: cmd.slice(0, 80) };
    return { kind: "bash-other", target: cmd.slice(0, 80) };
  }
  return { kind: null, target: null };
}

function checkBloat(target, history, opts) {
  if (!target || !target.target) return null;
  if (target.kind !== "read" && target.kind !== "bash-read") return null;
  var ago = Date.now() - (opts.windowMs || 30 * 60 * 1000);
  var matches = history.filter(function(h) {
    return h.target === target.target && Date.parse(h.timestamp) >= ago;
  });
  if (matches.length >= (opts.duplicateThreshold || 2)) {
    return {
      kind: "duplicate-read",
      target: target.target,
      count: matches.length + 1,
      message: "[Model Router] Context bloat: '" + target.target + "' read " + (matches.length + 1) + "x in last " + Math.round((opts.windowMs || 1800000) / 60000) + " min — consider /clear or pinning to a skill"
    };
  }
  return null;
}

function main() {
  var input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function(c) { input += c; });
  process.stdin.on("end", function() {
    try {
      if (!input || input.trim().length === 0) {
        process.stdout.write(JSON.stringify({}));
        return;
      }
      var data = null;
      try { data = JSON.parse(input); } catch (e) { process.stdout.write(JSON.stringify({})); return; }

      var cfg = readJsonSafe(CONFIG_FILE) || {};
      var bloatCfg = cfg.contextBloat || {};
      if (bloatCfg.enabled === false) { process.stdout.write(JSON.stringify({})); return; }

      var target = extractTarget(data);
      if (!target.kind) { process.stdout.write(JSON.stringify({})); return; }

      var history = readHistory();
      var bloat = checkBloat(target, history, {
        duplicateThreshold: bloatCfg.duplicateThreshold || 2,
        windowMs: (bloatCfg.windowMinutes || 30) * 60 * 1000
      });

      // Always append the current call to history
      appendHistory({
        timestamp: new Date().toISOString(),
        kind: target.kind,
        target: target.target,
        tool: data.tool_name || "unknown"
      });

      if (bloat) {
        process.stdout.write(JSON.stringify({
          systemMessage: bloat.message,
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: bloat.message
          }
        }));
      } else {
        process.stdout.write(JSON.stringify({}));
      }
    } catch (err) {
      try { require("./lib/error-log").logHookError({ script: "context-bloat-detect.js", phase: "main", error: err }); }
      catch (e) { /* never cascade */ }
      process.stdout.write(JSON.stringify({}));
    }
  });
}

if (require.main === module) main();

module.exports = { extractTarget: extractTarget, checkBloat: checkBloat, appendHistory: appendHistory };
