#!/usr/bin/env node

/**
 * update-central-claude-md.js
 *
 * Inserts / refreshes a managed block in ~/.claude/CLAUDE.md that documents
 * the karpathy-guidelines skill bundled with this plugin.
 *
 * Idempotent: a block delimited by BEGIN/END markers is replaced on every run,
 * so the rest of the user's CLAUDE.md is never touched.
 *
 * Usage:
 *   node scripts/update-central-claude-md.js [skillNames...]
 *
 * If no skill names are passed, the block lists every folder currently
 * present in the karpathy cache directory.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var sync = require("./sync-karpathy-skills.js");

var BEGIN = "<!-- BEGIN: andrej-karpathy-skills (managed by claude-model-changer) -->";
var END   = "<!-- END: andrej-karpathy-skills (managed by claude-model-changer) -->";

function getHomeDir() {
  var home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("HOME or USERPROFILE not set");
  return home;
}

function getCentralClaudeMdPath() {
  return path.join(getHomeDir(), ".claude", "CLAUDE.md");
}

function listCachedSkills() {
  var skillsDir = path.join(sync.getRepoCacheDir(), "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(function(e) { return e.isDirectory(); })
    .map(function(e) { return e.name; });
}

function buildBlock(skillNames) {
  var lines = [];
  lines.push(BEGIN);
  lines.push("");
  lines.push("# Andrej Karpathy Skills");
  lines.push("");
  lines.push("Auto-installed by `claude-model-changer`. Source: " + sync.REPO_URL);
  lines.push("Refreshed on every plugin install (latest commit on default branch).");
  lines.push("");
  if (skillNames.length === 0) {
    lines.push("_(No skills currently cached. Re-run `node scripts/sync-karpathy-skills.js` after restoring network access.)_");
  } else {
    lines.push("Available skills:");
    lines.push("");
    for (var i = 0; i < skillNames.length; i++) {
      lines.push("- `" + skillNames[i] + "`");
    }
  }
  lines.push("");
  lines.push("To refresh manually: `node scripts/sync-karpathy-skills.js`");
  lines.push("");
  lines.push(END);
  return lines.join("\n");
}

function upsertBlock(filePath, block) {
  var existing = "";
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, "utf8");

  // Match the managed block, including a trailing newline if present.
  var pattern = new RegExp(
    escapeRegex(BEGIN) + "[\\s\\S]*?" + escapeRegex(END) + "\\n?"
  );

  if (pattern.test(existing)) {
    var updated = existing.replace(pattern, block + "\n");
    if (updated !== existing) {
      fs.writeFileSync(filePath, updated);
      console.log("[claude-md] Updated managed block in " + filePath);
    } else {
      console.log("[claude-md] Managed block already up to date");
    }
    return;
  }

  // Append (preserve any user content)
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  var sep = "";
  if (existing.length > 0 && !existing.endsWith("\n")) sep = "\n\n";
  else if (existing.length > 0) sep = "\n";

  fs.writeFileSync(filePath, existing + sep + block + "\n");
  console.log("[claude-md] Inserted managed block into " + filePath);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  var skills = process.argv.slice(2);
  if (skills.length === 0) skills = listCachedSkills();
  var block = buildBlock(skills);
  upsertBlock(getCentralClaudeMdPath(), block);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error("[claude-md] ERROR: " + e.message); process.exit(1); }
}

module.exports = { upsertBlock: upsertBlock, buildBlock: buildBlock, BEGIN: BEGIN, END: END };
