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

// v3.6.2: symlink boundary — the realpath of the external cache root. A
// symlink is dereferenced only if its target stays within this boundary
// (e.g. ui-ux-pro-max-skill uses in-repo symlinks like ../../../src/...).
// A link escaping the cache (→ /etc, ~/.ssh, etc.) is skipped so a crafted
// upstream repo can't pull host files into the plugin.
function _cacheBoundary() {
  try { return fs.realpathSync(getCacheRoot()); }
  catch (e) { return getCacheRoot(); }
}

// Dereferences in-cache symlinks and copies their target content. Skips broken,
// circular, or cache-escaping links rather than aborting the whole sync.
// Depth-capped at 32 to keep pathological cases bounded.
function copyDirRecursive(src, dest, skipNames, depth, boundary) {
  skipNames = skipNames || [];
  depth = depth || 0;
  if (depth > 32) return;
  if (!boundary) boundary = _cacheBoundary();
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
      if (real.indexOf(boundary) !== 0) continue; // escapes cache — skip
      var st;
      try { st = fs.statSync(real); }
      catch (err) { continue; }
      if (st.isDirectory()) copyDirRecursive(real, d, skipNames, depth + 1, boundary);
      else { try { fs.copyFileSync(real, d); } catch (err) { /* skip */ } }
    } else if (e.isDirectory()) {
      copyDirRecursive(s, d, skipNames, depth + 1, boundary);
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

// Cheap check: does the file start with a YAML frontmatter delimiter?
// Used to skip doc/reference .md files that masquerade as agents/commands.
// Reads only the first ~16 bytes to keep the check fast over thousands
// of files.
function hasYamlFrontmatter(filePath) {
  try {
    var fd = fs.openSync(filePath, "r");
    var buf = Buffer.alloc(16);
    var n = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    var head = buf.slice(0, n).toString("utf8").replace(/^﻿/, "");
    // Accept either "---\n" or "---\r\n" at the very start.
    return head.indexOf("---\n") === 0 || head.indexOf("---\r\n") === 0;
  } catch (e) { return false; }
}

/**
 * Recursively collect every .md file under dir. Returns array of
 *   { absPath, relPath } where relPath is POSIX-style relative to dir.
 * Skips dot-prefixed dirs, SKIP_NAMES_DEFAULT, and well-known repo docs.
 * If `requireFrontmatter` is true, only .md files starting with `---` are
 * kept — used for agent/command sources to filter out documentation
 * .md files that masquerade as Claude items (e.g. ruflo's
 * .claude/commands/agents/agent-capabilities.md, which is a reference
 * table, not a slash command).
 */
function walkMdFiles(dir, recursive, requireFrontmatter, depth) {
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
      var children = walkMdFiles(p, true, requireFrontmatter, depth + 1);
      for (var j = 0; j < children.length; j++) {
        out.push({
          absPath: children[j].absPath,
          relPath: e.name + "/" + children[j].relPath
        });
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      var lower = e.name.toLowerCase();
      // Filter out repository-level docs.
      if (lower === "readme.md" || lower === "changelog.md" || lower === "license.md" ||
          lower === "contributing.md" || lower === "code_of_conduct.md" ||
          lower === "security.md" || lower === "migration_summary.md" ||
          lower === "agents.md" || lower === "claude.md") continue;
      // Optional: only items with `---` frontmatter (real agents/commands).
      if (requireFrontmatter && !hasYamlFrontmatter(p)) continue;
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
  var exclude = source.excludeFolders || [];
  var kind = source.kind || "skill";
  var out = [];

  // v3.9.0: items keep their ORIGINAL names. destName = the source basename
  // (skill folder name, or agent/command file basename) — never a prefix and
  // never a path-flattened form. Collisions across repos/sources are resolved
  // later by first-wins dedup in installRepo().

  // root-single
  if (source.layout === "root-single") {
    var basePath = source.skillsPath ? path.join(repoDir, source.skillsPath) : repoDir;
    var destName = source.destFolderName || repo.name;
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

  // For agent/command kinds, only accept .md files with YAML frontmatter
  // (real Claude items). Skills are folders, so this doesn't apply.
  var needFm = (kind === "agent" || kind === "command");

  // flat-md: each .md file at the root of listDir (original filename)
  if (source.layout === "flat-md") {
    var mdFlat = walkMdFiles(listDir, false, needFm);
    for (var i = 0; i < mdFlat.length; i++) {
      var name = mdFlat[i].relPath;
      if (exclude.indexOf(name) !== -1) continue;
      out.push({ srcPath: mdFlat[i].absPath, destName: name, kind: kind, isFile: true });
    }
    return out;
  }

  // nested-md: walk recursively; destName = the file's ORIGINAL basename
  // (not the flattened path). Same-basename files in different subdirs collide
  // and are deduped first-wins later — acceptable, since the item identity is
  // its frontmatter name, not the on-disk filename.
  if (source.layout === "nested-md") {
    var mdNested = walkMdFiles(listDir, true, needFm);
    for (var k = 0; k < mdNested.length; k++) {
      var rel = mdNested[k].relPath;
      var top = rel.indexOf("/") === -1 ? rel : rel.slice(0, rel.indexOf("/"));
      if (exclude.indexOf(top) !== -1) continue;
      out.push({ srcPath: mdNested[k].absPath, destName: path.basename(rel), kind: kind, isFile: true });
    }
    return out;
  }

  // plugin-multi: iterate <listDir>/<plugin>/<innerPath>/... ; items keep their
  // original basenames (no plugin-name prefix).
  if (source.layout === "plugin-multi") {
    var inner = source.innerPath || "";
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
      if (innerLayout === "subfolder") {
        var subEntries = fs.readdirSync(innerDir, { withFileTypes: true });
        for (var n = 0; n < subEntries.length; n++) {
          var se = subEntries[n];
          if (!se.isDirectory()) continue;
          if (se.name.charAt(0) === ".") continue;
          out.push({ srcPath: path.join(innerDir, se.name), destName: se.name, kind: kind, isFile: false });
        }
      } else if (innerLayout === "flat-md") {
        var subMd = walkMdFiles(innerDir, false, needFm);
        for (var q = 0; q < subMd.length; q++) {
          out.push({ srcPath: subMd[q].absPath, destName: subMd[q].relPath, kind: kind, isFile: true });
        }
      } else if (innerLayout === "nested-md") {
        var subMdN = walkMdFiles(innerDir, true, needFm);
        for (var t = 0; t < subMdN.length; t++) {
          out.push({ srcPath: subMdN[t].absPath, destName: path.basename(subMdN[t].relPath), kind: kind, isFile: true });
        }
      }
    }
    return out;
  }

  // subfolder or root-multi: each child folder = one item (original folder name)
  var entries = fs.readdirSync(listDir, { withFileTypes: true });
  entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  for (var i2 = 0; i2 < entries.length; i2++) {
    var e2 = entries[i2];
    if (!e2.isDirectory()) continue;
    if (e2.name.charAt(0) === ".") continue;
    if (exclude.indexOf(e2.name) !== -1) continue;
    var folder = path.join(listDir, e2.name);
    if (source.layout === "root-multi" && !hasSkillMarker(folder)) continue;
    out.push({ srcPath: folder, destName: e2.name, kind: kind, isFile: false });
  }
  return out;
}

// Read an agent/command .md file's frontmatter `name:` (its real identity for
// agents). Falls back to the filename without extension.
function readItemName(filePath, destName) {
  try {
    var fd = fs.openSync(filePath, "r");
    var buf = Buffer.alloc(2048);
    var n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    var head = buf.slice(0, n).toString("utf8").replace(/^﻿/, "");
    var m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      var nm = m[1].match(/^name:[ \t]*["']?([^"'\r\n]+)["']?[ \t]*$/m);
      if (nm) return nm[1].trim();
    }
  } catch (e) {}
  return destName.replace(/\.md$/i, "");
}

var MANIFEST_NAME = "external-skills-manifest.json";

function manifestPath(pluginRoot) {
  return path.join(pluginRoot, "logs", MANIFEST_NAME);
}

// Identity used to dedup an item. Skills/commands key off their dest name
// (folder/filename); agents key off their frontmatter `name:` (what Claude Code
// actually uses — two agents with the same name silently collide).
function itemIdentity(it) {
  if (it.kind === "agent") return readItemName(it.srcPath, it.destName).toLowerCase();
  return it.destName.toLowerCase();
}

function copyItem(it, pluginRoot, repoName) {
  var destDir = path.join(pluginRoot, KIND_TO_DIR[it.kind] || "skills");
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  var dest = path.join(destDir, it.destName);
  if (it.isFile) {
    try { fs.rmSync(dest, { force: true }); } catch (e) {}
    return copyFileSafe(it.srcPath, dest);
  }
  // Directory: atomic temp+swap (see v3.6.2).
  var tmpDest = dest + ".tmp-" + process.pid + "-" + Date.now();
  try {
    rmrf(tmpDest);
    copyDirRecursive(it.srcPath, tmpDest, SKIP_NAMES_DEFAULT);
    rmrf(dest);
    fs.renameSync(tmpDest, dest);
    return true;
  } catch (e) {
    rmrf(tmpDest);
    warn(repoName, "copy failed for " + it.destName + ": " + (e && e.message || e));
    return false;
  }
}

/**
 * Install all of a repo's items into pluginRoot, honoring the shared `dedup`
 * context (first-wins across repos, in config order). Records what this repo
 * actually installed into `manifestEntry`. Returns per-kind install counts.
 */
function installRepo(repo, pluginRoot, dedup, manifestEntry) {
  var sources = getRepoSources(repo);
  var totals = { skill: 0, agent: 0, command: 0, hook: 0, skipped: 0 };
  for (var s = 0; s < sources.length; s++) {
    var items = discoverSourceItems(repo, sources[s]);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var kind = it.kind || "skill";
      if (!dedup[kind]) dedup[kind] = {};
      var id = itemIdentity(it);
      if (dedup[kind][id]) { totals.skipped++; continue; }   // a duplicate name — first repo wins
      if (copyItem(it, pluginRoot, repo.name)) {
        dedup[kind][id] = repo.name;
        totals[kind] = (totals[kind] || 0) + 1;
        if (manifestEntry) {
          if (!manifestEntry[kind]) manifestEntry[kind] = [];
          manifestEntry[kind].push(it.destName);
        }
      }
    }
  }
  return totals;
}

