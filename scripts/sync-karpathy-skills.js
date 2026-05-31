#!/usr/bin/env node

/**
 * sync-karpathy-skills.js
 *
 * Pulls the latest skills from https://github.com/multica-ai/andrej-karpathy-skills
 * into a managed cache under ~/.claude/plugins/cache/<owner>/external/, then
 * mirrors each skill folder into a destination skills/ directory.
 *
 * Usage:
 *   node scripts/sync-karpathy-skills.js [destinationSkillsDir]
 *
 * If destinationSkillsDir is omitted, only the cache is refreshed.
 *
 * Always tries to fetch the most recent commit so installations are
 * "always latest" without bundling the upstream code in this repo.
 *
 * Exit codes:
 *   0 = success (or graceful fallback when offline / git missing)
 *   1 = unrecoverable error
 */

"use strict";

var fs = require("fs");
var path = require("path");
var proc = require("child_process");

var REPO_URL = "https://github.com/multica-ai/andrej-karpathy-skills";
var REPO_NAME = "andrej-karpathy-skills";

function log(msg)  { console.log("[karpathy] " + msg); }
function warn(msg) { console.warn("[karpathy] WARN: " + msg); }
function err(msg)  { console.error("[karpathy] ERROR: " + msg); }

function getHomeDir() {
  var home = process.env.HOME || process.env.USERPROFILE;
  if (!home) { err("HOME or USERPROFILE not set"); process.exit(1); }
  return home;
}

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

function getCacheRoot() {
  return path.join(getHomeDir(), ".claude", "plugins", "cache", detectMarketplaceOwner(), "external");
}

function getRepoCacheDir() {
  return path.join(getCacheRoot(), REPO_NAME);
}

// Run a binary with a fixed argv array. Uses spawnSync (no shell, no injection).
function run(cmd, args, opts) {
  return proc.spawnSync(cmd, args, Object.assign({ stdio: "inherit" }, opts || {}));
}

function hasGit() {
  var r = proc.spawnSync("git", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

function copyDirRecursive(src, dest, skipNames, depth) {
  skipNames = skipNames || [];
  depth = depth || 0;
  if (depth > 32) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  var entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { return; }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (skipNames.indexOf(e.name) !== -1) continue;
    var s = path.join(src, e.name);
    var d = path.join(dest, e.name);
    // v3.6.2: handle symlinks. Previously a symlinked directory hit the `else`
    // branch and `fs.copyFileSync` threw (EISDIR), aborting the whole karpathy
    // sync. Dereference links whose target stays within the source tree; skip
    // links that escape it (defensive against a crafted upstream repo).
    if (e.isSymbolicLink()) {
      var real;
      try { real = fs.realpathSync(s); } catch (err) { continue; }
      var srcRoot;
      try { srcRoot = fs.realpathSync(src); } catch (err) { srcRoot = src; }
      if (real.indexOf(srcRoot) !== 0) continue; // link escapes src — skip
      var st;
      try { st = fs.statSync(real); } catch (err) { continue; }
      if (st.isDirectory()) copyDirRecursive(real, d, skipNames, depth + 1);
      else { try { fs.copyFileSync(real, d); } catch (err) {} }
    } else if (e.isDirectory()) {
      copyDirRecursive(s, d, skipNames, depth + 1);
    } else if (e.isFile()) {
      try { fs.copyFileSync(s, d); } catch (err) {}
    }
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  // fs.rmSync requires Node >= 14.14; this plugin requires >= 16.
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Clone if missing, otherwise hard-reset to origin HEAD.
 * Returns true on success, false on non-fatal failure (caller decides).
 */
function syncRepo() {
  var cacheRoot = getCacheRoot();
  var repoDir = getRepoCacheDir();

  if (!hasGit()) {
    if (fs.existsSync(repoDir)) {
      warn("git not available - using existing cached copy at " + repoDir);
      return true;
    }
    warn("git not available and no cached copy - skipping karpathy skills sync");
    return false;
  }

  if (!fs.existsSync(cacheRoot)) fs.mkdirSync(cacheRoot, { recursive: true });

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    log("Updating cached repo: " + repoDir);
    var f = run("git", ["-C", repoDir, "fetch", "--depth", "1", "origin", "HEAD"]);
    if (f.status !== 0) {
      warn("git fetch failed - keeping existing cached copy");
      return true;
    }
    var r = run("git", ["-C", repoDir, "reset", "--hard", "FETCH_HEAD"]);
    if (r.status !== 0) {
      warn("git reset failed - cached copy may be stale");
      return true;
    }
    return true;
  }

  log("Cloning " + REPO_URL + " -> " + repoDir);
  var c = run("git", ["clone", "--depth", "1", REPO_URL, repoDir]);
  if (c.status !== 0) {
    warn("git clone failed (offline?) - karpathy skills NOT installed this run");
    return false;
  }
  return true;
}

/**
 * Mirror each top-level folder under <repo>/skills/ into <destSkillsDir>/.
 * Existing folders with the same name are replaced (latest wins).
 * Returns array of installed skill names.
 */
function installSkillsTo(destSkillsDir) {
  var srcSkillsDir = path.join(getRepoCacheDir(), "skills");
  if (!fs.existsSync(srcSkillsDir)) {
    warn("No skills/ dir in cached repo - nothing to install");
    return [];
  }
  if (!fs.existsSync(destSkillsDir)) fs.mkdirSync(destSkillsDir, { recursive: true });

  var installed = [];
  var entries = fs.readdirSync(srcSkillsDir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isDirectory()) continue;
    var src = path.join(srcSkillsDir, e.name);
    var dest = path.join(destSkillsDir, e.name);
    rmrf(dest);
    copyDirRecursive(src, dest);
    installed.push(e.name);
    log("Installed skill: " + e.name + " -> " + dest);
  }
  return installed;
}

function main() {
  var destArg = process.argv[2];
  var ok = syncRepo();

  if (!destArg) {
    log(ok ? "Cache up to date: " + getRepoCacheDir() : "Sync skipped");
    return;
  }

  if (!ok && !fs.existsSync(getRepoCacheDir())) {
    warn("No karpathy skills available to install (no cache, no network)");
    return;
  }

  var installed = installSkillsTo(path.resolve(destArg));
  log("Done. " + installed.length + " skill(s) installed: " + installed.join(", "));
}

if (require.main === module) {
  try { main(); }
  catch (e) { err(e.message); process.exit(1); }
}

module.exports = {
  syncRepo: syncRepo,
  installSkillsTo: installSkillsTo,
  getRepoCacheDir: getRepoCacheDir,
  REPO_URL: REPO_URL,
  REPO_NAME: REPO_NAME
};
