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

// Approximate the context tokens a list of items adds (Claude Code loads each
// skill/agent name + description). Reads ~400 bytes of each item's SKILL.md / md
// file, chars/4. Cheap upper-bound estimate.
function approxTokensFor(kindDir, names) {
  var dir = path.join(PLUGIN_ROOT, kindDir);
  var total = 0;
  names.forEach(function (name) {
    var p = path.join(dir, name);
    var mdPath = p;
    try { if (fs.statSync(p).isDirectory()) mdPath = path.join(p, "SKILL.md"); } catch (e) { return; }
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
  // The manifest records exactly which items each repo installed (after the
  // first-wins dedup), so per-repo counts come straight from it — no prefixes.
  var manifest = readJsonSafe(sync.manifestPath(PLUGIN_ROOT)) || {};

  var repos = (cfg.repos || []).map(function (r) {
    var m = manifest[r.name] || {};
    var skills = m.skill || [];
    var agents = m.agent || [];
    var commands = m.command || [];
    return {
      name: r.name,
      url: r.url,
      enabled: r.enabled !== false,
      lastSyncedSha: localSha(r.name),
      installed: { skills: skills.length, agents: agents.length, commands: commands.length },
      approxContextTokens:
        approxTokensFor("skills", skills) +
        approxTokensFor("agents", agents) +
        approxTokensFor("commands", commands)
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

  // Dedup decisions (which repo won each same-name conflict, and why).
  var dedup = readJsonSafe(path.join(PLUGIN_ROOT, "logs", sync.dedupReportName)) || {};

  return {
    repos: repos,
    activeTotals: totals,
    dedup: {
      strategy: dedup.strategy || "richest-wins (largest total bytes; ties -> earliest config order)",
      conflictCount: dedup.conflictCount || 0,
      conflicts: dedup.conflicts || []
    },
    sync: {
      lastExternalSync: readStamp("external-skills-last-sync.json", "lastSyncIso"),
      lastSelfUpdateCheck: readStamp("self-update-last-check.json", "lastCheckIso"),
      lastKarpathySync: readStamp("karpathy-last-sync.json", "lastSyncIso"),
      intervalHours: (cfg.sync && cfg.sync.intervalHours) || 24,
      enabled: !(cfg.sync && cfg.sync.enabled === false)
    },
    hint: "Disable a heavy repo with \"enabled\": false in config/external-skills.json, then the next sync prunes its items. Same-name conflicts are resolved richest-wins — see logs/" + sync.dedupReportName + " for every decision."
  };
}

function formatHuman(st) {
  var lines = [];
  lines.push("=== External skills sync status ===");
  lines.push("");
  st.repos.forEach(function (r) {
    var flag = r.enabled ? "✓" : "✗ disabled";
    var inv = r.installed.skills + " skills, " + r.installed.agents + " agents, " + r.installed.commands + " cmds";
    lines.push(flag + "  " + r.name + "  sha=" + (r.lastSyncedSha || "?"));
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
  // Dedup conflicts: which repo won each same-name clash, by content size.
  if (st.dedup && st.dedup.conflictCount > 0) {
    lines.push("DEDUP: " + st.dedup.conflictCount + " same-name conflict(s), kept richest:");
    st.dedup.conflicts.slice(0, 12).forEach(function (c) {
      var others = c.candidates.filter(function (x) { return x.repo !== c.winner.repo; })
        .map(function (x) { return x.repo + " " + x.bytes + "b"; }).join(", ");
      lines.push("  " + c.name + " (" + c.kind + ") → " + c.winner.repo + " " + c.winner.bytes + "b  (over " + others + ")");
    });
    if (st.dedup.conflicts.length > 12) lines.push("  … +" + (st.dedup.conflicts.length - 12) + " more in logs/" + sync.dedupReportName);
    lines.push("");
  }
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
