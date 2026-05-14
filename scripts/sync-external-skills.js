#!/usr/bin/env node
/**
 * sync-external-skills.js
 *
 * Smart, every-session sync of FIVE curated GitHub skill repos into the plugin's
 * skills/ folder so Claude Code auto-discovers them as plugin skills.
 *
 * Karpathy is intentionally NOT in this list — sync-karpathy-skills.js already
 * mirrors that repo with the original folder names. This script mirrors the
 * OTHER five and namespaces every imported folder as `<repo-slug>-<skill-name>`
 * to avoid collisions with built-in Anthropic skills and with each other.
 *
 * Strategy:
 *   - First run: shallow + sparse clone of the upstream repo's skill subtree.
 *   - Subsequent runs: `git fetch`; compare HEAD vs FETCH_HEAD; copy only on diff.
 *   - Per-repo isolation: one repo failing never blocks the others.
 *   - Atomic per-skill swap: `<dest>.tmp` + rmrf + rename. A half-copied skill
 *     is never visible to discovery.
 *   - Cleanup of stale folders, gated by a 50% anomaly threshold.
 *   - Silent: no stdout/stderr. All output to logs/external-skills-sync.log (JSONL).
 *
 * Triggered from runtime-check.js (SessionStart) via a detached background spawn.
 * Called without flags, this script self-detaches and exits immediately.
 *
 * Usage:
 *   node sync-external-skills.js              # self-detach to bg, return now
 *   node sync-external-skills.js --foreground # blocking foreground (debug)
 *   node sync-external-skills.js --background # bg mode (called by self-detach)
 *   node sync-external-skills.js --dry-run    # report plan, no FS changes
 */

"use strict";

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

// ---- ARGS (parsed before any heavy work) ----
var ARGV = process.argv.slice(2);
var IS_BACKGROUND = ARGV.indexOf("--background") !== -1;
var IS_FOREGROUND = ARGV.indexOf("--foreground") !== -1;
var IS_DRY_RUN    = ARGV.indexOf("--dry-run") !== -1;

