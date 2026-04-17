#!/usr/bin/env node
/**
 * deploy.js - Sync plugin files to cache and update install manifest
 *
 * Usage: node scripts/deploy.js
 */
"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var SRC_DIR = path.join(__dirname, "..");
var PLUGIN_ID = "claude-model-changer@neon-local";
var VERSION = "2.2.0";
var HOME = process.env.HOME || process.env.USERPROFILE;
if (!HOME) { console.error("[deploy] ERROR: HOME or USERPROFILE environment variable not set"); process.exit(1); }
var CACHE_DIR = path.join(HOME, ".claude", "plugins", "cache", "neon-local", "claude-model-changer", VERSION);
var MANIFEST_DIR = path.join(HOME, ".claude", "plugins", ".install-manifests");
var MANIFEST_PATH = path.join(MANIFEST_DIR, PLUGIN_ID + ".json");

// Files to include in plugin (relative to SRC_DIR)
var INCLUDE_DIRS = ["scripts", "scripts/lib", "config", "hooks", "agents", "commands", "skills/model-router", ".claude-plugin"];
var INCLUDE_ROOT_FILES = ["CLAUDE.md", "README.md", "CHANGELOG.md", "LICENSE"];
// Files to exclude (mutable/generated)
var EXCLUDE_PATTERNS = ["logs/", "node_modules/", ".git/", "vscode-extension/", "install.js", "package.json", ".gitignore"];

function sha256(filePath) {
  var content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function shouldExclude(relPath) {
  for (var i = 0; i < EXCLUDE_PATTERNS.length; i++) {
    if (relPath.includes(EXCLUDE_PATTERNS[i])) return true;
  }
  return false;
}

function collectFiles(dir, baseDir) {
  var results = [];
  if (!fs.existsSync(dir)) return results;
  var entries = fs.readdirSync(dir);
  for (var i = 0; i < entries.length; i++) {
    var fullPath = path.join(dir, entries[i]);
    var relPath = path.relative(baseDir, fullPath);
    if (shouldExclude(relPath)) continue;
    var stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      results.push({ fullPath: fullPath, relPath: relPath });
    } else if (stat.isDirectory()) {
      results = results.concat(collectFiles(fullPath, baseDir));
    }
  }
  return results;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function deploy() {
  console.log("[Deploy] Source: " + SRC_DIR);
  console.log("[Deploy] Cache:  " + CACHE_DIR);
  console.log("");

  // Collect all plugin files
  var allFiles = [];
  INCLUDE_DIRS.forEach(function(dir) {
    var absDir = path.join(SRC_DIR, dir);
    if (fs.existsSync(absDir)) {
      var entries = fs.readdirSync(absDir);
      entries.forEach(function(entry) {
        var fullPath = path.join(absDir, entry);
        if (fs.statSync(fullPath).isFile()) {
          allFiles.push({ fullPath: fullPath, relPath: path.relative(SRC_DIR, fullPath) });
        }
      });
    }
  });
  INCLUDE_ROOT_FILES.forEach(function(f) {
    var fullPath = path.join(SRC_DIR, f);
    if (fs.existsSync(fullPath)) {
      allFiles.push({ fullPath: fullPath, relPath: f });
    }
  });

  // Copy files to cache
  var copied = 0;
  allFiles.forEach(function(file) {
    var destPath = path.join(CACHE_DIR, file.relPath);
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(file.fullPath, destPath);
    copied++;
  });
  console.log("[Deploy] Copied " + copied + " files to cache");

  // Ensure marker files exist
  var cliInstalledPath = path.join(CACHE_DIR, ".cli-installed");
  if (!fs.existsSync(cliInstalledPath)) {
    fs.writeFileSync(cliInstalledPath, new Date().toISOString() + "\n");
  }
  var installVersionPath = path.join(CACHE_DIR, ".install-version");
  fs.writeFileSync(installVersionPath, JSON.stringify({ version: VERSION, bun: null, uv: null, installedAt: new Date().toISOString() }) + "\n");

  // Generate manifest with SHA256 hashes
  var manifest = { pluginId: PLUGIN_ID, createdAt: new Date().toISOString(), files: {} };
  allFiles.forEach(function(file) {
    var cachePath = path.join(CACHE_DIR, file.relPath);
    var hash = sha256(cachePath);
    // Use backslash for Windows-style paths in manifest (matching Claude Code convention)
    var manifestKey = file.relPath.replace(/\//g, "\\");
    manifest.files[manifestKey] = hash;
  });

  ensureDir(MANIFEST_DIR);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log("[Deploy] Manifest updated: " + Object.keys(manifest.files).length + " file hashes");
  console.log("[Deploy] Done! Restart Claude Code to activate changes.");
}

deploy();
