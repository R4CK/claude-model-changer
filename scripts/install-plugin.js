#!/usr/bin/env node

/**
 * Claude Model Changer - Plugin Installer
 * Cross-platform (Windows, macOS, Linux)
 *
 * Usage: node scripts/install-plugin.js
 */

"use strict";

var fs = require("fs");
var path = require("path");
var karpathy = require("./sync-karpathy-skills.js");
var centralClaudeMd = require("./update-central-claude-md.js");

var PLUGIN_NAME = "claude-model-changer";

// PLUGIN_VERSION is read from .claude-plugin/plugin.json (single source of
// truth). NEVER hardcode it here - the plugin.json version drives every
// versioned artifact (cache dir, registration entry, manifest, etc.).
var PLUGIN_VERSION = (function() {
  try {
    var manifestPath = path.join(__dirname, "..", ".claude-plugin", "plugin.json");
    var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.version) throw new Error("plugin.json has no version field");
    return manifest.version;
  } catch (err) {
    console.error("[install] FATAL: cannot read plugin version from .claude-plugin/plugin.json: " + err.message);
    process.exit(1);
  }
})();

// Semver-like comparison: returns true if verA > verB (e.g., "3.0.0" > "2.5.0").
// Simple numeric comparison on dot-separated parts; good enough for version cleanup.
function isVersionGreater(verA, verB) {
  var partsA = (verA || "0").split(".").map(function(x) { return parseInt(x, 10) || 0; });
  var partsB = (verB || "0").split(".").map(function(x) { return parseInt(x, 10) || 0; });
  for (var i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    var a = partsA[i] || 0;
    var b = partsB[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

// Marketplace owner namespace. Used both as the cache subdir name
// (~/.claude/plugins/cache/<OWNER>/...) and as the registration key suffix
// "<plugin>@<owner>". The two MUST match.
//
// Resolution order:
//   1. CMC_MARKETPLACE_OWNER environment variable (explicit override)
//   2. Derived from system username: "<lowercase-username>-local"
//   3. Fallback "user-local" if no username detectable
//
// NOTE: For the original author (username "NEON"), the dynamic value resolves
// to "neon-local", which is exactly the existing registration key on this
// machine. Migration is therefore a no-op for the original installer.
function detectMarketplaceOwner() {
  if (process.env.CMC_MARKETPLACE_OWNER) {
    return process.env.CMC_MARKETPLACE_OWNER;
  }
  var user = process.env.USER ||
             process.env.USERNAME ||
             (process.env.USERPROFILE ? path.basename(process.env.USERPROFILE) : "") ||
             (process.env.HOME ? path.basename(process.env.HOME) : "") ||
             "user";
  // Sanitize: lowercase, only [a-z0-9_-]
  var slug = user.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) slug = "user";
  return slug + "-local";
}
var PLUGIN_OWNER = detectMarketplaceOwner();

// ---- Helpers ----

function getHomeDir() {
  var home = process.env.HOME || process.env.USERPROFILE;
  if (!home) { console.error("[install] ERROR: HOME or USERPROFILE not set"); process.exit(1); }
  return home;
}

function getClaudeDir() {
  return path.join(getHomeDir(), ".claude");
}

function getCacheDir() {
  return path.join(getClaudeDir(), "plugins", "cache", PLUGIN_OWNER, PLUGIN_NAME, PLUGIN_VERSION);
}

// Stable path that hooks always reference — replaced wholesale on each install.
// Eliminates the need to ever update settings.local.json after version upgrades.
function getCurrentDir() {
  return path.join(getClaudeDir(), "plugins", "cache", PLUGIN_OWNER, PLUGIN_NAME, "current");
}

function rmrf(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function getPluginsJsonPath() {
  return path.join(getClaudeDir(), "plugins", "installed_plugins.json");
}

function getSettingsJsonPath() {
  return path.join(getClaudeDir(), "settings.json");
}

function getProjectRoot() {
  return path.resolve(__dirname, "..");
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var srcPath = path.join(src, entry.name);
    var destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getSettingsLocalJsonPath() {
  return path.join(getClaudeDir(), "settings.local.json");
}

function log(msg) {
  console.log("[install] " + msg);
}

function logError(msg) {
  console.error("[install] ERROR: " + msg);
}

// Build a hook command that references pluginRoot directly (no dynamic version lookup).
// This avoids the alphabetical-sort trap when multiple cached versions coexist.
function makeHookCmd(pluginRoot, script) {
  // Use forward slashes; Node on Windows accepts them fine.
  var normalised = pluginRoot.replace(/\\/g, "/");
  return "node \"" + normalised + "/scripts/" + script + "\"";
}

function updateSettingsLocalHooks(pluginRoot) {
  var slPath = getSettingsLocalJsonPath();
  var sl = {};
  try {
    if (fs.existsSync(slPath)) {
      sl = JSON.parse(fs.readFileSync(slPath, "utf8"));
    }
  } catch (e) {
    log("Warning: Could not read settings.local.json, creating new");
  }

  if (!sl.hooks) sl.hooks = {};

  // Replace our plugin's hook entries (all four event types).
  // We deliberately overwrite so the active version stays current after upgrades.
  sl.hooks["SessionStart"] = [
    { hooks: [{ type: "command", command: makeHookCmd(pluginRoot, "runtime-check.js"), timeout: 10 }] }
  ];
  sl.hooks["UserPromptSubmit"] = [
    { hooks: [{ type: "command", command: makeHookCmd(pluginRoot, "analyze-complexity.js"), timeout: 60 }] }
  ];
  sl.hooks["Stop"] = [
    { hooks: [{ type: "command", command: makeHookCmd(pluginRoot, "enforce-stats.js"), timeout: 30 }] }
  ];
  sl.hooks["SubagentStop"] = [
    { hooks: [{ type: "command", command: makeHookCmd(pluginRoot, "detect-fallback.js"), timeout: 15 }] }
  ];

  fs.writeFileSync(slPath, JSON.stringify(sl, null, 2));
  log("Updated hooks in settings.local.json -> " + pluginRoot);
}

// Clean up old cached versions, keeping only the newest and one previous (for rollback).
// Removes "current" and non-semver directories from consideration.
function cleanupOldVersions(cacheBaseDir) {
  if (!fs.existsSync(cacheBaseDir)) return;
  var entries = fs.readdirSync(cacheBaseDir, { withFileTypes: true });
  var versions = [];

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isDirectory()) continue;
    if (e.name === "current" || e.name === "external") continue;
    // Rough semver check: must have dots (e.g., "3.0.0")
    if (!/^\d+\.\d+\.\d+/.test(e.name)) continue;
    versions.push(e.name);
  }

  if (versions.length <= 2) return; // Keep all if only 1-2 versions exist

  // Sort descending (newest first)
  versions.sort(function(a, b) {
    return isVersionGreater(a, b) ? -1 : (isVersionGreater(b, a) ? 1 : 0);
  });

  var toDelete = versions.slice(2); // All except newest + previous
  for (var i = 0; i < toDelete.length; i++) {
    var oldDir = path.join(cacheBaseDir, toDelete[i]);
    rmrf(oldDir);
    log("Cleaned up old version: " + toDelete[i]);
  }
}



// ---- Main ----

function main() {
  var projectRoot = getProjectRoot();
  var claudeDir = getClaudeDir();
  var cacheDir = getCacheDir();
  var currentDir = getCurrentDir();

  log("Claude Model Changer v" + PLUGIN_VERSION + " - Installer");
  log("Project root: " + projectRoot);
  log("Marketplace owner: " + PLUGIN_OWNER +
      (process.env.CMC_MARKETPLACE_OWNER ? " (from CMC_MARKETPLACE_OWNER env)" : " (auto-detected from username)"));
  log("Versioned target : " + cacheDir);
  log("Stable target    : " + currentDir);
  log("");

  // Check Claude Code directory exists
  if (!fs.existsSync(claudeDir)) {
    logError("Claude Code directory not found: " + claudeDir);
    logError("Make sure Claude Code is installed first.");
    process.exit(1);
  }

  // Ensure plugins directory structure
  var pluginsDir = path.join(claudeDir, "plugins");
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    log("Created plugins directory");
  }

  var cacheBase = path.join(pluginsDir, "cache", "neon-local", PLUGIN_NAME);
  if (!fs.existsSync(cacheBase)) {
    fs.mkdirSync(cacheBase, { recursive: true });
  }

  // Copy plugin directories to cache
  var dirs = ["scripts", "config", "commands", "agents", "skills", "hooks", ".claude-plugin"];
  dirs.forEach(function(dir) {
    var src = path.join(projectRoot, dir);
    var dest = path.join(cacheDir, dir);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, dest);
      log("Copied " + dir + "/");
    } else {
      log("Skipped " + dir + "/ (not found)");
    }
  });

  // Copy individual files
  ["README.md", "LICENSE", "CHANGELOG.md", "CLAUDE.md", "package.json"].forEach(function(file) {
    var src = path.join(projectRoot, file);
    var dest = path.join(cacheDir, file);
    if (fs.existsSync(src)) {
      if (!fs.existsSync(path.dirname(dest))) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
      }
      fs.copyFileSync(src, dest);
      log("Copied " + file);
    }
  });

  // Ensure logs directory exists in cache
  var logsDir = path.join(cacheDir, "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    log("Created logs/");
  }

  // Sync external karpathy skills (always-latest from upstream repo)
  // and merge into the plugin's central skills/ directory.
  log("");
  log("Syncing external skills (andrej-karpathy-skills)...");
  var karpathyInstalled = [];
  try {
    var ok = karpathy.syncRepo();
    if (ok || fs.existsSync(karpathy.getRepoCacheDir())) {
      karpathyInstalled = karpathy.installSkillsTo(path.join(cacheDir, "skills"));
    } else {
      log("Skipped karpathy skills (no cache, no network)");
    }
  } catch (e) {
    log("Warning: karpathy sync failed - " + e.message);
  }

  // Update the central ~/.claude/CLAUDE.md with a managed block listing
  // the karpathy skills that are now available.
  try {
    var skillNames = karpathyInstalled.length > 0
      ? karpathyInstalled
      : (function() {
          var d = path.join(karpathy.getRepoCacheDir(), "skills");
          if (!fs.existsSync(d)) return [];
          return fs.readdirSync(d, { withFileTypes: true })
            .filter(function(x) { return x.isDirectory(); })
            .map(function(x) { return x.name; });
        })();
    var block = centralClaudeMd.buildBlock(skillNames);
    var centralPath = path.join(getClaudeDir(), "CLAUDE.md");
    centralClaudeMd.upsertBlock(centralPath, block);
  } catch (e) {
    log("Warning: failed to update central CLAUDE.md - " + e.message);
  }

  log("");

  // Register in installed_plugins.json
  var pluginsJsonPath = getPluginsJsonPath();
  var pluginsData = {};
  try {
    if (fs.existsSync(pluginsJsonPath)) {
      pluginsData = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf8"));
    }
  } catch (err) {
    log("Warning: Could not read installed_plugins.json, creating new");
  }

  var pluginKey = PLUGIN_NAME + "@" + PLUGIN_OWNER;

  // Migrate any legacy "@local" entry from previous buggy installs
  var legacyKey = PLUGIN_NAME + "@local";
  var pluginEntry = [
    {
      scope: "user",
      installPath: cacheDir,
      version: PLUGIN_VERSION,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    }
  ];

  // Support both v2 format (has "plugins" sub-object) and legacy flat format
  if (pluginsData.plugins && typeof pluginsData.plugins === "object") {
    pluginsData.plugins[pluginKey] = pluginEntry;
    // Clean up any stale top-level entry from old installs
    if (pluginsData[pluginKey]) delete pluginsData[pluginKey];
    // Migrate: remove legacy "@local" duplicate (created by older buggy installs)
    if (legacyKey !== pluginKey && pluginsData.plugins[legacyKey]) {
      delete pluginsData.plugins[legacyKey];
      log("Removed legacy '" + legacyKey + "' entry");
    }
  } else {
    pluginsData[pluginKey] = pluginEntry;
    if (legacyKey !== pluginKey && pluginsData[legacyKey]) {
      delete pluginsData[legacyKey];
      log("Removed legacy '" + legacyKey + "' entry");
    }
  }
  fs.writeFileSync(pluginsJsonPath, JSON.stringify(pluginsData, null, 2));
  log("Registered in installed_plugins.json");

  // Enable plugin in settings.json
  var settingsPath = getSettingsJsonPath();
  var settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch (err) {
    log("Warning: Could not read settings.json, creating new");
  }

  if (!settings.enabledPlugins) {
    settings.enabledPlugins = {};
  }
  // enabledPlugins is an object: { "plugin-name@scope": true }
  if (typeof settings.enabledPlugins === "object" && !Array.isArray(settings.enabledPlugins)) {
    var changed = false;
    if (!settings.enabledPlugins[pluginKey]) {
      settings.enabledPlugins[pluginKey] = true;
      changed = true;
    }
    // Migrate: remove legacy "@local" duplicate (created by older buggy installs)
    if (legacyKey !== pluginKey && settings.enabledPlugins[legacyKey]) {
      delete settings.enabledPlugins[legacyKey];
      log("Removed legacy '" + legacyKey + "' from enabledPlugins");
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      log("Enabled in settings.json");
    } else {
      log("Already enabled in settings.json");
    }
  }

  // Publish to current/ — the stable path hooks permanently reference.
  // Wipe and re-copy so current/ always exactly matches the just-installed version.
  log("Publishing to stable current/ path...");
  rmrf(currentDir);
  copyDirRecursive(cacheDir, currentDir);
  log("Published: " + currentDir);

  // Write hooks once, pointing at current/ — never needs touching again on upgrades.
  updateSettingsLocalHooks(currentDir);

  // Clean up old cached versions (keep newest + 1 previous for rollback).
  var cacheBase = path.join(claudeDir, "plugins", "cache", PLUGIN_OWNER, PLUGIN_NAME);
  cleanupOldVersions(cacheBase);

  log("");
  log("Installation complete!");
  log("Restart Claude Code to activate the plugin.");
  log("");
  log("Available commands: /stats, /tune, /configure, /benchmark, /dashboard");
  log("Auto-routing is active on every prompt.");
}

try {
  main();
} catch (err) {
  logError(err.message);
  process.exit(1);
}
