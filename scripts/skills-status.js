#!/usr/bin/env node

/**
 * skills-status.js — report on the auto-synced external skills/agents/commands.
 *
 * Surfaces what's currently installed (per repo), each repo's enabled state and
 * last-synced commit, the sync/self-update throttle stamps, and a rough estimate
 * of the context overhead the synced items add. Backs the /skills-status command.
 *
 * Usage:
 *   node scripts/skills-status.js            # human-readable
 *   node scripts/skills-status.js --json     # machine-readable
 */

"use strict";

var fs = require("fs");
var path = require("path");
var proc = require("child_process");
var sync = require("./sync-external-skills");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "external-skills.json");

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function countByPrefix(dir, prefixes) {
  var n = 0;
  if (!fs.existsSync(dir)) return 0;
  var entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return 0; }
  entries.forEach(function (name) {
    for (var i = 0; i < prefixes.length; i++) {
      if (name.indexOf(prefixes[i]) === 0) { n++; break; }
    }
  });
  return n;
}

function approxItemTokens(dir, prefixes) {
  // Claude Code loads each skill's name + SKILL.md description. We approximate
  // by reading the first ~400 bytes of each item's SKILL.md / the .md file and
  // dividing characters by 4. Cheap and good enough for an overhead estimate.
  var total = 0;
  if (!fs.existsSync(dir)) return 0;
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  entries.forEach(function (e) {
    var owned = false;
    for (var i = 0; i < prefixes.length; i++) { if (e.name.indexOf(prefixes[i]) === 0) { owned = true; break; } }
    if (!owned) return;
    var mdPath = e.isDirectory()
      ? path.join(dir, e.name, "SKILL.md")
      : path.join(dir, e.name);
    try {
      var fd = fs.openSync(mdPath, "r");
      var buf = Buffer.alloc(400);
      var read = fs.readSync(fd, buf, 0, 400, 0);
      fs.closeSync(fd);
      total += Math.round(read / 4);
    } catch (er) { total += 10; }
  });
  return total;
}

function localSha(repoName) {
  try {
    var dir = path.join(sync.getCacheRoot(), repoName);
    if (!fs.existsSync(path.join(dir, ".git"))) return null;
    var r = proc.spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : null;
  } catch (e) { return null; }
}

function readStamp(file, key) {
  var d = readJsonSafe(path.join(PLUGIN_ROOT, "logs", file));
  return d && d[key] ? d[key] : null;
}

function buildStatus() {
  var cfg = readJsonSafe(CONFIG_FILE) || { repos: [] };
  var skillsDir = path.join(PLUGIN_ROOT, "skills");
  var agentsDir = path.join(PLUGIN_ROOT, "agents");
  var commandsDir = path.join(PLUGIN_ROOT, "commands");

  var repos = (cfg.repos || []).map(function (r) {
    var prefixes = sync.ownedPrefixes(r);
    return {
      name: r.name,
      url: r.url,
      enabled: r.enabled !== false,
      prefixes: prefixes,
      lastSyncedSha: localSha(r.name),
      installed: {
        skills: countByPrefix(skillsDir, prefixes),
        agents: countByPrefix(agentsDir, prefixes),
        commands: countByPrefix(commandsDir, prefixes)
      },
      approxContextTokens:
        approxItemTokens(skillsDir, prefixes) +
        approxItemTokens(agentsDir, prefixes) +
        approxItemTokens(commandsDir, prefixes)
    };
  });

  var totals = repos.reduce(function (acc, r) {
    if (!r.enabled) return acc;
    acc.skills += r.installed.skills;
    acc.agents += r.installed.agents;
    acc.commands += r.installed.commands;
    acc.approxContextTokens += r.approxContextTokens;
    return acc;
  }, { skills: 0, agents: 0, commands: 0, approxContextTokens: 0 });

  return {
    repos: repos,
    activeTotals: totals,
    sync: {
      lastExternalSync: readStamp("external-skills-last-sync.json", "lastSyncIso"),
      lastSelfUpdateCheck: readStamp("self-update-last-check.json", "lastCheckIso"),
      lastKarpathySync: readStamp("karpathy-last-sync.json", "lastSyncIso"),
      intervalHours: (cfg.sync && cfg.sync.intervalHours) || 24,
      enabled: !(cfg.sync && cfg.sync.enabled === false)
    },
    hint: "Disable a heavy repo with \"enabled\": false in config/external-skills.json, then the next sync prunes its items (frees ~its approxContextTokens of context)."
  };
}

function formatHuman(st) {
  var lines = [];
  lines.push("=== External skills sync status ===");
  lines.push("");
  st.repos.forEach(function (r) {
    var flag = r.enabled ? "✓" : "✗ disabled";
    var inv = r.installed.skills + " skills, " + r.installed.agents + " agents, " + r.installed.commands + " cmds";
    lines.push(flag + "  " + r.name + "  [" + (r.prefixes.join(", ") || "—") + "]  sha=" + (r.lastSyncedSha || "?"));
    lines.push("     " + inv + "  · ~" + r.approxContextTokens + " ctx tokens");
  });
  lines.push("");
  lines.push("ACTIVE TOTAL: " + st.activeTotals.skills + " skills + " + st.activeTotals.agents +
    " agents + " + st.activeTotals.commands + " commands  · ~" + st.activeTotals.approxContextTokens + " context tokens");
  lines.push("");
  lines.push("Last external sync: " + (st.sync.lastExternalSync || "never"));
  lines.push("Last self-update check: " + (st.sync.lastSelfUpdateCheck || "never"));
  lines.push("Sync interval: " + st.sync.intervalHours + "h  (enabled: " + st.sync.enabled + ")");
  lines.push("");
  lines.push(st.hint);
  return lines.join("\n");
}

if (require.main === module) {
  var asJson = process.argv.indexOf("--json") !== -1;
  var st = buildStatus();
  process.stdout.write(asJson ? JSON.stringify(st, null, 2) : formatHuman(st));
  process.stdout.write("\n");
  process.exit(0);
}

module.exports = { buildStatus: buildStatus, formatHuman: formatHuman };