// Self-detach: when invoked with no explicit mode flag, re-spawn ourselves
// detached in the background and exit immediately. Keeps the SessionStart
// hook command trivial and dodges the bash/Windows path-translation pitfalls
// of `node -e "spawn(...)"`. __filename is always a native-format path.
if (!IS_BACKGROUND && !IS_FOREGROUND && !IS_DRY_RUN) {
  try {
    childProcess.spawn(process.execPath, [__filename, "--background"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
  } catch (e) { /* swallow */ }
  process.exit(0);
}

// ---- PATHS ----
var ROOT       = path.resolve(__dirname, "..");
var CACHE_DIR  = path.join(ROOT, ".external-skills-cache");
var SKILLS_DIR = path.join(ROOT, "skills");
var LOGS_DIR   = path.join(ROOT, "logs");
var STATE_PATH = path.join(LOGS_DIR, "external-skills-state.json");
var LOCK_PATH  = STATE_PATH + ".lock";
var LOG_PATH   = path.join(LOGS_DIR, "external-skills-sync.log");

// ---- TIMEOUTS ----
var GIT_CLONE_TIMEOUT_MS    = 300000; // 5 min (open-design + everything are slow first-time)
var GIT_FETCH_TIMEOUT_MS    = 60000;
var GIT_CHECKOUT_TIMEOUT_MS = 60000;
var LOCK_TIMEOUT_MS         = 5000;
var LOCK_RETRY_MS           = 50;
var LOG_MAX_BYTES           = 50000;
var LOG_KEEP_LINES          = 500;
var SHRINK_THRESHOLD        = 0.5;
var WIN_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// Bump when materialize semantics change in a way that requires re-running
// over already-materialized repos. The state file stores the version it was
// written under; if it differs from the current value, all repos are forced
// to re-materialize so the new transform applies retroactively.
//   v1: initial release (v3.5.0)
//   v2: SKILL.md `name:` field rewritten to match the prefixed folder name
//       (Anthropic skill spec compliance + intra-plugin name uniqueness)
var MATERIALIZER_VERSION = 2;

// ---- REPO CONFIG ----
//   slug      : folder prefix (`<slug>-<skill-name>`) and cache dir name
//   url       : git URL
//   branch    : default branch
//   sparse    : sparse-checkout path(s); string OR array; null = no sparse
//   layout    : "flat" | "nested" | "root-detect"
//   subdir    : skill source dir relative to repo root; string OR array (multi)
//   categories: only for "nested" layout (mattpocock)
var REPOS = [
  {
    slug: "everything",
    url: "https://github.com/affaan-m/everything-claude-code.git",
    branch: "main",
    sparse: "skills",
    layout: "flat",
    subdir: "skills"
  },
  {
    slug: "mattpocock",
    url: "https://github.com/mattpocock/skills.git",
    branch: "main",
    sparse: "skills",
    layout: "nested",
    subdir: "skills",
    categories: ["engineering", "productivity", "misc"]
  },
  {
    slug: "uiuxmax",
    url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git",
    branch: "main",
    sparse: ".claude/skills",
    layout: "flat",
    subdir: ".claude/skills"
  },
  {
    slug: "composio",
    url: "https://github.com/ComposioHQ/awesome-claude-skills.git",
    branch: "master",
    sparse: null,
    layout: "root-detect",
    subdir: ""
  },
  {
    slug: "opendesign",
    url: "https://github.com/nexu-io/open-design.git",
    branch: "main",
    // open-design has skills in TWO top-level dirs: skills/ AND design-templates/.
    // Sparse-checkout supports multiple paths; pass an array.
    sparse: ["skills", "design-templates"],
    layout: "flat",
    subdir: ["skills", "design-templates"]
  }
];

// ============================================================
// LOGGING (JSONL append + rotation)
// ============================================================

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    var stat = fs.statSync(LOG_PATH);
    if (stat.size < LOG_MAX_BYTES) return;
    var content = fs.readFileSync(LOG_PATH, "utf8");
    var lines = content.split("\n").filter(function(l) { return l.length > 0; });
    if (lines.length > LOG_KEEP_LINES) {
      var keep = lines.slice(lines.length - LOG_KEEP_LINES).join("\n") + "\n";
      var tmp = LOG_PATH + ".rotate.tmp";
      fs.writeFileSync(tmp, keep);
      fs.renameSync(tmp, LOG_PATH);
    }
  } catch (e) { /* swallow */ }
}

function logEvent(level, repo, event, msg, extra) {
  try {
    ensureDir(LOGS_DIR);
    var entry = {
      ts: new Date().toISOString(),
      level: level,
      mode: IS_BACKGROUND ? "bg" : (IS_DRY_RUN ? "dry" : "fg"),
      repo: repo || null,
      event: event,
      msg: msg || ""
    };
    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach(function(k) { entry[k] = extra[k]; });
    }
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (e) { /* never crash hook */ }
}

function logHookError(err, phase) {
  try {
    var el = require("./lib/error-log");
    el.logHookError({ script: "sync-external-skills.js", phase: phase || "main", error: err });
  } catch (e) { /* swallow */ }
}

// ============================================================
// LOCK (PID-based, stale-detection)
// ============================================================

function acquireLock() {
  ensureDir(LOGS_DIR);
  var start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      try {
        var stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 10000) {
          try {
            var pid = parseInt(fs.readFileSync(LOCK_PATH, "utf8"), 10);
            if (pid && !isNaN(pid)) {
              try { process.kill(pid, 0); }
              catch (e) { try { fs.unlinkSync(LOCK_PATH); } catch (e2) {} continue; }
            }
          } catch (e) {}
        }
      } catch (e) { continue; }
      var waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* busy wait */ }
    }
  }
  return false;
}

function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch (e) {} }

