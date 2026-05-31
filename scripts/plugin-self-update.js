#!/usr/bin/env node

/**
 * plugin-self-update.js — keep the INSTALLED plugin itself current with GitHub.
 *
 * Distinct from the external-skills sync (which only refreshes skills/agents/
 * commands). This updates the plugin's OWN code (scripts, config, hooks, ...).
 *
 * Flow (only runs from an installed cache copy, never a dev checkout):
 *   1. Guard: skip if this is a git checkout (.git present) or the path doesn't
 *      look like .../plugins/cache/<owner>/claude-model-changer/<version>/.
 *   2. Maintain a shallow self-clone under cache/<owner>/external/_self-update/.
 *      Clone if missing, else `git fetch origin HEAD` + reset --hard.
 *   3. Read the upstream version from the clone's package.json (main branch).
 *   4. SemVer-compare to the running version (this install's package.json).
 *      If upstream <= local -> no-op.
 *   5. If upstream is newer: copy the plugin tree into a NEW versioned cache
 *      dir, write install markers, then ATOMICALLY repoint installed_plugins.json
 *      at the new dir. The currently-running session keeps the old version until
 *      Claude Code restarts; the next launch picks up the new one.
 *   6. Remove now-orphan version dirs (never the just-installed one).
 *
 * The update is conservative and non-destructive: any failure leaves the
 * existing install fully intact. installed_plugins.json is only ever rewritten
 * via a temp+rename, and only our own plugin entry is touched.
 *
 * Usage:
 *   node scripts/plugin-self-update.js            # apply if newer
 *   node scripts/plugin-self-update.js --check    # report only, change nothing
 *   node scripts/plugin-self-update.js --force    # reinstall upstream even if equal
 *
 * Exit codes: always 0 (never block a session). Diagnostics go to stderr.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var proc = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var PLUGIN_NAME = "claude-model-changer";

// Files/dirs that constitute the installable plugin (mirrors build-installer.js).
var DIRS_TO_INCLUDE = ["scripts", "config", "commands", "agents", "skills", "hooks", ".claude-plugin"];
var FILES_TO_INCLUDE = ["README.md", "LICENSE", "CHANGELOG.md", "CLAUDE.md", "package.json"];
// Never copy these from the clone.
var COPY_SKIP = [".git", ".github", "node_modules", "logs", "dist", "tests", "vscode-extension"];
// Auto-synced skill/agent/command prefixes are NOT part of the plugin bundle;
// the external-skills sync repopulates them. The clone won't have them anyway
// (gitignored), but we guard defensively.
var SYNCED_PREFIXES = ["acs-", "ecc-", "od-", "nlb-", "obs-", "sp-", "rf-", "rfp-", "karpathy-"];

function log(msg)  { process.stderr.write("[self-update] " + msg + "\n"); }

function getHomeDir() { return process.env.USERPROFILE || process.env.HOME || ""; }

function detectMarketplaceOwner() {
  if (process.env.CMC_MARKETPLACE_OWNER) return process.env.CMC_MARKETPLACE_OWNER;
  var user = process.env.USER ||
             process.env.USERNAME ||
             (process.env.USERPROFILE ? path.basename(process.env.USERPROFILE) : "") ||
             (process.env.HOME ? path.basename(process.env.HOME) : "") ||
             "user";
  var slug = user.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) slug = "user";
  return slug + "-local";
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function run(cmd, args, opts) {
  return proc.spawnSync(cmd, args, Object.assign({ stdio: "pipe", encoding: "utf8" }, opts || {}));
}

function hasGit() {
  var r = proc.spawnSync("git", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

// Parse "X.Y.Z[-pre]" -> [X, Y, Z]; returns null if unparseable.
function parseSemver(v) {
  if (typeof v !== "string") return null;
  var m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// true iff a > b (strictly newer)
function isNewer(a, b) {
  var pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (var i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

// Only update an actual installed cache copy — never a dev checkout.
function isInstalledCacheCopy() {
  if (fs.existsSync(path.join(PLUGIN_ROOT, ".git"))) return false; // dev checkout
  var norm = PLUGIN_ROOT.replace(/\\/g, "/");
  // .../plugins/cache/<owner>/claude-model-changer/<version>
  return /\/plugins\/cache\/[^/]+\/claude-model-changer\/\d+\.\d+\.\d+/.test(norm);
}

function copyTree(src, dst, depth) {
  depth = depth || 0;
  if (depth > 32) return;
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  var entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { return; }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (COPY_SKIP.indexOf(e.name) !== -1) continue;
    // Skip auto-synced items if they somehow exist in the clone.
    var isSynced = false;
    for (var p = 0; p < SYNCED_PREFIXES.length; p++) {
      if (e.name.indexOf(SYNCED_PREFIXES[p]) === 0) { isSynced = true; break; }
    }
    if (isSynced) continue;
    var s = path.join(src, e.name);
    var d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, depth + 1);
    else if (e.isFile()) { try { fs.copyFileSync(s, d); } catch (er) {} }
  }
}

function rmrf(p) {
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

function atomicWriteJson(filepath, data) {
  var tmp = filepath + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filepath);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (x) {}
    return false;
  }
}

function main() {
  var args = process.argv.slice(2);
  var check = args.indexOf("--check") !== -1;
  var force = args.indexOf("--force") !== -1;

  var home = getHomeDir();
  if (!home) { log("HOME/USERPROFILE not set; skipping"); return; }

  if (!isInstalledCacheCopy() && !force) {
    log("not an installed cache copy (dev checkout?) — skipping self-update");
    return;
  }

  if (!hasGit()) { log("git not available — skipping"); return; }

  var localPkg = readJsonSafe(path.join(PLUGIN_ROOT, "package.json"));
  var localVersion = localPkg && localPkg.version;
  if (!localVersion) { log("cannot read local version — skipping"); return; }

  var owner = detectMarketplaceOwner();
  var cloneParent = path.join(home, ".claude", "plugins", "cache", owner, "external", "_self-update");
  var cloneDir = path.join(cloneParent, PLUGIN_NAME);
  var REPO_URL = "https://github.com/R4CK/claude-model-changer.git";

  // 1. Sync the self-clone (main branch).
  try {
    if (!fs.existsSync(cloneParent)) fs.mkdirSync(cloneParent, { recursive: true });
    if (fs.existsSync(path.join(cloneDir, ".git"))) {
      var f = run("git", ["-C", cloneDir, "fetch", "--depth", "1", "origin", "HEAD"]);
      if (f.status !== 0) { log("fetch failed — keeping current install"); return; }
      var r = run("git", ["-C", cloneDir, "reset", "--hard", "FETCH_HEAD"]);
      if (r.status !== 0) { log("reset failed — keeping current install"); return; }
    } else {
      var c = run("git", ["clone", "--depth", "1", REPO_URL, cloneDir]);
      if (c.status !== 0) { log("clone failed (offline?) — keeping current install"); return; }
    }
  } catch (e) { log("self-clone error: " + e.message); return; }

  // 2. Read upstream version.
  var upstreamPkg = readJsonSafe(path.join(cloneDir, "package.json"));
  var upstreamVersion = upstreamPkg && upstreamPkg.version;
  if (!upstreamVersion) { log("cannot read upstream version — skipping"); return; }

  var newer = isNewer(upstreamVersion, localVersion);
  if (!newer && !force) {
    log("up to date (local " + localVersion + ", upstream " + upstreamVersion + ")");
    return;
  }

  if (check) {
    log("UPDATE AVAILABLE: " + localVersion + " -> " + upstreamVersion + " (run without --check to apply)");
    return;
  }

  log((newer ? "updating " : "reinstalling ") + localVersion + " -> " + upstreamVersion);

  // 3. Copy the plugin tree into a new versioned cache dir.
  var installRoot = path.join(home, ".claude", "plugins", "cache", owner, PLUGIN_NAME);
  var newDir = path.join(installRoot, upstreamVersion);
  var stagingDir = newDir + ".staging-" + process.pid;

  // Refuse to replace the directory we are currently executing from — on
  // Windows the rename would EPERM, and we must never delete the running code.
  // The normal upgrade path targets a DIFFERENT version dir, so this only
  // guards the degenerate `--force` reinstall-in-place case.
  if (path.resolve(newDir).toLowerCase() === path.resolve(PLUGIN_ROOT).toLowerCase()) {
    log("target equals the running install dir — refusing in-place replace (restart from a different version to reinstall)");
    return;
  }

  try {
    rmrf(stagingDir);
    fs.mkdirSync(stagingDir, { recursive: true });
    DIRS_TO_INCLUDE.forEach(function(dir) {
      var src = path.join(cloneDir, dir);
      if (fs.existsSync(src)) copyTree(src, path.join(stagingDir, dir));
    });
    FILES_TO_INCLUDE.forEach(function(f) {
      var src = path.join(cloneDir, f);
      if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(stagingDir, f)); } catch (e) {} }
    });
    // Install markers (mirror install-plugin.js).
    fs.mkdirSync(path.join(stagingDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, ".cli-installed"), new Date().toISOString() + "\n");
    fs.writeFileSync(path.join(stagingDir, ".install-version"),
      JSON.stringify({ version: upstreamVersion, installedAt: new Date().toISOString(), via: "self-update" }));

    // Crash-safe swap: move any existing newDir aside FIRST, then rename staging
    // into place, then drop the backup. If the staging rename fails, restore the
    // backup so the existing install is never lost (the old rmrf-then-rename
    // ordering could delete newDir and then fail the rename, destroying it).
    if (fs.existsSync(newDir)) {
      var backupDir = newDir + ".old-" + process.pid;
      rmrf(backupDir);
      fs.renameSync(newDir, backupDir);   // fails BEFORE any deletion on EPERM
      try {
        fs.renameSync(stagingDir, newDir);
        rmrf(backupDir);
      } catch (e2) {
        rmrf(newDir);
        try { fs.renameSync(backupDir, newDir); } catch (e3) {}
        throw e2;
      }
    } else {
      fs.renameSync(stagingDir, newDir);
    }
  } catch (e) {
    log("copy/install failed: " + e.message + " — existing install untouched");
    rmrf(stagingDir);
    return;
  }

  // 4. Repoint installed_plugins.json (atomic, only our entry).
  var pluginsFile = path.join(home, ".claude", "plugins", "installed_plugins.json");
  var pd = readJsonSafe(pluginsFile);
  if (!pd || !pd.plugins) {
    log("installed_plugins.json missing/unreadable — new dir staged but registry NOT repointed. Re-run install.js to finish.");
    return;
  }
  var pluginKey = PLUGIN_NAME + "@" + owner;
  var nowIso = new Date().toISOString();
  var entry = { scope: "user", installPath: newDir, version: upstreamVersion, installedAt: nowIso, lastUpdated: nowIso };
  if (Array.isArray(pd.plugins[pluginKey])) {
    pd.plugins[pluginKey] = [entry];
  } else if (pd.plugins[pluginKey]) {
    pd.plugins[pluginKey] = entry;
  } else {
    // Key not found under expected name; don't guess — stage only.
    log("plugin key '" + pluginKey + "' not in registry — new dir staged but NOT repointed.");
    return;
  }
  if (!atomicWriteJson(pluginsFile, pd)) {
    log("failed to write installed_plugins.json — new dir staged but NOT repointed.");
    return;
  }

  // 4b. Keep the terminal statusLine pointed at the NEW install dir. Only touch
  // it if it already points at OUR statusline.js (an absolute path written by a
  // previous install/update) — never clobber a user's custom statusLine, and
  // never introduce one that wasn't there.
  try {
    var settingsFile = path.join(home, ".claude", "settings.json");
    var sj = readJsonSafe(settingsFile);
    if (sj && sj.statusLine && sj.statusLine.command &&
        sj.statusLine.command.indexOf("statusline.js") !== -1 &&
        sj.statusLine.command.indexOf("claude-model-changer") !== -1) {
      var newCmd = "node \"" + newDir.replace(/\\/g, "/") + "/scripts/statusline.js\"";
      if (sj.statusLine.command !== newCmd) {
        sj.statusLine.command = newCmd;
        if (atomicWriteJson(settingsFile, sj)) log("statusLine repointed to new install");
      }
    }
  } catch (e) { /* best-effort */ }

  // 5. Clean up orphan version dirs (keep the new one).
  try {
    fs.readdirSync(installRoot).forEach(function(name) {
      if (name === upstreamVersion) return;
      if (!/^\d+\.\d+\.\d+([.\-+].*)?$/.test(name)) return;
      var dirp = path.join(installRoot, name);
      try { if (fs.statSync(dirp).isDirectory()) { rmrf(dirp); log("removed orphan v" + name); } } catch (e) {}
    });
  } catch (e) {}

  // 6. Record the update so the NEXT session (running the new dir) can surface
  // a one-time notice. Written into the NEW dir's logs/ — the next launch runs
  // from there, so the per-version logs dir is the right handoff location.
  try {
    fs.writeFileSync(path.join(newDir, "logs", "self-update-applied.json"),
      JSON.stringify({ from: localVersion, to: upstreamVersion, at: nowIso }));
  } catch (e) {}

  log("DONE: " + localVersion + " -> " + upstreamVersion + " installed. Restart Claude Code to activate.");
}

if (require.main === module) {
  try { main(); }
  catch (e) { log("fatal: " + (e && e.message || e)); }
  process.exit(0);
}

module.exports = {
  parseSemver: parseSemver,
  isNewer: isNewer,
  isInstalledCacheCopy: isInstalledCacheCopy,
  detectMarketplaceOwner: detectMarketplaceOwner
};