// Back-compat shim for callers/tests that installed a single source.
function installSourceItems(repo, source, pluginRoot) {
  var dedup = {}, entry = {};
  installRepo({ name: repo.name, sources: [source] }, pluginRoot, dedup, entry);
  var kind = source.kind || "skill";
  return (entry[kind] || []);
}

function totalsToString(totals) {
  var parts = [];
  if (totals.skill)   parts.push(totals.skill + " skill(s)");
  if (totals.agent)   parts.push(totals.agent + " agent(s)");
  if (totals.command) parts.push(totals.command + " command(s)");
  if (totals.hook)    parts.push(totals.hook + " hook(s)");
  if (totals.skipped) parts.push(totals.skipped + " dup(s) skipped");
  return parts.length ? parts.join(", ") : "0 item(s)";
}

/**
 * Reconcile the installed items with a freshly-built manifest. Any item that
 * was previously synced (present in the old or new manifest) but is NOT in the
 * new manifest's active set is removed — this covers disabled repos, items
 * deleted upstream, and ownership changes. Built-in items (model-router, the
 * worker agents, the plugin's own commands) are never in any manifest, so they
 * are never touched. Returns the count removed.
 */
function reconcile(pluginRoot, oldManifest, newManifest) {
  var managed = { skills: {}, agents: {}, commands: {}, hooks: {} };
  var active = { skills: {}, agents: {}, commands: {}, hooks: {} };
  var KIND_PLURAL = { skill: "skills", agent: "agents", command: "commands", hook: "hooks" };

  function absorb(manifest, into) {
    Object.keys(manifest || {}).forEach(function (repoName) {
      var entry = manifest[repoName] || {};
      Object.keys(entry).forEach(function (kind) {
        var plural = KIND_PLURAL[kind] || kind;
        (entry[kind] || []).forEach(function (name) { into[plural][name] = true; });
      });
    });
  }
  absorb(oldManifest, managed);
  absorb(newManifest, managed);
  absorb(newManifest, active);

  var removed = 0;
  Object.keys(managed).forEach(function (plural) {
    var dir = path.join(pluginRoot, plural);
    Object.keys(managed[plural]).forEach(function (name) {
      if (active[plural][name]) return;           // still wanted — keep
      var p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch (e) {}
      }
    });
  });
  return removed;
}