// ============================================================
// STATE FILE (atomic via temp + rename)
// ============================================================

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { version: 1, repos: {} };
    var raw = fs.readFileSync(STATE_PATH, "utf8").replace(/^﻿/, "");
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, repos: {} };
    if (!parsed.repos || typeof parsed.repos !== "object") parsed.repos = {};
    return parsed;
  } catch (e) {
    logEvent("WARN", null, "stateLoadError", e.message);
    return { version: 1, repos: {} };
  }
}

function saveState(state) {
  try {
    ensureDir(LOGS_DIR);
    var tmp = STATE_PATH + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    logEvent("ERROR", null, "stateSaveError", e.message);
    try { fs.unlinkSync(STATE_PATH + "." + process.pid + ".tmp"); } catch (e2) {}
  }
}

// ============================================================
// FILE HELPERS
// ============================================================

function rmrfSync(p) {
  if (!fs.existsSync(p)) return;
  if (typeof fs.rmSync === "function") {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    return;
  }
  var entries = fs.readdirSync(p);
  for (var i = 0; i < entries.length; i++) {
    var sub = path.join(p, entries[i]);
    if (fs.statSync(sub).isDirectory()) rmrfSync(sub);
    else { try { fs.unlinkSync(sub); } catch (e) {} }
  }
  try { fs.rmdirSync(p); } catch (e) {}
}

function copyDirRecursive(src, dest) {
  if (typeof fs.cpSync === "function") {
    fs.cpSync(src, dest, { recursive: true, force: true, dereference: false });
    return;
  }
  ensureDir(dest);
  var entries = fs.readdirSync(src);
  for (var i = 0; i < entries.length; i++) {
    var s = path.join(src, entries[i]);
    var d = path.join(dest, entries[i]);
    var st = fs.lstatSync(s);
    if (st.isDirectory()) copyDirRecursive(s, d);
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
}

// ============================================================
// GIT
// ============================================================

function runGit(args, opts) {
  opts = opts || {};
  var execOpts = {
    encoding: "utf8",
    timeout: opts.timeout || 30000,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd || undefined,
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    })
  };
  try {
    var out = childProcess.execFileSync("git", args, execOpts);
    return out.toString("utf8");
  } catch (e) {
    var stderr = (e.stderr && e.stderr.toString("utf8")) || "";
    var err = new Error("git " + args.slice(0, 2).join(" ") + " failed: " + (stderr.trim() || e.message));
    err.code = e.code;
    err.stderr = stderr;
    throw err;
  }
}

function gitAvailable() {
  try {
    childProcess.execFileSync("git", ["--version"], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"]
    });
    return true;
  } catch (e) { return false; }
}

// ============================================================
// PER-REPO SYNC
// ============================================================

function asArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function ensureClone(repo, clonePath) {
  var freshClone = false;
  if (!fs.existsSync(path.join(clonePath, ".git"))) {
    if (fs.existsSync(clonePath)) rmrfSync(clonePath);
    ensureDir(CACHE_DIR);
    var cloneArgs = [
      "clone", "--depth", "1", "--branch", repo.branch,
      "--filter=blob:none", "--no-checkout",
      repo.url, clonePath
    ];
    runGit(cloneArgs, { timeout: GIT_CLONE_TIMEOUT_MS });
    freshClone = true;
    var sparsePaths = asArray(repo.sparse);
    if (sparsePaths.length > 0) {
      try { runGit(["sparse-checkout", "init", "--cone"], { cwd: clonePath, timeout: 10000 }); }
      catch (e) { logEvent("WARN", repo.slug, "sparseInitFailed", e.message); }
      try { runGit(["sparse-checkout", "set"].concat(sparsePaths), { cwd: clonePath, timeout: 10000 }); }
      catch (e) { logEvent("WARN", repo.slug, "sparseSetFailed", e.message); }
    }
    runGit(["checkout", repo.branch], { cwd: clonePath, timeout: GIT_CHECKOUT_TIMEOUT_MS });
  }
  return freshClone;
}

