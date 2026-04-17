#!/usr/bin/env node
/**
 * scoring.js - Complexity scoring, language detection, keyword engine, confidence
 */
"use strict";

var fs = require("fs");

// ---- MULTI-LANGUAGE DETECTION (D2) ----

function detectLanguage(prompt) {
  var lower = prompt.toLowerCase();

  var huWords = ["egy", "nem", "van", "hogy", "ezt", "azt", "ide", "oda",
    "most", "majd", "meg", "fel", "ami", "aki", "itt", "ott",
    "hozzá", "létre", "össze", "szét", "bele", "kell", "legyen",
    "javítsd", "írd", "nézd", "keresd", "töröld", "adj", "csinálj",
    "módosítsd", "változtasd", "futtasd", "teszteld", "implementáld",
    "ellenőrizd", "frissítsd", "hozz", "készíts", "szeretném", "kellene",
    "lehetne", "lenne", "hibát", "hibás", "hiba", "fájl", "fájlban",
    "osztály", "metódus", "függvény", "változó"];
  var huCount = 0;
  huWords.forEach(function(w) { if (lower.includes(w)) huCount++; });
  if (/[áéíóöőúüű]/i.test(prompt)) huCount += 2;

  var deWords = ["das", "die", "der", "ein", "eine", "ist", "sind", "nicht",
    "bitte", "kannst", "können", "soll", "sollte", "muss", "mach",
    "füge", "ändere", "lösche", "finde", "suche", "erstelle",
    "implementiere", "überprüfe", "aktualisiere", "korrigiere",
    "behebe", "refaktoriere", "teste", "optimiere", "datei",
    "fehler", "funktion", "klasse", "methode", "variable",
    "tippfehler", "hinzu", "entferne"];
  var deCount = 0;
  deWords.forEach(function(w) { if (lower.includes(w)) deCount++; });
  if (/[äöüß]/i.test(prompt)) deCount += 2;

  if (huCount >= 3 && huCount > deCount) return "hu";
  if (deCount >= 3 && deCount > huCount) return "de";
  return "en";
}

// ---- KEYWORD SCORING ENGINE ----

