#!/usr/bin/env node

/**
 * sync-external-skills.js
 *
 * Generic config-driven syncer for external skill / agent / command / hook
 * sources. Reads config/external-skills.json and for each enabled repo:
 *
 *   1. If the cache dir is missing -> shallow clone.
 *   2. Otherwise -> `git ls-remote origin HEAD` and compare to local HEAD.
 *      If shas match AND every expected dest item still exists -> skip
 *      entirely. No fetch, no copy.
 *   3. If the sha differs -> shallow `fetch + reset --hard FETCH_HEAD`.
 *   4. For each configured `source` in the repo, discover items per its
 *      `layout` and mirror them into the appropriate dest directory:
 *
 *         kind=skill   -> <pluginRoot>/skills/
 *         kind=agent   -> <pluginRoot>/agents/
 *         kind=command -> <pluginRoot>/commands/
 *         kind=hook    -> <pluginRoot>/hooks/
 *
 *      Supported layouts:
 *        subfolder         each direct child folder of <path>/ is one item
 *        root-multi        each top-level folder that has SKILL.md/skill.json
 *        root-single       the repo (or <path>) itself is one item
 *        flat-md           each .md file directly under <path>/
 *        nested-md         recursively walk <path>/, each .md is one item
 *                          (subdir parts become dashed name segments)
 *        plugin-multi      iterate <path>/<plugin>/<innerPath>/* per plugin
 *                          (used for ruflo plugins/ ecosystem)
 *
 * Usage:
 *   node scripts/sync-external-skills.js                # cache-only refresh
 *   node scripts/sync-external-skills.js <pluginRoot>   # install items
 *   node scripts/sync-external-skills.js <pluginRoot> --force
 *   node scripts/sync-external-skills.js <pluginRoot> --repo=<name>
 *
 * Backward compat: if <pluginRoot> ends with "/skills" (the legacy v3.5.0
 * caller convention), it's auto-converted to the parent dir.
 *
 * Exit codes:
 *   0 = success (or graceful fallback when offline / git missing)
 *   1 = unrecoverable error
 */

"use strict";

var fs = require("fs");
var path = require("path");
var proc = require("child_process");

var PLUGIN_ROOT = path.resolve(__dirname, "..");
var CONFIG_FILE = path.join(PLUGIN_ROOT, "config", "external-skills.json");
var KIND_TO_DIR = {
  skill: "skills",
  agent: "agents",
  command: "commands",
  hook: "hooks"
};
var SKIP_NAMES_DEFAULT = [".git", ".github", "node_modules", ".DS_Store"];

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
      catch (err) { continue; }
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

function copyFileSafe(src, dest) {
  var dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try { fs.copyFileSync(src, dest); return true; }
  catch (e) { return false; }
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
  var r = run("git", ["-C", repoDir, "ls-remote", "origin", "HEAD"]);
  if (r.status !== 0) return null;
  var line = (r.stdout || "").trim().split(/\r?\n/)[0] || "";
  var sha = line.split(/\s+/)[0];
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/**
 * Sync a single repo's cache dir. Returns {ok, changed, reason}.
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

  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    log(repo.name, "cloning " + repo.url);
    var c = runInherit("git", ["clone", "--depth", "1", repo.url, repoDir]);
    if (c.status !== 0) {
      warn(repo.name, "git clone failed (offline?) - skipping this run");
      return { ok: false, changed: false, reason: "clone-failed" };
    }
    return { ok: true, changed: true, reason: "cloned" };
  }

  if (!force) {
    var localSha = localHeadSha(repoDir);
    var remoteSha = remoteHeadSha(repoDir);
    if (localSha && remoteSha && localSha === remoteSha) {
      return { ok: true, changed: false, reason: "up-to-date" };
    }
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
 * Recursively collect every .md file under dir. Returns array of
 *   { absPath, relPath } where relPath is POSIX-style relative to dir.
 * Skips dot-prefixed dirs and SKIP_NAMES_DEFAULT entries.
 */
function walkMdFiles(dir, recursive, depth) {
  depth = depth || 0;
  if (depth > 12) return [];
  var out = [];
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return []; }
  entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.name.charAt(0) === ".") continue;
    if (SKIP_NAMES_DEFAULT.indexOf(e.name) !== -1) continue;
    var p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!recursive) continue;
      var children = walkMdFiles(p, true, depth + 1);
      for (var j = 0; j < children.length; j++) {
        out.push({
          absPath: children[j].absPath,
          relPath: e.name + "/" + children[j].relPath
        });
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      // Filter out repository-level docs that aren't agents/commands.
      var lower = e.name.toLowerCase();
      if (lower === "readme.md" || lower === "changelog.md" || lower === "license.md" ||
          lower === "contributing.md" || lower === "code_of_conduct.md" ||
          lower === "security.md" || lower === "migration_summary.md" ||
          lower === "agents.md" || lower === "claude.md") continue;
      out.push({ absPath: p, relPath: e.name });
    }
  }
  return out;
}