function syncRepo(repo, state) {
  var clonePath = path.join(CACHE_DIR, repo.slug);
  var prev = state.repos[repo.slug] || {};
  var freshClone = false;

  try {
    freshClone = ensureClone(repo, clonePath);
  } catch (e) {
    logEvent("WARN", repo.slug, "ensureCloneFailed", e.message + " - retrying fresh");
    try { rmrfSync(clonePath); } catch (e2) {}
    freshClone = ensureClone(repo, clonePath);
  }

  if (!freshClone) {
    runGit(["fetch", "--depth", "1", "origin", repo.branch],
           { cwd: clonePath, timeout: GIT_FETCH_TIMEOUT_MS });
  }

  var head = runGit(["rev-parse", "HEAD"], { cwd: clonePath, timeout: 5000 }).trim();
  var fetchHead;
  try {
    fetchHead = runGit(["rev-parse", "FETCH_HEAD"], { cwd: clonePath, timeout: 5000 }).trim();
  } catch (e) {
    fetchHead = head;
  }

  if (head !== fetchHead) {
    runGit(["reset", "--hard", "FETCH_HEAD"], { cwd: clonePath, timeout: GIT_CHECKOUT_TIMEOUT_MS });
    head = fetchHead;
  }

  // Smart-skip: same SHA + materializer version → safe to skip.
  // If MATERIALIZER_VERSION changed since the state was written, force a
  // re-materialize even on unchanged SHA so the new transform applies.
  var sameMaterializer = (prev.materializerVersion === MATERIALIZER_VERSION);
  if (prev.sha === head && sameMaterializer &&
      Array.isArray(prev.folders) && prev.folders.length > 0 && !freshClone) {
    logEvent("INFO", repo.slug, "skipUnchanged", "sha unchanged",
             { sha: head, folders: prev.folders.length });
    return { changed: false, sha: head, folders: prev.folders };
  }

  var folders = materializeSkills(repo, clonePath);
  return { changed: true, sha: head, folders: folders };
}

// ============================================================
// MATERIALIZE
// ============================================================

function discoverSkillFolders(repo, clonePath) {
  var srcDirs = [];
  var subdirs = asArray(repo.subdir);

  if (repo.layout === "flat") {
    for (var si = 0; si < subdirs.length; si++) {
      var base = subdirs[si] ? path.join(clonePath, subdirs[si]) : clonePath;
      if (!fs.existsSync(base)) continue;
      var entries = fs.readdirSync(base);
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        if (name.startsWith(".")) continue;
        var full = path.join(base, name);
        try {
          if (fs.statSync(full).isDirectory()) srcDirs.push({ src: full, name: name });
        } catch (e) {}
      }
    }
  } else if (repo.layout === "nested") {
    var rootDir = path.join(clonePath, subdirs[0] || "skills");
    if (!fs.existsSync(rootDir)) return srcDirs;
    (repo.categories || []).forEach(function(cat) {
      var catDir = path.join(rootDir, cat);
      if (!fs.existsSync(catDir)) return;
      fs.readdirSync(catDir).forEach(function(name) {
        if (name.startsWith(".")) return;
        var full = path.join(catDir, name);
        try {
          if (fs.statSync(full).isDirectory()) srcDirs.push({ src: full, name: name });
        } catch (e) {}
      });
    });
  } else if (repo.layout === "root-detect") {
    var base2 = clonePath;
    fs.readdirSync(base2).forEach(function(name) {
      if (name.startsWith(".")) return;
      var full = path.join(base2, name);
      try {
        if (!fs.statSync(full).isDirectory()) return;
        if (!fs.existsSync(path.join(full, "SKILL.md"))) return;
        srcDirs.push({ src: full, name: name });
      } catch (e) {}
    });
  }
  return srcDirs;
}