function scoreKeywordsEngine(promptLower, config, lang) {
  if (!config || !config.models) return { score: 0, matchedModel: "none", matchedCategory: "none", matchLength: 0 };
  var modelScores = { opus: 8, sonnet: 5, haiku: 2 };
  var allMatches = [];
  var promptLen = promptLower.length;
  var earlyZone = Math.max(20, Math.round(promptLen * 0.3)); // first 30% of prompt
  var translations = (lang && config.translations && config.translations[lang]) || null;

  ["opus", "sonnet", "haiku"].forEach(function(modelName) {
    var modelDef = config.models[modelName];
    if (!modelDef || !modelDef.categories) return;
    Object.entries(modelDef.categories).forEach(function(pair) {
      var catKey = pair[0];
      var catDef = pair[1];

      // Position-weighted keyword matching: keywords in the first 30% get 1.5x effective length
      function addMatch(kwLower, modelName, catLabel) {
        var idx = promptLower.indexOf(kwLower);
        if (idx === -1) return;
        var positionBoost = (idx < earlyZone) ? 1.5 : 1.0;
        var effectiveLength = Math.round(kwLower.length * positionBoost);
        allMatches.push({ keyword: kwLower, length: effectiveLength, model: modelName, score: modelScores[modelName], category: catLabel, matchLength: kwLower.length, position: idx });
      }

      if (!lang && catDef.keywords) {
        catDef.keywords.forEach(function(kw) {
          var kwLower = kw.toLowerCase();
          if (promptLower.includes(kwLower)) {
            addMatch(kwLower, modelName, catDef.label || catKey);
          }
        });
      }

      if (lang && translations && translations[catKey]) {
        var transKeywords = translations[catKey];
        if (Array.isArray(transKeywords)) {
          transKeywords.forEach(function(kw) {
            var kwLower = kw.toLowerCase();
            if (promptLower.includes(kwLower)) {
              addMatch(kwLower, modelName, catDef.label || catKey);
            }
          });
        }
      }
    });
  });

  if (allMatches.length === 0) return { score: 0, matchedModel: "none", matchedCategory: "none", matchLength: 0 };

  // Two-pass keyword matching: action verbs get priority over context nouns
  var actionVerbs = ["fix", "rename", "refactor", "implement", "add", "create", "remove", "delete",
    "update", "change", "move", "migrate", "convert", "replace", "merge", "split",
    "optimize", "debug", "test", "deploy", "install", "configure", "setup",
    "javítsd", "töröld", "hozz", "készíts", "módosítsd", "implementáld", "teszteld",
    "futtasd", "frissítsd", "behebe", "erstelle", "lösche", "ändere", "implementiere"];
  var actionMatches = allMatches.filter(function(m) {
    return actionVerbs.some(function(v) { return m.keyword.startsWith(v); });
  });
  // If action verb matches exist, prefer them; otherwise fall back to all matches
  var pool = actionMatches.length > 0 ? actionMatches : allMatches;
  pool.sort(function(a, b) { return b.length !== a.length ? b.length - a.length : b.score - a.score; });
  var best = pool[0];

  // Multi-keyword voting: if 3+ keywords matched, use weighted majority instead of winner-takes-all
  if (allMatches.length >= 3) {
    var modelVotes = { haiku: 0, sonnet: 0, opus: 0 };
    var modelCats = { haiku: null, sonnet: null, opus: null };
    allMatches.forEach(function(m) {
      // Weight: action verbs count 2x, position-boosted count by effective length
      var isAction = actionVerbs.some(function(v) { return m.keyword.startsWith(v); });
      var weight = (isAction ? 2 : 1) * (m.length / 10);
      modelVotes[m.model] = (modelVotes[m.model] || 0) + weight;
      if (!modelCats[m.model]) modelCats[m.model] = m.category;
    });
    // Find winner by weighted votes
    var voteWinner = null, maxVotes = 0;
    ["haiku", "sonnet", "opus"].forEach(function(m) {
      if (modelVotes[m] > maxVotes) { maxVotes = modelVotes[m]; voteWinner = m; }
    });
    // Only override if voting winner differs from single-best AND has clear majority (>50% of total votes)
    if (voteWinner && voteWinner !== best.model) {
      var totalVotes = modelVotes.haiku + modelVotes.sonnet + modelVotes.opus;
      if (maxVotes / totalVotes > 0.5) {
        return { score: modelScores[voteWinner], matchedModel: voteWinner, matchedCategory: modelCats[voteWinner] || best.category, matchLength: best.matchLength, votingUsed: true };
      }
    }
  }

  return { score: best.score, matchedModel: best.model, matchedCategory: best.category, matchLength: best.matchLength };
}

function scoreKeywordsMultiLang(promptLower, config, detectedLang) {
  var result = scoreKeywordsEngine(promptLower, config, null);
  if (detectedLang !== "en" && config && config.translations && config.translations[detectedLang]) {
    var transResult = scoreKeywordsEngine(promptLower, config, detectedLang);
    if (transResult.score > result.score || (transResult.score === result.score && transResult.matchLength > result.matchLength)) {
      return transResult;
    }
  }
  return result;
}

function scoreKeywords(promptLower, config) {
  return scoreKeywordsEngine(promptLower, config, null);
}

// ---- SCORING FUNCTIONS ----

function scoreWordCount(wordCount) {
  if (wordCount <= 3) return 1;
  if (wordCount <= 8) return 2;
  if (wordCount <= 15) return 3;
  if (wordCount <= 30) return 4;
  if (wordCount <= 60) return 5;
  if (wordCount <= 100) return 6;
  if (wordCount <= 150) return 7;
  if (wordCount <= 250) return 8;
  return 9;
}