/**
 * Normalize a repo entry into an array of source descriptors.
 * Backward-compatible: if the entry uses the legacy `layout` / `skillsPath`
 * fields directly, synthesize a single source of kind "skill".
 */
function getRepoSources(repo) {
  if (Array.isArray(repo.sources) && repo.sources.length) {
    return repo.sources.map(function (s) {
      return Object.assign({ kind: "skill" }, s);
    });
  }
  return [{
    kind: "skill",
    layout: repo.layout,
    skillsPath: repo.skillsPath,
    destFolderName: repo.destFolderName,
    destPrefix: repo.destPrefix,
    excludeFolders: repo.excludeFolders
  }];
}

/**
 * Returns array of { srcPath, destName, kind, isFile } for one source.
 *   srcPath  = absolute path on disk in the cache
 *   destName = final folder/filename under the kind's dest dir
 *   kind     = "skill"/"agent"/"command"/"hook"
 *   isFile   = true for .md leaf files, false for folder items
 */
function discoverSourceItems(repo, source) {
  var repoDir = path.join(getCacheRoot(), repo.name);
  var prefix = source.destPrefix || "";
  var exclude = source.excludeFolders || [];
  var kind = source.kind || "skill";
  var out = [];

  // root-single
  if (source.layout === "root-single") {
    var basePath = source.skillsPath ? path.join(repoDir, source.skillsPath) : repoDir;
    var destName = source.destFolderName || (prefix + repo.name);
    out.push({ srcPath: basePath, destName: destName, kind: kind, isFile: false });
    return out;
  }

  // Determine listing dir for the rest
  var listDir;
  if (source.layout === "subfolder" || source.layout === "flat-md" ||
      source.layout === "nested-md" || source.layout === "plugin-multi") {
    listDir = source.skillsPath ? path.join(repoDir, source.skillsPath) : repoDir;
  } else if (source.layout === "root-multi") {
    listDir = repoDir;
  } else {
    warn(repo.name, "unknown layout: " + source.layout);
    return out;
  }

  if (!fs.existsSync(listDir)) {
    warn(repo.name, "source dir not found: " + listDir);
    return out;
  }

  // flat-md: each .md file at the root of listDir
  if (source.layout === "flat-md") {
    var mdFlat = walkMdFiles(listDir, false);
    for (var i = 0; i < mdFlat.length; i++) {
      var name = mdFlat[i].relPath;
      if (exclude.indexOf(name) !== -1) continue;
      out.push({ srcPath: mdFlat[i].absPath, destName: prefix + name, kind: kind, isFile: true });
    }
    return out;
  }

  // nested-md: walk recursively, each .md becomes one item
  if (source.layout === "nested-md") {
    var mdNested = walkMdFiles(listDir, true);
    for (var k = 0; k < mdNested.length; k++) {
      var rel = mdNested[k].relPath;
      // Drop excluded top-level path segments
      var top = rel.indexOf("/") === -1 ? rel : rel.slice(0, rel.indexOf("/"));
      if (exclude.indexOf(top) !== -1) continue;
      // Flatten path: "sub/dir/foo.md" -> "<prefix>sub-dir-foo.md"
      var dashed = rel.replace(/\//g, "-").replace(/-+/g, "-");
      out.push({ srcPath: mdNested[k].absPath, destName: prefix + dashed, kind: kind, isFile: true });
    }
    return out;
  }

  // plugin-multi: iterate <listDir>/<plugin>/<innerPath>/...
  if (source.layout === "plugin-multi") {
    var inner = source.innerPath || "";        // e.g. "agents", "commands", "skills"
    var innerLayout = source.innerLayout || "subfolder";
    var pluginEntries;
    try { pluginEntries = fs.readdirSync(listDir, { withFileTypes: true }); }
    catch (e) { return out; }
    pluginEntries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    for (var m = 0; m < pluginEntries.length; m++) {
      var p = pluginEntries[m];
      if (!p.isDirectory()) continue;
      if (p.name.charAt(0) === ".") continue;
      if (exclude.indexOf(p.name) !== -1) continue;
      var innerDir = inner ? path.join(listDir, p.name, inner) : path.join(listDir, p.name);
      if (!fs.existsSync(innerDir)) continue;
      var perPluginPrefix = prefix + p.name + "-";
      if (innerLayout === "subfolder") {
        var subEntries = fs.readdirSync(innerDir, { withFileTypes: true });
        for (var n = 0; n < subEntries.length; n++) {
          var se = subEntries[n];
          if (!se.isDirectory()) continue;
          if (se.name.charAt(0) === ".") continue;
          out.push({
            srcPath: path.join(innerDir, se.name),
            destName: perPluginPrefix + se.name,
            kind: kind,
            isFile: false
          });
        }
      } else if (innerLayout === "flat-md") {
        var subMd = walkMdFiles(innerDir, false);
        for (var q = 0; q < subMd.length; q++) {
          out.push({
            srcPath: subMd[q].absPath,
            destName: perPluginPrefix + subMd[q].relPath,
            kind: kind,
            isFile: true
          });
        }
      } else if (innerLayout === "nested-md") {
        var subMdN = walkMdFiles(innerDir, true);
        for (var t = 0; t < subMdN.length; t++) {
          var dashedN = subMdN[t].relPath.replace(/\//g, "-").replace(/-+/g, "-");
          out.push({
            srcPath: subMdN[t].absPath,
            destName: perPluginPrefix + dashedN,
            kind: kind,
            isFile: true
          });
        }
      }
    }
    return out;
  }

  // subfolder or root-multi: each child folder = one item
  var entries = fs.readdirSync(listDir, { withFileTypes: true });
  entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  for (var i2 = 0; i2 < entries.length; i2++) {
    var e2 = entries[i2];
    if (!e2.isDirectory()) continue;
    if (e2.name.charAt(0) === ".") continue;
    if (exclude.indexOf(e2.name) !== -1) continue;
    var folder = path.join(listDir, e2.name);
    if (source.layout === "root-multi" && !hasSkillMarker(folder)) continue;
    out.push({ srcPath: folder, destName: prefix + e2.name, kind: kind, isFile: false });
  }
  return out;
}

/**
 * Install one source's discovered items into the plugin's appropriate
 * dest dir. Returns array of installed dest names.
 */
function installSourceItems(repo, source, pluginRoot) {
  var items = discoverSourceItems(repo, source);
  if (!items.length) return [];

  var installed = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var destDir = path.join(pluginRoot, KIND_TO_DIR[it.kind] || "skills");
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    var dest = path.join(destDir, it.destName);
    if (it.isFile) {
      // File replacement: simple overwrite
      try { fs.rmSync(dest, { force: true }); } catch (e) {}
      if (copyFileSafe(it.srcPath, dest)) installed.push(it.destName);
    } else {
      rmrf(dest);
      copyDirRecursive(it.srcPath, dest, SKIP_NAMES_DEFAULT);
      installed.push(it.destName);
    }
  }
  return installed;
}

/**
 * True iff every expected item for every source of `repo` already exists
 * at its destination path.
 */
function destItemsPresent(repo, pluginRoot) {
  var sources = getRepoSources(repo);
  for (var s = 0; s < sources.length; s++) {
    var items = discoverSourceItems(repo, sources[s]);
    if (!items.length) continue;
    for (var i = 0; i < items.length; i++) {
      var destDir = path.join(pluginRoot, KIND_TO_DIR[items[i].kind] || "skills");
      if (!fs.existsSync(path.join(destDir, items[i].destName))) return false;
    }
  }
  return true;
}

function installRepo(repo, pluginRoot) {
  var sources = getRepoSources(repo);
  var totals = { skill: 0, agent: 0, command: 0, hook: 0 };
  for (var i = 0; i < sources.length; i++) {
    var installed = installSourceItems(repo, sources[i], pluginRoot);
    var kind = sources[i].kind || "skill";
    totals[kind] = (totals[kind] || 0) + installed.length;
  }
  return totals;
}

function totalsToString(totals) {
  var parts = [];
  if (totals.skill)   parts.push(totals.skill + " skill(s)");
  if (totals.agent)   parts.push(totals.agent + " agent(s)");
  if (totals.command) parts.push(totals.command + " command(s)");
  if (totals.hook)    parts.push(totals.hook + " hook(s)");
  return parts.length ? parts.join(", ") : "0 item(s)";
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

function resolvePluginRoot(arg) {
  if (!arg) return null;
  var abs = path.resolve(arg);
  // Legacy: callers used to pass "<pluginRoot>/skills". Detect and back off.
  if (path.basename(abs).toLowerCase() === "skills") return path.dirname(abs);
  return abs;
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

  var pluginRoot = resolvePluginRoot(args.dest);
  var totalInstalled = { skill: 0, agent: 0, command: 0, hook: 0 };
  var totalSkipped = 0;

  for (var i = 0; i < repos.length; i++) {
    var repo = repos[i];
    var res = syncRepoCache(repo, { force: args.force });

    if (!res.ok) {
      warn(repo.name, "skipped: " + res.reason);
      continue;
    }

    if (!pluginRoot) {
      log(repo.name, res.reason);
      continue;
    }

    if (!res.changed && !args.force && destItemsPresent(repo, pluginRoot)) {
      totalSkipped++;
      continue;
    }

    var t = installRepo(repo, pluginRoot);
    totalInstalled.skill   += t.skill;
    totalInstalled.agent   += t.agent;
    totalInstalled.command += t.command;
    totalInstalled.hook    += t.hook;
    log(repo.name, "installed " + totalsToString(t) + " [" + res.reason + "]");
  }

  if (pluginRoot) {
    log("done", "installed " + totalsToString(totalInstalled) + "; " + totalSkipped + " repo(s) up-to-date");
  }
}

if (require.main === module) {
  try { main(); }
  catch (e) { err("main", e.message); process.exit(1); }
}

module.exports = {
  syncRepoCache: syncRepoCache,
  getRepoSources: getRepoSources,
  discoverSourceItems: discoverSourceItems,
  installSourceItems: installSourceItems,
  installRepo: installRepo,
  destItemsPresent: destItemsPresent,
  remoteHeadSha: remoteHeadSha,
  localHeadSha: localHeadSha,
  getCacheRoot: getCacheRoot,
  resolvePluginRoot: resolvePluginRoot,
  walkMdFiles: walkMdFiles
};