// After a skill is copied into its prefixed destination folder, rewrite the
// YAML `name:` field in SKILL.md so it matches the new folder name. Without
// this, Claude Code's skill loader sees `name: shadcn-ui` inside a folder
// called `opendesign-shadcn-ui` — a spec violation that can either cause the
// skill to be skipped entirely or cause cross-repo skill-ID collisions
// (e.g. two different folders both claiming `name: mcp-builder`).
//
// Conservative regex: only the `name:` line in the frontmatter block, only
// the first occurrence, preserves indentation, drops quoting. If SKILL.md is
// missing or has no recognizable frontmatter, leave the folder alone.
function rewriteSkillName(destDir, newName) {
  var smPath = path.join(destDir, "SKILL.md");
  if (!fs.existsSync(smPath)) return false;
  var raw;
  try { raw = fs.readFileSync(smPath, "utf8"); } catch (e) { return false; }
  var content = raw.replace(/^﻿/, "");
  // Match leading frontmatter delimiter; require it to actually be a YAML block
  var fmMatch = content.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*\r?\n)/);
  if (!fmMatch) return false;
  var fmStart = fmMatch[1];
  var fmBody  = fmMatch[2];
  var fmEnd   = fmMatch[3];
  var rest    = content.slice(fmMatch[0].length);
  // Replace the first top-level `name:` line. Handles quoted ('foo'/"foo")
  // and unquoted values. Preserves leading whitespace (sanity: top-level
  // keys typically have none, but defensive).
  var nameRe = /^([ \t]*name[ \t]*:[ \t]*).*$/m;
  var newBody;
  if (nameRe.test(fmBody)) {
    newBody = fmBody.replace(nameRe, "$1" + newName);
  } else {
    // No `name:` field at all — prepend one. Extremely rare in practice.
    newBody = "name: " + newName + (fmBody.length > 0 ? "\n" + fmBody : "");
  }
  if (newBody === fmBody) return false;
  try {
    fs.writeFileSync(smPath, fmStart + newBody + fmEnd + rest, "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeSkillName(repoSlug, rawName) {
  var slug = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) return null;
  if (WIN_RESERVED_RE.test(slug)) return null;
  var full = repoSlug + "-" + slug;
  if (full.length > 240) return null;
  return full;
}

function materializeSkills(repo, clonePath) {
  ensureDir(SKILLS_DIR);
  var seen = {};
  var written = [];
  var skipped = 0;
  var srcDirs = discoverSkillFolders(repo, clonePath);

  for (var i = 0; i < srcDirs.length; i++) {
    var entry = srcDirs[i];
    var safe = normalizeSkillName(repo.slug, entry.name);
    if (!safe) {
      logEvent("WARN", repo.slug, "skipReservedOrEmpty", entry.name);
      skipped++;
      continue;
    }
    // Collision suffix when two source dirs produce the same basename
    var finalName = safe;
    if (seen[finalName]) {
      var n = 2;
      while (seen[safe + "-" + n]) n++;
      finalName = safe + "-" + n;
      logEvent("WARN", repo.slug, "nameCollision", entry.name + " -> " + finalName);
    }
    seen[finalName] = true;

    // Defensive: never write outside <slug>- namespace
    if (finalName.indexOf(repo.slug + "-") !== 0) {
      logEvent("ERROR", repo.slug, "namespaceBreach", finalName);
      skipped++;
      continue;
    }

    var dest = path.join(SKILLS_DIR, finalName);
    var tmp  = dest + ".tmp";

    if (IS_DRY_RUN) {
      written.push(finalName);
      continue;
    }

    try {
      if (fs.existsSync(tmp)) rmrfSync(tmp);
      copyDirRecursive(entry.src, tmp);
      // Spec-compliance fix-up: rewrite YAML `name:` field inside the tmp copy
      // BEFORE the final atomic rename, so discovery never sees a mismatched
      // SKILL.md and we don't need a separate atomic write inside dest.
      rewriteSkillName(tmp, finalName);
      if (fs.existsSync(dest)) rmrfSync(dest);
      fs.renameSync(tmp, dest);
      written.push(finalName);
    } catch (e) {
      logEvent("ERROR", repo.slug, "materializeFailed", entry.name + ": " + e.message);
      try { if (fs.existsSync(tmp)) rmrfSync(tmp); } catch (e2) {}
      skipped++;
    }
  }

  logEvent("INFO", repo.slug, "materialized", "wrote " + written.length + ", skipped " + skipped,
           { written: written.length, skipped: skipped });
  return written;
}