function scoreCodeBlocks(prompt) {
  var n = Math.floor((prompt.match(/```/g) || []).length / 2);
  return n === 0 ? 0 : n <= 1 ? 2 : n <= 3 ? 4 : 6;
}

function scoreMultiFileIndicators(promptLower, config) {
  var indicators = (config && config.scoring && config.scoring.multiFileIndicators)
    ? config.scoring.multiFileIndicators
    : ["multiple files", "several files", "all files", "across files", "many files",
       "each file", "every file", "throughout", "project-wide", "codebase-wide",
       "repo-wide", "components", "modules", "services", "layers",
       "frontend and backend", "client and server"];
  var count = indicators.filter(function(ind) { return promptLower.includes(ind.toLowerCase()); }).length;
  return count === 0 ? 0 : count === 1 ? 3 : count === 2 ? 5 : 7;
}

function scoreStructuralComplexity(prompt) {
  var score = 0;
  var n = (prompt.match(/^\s*\d+[.)]/gm) || []).length;
  score += n >= 5 ? 4 : n >= 3 ? 3 : n >= 1 ? 1 : 0;
  var b = (prompt.match(/^\s*[-*]/gm) || []).length;
  score += b >= 5 ? 3 : b >= 3 ? 2 : b >= 1 ? 1 : 0;
  if ((prompt.match(/\?/g) || []).length >= 3) score += 2;
  else if ((prompt.match(/\?/g) || []).length >= 1) score += 1;
  // Truncate for file-path regex to avoid O(n^2) on large prompts
  var fpInput = prompt.length > 10000 ? prompt.substring(0, 10000) : prompt;
  var f = (fpInput.match(/[\w/\\]+\.\w{1,5}/g) || []).length;
  score += f >= 5 ? 4 : f >= 3 ? 3 : f >= 1 ? 1 : 0;
  var s = (prompt.match(/\n/g) || []).length;
  score += s >= 10 ? 3 : s >= 5 ? 2 : s >= 2 ? 1 : 0;
  return Math.min(score, 8);
}

function classifyQuestionVsTask(promptLower) {
  var patterns = [/^what /, /^how /, /^why /, /^where /, /^when /,
    /^is /, /^are /, /^can /, /^could /, /^should /,
    /^does /, /^do /, /^will /, /^would /, /\?$/];
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(promptLower.trim())) return "question";
  }
  return "task";
}

function detectManualOverride(prompt, config) {
  var markers = (config && config.overrideMarkers) ? config.overrideMarkers : ["@haiku", "@sonnet", "@opus"];
  for (var i = 0; i < markers.length; i++) {
    if (prompt.toLowerCase().includes(markers[i].toLowerCase())) {
      return markers[i].replace("@", "").toLowerCase();
    }
  }
  var m = prompt.match(/\buse\s+(haiku|sonnet|opus)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function detectBorderline(score, config) {
  var zones = (config && config.autoMode && config.autoMode.borderlineZones) ? config.autoMode.borderlineZones : [3, 4, 7, 8];
  if (zones.indexOf(score) !== -1) {
    if (score <= 4) return { isBorderline: true, between: "haiku/sonnet", lower: "haiku", upper: "sonnet" };
    return { isBorderline: true, between: "sonnet/opus", lower: "sonnet", upper: "opus" };
  }
  return { isBorderline: false };
}

function shouldAutoRoute(score, config, confidence) {
  if (!config || !config.autoMode || !config.autoMode.enabled) return false;
  var t = config.autoMode.autoThresholds;
  if (!t) return false;
  if (t.haiku && score >= t.haiku[0] && score <= t.haiku[1]) return true;
  if (t.opus && score >= t.opus[0] && score <= t.opus[1]) return true;
  // Confidence-based: if confidence >= 90%, auto-route even in borderline zones
  var conf = (typeof confidence === "number") ? confidence : 0;
  if (conf >= 90) return true;
  // If confidence < 30%, never auto-route regardless of score
  if (conf > 0 && conf < 30) return false;
  return false;
}

// ---- CONFIDENCE METRIC (A2) ----

function calculateConfidence(scores) {
  var activeSignals = 0;
  var tiers = [];

  if (scores.keyword > 0) {
    activeSignals++;
    if (scores.keyword <= 3) tiers.push("simple");
    else if (scores.keyword <= 6) tiers.push("moderate");
    else tiers.push("complex");
  }
  if (scores.wordCount > 3) { activeSignals++; tiers.push("moderate"); }
  else if (scores.wordCount > 0) { activeSignals++; tiers.push("simple"); }
  if (scores.codeBlocks > 0) { activeSignals++; tiers.push("moderate"); }
  if (scores.multiFile > 0) { activeSignals++; tiers.push("complex"); }
  if (scores.structure > 2) { activeSignals++; tiers.push("complex"); }
  else if (scores.structure > 0) { activeSignals++; tiers.push("moderate"); }

  var tierCounts = { simple: 0, moderate: 0, complex: 0 };
  tiers.forEach(function(t) { tierCounts[t]++; });
  var maxTierCount = Math.max(tierCounts.simple, tierCounts.moderate, tierCounts.complex);
  var agreement = activeSignals > 0 ? maxTierCount / activeSignals : 0;

  var confidence;
  if (activeSignals === 0) confidence = 10;
  else if (activeSignals === 1) confidence = 25;
  else if (activeSignals === 2) confidence = agreement > 0.8 ? 50 : 40;
  else if (activeSignals >= 3) confidence = agreement > 0.6 ? 70 + Math.round(agreement * 20) : 45 + Math.round(agreement * 20);
  else confidence = 30;

  confidence = Math.min(95, Math.max(10, confidence));

  return { confidence: confidence, signals: activeSignals, agreement: agreement > 0.6 ? "high" : "mixed" };
}

function getCostEstimate(model, config) {
  if (!config || !config.costEstimates || !config.costEstimates[model]) {
    return { haiku: "~10x cheaper than opus", sonnet: "balanced cost/performance", opus: "most capable, highest cost" }[model] || "";
  }
  var c = config.costEstimates[model];
  var label = c.label || model;
  var inp = (typeof c.inputPer1M === "number" && isFinite(c.inputPer1M)) ? c.inputPer1M : "?";
  var outp = (typeof c.outputPer1M === "number" && isFinite(c.outputPer1M)) ? c.outputPer1M : "?";
  return label + " ($" + inp + "/$" + outp + " per 1M tokens in/out)";
}

// ---- PREFLIGHT CHECK FOR OPUS TASKS (GSD-inspired) ----

function preflightCheck(prompt, score, model, config) {
  if (model !== "opus") return { ready: true, suggestions: [] };

  var preflight = (config && config.preflight) || {};
  if (preflight.enabled === false) return { ready: true, suggestions: [] };

  var suggestions = [];
  var words = prompt.split(/\s+/).filter(function(w) { return w.length > 0; });
  var minWords = preflight.opusMinWords || 20;

  // Check word count
  if (words.length < minWords) {
    suggestions.push("Add more detail (" + words.length + " words, recommend " + minWords + "+)");
  }

  // Check for file references
  if (preflight.suggestFileRefs !== false) {
    var hasFileRefs = /[\w/\\]+\.\w{1,5}/.test(prompt) || /\bsrc\/|\blib\/|\bconfig\/|\bscripts\//.test(prompt);
    if (!hasFileRefs) {
      suggestions.push("Include specific file paths for targeted work");
    }
  }

  // Check for structure (numbered steps, bullets, success criteria)
  if (preflight.suggestCriteria !== false) {
    var hasStructure = /^\s*\d+[.)]/m.test(prompt) || /^\s*[-*]/m.test(prompt);
    var hasCriteria = /should|must|expect|ensure|verify|result/i.test(prompt);
    if (!hasStructure && !hasCriteria) {
      suggestions.push("Add expected behavior or success criteria");
    }
  }

  return {
    ready: suggestions.length === 0,
    suggestions: suggestions
  };
}

// getBorderlineContext moved to ./history.js to remove the scoring <-> io
// circular dependency. scoring.js now stays a pure function module.

module.exports = {
  detectLanguage: detectLanguage,
  scoreKeywords: scoreKeywords,
  scoreKeywordsMultiLang: scoreKeywordsMultiLang,
  scoreKeywordsEngine: scoreKeywordsEngine,
  scoreWordCount: scoreWordCount,
  scoreCodeBlocks: scoreCodeBlocks,
  scoreMultiFileIndicators: scoreMultiFileIndicators,
  scoreStructuralComplexity: scoreStructuralComplexity,
  classifyQuestionVsTask: classifyQuestionVsTask,
  detectManualOverride: detectManualOverride,
  detectBorderline: detectBorderline,
  shouldAutoRoute: shouldAutoRoute,
  calculateConfidence: calculateConfidence,
  getCostEstimate: getCostEstimate,
  preflightCheck: preflightCheck
};
