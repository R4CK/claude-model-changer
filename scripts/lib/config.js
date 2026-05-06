#!/usr/bin/env node
/**
 * config.js - Config loading, validation, deep merge
 */
"use strict";

var fs = require("fs");
var path = require("path");
var io = require("./io");
var configMigrate = require("./config-migrate");

// Config cache with mtime-based invalidation (v3.0.0).
// Key: cwd or "__base__"; Value: { config, mtimeSignature, loadedAt }
// Signature is built from all 3 input files' mtimes so any edit invalidates.
var _configCache = {};

function _computeMtimeSignature(cwd) {
  var parts = [];
  var paths = [io.getConfigPath(), io.getLearnedConfigPath()];
  if (cwd) paths.push(path.join(cwd, ".claude", "model-routing.json"));
  for (var i = 0; i < paths.length; i++) {
    try {
      var st = fs.statSync(paths[i]);
      parts.push(paths[i] + "@" + st.mtimeMs + ":" + st.size);
    } catch (e) {
      parts.push(paths[i] + "@missing");
    }
  }
  return parts.join("|");
}

// Explicit cache-invalidation API (useful for tests and forced reloads)
function clearConfigCache() {
  _configCache = {};
}

function loadConfig(cwd) {
  var cacheKey = cwd || "__base__";
  // v3.0.0: hot-reload. Re-check input-file mtimes on every call; reuse the
  // cached parsed config only if the signature still matches.
  var currentSig = _computeMtimeSignature(cwd);
  var cached = _configCache[cacheKey];
  if (cached && cached.mtimeSignature === currentSig) {
    return cached.config;
  }

  var baseConfig = null;
  var configCorrupt = false;
  try {
    baseConfig = JSON.parse(fs.readFileSync(io.getConfigPath(), "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    process.stderr.write("[Model Router] Config error: Could not parse task-routing.json - " + err.message + "\n");
    configCorrupt = true;
    baseConfig = null;
  }
  // Store corruption flag for output visibility (H4: silent config failure)
  if (configCorrupt && !baseConfig) {
    _configCache["__configCorrupt__"] = true;
  }

  // Merge in learned-keywords.json (per-user, gitignored, auto-applied
  // suggestions from LLM-fallback). Comes BETWEEN base and project so
  // project-level overrides remain authoritative.
  try {
    var learnedPath = io.getLearnedConfigPath();
    if (fs.existsSync(learnedPath)) {
      var learnedRaw = fs.readFileSync(learnedPath, "utf8").replace(/^\uFEFF/, "");
      var learned = JSON.parse(learnedRaw);
      baseConfig = deepMerge(baseConfig || {}, learned);
    }
  } catch (err) { /* ignore - learned config is optional */ }

  // v3.3.0: Active profile overlay (R43). Profiles are global "personal vs
  // work" toggles stored under ~/.claude/profiles/<name>.json. They sit
  // BETWEEN learned-keywords and the per-project override, so:
  //   base \u2192 learned \u2192 profile \u2192 per-project
  // Per-project remains the strongest scope (most specific wins).
  try {
    var profileMgr = require("./profile-manager");
    var applied = profileMgr.applyProfile(baseConfig, cwd);
    if (applied && applied.profile) {
      baseConfig = applied.config;
      // Annotate so /stats / statusline can show which profile is active
      baseConfig._activeProfile = applied.profile;
    }
  } catch (err) { /* profile manager is optional */ }

  if (cwd) {
    var projectConfigPath = path.join(cwd, ".claude", "model-routing.json");
    try {
      var projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf8"));
      baseConfig = deepMerge(baseConfig || {}, projectConfig);
    } catch (err) {}
  }

  // T1.1 (v2.4.1): never return null from loadConfig. A corrupt or missing
  // task-routing.json should not crash downstream callers - they should get
  // an empty object and degrade to built-in defaults.
  if (!baseConfig) baseConfig = {};

  // Auto-migrate config schema if needed
  var migration = configMigrate.migrateConfig(baseConfig);
  if (migration.migrated) {
    baseConfig = migration.config;
    process.stderr.write("[Model Router] Config migrated: " + migration.fromVersion + " -> " + migration.toVersion + "\n");
    // Save migrated config back to disk
    try { configMigrate.saveMigratedConfig(io.getConfigPath(), baseConfig); } catch (e) {}
  }

  var errors = validateConfig(baseConfig);
  if (errors.length > 0) {
    process.stderr.write("[Model Router] Config warnings:\n  - " + errors.join("\n  - ") + "\n");
  }

  _configCache[cacheKey] = {
    config: baseConfig,
    mtimeSignature: currentSig,
    loadedAt: Date.now()
  };
  return baseConfig;
}

function validateConfig(config) {
  var errors = [];
  if (!config || typeof config !== "object") {
    errors.push("Config is not a valid object");
    return errors;
  }

  if (!config.models || typeof config.models !== "object") {
    errors.push("Missing 'models' section");
  } else {
    ["haiku", "sonnet", "opus"].forEach(function(m) {
      var model = config.models[m];
      if (!model) { errors.push("Missing model definition: " + m); return; }
      if (!Array.isArray(model.scoreRange) || model.scoreRange.length !== 2) {
        errors.push(m + ": scoreRange must be array of 2 numbers");
      } else {
        if (typeof model.scoreRange[0] !== "number" || typeof model.scoreRange[1] !== "number") {
          errors.push(m + ": scoreRange values must be numbers");
        } else if (model.scoreRange[0] > model.scoreRange[1]) {
          errors.push(m + ": scoreRange[0] must be <= scoreRange[1]");
        } else if (model.scoreRange[0] < 1 || model.scoreRange[1] > 10) {
          errors.push(m + ": scoreRange values must be between 1-10");
        }
      }
      if (model.categories && typeof model.categories === "object") {
        Object.keys(model.categories).forEach(function(cat) {
          var c = model.categories[cat];
          if (!c || typeof c !== "object") {
            errors.push(m + "." + cat + ": category must be a valid object");
            return;
          }
          if (!c.keywords || !Array.isArray(c.keywords)) {
            errors.push(m + "." + cat + ": keywords must be an array");
          } else if (c.keywords.length === 0) {
            errors.push(m + "." + cat + ": keywords array is empty");
          }
        });
      }
    });
  }

  if (config.scoring && config.scoring.weights) {
    var w = config.scoring.weights;
    var subScoreKeys = ["keyword", "multiFile", "structure", "wordCount", "codeBlocks"];
    var sum = 0;
    Object.keys(w).forEach(function(k) {
      if (typeof w[k] !== "number" || isNaN(w[k]) || !isFinite(w[k]) || w[k] < 0 || w[k] > 1) {
        errors.push("scoring.weights." + k + " must be finite number between 0 and 1 (got: " + w[k] + ")");
      } else if (subScoreKeys.indexOf(k) !== -1) { sum += w[k]; }
    });
    // Sub-score weights (excluding contextBoost) should sum to ~1.0
    if (isNaN(sum) || !isFinite(sum) || Math.abs(sum - 1.0) > 0.15) {
      errors.push("scoring.weights (keyword+multiFile+structure+wordCount+codeBlocks) should sum to ~1.0 (currently " + (isNaN(sum) ? "NaN" : sum.toFixed(2)) + ")");
    }
  }

  if (config.budgets && config.budgets.enabled) {
    if (!config.budgets.limits || typeof config.budgets.limits !== "object") {
      errors.push("budgets.limits must be an object with model token limits");
    }
  }

  return errors;
}

function deepMerge(target, source) {
  var result = JSON.parse(JSON.stringify(target));
  for (var key in source) {
    if (!source.hasOwnProperty(key)) continue;
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = {
  loadConfig: loadConfig,
  validateConfig: validateConfig,
  deepMerge: deepMerge,
  clearConfigCache: clearConfigCache,  // v3.0.0: force cache flush
  _internal: {
    computeMtimeSignature: _computeMtimeSignature
  }
};