function cleanupRemoved(repo, prevFolders, currFolders) {
  if (IS_DRY_RUN) return [];
  if (!Array.isArray(prevFolders) || prevFolders.length === 0) return [];

  if (currFolders.length < prevFolders.length * SHRINK_THRESHOLD) {
    logEvent("WARN", repo.slug, "suspiciousShrink",
             "prev=" + prevFolders.length + " curr=" + currFolders.length + " - skipping cleanup");
    return [];
  }

  var currSet = {};
  for (var i = 0; i < currFolders.length; i++) currSet[currFolders[i]] = true;

  var removed = [];
  for (var j = 0; j < prevFolders.length; j++) {
    var name = prevFolders[j];
    if (currSet[name]) continue;
    if (!name || name.indexOf(repo.slug + "-") !== 0) continue;
    var p = path.join(SKILLS_DIR, name);
    try { rmrfSync(p); removed.push(name); }
    catch (e) { logEvent("WARN", repo.slug, "cleanupFailed", name + ": " + e.message); }
  }
  if (removed.length > 0) {
    logEvent("INFO", repo.slug, "cleanedUp", "removed " + removed.length + " stale folder(s)",
             { removed: removed });
  }
  return removed;
}

// ============================================================
// MAIN
// ============================================================

function main() {
  rotateLog();
  ensureDir(LOGS_DIR);

  if (!gitAvailable()) {
    logEvent("FATAL", null, "gitMissing", "git binary not in PATH");
    return 0;
  }

  if (!acquireLock()) {
    logEvent("INFO", null, "lockBusy", "another sync in progress");
    return 0;
  }

  var startedAt = Date.now();
  logEvent("INFO", null, "syncStart", "begin sync of " + REPOS.length + " repos");

  try {
    ensureDir(CACHE_DIR);
    var state = loadState();
    if (!state.repos) state.repos = {};

    for (var i = 0; i < REPOS.length; i++) {
      var repo = REPOS[i];
      var prev = state.repos[repo.slug] || { folders: [] };
      try {
        var result = syncRepo(repo, state);
        if (result.changed) {
          cleanupRemoved(repo, prev.folders || [], result.folders);
        }
        state.repos[repo.slug] = {
          sha: result.sha,
          syncedAt: new Date().toISOString(),
          folders: result.folders,
          skillCount: result.folders.length,
          materializerVersion: MATERIALIZER_VERSION,
          changed: result.changed,
          lastError: null
        };
        logEvent("INFO", repo.slug, "syncOk",
                 (result.changed ? "updated" : "unchanged") + " sha=" + result.sha.slice(0, 7),
                 { skillCount: result.folders.length });
      } catch (e) {
        var prevState = state.repos[repo.slug] || {};
        state.repos[repo.slug] = {
          sha: prevState.sha || null,
          syncedAt: prevState.syncedAt || null,
          folders: prevState.folders || [],
          skillCount: (prevState.folders || []).length,
          changed: false,
          lastError: (e.message || String(e)).slice(0, 500)
        };
        logEvent("ERROR", repo.slug, "syncFailed", e.message);
      }
      if (!IS_DRY_RUN) saveState(state);
    }

    state.lastSyncAt = new Date().toISOString();
    state.lastSyncDurationMs = Date.now() - startedAt;
    state.version = 1;
    if (!IS_DRY_RUN) saveState(state);

    logEvent("INFO", null, "syncEnd", "done in " + state.lastSyncDurationMs + "ms");
  } catch (e) {
    logEvent("FATAL", null, "mainError", e.message);
    logHookError(e, "main");
  } finally {
    releaseLock();
  }

  return 0;
}

try {
  process.exit(main());
} catch (e) {
  logHookError(e, "uncaught");
  try { logEvent("FATAL", null, "uncaught", e.message); } catch (e2) {}
  process.exit(0);
}
