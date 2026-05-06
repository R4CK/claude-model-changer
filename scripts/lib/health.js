#!/usr/bin/env node
/**
 * health.js - Plugin health check diagnostics
 */
"use strict";

var fs = require("fs");
var path = require("path");
var io = require("./io");

function checkConfig() {
  var result = { status: "ok", issues: [] };
  try {
    var configPath = io.getConfigPath();
    if (!fs.existsSync(configPath)) {
      result.status = "error";
      result.issues.push("Config file missing: " + configPath);
      return result;
    }
    var raw = fs.readFileSync(configPath, "utf8");
    var config;
    try { config = JSON.parse(raw); } catch (e) {
      result.status = "error";
      result.issues.push("Config is not valid JSON: " + e.message);
      return result;
    }
    // Required sections
    var required = ["models", "scoring", "autoMode"];
    required.forEach(function(key) {
      if (!config[key]) {
        result.status = "warn";
        result.issues.push("Missing config section: " + key);
      }
    });
    // Check scoring weights sum
    if (config.scoring && config.scoring.weights) {
      var w = config.scoring.weights;
      var sum = (w.keyword || 0) + (w.multiFile || 0) + (w.structure || 0) + (w.wordCount || 0) + (w.codeBlocks || 0);
      if (Math.abs(sum - 1.0) > 0.05) {
        result.status = "warn";
        result.issues.push("Sub-score weights sum to " + sum.toFixed(3) + " (expected ~1.0, contextBoost is separate)");
      }
    }
    // Check model score ranges
    if (config.models) {
      ["haiku", "sonnet", "opus"].forEach(function(m) {
        if (config.models[m] && config.models[m].scoreRange) {
          var range = config.models[m].scoreRange;
          if (!Array.isArray(range) || range.length !== 2 || range[0] > range[1]) {
            result.status = "warn";
            result.issues.push(m + " scoreRange invalid: " + JSON.stringify(range));
          }
        }
      });
    }
    result.version = config.version || "unknown";
  } catch (e) {
    result.status = "error";
    result.issues.push("Config check failed: " + e.message);
  }
  return result;
}

function checkLogs() {
  var result = { status: "ok", issues: [], files: {} };
  var logDir = path.join(io.BASE_DIR, "logs");

  if (!fs.existsSync(logDir)) {
    result.status = "warn";
    result.issues.push("Logs directory missing");
    return result;
  }

  var logFiles = {
    "usage.jsonl": { required: false, maxSize: 1024 * 1024 },  // 1MB
    "session-state.json": { required: false, maxSize: 100 * 1024 },
    "quality.jsonl": { required: false, maxSize: 512 * 1024 },
    "overrides.jsonl": { required: false, maxSize: 512 * 1024 }
  };

  var totalSize = 0;
  Object.keys(logFiles).forEach(function(filename) {
    var filePath = path.join(logDir, filename);
    var spec = logFiles[filename];
    if (fs.existsSync(filePath)) {
      try {
        var stat = fs.statSync(filePath);
        totalSize += stat.size;
        result.files[filename] = { exists: true, size: stat.size };
        if (stat.size > spec.maxSize) {
          result.status = "warn";
          result.issues.push(filename + " is large (" + Math.round(stat.size / 1024) + "KB)");
        }
        // Validate JSON/JSONL
        if (filename.endsWith(".json")) {
          try { JSON.parse(fs.readFileSync(filePath, "utf8")); }
          catch (e) { result.status = "warn"; result.issues.push(filename + " is not valid JSON"); }
        } else if (filename.endsWith(".jsonl")) {
          var lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(function(l) { return l.length > 0; });
          var badLines = 0;
          lines.forEach(function(l) { try { JSON.parse(l); } catch(e) { badLines++; } });
          if (badLines > 0) {
            result.status = "warn";
            result.issues.push(filename + " has " + badLines + " corrupt line(s)");
          }
          result.files[filename].entries = lines.length - badLines;
        }
      } catch (e) {
        result.status = "warn";
        result.issues.push(filename + " unreadable: " + e.message);
      }
    } else {
      result.files[filename] = { exists: false };
    }
  });

  result.totalLogSize = totalSize;
  result.totalLogSizeKB = Math.round(totalSize / 1024);
  return result;
}

