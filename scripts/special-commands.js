#!/usr/bin/env node
/**
 * special-commands.js — terminal "--xxx" hook commands extracted from
 * analyze-complexity.js. Each command produces a string and the hook then
 * writes it and exits; none of them fall through to the routing analysis.
 *
 * Kept in scripts/ (not scripts/lib/) on purpose: the handlers use __dirname
 * relative to scripts/ (logs live at ../logs) and lazy-require sibling scripts
 * (./export-prometheus, ./skills-status, ./weekly-digest, ./whatif), so the
 * paths stay byte-identical to the original inline code.
 *
 * handle(prompt, ctx) returns:
 *   { output: "<text>" }  → caller writes output and exits
 *   null                  → not a special command; caller continues analysis
 */
"use strict";

var fs = require("fs");
var path = require("path");

var configModule = require("./lib/config");
var io = require("./lib/io");
var stats = require("./lib/stats");
var session = require("./lib/session");
var health = require("./lib/health");
var errorLog = require("./lib/error-log");
var autoTune = require("./lib/auto-tune");
var quotaTracker = require("./lib/quota-tracker");
var contextAudit = require("./lib/context-audit");
var fallbackLearn = require("./lib/fallback-learn");
var lastRouting = require("./lib/last-routing");
var profileManager = require("./lib/profile-manager");
var learnLog = require("./lib/learn-log");

