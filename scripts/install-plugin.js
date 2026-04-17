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

var PLUGIN_NAME = "claude-model-changer";
var PLUGIN_VERSION = "5.3.3";

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

function log(msg) {
  console.log("[install] " + msg);
}

function logError(msg) {
  console.error("[install] ERROR: " + msg);
}

// ---- Main ----

function main() {
  var projectRoot = getProjectRoot();
  var claudeDir = getClaudeDir();
  var cacheDir = getCacheDir();

  log("Claude Model Changer v" + PLUGIN_VERSION + " - Installer");
  log("Project root: " + projectRoot);
  log("Marketplace owner: " + PLUGIN_OWNER +
      (process.env.CMC_MARKETPLACE_OWNER ? " (from CMC_MARKETPLACE_OWNER env)" : " (auto-detected from username)"));
  log("Target: " + cacheDir);
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
  ["README.md", "LICENSE", "CHANGELOG.md", "CLAUDE.md"].forEach(function(file) {
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
