#!/usr/bin/env node

/**
 * sync-external-skills.js
 *
 * Generic config-driven skill syncer. Reads config/external-skills.json and
 * for each enabled repo:
 *   1. If the cache dir is missing -> shallow clone.
 *   2. Otherwise -> `git ls-remote origin HEAD` and compare to local HEAD.
 *      - If shas match AND dest skill folders already exist -> skip entirely
 *        (no fetch, no copy). This is the "only update if changed" path.
 *      - If shas differ -> fetch + reset + recopy.
 *   3. Discover skill folders based on per-repo `layout`:
 *        subfolder   -> each child of <repo>/<skillsPath>/
 *        root-multi  -> each top-level folder that has SKILL.md or skill.json
 *        root-single -> the repo root itself is a single skill
 *   4. Mirror each skill into <destSkillsDir>/<destPrefix><name>/.
 *
 * Usage:
 *   node scripts/sync-external-skills.js [destinationSkillsDir] [--force] [--repo=<name>]
 *
 * If destinationSkillsDir is omitted, the cache is refreshed but no skills are
 * installed into the plugin's skills/ dir.
 *
 * Flags:
 *   --force       Bypass the smart-skip check; always fetch/reset and re-copy.
 *   --repo=<n>    Only sync the repo with the given name.
 *
 * Exit codes:
 *   0 = success (or graceful fallback when offline / git missing)
 *   1 = unrecoverable error
 *
 * Silent on no-op. Each repo that actually changes prints a single summary line.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var proc = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "external-skills.json");

function log(tag, msg)  { console.log("[ext-skills:" + tag + "] " + msg); }
function warn(tag, msg) { console.warn("[ext-skills:" + tag + "] WARN: " + msg); }
function err(tag, msg)  { console.error("[ext-skills:" + tag + "] ERROR: " + msg); }

function getHomeDir() {
  var home = process.env.HOME || process.env.USERPROFILE;
  if (!home) { err("init", "HOME or USERPROFILE not set"); process.exit(1); }
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

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) { return null; }
}

function run(cmd, args, opts) {
  return proc.spawnSync(cmd, args, Object.assign({ stdio: "pipe", encoding: "utf8" }, opts || {}));
}

function runInherit(cmd, args, opts) {
  return proc.spawnSync(cmd, args, Object.assign({ stdio: "inherit" }, opts || {}));
}

function hasGit() {
  var r = proc.spawnSync("git", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

// Dereferences symlinks and copies their target content. Skips broken /
// circular links rather than aborting the whole sync. Depth-capped at 32 to
// keep pathological cases bounded.
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
    if (e.isSymbolicLink()) {
      var real;
      try { real = fs.realpathSync(s); }
      catch (err) { continue; } // broken link — skip
      var st;
      try { st = fs.statSync(real); }
      catch (err) { continue; }
      if (st.isDirectory()) copyDirRecursive(real, d, skipNames, depth + 1);
      else { try { fs.copyFileSync(real, d); } catch (err) { /* skip */ } }
    } else if (e.isDirectory()) {
      copyDirRecursive(s, d, skipNames, depth + 1);
    } else if (e.isFile()) {
      try { fs.copyFileSync(s, d); } catch (err) { /* skip unreadable */ }
    }
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function localHeadSha(repoDir) {
  var r = run("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  if (r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

function remoteHeadSha(repoDir) {
  // Lightweight: ls-remote doesn't download objects, just the ref listing.
  var r = run("git", ["-C", repoDir, "ls-remote", "origin", "HEAD"]);
  if (r.status !== 0) return null;
  var line = (r.stdout || "").trim().split(/\r?\n/)[0] || "";
  var sha = line.split(/\s+/)[0];
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/**
 * Sync a single repo's cache dir. Returns {ok, changed, reason}.
 *   ok      -> true if cache is usable after this call
 *   changed -> true if files in the cache changed (or were just cloned)
 *   reason  -> short string for logging
 */
function syncRepoCache(repo, opts) {
  opts = opts || {};
  var force = !!opts.force;

  var cacheRoot = getCacheRoot();
  var repoDir = path.join(cacheRoot, repo.name);

  if (!hasGit()) {
    if (fs.existsSync(repoDir)) return { ok: true, changed: false, reason: "no-git-but-cached" };
    return { ok: false, changed: false, reason: "no-git-no-cache" };
  }

  if (!fs.existsSync(cacheRoot)) fs.mkdirSync(cacheRoot, { recursive: true });

  // Initial clone
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    log(repo.name, "cloning " + repo.url);
    var c = runInherit("git", ["clone", "--depth", "1", repo.url, repoDir]);
    if (c.status !== 0) {
      warn(repo.name, "git clone failed (offline?) - skipping this run");
      return { ok: false, changed: false, reason: "clone-failed" };
    }
    return { ok: true, changed: true, reason: "cloned" };
  }

  // Incremental: cheap remote check
  if (!force) {
    var localSha = localHeadSha(repoDir);
    var remoteSha = remoteHeadSha(repoDir);
    if (localSha && remoteSha && localSha === remoteSha) {
      return { ok: true, changed: false, reason: "up-to-date" };
    }
    // null on either side => fall through and attempt a real fetch
  }

  log(repo.name, "remote changed, fetching");
  var f = run("git", ["-C", repoDir, "fetch", "--depth", "1", "origin", "HEAD"]);
  if (f.status !== 0) {
    warn(repo.name, "git fetch failed - keeping existing cached copy");
    return { ok: true, changed: false, reason: "fetch-failed" };
  }
  var r = run("git", ["-C", repoDir, "reset", "--hard", "FETCH_HEAD"]);
  if (r.status !== 0) {
    warn(repo.name, "git reset failed - cached copy may be stale");
    return { ok: true, changed: false, reason: "reset-failed" };
  }
  return { ok: true, changed: true, reason: "updated" };
}

function hasSkillMarker(folderPath) {
  return fs.existsSync(path.join(folderPath, "SKILL.md")) ||
         fs.existsSync(path.join(folderPath, "skill.json"));
}

/**
 * Resolve the list of skill source dirs based on the repo layout.
 * Returns [{srcPath, destName}, ...]
 */
function discoverSkills(repo) {
  var repoDir = path.join(getCacheRoot(), repo.name);
  var prefix = repo.destPrefix || "";
  var exclude = repo.excludeFolders || [];
  var out = [];

  if (repo.layout === "root-single") {
    var destName = repo.destFolderName || (prefix + repo.name);
    out.push({ srcPath: repoDir, destName: destName });
    return out;
  }

  var listDir;
  if (repo.layout === "subfolder") {
    var sub = repo.skillsPath || "skills";
    listDir = path.join(repoDir, sub);
  } else if (repo.layout === "root-multi") {
    listDir = repoDir;
  } else {
    warn(repo.name, "unknown layout: " + repo.layout);
    return out;
  }

  if (!fs.existsSync(listDir)) {
    warn(repo.name, "skills source dir not found: " + listDir);
    return out;
  }

  var entries = fs.readdirSync(listDir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isDirectory()) continue;
    if (e.name.charAt(0) === ".") continue;          // .git, .github, etc.
    if (exclude.indexOf(e.name) !== -1) continue;
    var folder = path.join(listDir, e.name);
    if (repo.layout === "root-multi" && !hasSkillMarker(folder)) continue;
    out.push({ srcPath: folder, destName: prefix + e.name });
  }
  return out;
}

/**
 * Mirror all discovered skills for a repo into destSkillsDir.
 * Returns array of installed dest names.
 */
function installRepoSkills(repo, destSkillsDir) {
  var skills = discoverSkills(repo);
  if (!skills.length) return [];

  if (!fs.existsSync(destSkillsDir)) fs.mkdirSync(destSkillsDir, { recursive: true });

  var installed = [];
  for (var i = 0; i < skills.length; i++) {
    var s = skills[i];
    var dest = path.join(destSkillsDir, s.destName);
    rmrf(dest);
    copyDirRecursive(s.srcPath, dest, [".git", ".github", "node_modules", ".DS_Store"]);
    installed.push(s.destName);
  }
  return installed;
}

/**
 * If a repo was already up-to-date AND every expected dest folder still
 * exists, we can safely skip the recopy step. If any dest is missing
 * (user manually deleted it, prior run aborted mid-copy, etc.), recopy.
 */
function destSkillsPresent(repo, destSkillsDir) {
  var skills = discoverSkills(repo);
  if (!skills.length) return false;
  for (var i = 0; i < skills.length; i++) {
    if (!fs.existsSync(path.join(destSkillsDir, skills[i].destName))) return false;
  }
  return true;
}

function parseArgs(argv) {
  var out = { dest: null, force: false, only: null };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--force") { out.force = true; continue; }
    if (a.indexOf("--repo=") === 0) { out.only = a.slice("--repo=".length); continue; }
    if (a.charAt(0) !== "-" && !out.dest) { out.dest = a; continue; }
  }
  return out;
}