function handle(prompt, ctx) {
  var cwd = ctx.cwd;
  var sessionId = ctx.sessionId;

  // ---- Special commands (dispatch table) ----
  var SPECIAL_COMMANDS = {
    "--stats": function() {
      var cfg = configModule.loadConfig(cwd);
      var s = stats.getStats(cfg);
      return s ? JSON.stringify(s, null, 2) : "No usage data yet.";
    },
    "--tune": function() {
      var t = stats.getTuneAnalysis();
      return t ? JSON.stringify(t, null, 2) : "No override data yet.";
    },
    "--quality-stats": function() {
      var qs = stats.getQualityStats();
      return qs ? JSON.stringify(qs, null, 2) : "No quality data yet. Use /rate <1-5> after tasks.";
    },
    "--fallback-stats": function() {
      try {
        var fbPath = io.getFallbackLogPath();
        if (!fs.existsSync(fbPath)) return "No fallback events logged yet.";
        var fbLines = fs.readFileSync(fbPath, "utf8").trim().split("\n").filter(function(l) { return l.length > 0; });
        return "Fallback events: " + fbLines.length + "\n" + fbLines.slice(-10).join("\n");
      } catch (e) { return "No fallback data."; }
    },
    "--adaptive-stats": function() {
      var adCfg = configModule.loadConfig(cwd);
      return JSON.stringify(stats.getAdaptiveStats(adCfg), null, 2);
    },
    "--health": function() {
      var report = health.getFullHealthReport();
      return JSON.stringify(report, null, 2);
    },
    "--errors": function() {
      // T2.4 (v2.5.0): surface recent hook errors for /health and /errors commands
      var summary = errorLog.summarize();
      return JSON.stringify(summary, null, 2);
    },
    "--auto-tune": function() {
      var cfg = configModule.loadConfig(cwd);
      var report = autoTune.runAutoTune(cfg, false);
      return JSON.stringify(report, null, 2);
    },
    "--auto-tune-dry": function() {
      var cfg = configModule.loadConfig(cwd);
      var report = autoTune.runAutoTune(cfg, true);
      return JSON.stringify(report, null, 2);
    },
    "--metrics": function() {
      // v3.1.0: Prometheus text-format metrics export
      try {
        var exporter = require("./export-prometheus");
        return exporter.buildMetrics();
      } catch (e) {
        return "# error generating metrics: " + e.message + "\n";
      }
    },
    "--skills-status": function() {
      // v3.8.0: external skills sync status (per-repo inventory + context cost)
      try {
        var ss = require("./skills-status");
        return JSON.stringify(ss.buildStatus(), null, 2);
      } catch (e) {
        return "skills-status error: " + e.message;
      }
    },
    "--quota": function() {
      // v3.2.0: Quota state report
      var qaCfg = configModule.loadConfig(cwd);
      var qs = quotaTracker.getQuotaState(qaCfg);
      return JSON.stringify(qs, null, 2);
    },
    "--context-audit": function() {
      // v3.2.0: Context bloat audit
      var audit = contextAudit.buildAudit({ windowMinutes: 60 });
      return JSON.stringify(audit, null, 2);
    },
    "--undo": function() {
      // v3.3.0 (R33): /undo last routing
      var cfg = configModule.loadConfig(cwd);
      var payload = lastRouting.buildUndoPayload(cfg);
      if (payload.ok) {
        // Auto-rate the previous decision as quality 1 (poor)
        try {
          var qFs = require("fs");
          var qPath = require("path").join(__dirname, "..", "logs", "quality.jsonl");
          qFs.appendFileSync(qPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            sessionId: sessionId,
            model: payload.previousModel,
            category: payload.category,
            rating: 1,
            source: "undo"
          }) + "\n", "utf8");
        } catch (e) {}
      }
      return JSON.stringify(payload, null, 2);
    },
    "--fallback-learn": function() {
      // v3.3.0 (R30): full fallback-learn report (not cached)
      var cfg = configModule.loadConfig(cwd);
      return JSON.stringify(fallbackLearn.getReport(cfg), null, 2);
    },
    "--profile-list": function() {
      // v3.3.0 (R43)
      var profiles = profileManager.listProfiles();
      var active = profileManager.getActiveProfileName();
      return JSON.stringify({ profiles: profiles, active: active, count: profiles.length }, null, 2);
    },
    "--profile-current": function() {
      // v3.3.0 (R43)
      var byCwd = profileManager.getProfileForCwd(cwd);
      var active = profileManager.getActiveProfileName();
      return JSON.stringify({
        activeViaCwd: byCwd,
        activeGlobal: active,
        resolved: byCwd || active || null,
        cwd: cwd
      }, null, 2);
    },
    "--weekly-digest": function() {
      // v3.3.0 (R36)
      try {
        var digestMod = require("./weekly-digest");
        var report = digestMod.buildDigest({});
        return digestMod.formatMarkdown(report);
      } catch (e) {
        return "Weekly digest error: " + e.message;
      }
    },
    "--git-router-stats": function() {
      // v3.2.0: Git commit/push routing stats
      try {
        var fs2 = require("fs"), path2 = require("path");
        var statsFile = path2.join(__dirname, "..", "logs", "git-router-stats.jsonl");
        if (!fs2.existsSync(statsFile)) return JSON.stringify({ totalCommits: 0, totalPushes: 0, message: "No git router activity yet" }, null, 2);
        var entries = fs2.readFileSync(statsFile, "utf8").trim().split("\n")
          .filter(function(l) { return l.length > 0; })
          .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
          .filter(Boolean);
        var thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
        entries = entries.filter(function(e) { return Date.parse(e.timestamp) >= thirtyDaysAgo; });
        var commits = entries.filter(function(e) { return e.op === "commit"; });
        var pushes = entries.filter(function(e) { return e.op === "push"; });
        var byModel = { haiku: 0, sonnet: 0, opus: 0 };
        var totalLines = 0, maxDiff = 0;
        commits.forEach(function(c) {
          if (byModel[c.recommended] !== undefined) byModel[c.recommended]++;
          if (c.diff) {
            var lines = (c.diff.insertions || 0) + (c.diff.deletions || 0);
            totalLines += lines;
            if (lines > maxDiff) maxDiff = lines;
          }
        });
        return JSON.stringify({
          totalCommits: commits.length,
          totalPushes: pushes.length,
          forcePushes: pushes.filter(function(p) { return p.forcePush; }).length,
          commitsByRecommendedModel: byModel,
          avgDiffLines: commits.length > 0 ? Math.round(totalLines / commits.length) : 0,
          largestDiffLines: maxDiff
        }, null, 2);
      } catch (e) {
        return JSON.stringify({ error: e.message }, null, 2);
      }
    }
  };

  var trimmedPrompt = prompt.trim();
  if (SPECIAL_COMMANDS[trimmedPrompt]) {
    return { output: SPECIAL_COMMANDS[trimmedPrompt]() };
  }
  if (trimmedPrompt === "--session-summary") {
    var sumState = session.loadSessionState(sessionId);
    if (sumState && sumState.modelCounts) {
      var mc = sumState.modelCounts;
      var total = (mc.haiku || 0) + (mc.sonnet || 0) + (mc.opus || 0);
      var subCounts = sumState.subagentCounts || { haiku: 0, sonnet: 0, opus: 0 };
      var totalSub = (subCounts.haiku || 0) + (subCounts.sonnet || 0) + (subCounts.opus || 0);
      return { output: JSON.stringify({
        sessionId: sessionId, promptCount: total, modelCounts: mc,
        subagentCounts: subCounts, totalSubagents: totalSub,
        modelPercentages: { haiku: total > 0 ? Math.round((mc.haiku || 0) / total * 100) : 0, sonnet: total > 0 ? Math.round((mc.sonnet || 0) / total * 100) : 0, opus: total > 0 ? Math.round((mc.opus || 0) / total * 100) : 0 },
        skillsUsed: sumState.skillsUsed || {}, sessionStart: sumState.sessionStart || null, estimatedTokensUsed: sumState.estimatedTokensUsed || 0
      }, null, 2) };
    } else { return { output: "No session data yet." }; }
  }

  var overrideMatch = prompt.trim().match(/^--log-override\s+(\w+)\s+(\w+)\s+(.+)$/);
  if (overrideMatch) {
    io.logOverride({ timestamp: new Date().toISOString(), recommendedModel: overrideMatch[1], chosenModel: overrideMatch[2], category: overrideMatch[3] });
    return { output: "Override logged." };
  }

  // v3.3.0 (R43): --profile-switch <name>
  var profileSwitchMatch = prompt.trim().match(/^--profile-switch\s+([a-z0-9_-]+)$/i);
  if (profileSwitchMatch) {
    var pn = profileSwitchMatch[1];
    var ok = profileManager.setActiveProfile(pn);
    return { output: ok ? "Active profile set to: " + pn : "Profile not found: " + pn + " (create at ~/.claude/profiles/" + pn + ".json first)" };
  }
  if (prompt.trim() === "--profile-clear") {
    profileManager.clearActiveProfile();
    return { output: "Active profile cleared (using base config)." };
  }

  // v3.3.0 (R31): --whatif <op> <args...>
  var whatifMatch = prompt.trim().match(/^--whatif\s+(.+)$/);
  if (whatifMatch) {
    try {
      var whatifMod = require("./whatif");
      // Split args on whitespace, but preserve quoted strings
      var argParts = whatifMatch[1].match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      argParts = argParts.map(function(a) { return a.replace(/^"|"$/g, ""); });
      var report = whatifMod.run(argParts, { cwd: cwd });
      return { output: whatifMod.formatReport(report) };
    } catch (e) {
      return { output: "ERROR: " + e.message };
    }
  }

  var fallbackMatch = prompt.trim().match(/^--log-fallback\s+(\w+)\s+(\w+)\s+(.+)$/);
  if (fallbackMatch) {
    io.logFallback({ timestamp: new Date().toISOString(), fromModel: fallbackMatch[1], toModel: fallbackMatch[2], reason: fallbackMatch[3] });
    return { output: "Fallback logged." };
  }
  // --log-llm-suggestion <model> <category> <lang> <kw1,kw2,kw3> <originalPrompt>
  // Called by Claude after the haiku-worker subagent classifies a low-confidence prompt.
  //   <model>    : haiku | sonnet | opus
  //   <category> : 2-4 word label, with underscores instead of spaces
  //   <lang>     : en | hu | de  (matches detectLanguage output)
  //   <keywords> : comma-separated, no spaces within each keyword
  //   <prompt>   : the original user prompt (may contain spaces)
  var llmSuggestionMatch = prompt.trim().match(/^--log-llm-suggestion\s+(haiku|sonnet|opus)\s+([^\s]+)\s+(en|hu|de)\s+([^\s]+)\s+(.+)$/);
  if (llmSuggestionMatch) {
    var llmModel = llmSuggestionMatch[1];
    var llmCategory = llmSuggestionMatch[2].replace(/_/g, " ");
    var llmLang = llmSuggestionMatch[3];
    var keywords = llmSuggestionMatch[4].split(",").map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
    var llmOriginalPrompt = llmSuggestionMatch[5];

    var suggestion = {
      prompt: llmOriginalPrompt,
      suggestedCategory: llmCategory,
      suggestedKeywords: keywords,
      suggestedModel: llmModel,
      lang: llmLang,
      llmModel: "haiku-worker (subagent)",
      llmConfidence: null,
      latencyMs: null
    };
    learnLog.appendSuggestion(suggestion);

    // Auto-apply if config says so AND occurrence count hits threshold
    var output = "LLM suggestion logged (lang=" + llmLang + ").";
    try {
      var learnedConfigMod = require("./lib/learned-config");
      var autoCfg = configModule.loadConfig(cwd);
      var applied = learnedConfigMod.tryAutoApply(suggestion, autoCfg);
      if (applied && applied.length > 0) {
        output += " Auto-applied " + applied.length + " keyword(s) to learned-keywords.json: " +
          applied.map(function(a) { return '"' + a.keyword + '" (' + a.count + 'x)'; }).join(", ");
      }
    } catch (e) {
      // Auto-apply is best-effort
    }
    return { output: output };
  }

  // --learn-promote: emit a diff showing what learned-keywords.json would
  // promote into task-routing.json (manual workflow - user copies into PR)
  if (prompt.trim() === "--learn-promote") {
    try {
      var lcMod = require("./lib/learned-config");
      var bcCfg = configModule.loadConfig(cwd);
      return { output: lcMod.generatePromoteDiff(bcCfg) };
    } catch (e) {
      return { output: "Error generating promote diff: " + e.message };
    }
  }

  return null;
}

module.exports = { handle: handle };