function parseArgs(argv) {
  var out = { dest: null, force: false, only: null, prune: null };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--force") { out.force = true; continue; }
    if (a === "--prune") { out.prune = true; continue; }
    if (a === "--no-prune") { out.prune = false; continue; }
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

// A small signature of the config that affects the install outcome, so a config
// change (e.g. a repo disabled, a source edited) forces a re-sync even when no
// remote HEAD moved.
function configSignature(cfg) {
  try {
    var repos = (cfg.repos || []).map(function (r) {
      return { name: r.name, enabled: r.enabled !== false, url: r.url, sources: r.sources || r.layout };
    });
    return JSON.stringify(repos);
  } catch (e) { return ""; }
}

/**
 * Full install: walk enabled repos in config order, install with first-wins
 * dedup, reconcile against the previous manifest, and persist the new manifest.
 */
function fullInstall(cfg, pluginRoot) {
  var oldManifest = readJsonSafe(manifestPath(pluginRoot)) || {};
  delete oldManifest._configSignature;
  var newManifest = {};
  var dedup = {};
  var totals = { skill: 0, agent: 0, command: 0, hook: 0, skipped: 0 };

  (cfg.repos || []).forEach(function (repo) {
    if (!repo || repo.enabled === false) return;
    var entry = {};
    var t = installRepo(repo, pluginRoot, dedup, entry);
    newManifest[repo.name] = entry;
    ["skill", "agent", "command", "hook", "skipped"].forEach(function (k) { totals[k] += (t[k] || 0); });
    log(repo.name, "installed " + totalsToString(t));
  });

  var removed = reconcile(pluginRoot, oldManifest, newManifest);
  if (removed > 0) log("reconcile", "removed " + removed + " stale/inactive item(s)");

  try {
    var dir = path.dirname(manifestPath(pluginRoot));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    newManifest._configSignature = configSignature(cfg);
    fs.writeFileSync(manifestPath(pluginRoot), JSON.stringify(newManifest, null, 2), "utf8");
  } catch (e) { warn("manifest", "write failed: " + e.message); }

  return totals;
}

function main() {
  var args = parseArgs(process.argv.slice(2));

  var cfg = readJsonSafe(CONFIG_FILE);
  if (!cfg) { err("init", "config not found or invalid: " + CONFIG_FILE); process.exit(1); }

  var pluginRoot = resolvePluginRoot(args.dest);

  // 1. Refresh every enabled repo's cache (cheap HEAD check). Track if anything
  //    actually changed remotely.
  var anyChanged = false, anyCache = false;
  (cfg.repos || []).forEach(function (repo) {
    if (!repo || repo.enabled === false) return;
    if (args.only && repo.name !== args.only) return;
    var res = syncRepoCache(repo, { force: args.force });
    if (res.ok) anyCache = true;
    if (res.changed) anyChanged = true;
    if (!pluginRoot) log(repo.name, res.reason);
  });

  if (!pluginRoot) {
    log("done", "cache refreshed" + (anyChanged ? " (some repos changed)" : ""));
    return;
  }

  // 2. Decide whether a (re)install is needed. Dedup is global + order-sensitive,
  //    so any change means a full re-walk. Triggers: a repo changed, --force,
  //    --prune, the manifest is missing, or the config signature changed.
  var oldM = readJsonSafe(manifestPath(pluginRoot)) || {};
  var sigChanged = oldM._configSignature !== configSignature(cfg);
  var manifestMissing = !fs.existsSync(manifestPath(pluginRoot));
  var needInstall = anyChanged || args.force || args.prune === true || manifestMissing || sigChanged;

  if (!needInstall) {
    log("done", "up to date; no repo changed");
    return;
  }

  if (!anyCache) {
    warn("init", "no repo caches available (offline?) — skipping install");
    return;
  }

  var totals = fullInstall(cfg, pluginRoot);
  log("done", "installed " + totalsToString(totals));
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
  reconcile: reconcile,
  readItemName: readItemName,
  itemIdentity: itemIdentity,
  fullInstall: fullInstall,
  remoteHeadSha: remoteHeadSha,
  localHeadSha: localHeadSha,
  getCacheRoot: getCacheRoot,
  resolvePluginRoot: resolvePluginRoot,
  walkMdFiles: walkMdFiles,
  manifestPath: manifestPath
};