function main() {
  var args = parseArgs(process.argv.slice(2));

  var cfg = readJsonSafe(CONFIG_FILE);
  if (!cfg) { err("init", "config not found or invalid: " + CONFIG_FILE); process.exit(1); }

  var repos = (cfg.repos || []).filter(function (r) {
    if (!r || !r.enabled) return false;
    if (args.only && r.name !== args.only) return false;
    return true;
  });

  if (!repos.length) {
    log("init", "no enabled repos to sync");
    return;
  }

  var destDir = args.dest ? path.resolve(args.dest) : null;
  var totalInstalled = 0;
  var totalSkipped = 0;

  for (var i = 0; i < repos.length; i++) {
    var repo = repos[i];
    var res = syncRepoCache(repo, { force: args.force });

    if (!res.ok) {
      warn(repo.name, "skipped: " + res.reason);
      continue;
    }

    if (!destDir) {
      log(repo.name, res.reason);
      continue;
    }

    // Smart skip: cache unchanged AND all dest skills still present.
    if (!res.changed && !args.force && destSkillsPresent(repo, destDir)) {
      totalSkipped++;
      continue;
    }

    var installed = installRepoSkills(repo, destDir);
    totalInstalled += installed.length;
    log(repo.name, "installed " + installed.length + " skill(s) [" + res.reason + "]");
  }

  if (destDir) {
    log("done", "installed " + totalInstalled + " skill(s); " + totalSkipped + " repo(s) up-to-date");
  }
}

if (require.main === module) {
  try { main(); }
  catch (e) { err("main", e.message); process.exit(1); }
}

module.exports = {
  syncRepoCache: syncRepoCache,
  discoverSkills: discoverSkills,
  installRepoSkills: installRepoSkills,
  destSkillsPresent: destSkillsPresent,
  remoteHeadSha: remoteHeadSha,
  localHeadSha: localHeadSha,
  getCacheRoot: getCacheRoot
};
