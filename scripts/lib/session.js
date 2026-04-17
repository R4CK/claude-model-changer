#!/usr/bin/env node
/**
 * session.js - Unified session module
 *
 * Handles: session state persistence (per-sessionId isolation),
 * topic similarity, session stickiness, context-aware routing,
 * project type detection.
 *
 * Note: session-utils.js is kept as a backward-compatible facade for
 * enforce-stats.js and external consumers. This module is the primary
 * session logic owner.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var sessionUtils = require("../session-utils");

// Per-sessionId state isolation: use session-specific files when available
function getSessionPath(sessionId) {
  if (!sessionId || sessionId === "unknown" || sessionId === "__handoff__") {
    return sessionUtils.SESSION_PATH;
  }
  var shortId = sessionId.replace(/[^a-zA-Z0-9-]/g, "").substring(0, 12);
  return sessionUtils.SESSION_PATH.replace("session-state.json", "session-state-" + shortId + ".json");
}

function loadSessionState(sessionId) {
  var sessionPath = getSessionPath(sessionId);
  try {
    if (sessionPath !== sessionUtils.SESSION_PATH && fs.existsSync(sessionPath)) {
      return JSON.parse(fs.readFileSync(sessionPath, "utf8").replace(/^\uFEFF/, ""));
    }
  } catch (err) {}
  return sessionUtils.loadSessionState();
}

function saveSessionState(state) {
  var sessionId = state && state.sessionId;
  var sessionPath = getSessionPath(sessionId);
  // Always save to default path (enforce-stats reads it)
  sessionUtils.saveSessionState(state);
  // Also save to session-specific path if different
  if (sessionPath !== sessionUtils.SESSION_PATH) {
    try {
      var tmpPath = sessionPath + "." + process.pid + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(state));
      fs.renameSync(tmpPath, sessionPath);
    } catch (err) {
      try { fs.unlinkSync(sessionPath + "." + process.pid + ".tmp"); } catch (e) {}
    }
  }
}

function extractTopicWords(prompt) {
  var stopWords = ["this", "that", "with", "from", "have", "will", "been", "would", "could",
    "should", "about", "their", "there", "which", "make", "like", "just", "over",
    "such", "take", "into", "than", "them", "very", "some", "when", "what",
    "your", "more", "also", "need", "want", "please", "help", "code", "file"];
  return prompt.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/)
    .filter(function(w) { return w.length > 3 && stopWords.indexOf(w) === -1; });
}

function calculateTopicSimilarity(words1, words2) {
  if (!words1 || !words2 || words1.length === 0 || words2.length === 0) return 0;
  var set1 = {};
  words1.forEach(function(w) { set1[w] = true; });
  var overlap = words2.filter(function(w) { return set1[w]; }).length;
  var union = new Set(words1.concat(words2)).size;
  return union > 0 ? overlap / union : 0;
}

function getSessionStickiness(prompt, sessionId, lastModel, config) {
  if (!config || !config.sessionStickiness || !config.sessionStickiness.enabled) return { sticky: false };
  var sessionState = loadSessionState(sessionId);
  if (!sessionState || !sessionState.lastModel) return { sticky: false };
  var threshold = config.sessionStickiness.topicChangeThreshold || 0.3;
  var currentWords = extractTopicWords(prompt);
  var similarity = calculateTopicSimilarity(currentWords, sessionState.topicWords || []);
  if (similarity >= threshold) {
    return { sticky: true, stickyModel: sessionState.lastModel, similarity: similarity.toFixed(2),
      reason: "Same topic (similarity: " + (similarity * 100).toFixed(0) + "%)" };
  }
  return { sticky: false, similarity: similarity.toFixed(2), reason: "Topic changed" };
}

// ---- PROMPT HISTORY CONTEXT ----
// Track last 3 prompts; if current prompt is related, inherit context boost

function getPromptHistoryBoost(prompt, sessionId, config) {
  if (!config || !config.promptHistory || config.promptHistory.enabled === false) {
    // Default enabled if not explicitly disabled
    if (config && config.promptHistory && config.promptHistory.enabled === false) return { boost: 0 };
  }
  try {
    var state = loadSessionState(sessionId);
    if (!state || !state.recentPrompts || state.recentPrompts.length === 0) return { boost: 0 };

    var currentWords = extractTopicWords(prompt);
    if (currentWords.length === 0) return { boost: 0 };

    // Check similarity against recent prompts
    var maxSimilarity = 0;
    var relatedModel = null;
    var relatedCategory = null;
    state.recentPrompts.forEach(function(rp) {
      if (!rp.words || rp.words.length === 0) return;
      var sim = calculateTopicSimilarity(currentWords, rp.words);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        relatedModel = rp.model;
        relatedCategory = rp.category;
      }
    });

    // If strong relation (>40%) to a recent higher-complexity prompt, boost score
    if (maxSimilarity >= 0.4 && relatedModel) {
      var modelLevel = { haiku: 1, sonnet: 2, opus: 3 };
      var relatedLevel = modelLevel[relatedModel] || 1;
      // Boost: +1 if related to sonnet-level, +2 if related to opus-level
      var boost = Math.max(0, relatedLevel - 1);
      if (boost > 0) {
        return {
          boost: boost,
          similarity: Math.round(maxSimilarity * 100),
          relatedModel: relatedModel,
          relatedCategory: relatedCategory,
          reason: "Related to recent " + relatedModel + " task (" + Math.round(maxSimilarity * 100) + "% similar)"
        };
      }
    }
    return { boost: 0 };
  } catch (e) { return { boost: 0 }; }
}

function updatePromptHistory(state, prompt, model, category) {
  if (!state.recentPrompts) state.recentPrompts = [];
  state.recentPrompts.push({
    words: extractTopicWords(prompt),
    model: model,
    category: category || "unknown",
    timestamp: new Date().toISOString()
  });
  // Keep only last 3
  if (state.recentPrompts.length > 3) {
    state.recentPrompts = state.recentPrompts.slice(-3);
  }
  return state;
}

// ---- CONTEXT-AWARE ROUTING ----

function detectProjectType(cwd) {
  if (!cwd) return null;
  var detected = [];
  var signalFiles = {
    python: ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"],
    javascript: ["package.json"],
    typescript: ["tsconfig.json"],
    rust: ["Cargo.toml"],
    go: ["go.mod", "go.sum"]
  };
  for (var lang in signalFiles) {
    for (var f = 0; f < signalFiles[lang].length; f++) {
      try {
        if (fs.existsSync(path.join(cwd, signalFiles[lang][f]))) { detected.push(lang); break; }
      } catch (err) {}
    }
  }
  return detected.length > 0 ? detected : null;
}

function getContextBoost(promptLower, projectTypes, config) {
  if (!projectTypes || !config || !config.contextAware || !config.contextAware.enabled) return 0;
  var signals = config.contextAware.projectSignals;
  if (!signals) return 0;
  var boost = 0;
  for (var i = 0; i < projectTypes.length; i++) {
    var langConfig = signals[projectTypes[i]];
    if (!langConfig) continue;
    boost += langConfig.defaultBoost || 0;
    if (langConfig.boostKeywords) {
      for (var k = 0; k < langConfig.boostKeywords.length; k++) {
        if (promptLower.includes(langConfig.boostKeywords[k].toLowerCase())) { boost += 1; break; }
      }
    }
  }
  return boost;
}

module.exports = {
  loadSessionState: loadSessionState,
  saveSessionState: saveSessionState,
  extractTopicWords: extractTopicWords,
  calculateTopicSimilarity: calculateTopicSimilarity,
  getSessionStickiness: getSessionStickiness,
  getPromptHistoryBoost: getPromptHistoryBoost,
  updatePromptHistory: updatePromptHistory,
  detectProjectType: detectProjectType,
  getContextBoost: getContextBoost
};
