#!/usr/bin/env node

/**
 * Claude Model Changer - Plugin Uninstaller
 * Cross-platform (Windows, macOS, Linux)
 *
 * Usage: node scripts/uninstall-plugin.js
 */

"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_NAME = "claude-model-changer";

// ---- Helpers ----

function getHomeDir() {
  var home = process.env.HOME || process.env.USERPROFILE;
  if (!home) { console.error("[uninstall] ERROR: HOME or USERPROFILE not set"); process.exit(1); }
  return home;
}

function getClaudeDir() {
  return path.join(getHomeDir(), ".claude");
}

function getCacheBaseDir() {
  return path.join(getClaudeDir(), "plugins", "cache", "neon-local", PLUGIN_NAME);
}

function getPluginsJsonPath() {
  return path.join(getClaudeDir(), "plugins", "installed_plugins.json");
}

function getSettingsJsonPath() {
  return path.join(getClaudeDir(), "settings.json");
}

function removeDirRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  var entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var fullPath = path.join(dirPath, entries[i].name);
    if (entries[i].isDirectory()) {
      removeDirRecursive(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  fs.rmdirSync(dirPath);
}

function log(msg) {
  console.log("[uninstall] " + msg);
}

// ---- Main ----

function main() {
  var pluginKey = PLUGIN_NAME + "@neon-local";
  var legacyKey = PLUGIN_NAME + "@local";

  log("Claude Model Changer - Uninstaller");
  log("");

  // Remove from installed_plugins.json (supports both v1 flat and v2 nested format)
  var pluginsJsonPath = getPluginsJsonPath();
  if (fs.existsSync(pluginsJsonPath)) {
    try {
      var pluginsData = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf8"));
      var removed = false;
      // v2 format: { version: 2, plugins: { "key": [...] } }
      if (pluginsData.plugins && typeof pluginsData.plugins === "object") {
        if (pluginsData.plugins[pluginKey]) { delete pluginsData.plugins[pluginKey]; removed = true; }
        if (pluginsData.plugins[legacyKey]) { delete pluginsData.plugins[legacyKey]; removed = true; }
      }
      // v1 flat format
      if (pluginsData[pluginKey]) { delete pluginsData[pluginKey]; removed = true; }
      if (pluginsData[legacyKey]) { delete pluginsData[legacyKey]; removed = true; }
      if (removed) {
        fs.writeFileSync(pluginsJsonPath, JSON.stringify(pluginsData, null, 2));
        log("Removed from installed_plugins.json");
      } else {
        log("Not found in installed_plugins.json (already removed)");
      }
    } catch (err) {
      log("Warning: Could not update installed_plugins.json");
    }
  }

  // Remove from settings.json
  var settingsPath = getSettingsJsonPath();
  if (fs.existsSync(settingsPath)) {
    try {
      var settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings.enabledPlugins && typeof settings.enabledPlugins === "object") {
        var disabled = false;
        if (settings.enabledPlugins[pluginKey]) { delete settings.enabledPlugins[pluginKey]; disabled = true; }
        if (settings.enabledPlugins[legacyKey]) { delete settings.enabledPlugins[legacyKey]; disabled = true; }
        if (disabled) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          log("Disabled in settings.json");
        }
      }
    } catch (err) {
      log("Warning: Could not update settings.json");
    }
  }

  // Remove cache directory
  var cacheBase = getCacheBaseDir();
  if (fs.existsSync(cacheBase)) {
    removeDirRecursive(cacheBase);
    log("Removed cache directory: " + cacheBase);
  } else {
    log("Cache directory not found (already removed)");
  }

  log("");
  log("Uninstall complete!");
  log("Restart Claude Code to apply changes.");
}

try {
  main();
} catch (err) {
  console.error("[uninstall] ERROR: " + err.message);
  process.exit(1);
}