function checkAgents() {
  var result = { status: "ok", issues: [], agents: {} };
  var agentDir = path.join(io.BASE_DIR, "agents");

  if (!fs.existsSync(agentDir)) {
    result.status = "error";
    result.issues.push("Agents directory missing");
    return result;
  }

  ["haiku-worker.md", "sonnet-worker.md", "opus-worker.md"].forEach(function(filename) {
    var filePath = path.join(agentDir, filename);
    if (!fs.existsSync(filePath)) {
      result.status = "error";
      result.issues.push("Missing agent: " + filename);
      result.agents[filename] = { exists: false };
    } else {
      var content = fs.readFileSync(filePath, "utf8");
      var hasFrontmatter = content.startsWith("---");
      result.agents[filename] = { exists: true, hasFrontmatter: hasFrontmatter, size: content.length };
      if (!hasFrontmatter) {
        result.status = "warn";
        result.issues.push(filename + " missing frontmatter");
      }
    }
  });
  return result;
}

function checkHooks() {
  var result = { status: "ok", issues: [] };
  var hooksPath = path.join(io.BASE_DIR, "hooks", "hooks.json");

  if (!fs.existsSync(hooksPath)) {
    result.status = "error";
    result.issues.push("hooks.json missing");
    return result;
  }

  try {
    var hooksRoot = JSON.parse(fs.readFileSync(hooksPath, "utf8").replace(/^﻿/, ""));
    // The plugin hooks.json uses { "description": "...", "hooks": { "UserPromptSubmit": [...] } }.
    // Older callers may have written events at the top level; accept both shapes.
    var hooks = (hooksRoot && typeof hooksRoot.hooks === "object" && hooksRoot.hooks) ? hooksRoot.hooks : hooksRoot;
    var hookTypes = ["UserPromptSubmit", "Stop"];
    hookTypes.forEach(function(hookType) {
      if (!hooks[hookType] || !Array.isArray(hooks[hookType]) || hooks[hookType].length === 0) {
        result.status = "warn";
        result.issues.push("No " + hookType + " hooks defined");
        return;
      }
      hooks[hookType].forEach(function(hook, idx) {
        // Plugin hooks.json wraps each event in { hooks: [{ command, ... }] }.
        // Earlier callers passed a single { command, ... } directly; accept both.
        var inner = (hook && Array.isArray(hook.hooks)) ? hook.hooks : [hook];
        inner.forEach(function(h) {
          if (h && h.command) {
            var cmd = h.command;
            if (cmd.includes("analyze-complexity.js") || cmd.includes("enforce-stats.js") || cmd.includes("session-utils.js")) {
              var scriptName = cmd.match(/[\\/]([^\\/]+\.js)/);
              if (scriptName) {
                var scriptPath = path.join(io.BASE_DIR, "scripts", scriptName[1]);
                if (!fs.existsSync(scriptPath)) {
                  scriptPath = path.join(io.BASE_DIR, "scripts", "lib", scriptName[1]);
                  if (!fs.existsSync(scriptPath)) {
                    result.status = "warn";
                    result.issues.push(hookType + "[" + idx + "] references missing script: " + scriptName[1]);
                  }
                }
              }
            }
          }
        });
      });
    });
  } catch (e) {
    result.status = "error";
    result.issues.push("hooks.json is not valid JSON: " + e.message);
  }
  return result;
}

function checkSession() {
  var result = { status: "ok", issues: [] };
  try {
    var sessionPath = io.getSessionPath();
    if (!fs.existsSync(sessionPath)) {
      result.status = "ok";
      result.issues.push("No active session (normal for first run)");
      return result;
    }
    var state = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    result.sessionId = state.sessionId || "unknown";
    result.promptCount = state.promptCount || 0;
    result.modelCounts = state.modelCounts || {};

    // Check staleness
    if (state.timestamp) {
      var age = Date.now() - new Date(state.timestamp).getTime();
      var ageMinutes = Math.round(age / 60000);
      result.ageMinutes = ageMinutes;
      if (ageMinutes > 30) {
        result.issues.push("Session state is " + ageMinutes + " minutes old (will reset on next prompt)");
      }
    }
  } catch (e) {
    result.status = "warn";
    result.issues.push("Session state unreadable: " + e.message);
  }
  return result;
}

function getFullHealthReport() {
  var checks = {
    config: checkConfig(),
    logs: checkLogs(),
    agents: checkAgents(),
    hooks: checkHooks(),
    session: checkSession()
  };

  var overallStatus = "ok";
  var totalIssues = 0;
  Object.keys(checks).forEach(function(key) {
    totalIssues += checks[key].issues.length;
    if (checks[key].status === "error") overallStatus = "error";
    else if (checks[key].status === "warn" && overallStatus !== "error") overallStatus = "warn";
  });

  return {
    overall: overallStatus,
    totalIssues: totalIssues,
    timestamp: new Date().toISOString(),
    checks: checks
  };
}

module.exports = {
  checkConfig: checkConfig,
  checkLogs: checkLogs,
  checkAgents: checkAgents,
  checkHooks: checkHooks,
  checkSession: checkSession,
  getFullHealthReport: getFullHealthReport
};
