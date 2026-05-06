#!/usr/bin/env node
/**
 * update-from-github.js — Pull the latest claude-model-changer release from
 * GitHub and overwrite the local marketplace source.
 *
 * For users who keep a local-path marketplace (like the original author's
 * dev setup) but still want zero-touch updates from the upstream GitHub
 * repo. Run manually or hook to /loop for a recurring sync.
 *
 * Usage:
 *   node scripts/update-from-github.js               # update to latest tag
 *   node scripts/update-from-github.js --tag v3.2.1  # specific version
 *   node scripts/update-from-github.js --dry         # show diff without applying
 *
 * Strategy:
 *   1. Clone (or fetch) https://github.com/R4CK/claude-model-changer to
 *      ~/.claude/plugins/cache/<owner>/external/claude-model-changer
 *   2. Checkout the requested tag (default: most recent v* tag)
 *   3. rsync-style copy into the marketplace source directory
 *   4. Skip files in `logs/` and any user-edited files listed in
 *      `.update-preserve` (one path per line)
 */
"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var REPO_URL = "https://github.com/R4CK/claude-model-changer.git";

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME;
}

function getOwner() {
  if (process.env.CMC_MARKETPLACE_OWNER) return process.env.CMC_MARKETPLACE_OWNER;
  var u = process.env.USER || process.env.USERNAME || "";
  return u.toLowerCase().replace(/[^a-z0-9_-]/g, "") + "-local";
}

var HOME = getHomeDir();
var OWNER = getOwner();
var EXTERNAL_DIR = path.join(HOME, ".claude", "plugins", "cache", OWNER, "external", "claude-model-changer");
var MARKETPLACE_DIR = path.join(HOME, ".claude", "plugins", "marketplaces", OWNER, "plugins", "claude-model-changer");

function log(msg) { console.log("[update] " + msg); }
function err(msg) { console.error("[update] ERROR: " + msg); }

function run(cmd, args, opts) {
  return cp.spawnSync(cmd, args, Object.assign({ stdio: "inherit", encoding: "utf8" }, opts || {}));
}
function runCapture(cmd, args, opts) {
  var r = cp.spawnSync(cmd, args, Object.assign({ encoding: "utf8" }, opts || {}));
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function syncRepo() {
  if (!fs.existsSync(path.dirname(EXTERNAL_DIR))) fs.mkdirSync(path.dirname(EXTERNAL_DIR), { recursive: true });
  if (fs.existsSync(path.join(EXTERNAL_DIR, ".git"))) {
    log("fetching from origin...");
    run("git", ["-C", EXTERNAL_DIR, "fetch", "origin", "--tags"]);
  } else {
    log("cloning " + REPO_URL + " ...");
    run("git", ["clone", REPO_URL, EXTERNAL_DIR]);
  }
}

function latestTag() {
  var r = runCapture("git", ["-C", EXTERNAL_DIR, "tag", "--sort=-v:refname"]);
  if (r.status !== 0) return null;
  var tags = r.stdout.split("\n").filter(function(t) { return /^v?\d/.test(t); });
  return tags[0] || null;
}

function checkoutTag(tag) {
  var r = run("git", ["-C", EXTERNAL_DIR, "checkout", "--quiet", tag]);
  return r.status === 0;
}

function readPreserveList() {
  var f = path.join(MARKETPLACE_DIR, ".update-preserve");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l && !l.startsWith("#"); });
}

// Recursive copy from src to dst, skipping logs/ and any path in preserve list.
function copyTree(src, dst, preserve, dry) {
  preserve = preserve || [];
  if (!fs.existsSync(dst)) {
    if (!dry) fs.mkdirSync(dst, { recursive: true });
  }
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.name === ".git" || e.name === "logs" || e.name === "node_modules") continue;
    var s = path.join(src, e.name);
    var d = path.join(dst, e.name);
    var rel = path.relative(MARKETPLACE_DIR, d).replace(/\\/g, "/");
    if (preserve.indexOf(rel) !== -1) {
      log("preserved: " + rel);
      continue;
    }
    if (e.isDirectory()) {
      copyTree(s, d, preserve, dry);
    } else {
      if (dry) {
        var changed = !fs.existsSync(d) || fs.readFileSync(s).toString() !== fs.readFileSync(d).toString();
        if (changed) log("WOULD UPDATE: " + rel);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
}

function main() {
  if (!HOME) { err("HOME / USERPROFILE not set"); process.exit(1); }

  var args = process.argv.slice(2);
  var tagArg = null, dry = false;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) { tagArg = args[i + 1]; i++; }
    else if (args[i] === "--dry") dry = true;
  }

  syncRepo();
  var tag = tagArg || latestTag();
  if (!tag) { err("no tags found in upstream repo"); process.exit(1); }
  log("target tag: " + tag);

  if (!checkoutTag(tag)) {
    err("failed to checkout tag " + tag);
    process.exit(1);
  }

  // Skip the dist/ and install.* on local marketplaces — they're for the
  // self-extracting installer flow, not relevant here.
  var preserve = readPreserveList();
  log("preserve list (" + preserve.length + " entries): " + preserve.slice(0, 5).join(", "));

  // Copy plugin tree from external/claude-model-changer (which IS the plugin
  // root upstream) to MARKETPLACE_DIR.
  log((dry ? "dry-run: " : "") + "syncing files...");
  copyTree(EXTERNAL_DIR, MARKETPLACE_DIR, preserve, dry);

  if (dry) {
    log("dry-run complete. No changes applied.");
  } else {
    log("done. Restart Claude Code (or trigger plugin reload) for the cache to refresh.");
    log("Tag installed: " + tag);
  }
}

if (require.main === module) {
  try { main(); }
  catch (e) { err(e.message); process.exit(1); }
}

module.exports = { syncRepo: syncRepo, latestTag: latestTag, copyTree: copyTree };
