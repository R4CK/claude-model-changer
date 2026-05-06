#!/usr/bin/env node
/**
 * git-commit-hook.js — PreToolUse hook for `git commit`/`git push` calls.
 *
 * Two purposes:
 *   1. Routing hint: large diffs imply complex commits → recommend bumping to
 *      sonnet for the message generation. Tiny diffs → haiku is fine.
 *   2. Safety: warns on `git push --force` to main/master (without blocking).
 *
 * Hook input (stdin JSON):
 *   { tool_name: "Bash", tool_input: { command: "git commit -m '...'" } }
 *
 * Output: silent for non-git commands; advisory systemMessage for git ops.
 *
 * Configurable via config.gitHooks:
 *   enabled, autoMessageModel ("haiku"|"sonnet"|"opus"|"auto"),
 *   warnForcePush (default true), trackStats (default true)
 */
"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var STATS_FILE = path.join(PLUGIN_ROOT, "logs", "git-router-stats.jsonl");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "task-routing.json");

function readJsonSafe(p) {
  try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); }
  catch (e) { return null; }
}

function appendStats(entry) {
  try {
    var dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(STATS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) { /* swallow */ }
}

function getDiffSize(cwd) {
  try {
    var r = cp.spawnSync("git", ["diff", "--cached", "--shortstat"], {
      cwd: cwd || process.cwd(), encoding: "utf8", timeout: 3000
    });
    if (r.status !== 0 || !r.stdout) return null;
    // e.g. " 5 files changed, 120 insertions(+), 35 deletions(-)"
    var m = r.stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return null;
    return {
      files: parseInt(m[1], 10) || 0,
      insertions: parseInt(m[2], 10) || 0,
      deletions: parseInt(m[3], 10) || 0
    };
  } catch (e) { return null; }
}

function recommendModelForDiff(diff, gitCfg) {
  var thresholds = (gitCfg && gitCfg.diffThresholds) || { sonnet: 50, opus: 500 };
  if (!diff) return { model: "haiku", reason: "no diff stats — defaulting cheap" };
  var changed = diff.insertions + diff.deletions;
  if (changed >= (thresholds.opus || 500)) return { model: "opus", reason: "large diff (" + changed + " lines)" };
  if (changed >= (thresholds.sonnet || 50)) return { model: "sonnet", reason: "moderate diff (" + changed + " lines)" };
  return { model: "haiku", reason: "small diff (" + changed + " lines)" };
}

function checkForcePush(cmd) {
  if (!/git\s+push/.test(cmd)) return null;
  if (!/(--force|--force-with-lease|-f\b)/.test(cmd)) return null;
  if (!/(\bmain\b|\bmaster\b)/.test(cmd)) return null;
  return { warning: "[Model Router] git push --force to main/master detected — confirm this is intentional" };
}

function classify(cmd) {
  if (/^\s*git\s+commit/.test(cmd)) return "commit";
  if (/^\s*git\s+push/.test(cmd)) return "push";
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
      if (!data || data.tool_name !== "Bash") { process.stdout.write(JSON.stringify({})); return; }

      var cmd = (data.tool_input && data.tool_input.command) || "";
      var op = classify(cmd);
      if (!op) { process.stdout.write(JSON.stringify({})); return; }

      var cfg = readJsonSafe(CONFIG_FILE) || {};
      var gitCfg = cfg.gitHooks || {};
      if (gitCfg.enabled === false) { process.stdout.write(JSON.stringify({})); return; }

      var messages = [];

      if (op === "commit") {
        var diff = getDiffSize();
        var rec = recommendModelForDiff(diff, gitCfg);
        var modelOverride = gitCfg.autoMessageModel && gitCfg.autoMessageModel !== "auto" ? gitCfg.autoMessageModel : rec.model;
        messages.push("[Git Router] Commit detected. Diff: " + (diff ? diff.files + " file(s), +" + diff.insertions + "/-" + diff.deletions : "(no stats)") + " → message generation should use " + modelOverride + " (" + rec.reason + ")");
        if (gitCfg.trackStats !== false) {
          appendStats({
            timestamp: new Date().toISOString(),
            op: "commit",
            diff: diff,
            recommended: rec.model,
            chosen: modelOverride
          });
        }
      } else if (op === "push") {
        var fp = (gitCfg.warnForcePush !== false) ? checkForcePush(cmd) : null;
        if (fp) messages.push(fp.warning);
        if (gitCfg.trackStats !== false) {
          appendStats({ timestamp: new Date().toISOString(), op: "push", forcePush: !!fp });
        }
      }

      if (messages.length === 0) { process.stdout.write(JSON.stringify({})); return; }
      process.stdout.write(JSON.stringify({
        systemMessage: messages.join("\n"),
        continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: messages.join("\n") }
      }));
    } catch (err) {
      try { require("./lib/error-log").logHookError({ script: "git-commit-hook.js", phase: "main", error: err }); }
      catch (e) { /* never cascade */ }
      process.stdout.write(JSON.stringify({}));
    }
  });
}

if (require.main === module) main();

module.exports = { classify: classify, recommendModelForDiff: recommendModelForDiff, checkForcePush: checkForcePush };
