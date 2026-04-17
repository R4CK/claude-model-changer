#!/usr/bin/env node
/**
 * config-migrate.js - Config schema versioning and automatic migration
 *
 * Detects the config version and applies incremental migrations to bring
 * it up to the current schema version.
 */
"use strict";

var fs = require("fs");

var CURRENT_SCHEMA_VERSION = "2.0";

var MIGRATIONS = [
  {
    from: "1.0", to: "1.1",
    migrate: function(config) {
      // v1.1: Added adaptiveWeights, anomalyDetection, apiLimits
      if (!config.adaptiveWeights) {
        config.adaptiveWeights = { enabled: true, minRatings: 10, minWeight: 0.05, maxWeight: 0.60 };
      }
      if (!config.anomalyDetection) {
        config.anomalyDetection = { enabled: true, opusSpikeThreshold: 3, costSpikeMultiplier: 2.5, scoreDriftThreshold: 2.0 };
      }
      config.version = "1.1";
      return config;
    }
  },
  {
    from: "1.1", to: "2.0",
    migrate: function(config) {
      // v2.0: Removed dead fields, added benchmark cache, schema version field
      // Remove dead config fields if present
      if (config.logging && config.logging.maxEntries !== undefined) {
        delete config.logging.maxEntries;
      }
      if (config.planLimits) {
        delete config.planLimits.weeklyResetDay;
        delete config.planLimits.weeklyResetHour;
      }
      // Remove dead files arrays from projectSignals
      if (config.contextAware && config.contextAware.projectSignals) {
        var signals = config.contextAware.projectSignals;
        Object.keys(signals).forEach(function(lang) {
          if (signals[lang].files) delete signals[lang].files;
        });
      }
      // Update opus auto-route threshold
      if (config.autoMode && config.autoMode.autoThresholds && config.autoMode.autoThresholds.opus) {
        if (config.autoMode.autoThresholds.opus[0] === 9) {
          config.autoMode.autoThresholds.opus[0] = 8;
        }
      }
      config.version = "2.0";
      config.schemaVersion = "2.0";
      return config;
    }
  }
];

/**
 * Migrate a config object to the current schema version.
 * @param {Object} config - The loaded config
 * @returns {{ config: Object, migrated: boolean, fromVersion: string, toVersion: string }}
 */
function migrateConfig(config) {
  if (!config) return { config: config, migrated: false, fromVersion: "unknown", toVersion: "unknown" };

  var currentVersion = config.schemaVersion || config.version || "1.0";
  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    return { config: config, migrated: false, fromVersion: currentVersion, toVersion: currentVersion };
  }

  var fromVersion = currentVersion;
  var migrated = false;

  for (var i = 0; i < MIGRATIONS.length; i++) {
    var m = MIGRATIONS[i];
    var cv = config.schemaVersion || config.version || "1.0";
    if (cv === m.from) {
      try {
        config = m.migrate(config);
        migrated = true;
      } catch (e) {
        process.stderr.write("[Config Migrate] Migration " + m.from + " -> " + m.to + " failed: " + e.message + "\n");
        break;
      }
    }
  }

  return { config: config, migrated: migrated, fromVersion: fromVersion, toVersion: config.schemaVersion || config.version || fromVersion };
}

/**
 * Save migrated config back to disk.
 */
function saveMigratedConfig(configPath, config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch (e) {
    process.stderr.write("[Config Migrate] Save failed: " + e.message + "\n");
    return false;
  }
}

module.exports = {
  migrateConfig: migrateConfig,
  saveMigratedConfig: saveMigratedConfig,
  CURRENT_SCHEMA_VERSION: CURRENT_SCHEMA_VERSION
};
