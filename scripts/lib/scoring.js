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
    "osztály", "metódus", "függvény", "változó",
    // v3.4.0 (HU): IT-zsargon stems + common short forms so the language
    // detector still triggers on terse prompts like "refaktorozd a kódot".
    "refaktor", "kódot", "kód", "biztonsági", "vizsgáld", "elemezd",
    "tesztet", "tervezz", "tervezd", "ütemterv", "modul", "memória",
    "szivárgás", "szolgáltatás", "rendszer", "rendszert"];
  var huCount = 0;
  huWords.forEach(function(w) { if (lower.includes(w)) huCount++; });
  if (/[áéíóöőúüű]/i.test(prompt)) huCount += 2;

  var deWords = ["das", "die", "der", "ein", "eine", "ist", "sind", "nicht",
    "bitte", "kannst", "können", "soll", "sollte", "muss", "mach",
    "füge", "ändere", "lösche", "finde", "suche", "erstelle",
    "implementiere", "überprüfe", "aktualisiere", "korrigiere",
    "refaktoriere", "teste", "optimiere", "datei",
    "fehler", "funktion", "klasse", "methode", "variable",
    "tippfehler", "hinzu", "entferne",
    // v3.4.0 (DE): IT-jargon stems + common short forms so the language
    // detector still triggers on terse prompts like "Bug beheben".
    // v3.6.2: removed a duplicate "behebe" that previously lived in the line
    // above too — it double-counted deCount and could flip detection on a
    // single German word.
    "behebe", "beheben", "bug", "lasttest", "skalierung", "schnittstelle",
    "modul", "komponente", "konfiguration", "leistung", "speicher",
    "audit", "schritt", "untersuche", "untersuchen", "auflisten",
    "umbenennen", "extrahier", "monolith"];
  var deCount = 0;
  deWords.forEach(function(w) { if (lower.includes(w)) deCount++; });
  if (/[äöüß]/i.test(prompt)) deCount += 2;

  // v3.4.0: lowered HU/DE threshold from 3 to 2 with the expanded word lists
  // so terse 2-3 word prompts (e.g. "refaktorozd a kódot", "Bug beheben")
  // still hit. Single-match-noise risk is mitigated by the extended-list
  // bias toward IT terms (English short prompts won't accidentally match
  // 2 IT-specific HU/DE stems).
  if (huCount >= 2 && huCount > deCount) return "hu";
  if (deCount >= 2 && deCount > huCount) return "de";
  return "en";
}

// ---- KEYWORD SCORING ENGINE ----

// Hungarian morphology: match a keyword followed by a common inflectional suffix.
// Covers accusative (-t, -ot, -et, -öt, -at), locative (-ban/-ben, -ban/-ben),
// dative (-nak/-nek), instrumental (-val/-vel), elative (-ról/-ről), sublative
// (-ra/-re), illative (-ba/-be), causal (-ért), plural (-k, -ok, -ek, -ök, -ak),
// imperative endings (-d, -sd, -jd, -dd), and the "fel/meg/be/ki" + verb
// composition is handled by the verb keyword itself.
var HU_SUFFIX_RE = "(?:t|ot|et|öt|at|ok|ek|ök|ak|k|ban|ben|nak|nek|val|vel|ról|ről|ra|re|ba|be|ig|ért|d|sd|jd|dd|m|ja|je|jük|jétek|jük|i|im|id|ik)?";

function escapeRegex(s) {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

// Cache compiled patterns per (lang, keyword) to avoid rebuilding on every prompt.
var KW_REGEX_CACHE = Object.create(null);

function matchKeyword(promptLower, kwLower, lang, useMorphology) {
  if (!useMorphology || lang !== "hu") {
    return promptLower.indexOf(kwLower) !== -1 ? promptLower.indexOf(kwLower) : -1;
  }
  // Word-boundary aware: keyword must be preceded by start/whitespace/punct,
  // and followed by an optional Hungarian suffix + word boundary.
  var cacheKey = "hu:" + kwLower;
  var re = KW_REGEX_CACHE[cacheKey];
  if (!re) {
    re = new RegExp("(?:^|[^\\p{L}\\p{N}])" + escapeRegex(kwLower) + HU_SUFFIX_RE + "(?![\\p{L}\\p{N}])", "u");
    KW_REGEX_CACHE[cacheKey] = re;
  }
  var m = re.exec(promptLower);
  return m ? m.index : -1;
}

function scoreKeywordsEngine(promptLower, config, lang) {
  if (!config || !config.models) return { score: 0, matchedModel: "none", matchedCategory: "none", matchLength: 0 };
  var modelScores = { opus: 8, sonnet: 5, haiku: 2 };
  var allMatches = [];
  var promptLen = promptLower.length;
  var earlyZone = Math.max(20, Math.round(promptLen * 0.3)); // first 30% of prompt
  var translations = (lang && config.translations && config.translations[lang]) || null;

  ["opus", "sonnet", "haiku"].forEach(function(modelName) {
    var modelDef = config.models[modelName];
    if (!modelDef || !modelDef.categories || typeof modelDef.categories !== "object") return;
    // v2.5.1: use Object.keys + own-property check to avoid prototype-pollution
    // and non-enumerable surprises. Symbol properties and inherited keys are
    // ignored - only plain own keys are iterated.
    Object.keys(modelDef.categories).forEach(function(catKey) {
      if (!Object.prototype.hasOwnProperty.call(modelDef.categories, catKey)) return;
      var catDef = modelDef.categories[catKey];
      if (!catDef || typeof catDef !== "object") return;

      var morphologyEnabled = !!(config.translations && config.translations[lang || "_"] && config.translations[lang || "_"].morphology !== false) && lang === "hu";

      // Position-weighted keyword matching: keywords in the first 30% get 1.5x effective length
      function addMatch(kwLower, modelName, catLabel, idx) {
        if (idx === undefined || idx === -1) return;
        var positionBoost = (idx < earlyZone) ? 1.5 : 1.0;
        var effectiveLength = Math.round(kwLower.length * positionBoost);
        allMatches.push({ keyword: kwLower, length: effectiveLength, model: modelName, score: modelScores[modelName], category: catLabel, matchLength: kwLower.length, position: idx });
      }

      if (!lang && catDef.keywords) {
        catDef.keywords.forEach(function(kw) {
          var kwLower = kw.toLowerCase();
          var idx = promptLower.indexOf(kwLower);
          if (idx !== -1) {
            addMatch(kwLower, modelName, catDef.label || catKey, idx);
          }
        });
      }

      if (lang && translations && translations[catKey]) {
        var transKeywords = translations[catKey];
        if (Array.isArray(transKeywords)) {
          transKeywords.forEach(function(kw) {
            var kwLower = kw.toLowerCase();
            var idx = matchKeyword(promptLower, kwLower, lang, morphologyEnabled);
            if (idx !== -1) {
              addMatch(kwLower, modelName, catDef.label || catKey, idx);
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

// ---- EFFORT DETERMINATION (v2.7.0) ----
// Effort = "thinking budget" the model should use (Low / Medium / High).
// Orthogonal to model selection - pure function of sub-scores + confidence +
// matched category + config rules. Output is a hint for Claude + the user.
//
// Defaults (overridable via config.effort.rules):
//   HIGH: multi-file work, arch/security/planning categories, low-confidence-
//         with-match (the scorer found signal but isn't sure - need more
//         thinking), highly-structured prompts (6+ structure score).
//   LOW:  trivial categories (typo/formatting/rename/comments/status) with
//         high confidence (>=70%), OR very short + matched + high confidence.
//   MEDIUM: everything else (default).
//
// Per-category override: if matchedCategoryKey has a `defaultEffort` field
// in its config, that wins unless config says otherwise.

function slugifyCategory(category) {
  return String(category || "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

var DEFAULT_HIGH_CATEGORIES = [
  "architecture", "security", "planning", "system_design",
  "performance_audit", "large_refactoring", "multi_file_work",
  "algorithms", "tech_debt"
];
var DEFAULT_LOW_CATEGORIES = [
  "typo_fix", "formatting", "rename", "comments", "status",
  "imports", "search_list"
];

// Map an effort level to an extended-thinking budget (in tokens). Configurable
// via config.effort.thinkingBudgets; defaults are conservative and align with
// Claude 4.x extended-thinking guidance (low = no thinking, medium ~ short
// deliberation, high ~ deep reasoning for opus tasks).
function thinkingBudgetForEffort(level, config) {
  var defaults = { low: 0, medium: 5000, high: 16000 };
  var cfg = (config && config.effort && config.effort.thinkingBudgets) || {};
  if (typeof cfg[level] === "number" && isFinite(cfg[level]) && cfg[level] >= 0) return cfg[level];
  return defaults[level] != null ? defaults[level] : defaults.medium;
}

function determineEffort(scores, confidence, matchedCategory, config, categoryKey) {
  if (!config || !config.effort || config.effort.enabled === false) {
    // Feature disabled - return null so callers know not to emit
    return null;
  }

  var rules = (config.effort.rules) || {};
  var highCats = Array.isArray(rules.highCategories) ? rules.highCategories : DEFAULT_HIGH_CATEGORIES;
  var lowCats = Array.isArray(rules.lowCategories) ? rules.lowCategories : DEFAULT_LOW_CATEGORIES;
  var lowConfThreshold = typeof rules.lowConfidenceThreshold === "number" ? rules.lowConfidenceThreshold : 40;
  var multiFileThreshold = typeof rules.multiFileThreshold === "number" ? rules.multiFileThreshold : 4;
  var structuralHighThreshold = typeof rules.structuralHighThreshold === "number" ? rules.structuralHighThreshold : 6;
  var highConfForLow = typeof rules.lowEffortConfidenceThreshold === "number" ? rules.lowEffortConfidenceThreshold : 70;

  // Prefer explicit categoryKey (singular form from config) over slugifying
  // the display label (which may produce wrong plurals: "Typo fixes" -> "typo_fixes"
  // but config uses "typo_fix").
  var catSlug = categoryKey ? String(categoryKey).toLowerCase() : slugifyCategory(matchedCategory);

  // Per-category explicit override takes precedence if config exposes it
  if (categoryKey && config.models) {
    for (var m = 0; m < 3; m++) {
      var modelName = ["haiku", "sonnet", "opus"][m];
      var md = config.models[modelName];
      if (md && md.categories && md.categories[categoryKey] && md.categories[categoryKey].defaultEffort) {
        var explicit = String(md.categories[categoryKey].defaultEffort).toLowerCase();
        if (explicit === "low" || explicit === "medium" || explicit === "high") {
          return { level: explicit, reason: "per-category defaultEffort override", thinkingBudget: thinkingBudgetForEffort(explicit, config) };
        }
      }
    }
  }

  var s = scores || {};
  var kw = s.keyword || 0;
  var mf = s.multiFile || 0;
  var st = s.structure || 0;
  var wc = s.wordCount || 0;
  var conf = typeof confidence === "number" ? confidence : 50;

  function withBudget(level, reason) {
    return { level: level, reason: reason, thinkingBudget: thinkingBudgetForEffort(level, config) };
  }

  // HIGH triggers (check in priority order)
  if (mf >= multiFileThreshold) return withBudget("high", "multi-file signal (" + mf + " >= " + multiFileThreshold + ")");
  if (catSlug && highCats.indexOf(catSlug) !== -1) return withBudget("high", "category '" + catSlug + "' is in highCategories");
  if (conf < lowConfThreshold && kw > 0) return withBudget("high", "low confidence (" + conf + "%) with keyword signal - more deliberation needed");
  if (st >= structuralHighThreshold) return withBudget("high", "structurally complex prompt (structure=" + st + ")");

  // LOW triggers (any of these is enough)
  if (catSlug && lowCats.indexOf(catSlug) !== -1 && conf >= highConfForLow) {
    return withBudget("low", "trivial category '" + catSlug + "' with high confidence (" + conf + "%)");
  }
  // Relaxed: trivial category + matched keyword is enough even without high confidence
  // (typo/rename prompts are short so multi-signal confidence is naturally low)
  if (catSlug && lowCats.indexOf(catSlug) !== -1 && kw > 0) {
    return withBudget("low", "trivial category '" + catSlug + "' with keyword match (confidence=" + conf + "%)");
  }
  if (wc <= 2 && kw > 0 && conf >= 80) {
    return withBudget("low", "very short prompt (" + wc + ") with confident keyword match");
  }

  // Default
  var defaultLevel = (config.effort.defaultLevel) || "medium";
  return withBudget(defaultLevel, "default (no HIGH/LOW triggers fired)");
}

// v3.1.0: MCP tool density scoring. When a prompt asks for multiple external
// integrations (browser/playwright, github, slack, gmail, vercel, netlify, etc.),
// complexity is higher than the keyword count alone suggests because each tool
// has its own auth, latency, error model. Returns a small additive boost.
function scoreMcpToolDensity(promptLower, config) {
  if (!config || !config.mcpToolAwareness || config.mcpToolAwareness.enabled === false) return { score: 0, matchedTools: [] };
  var tools = (config.mcpToolAwareness.tools) || [
    "playwright", "browser_", "puppeteer",
    "github", "gh ", "git pr", "pull request",
    "slack", "channel", "send message",
    "gmail", "email",
    "vercel", "netlify", "deploy",
    "firefox", "fox_", "chrome",
    "context7", "fetch docs",
    "memory", "memorize",
    "scheduled task", "cron"
  ];
  var matched = [];
  for (var i = 0; i < tools.length; i++) {
    if (promptLower.indexOf(tools[i].toLowerCase()) !== -1) {
      matched.push(tools[i]);
    }
  }
  // Small score: 1 tool = 0, 2 tools = 1, 3+ tools = 2 (capped at 3)
  var unique = matched.length;
  var score = unique >= 3 ? 3 : (unique >= 2 ? 1 : 0);
  return { score: score, matchedTools: matched, count: unique };
}

// v3.1.0: Skills system integration. Detect skill triggers ("superpowers:debugging",
// "frontend-design", "/health" etc.) — when the prompt explicitly invokes a
// known skill, route accordingly. Skills like debugging/test-driven-development
// strongly imply medium-to-high complexity.
function detectSkillTrigger(promptLower, config) {
  if (!config || !config.skillIntegration || config.skillIntegration.enabled === false) return null;
  var skillRules = (config.skillIntegration.rules) || [];
  for (var i = 0; i < skillRules.length; i++) {
    var rule = skillRules[i];
    if (!rule || !rule.match || !rule.model) continue;
    if (promptLower.indexOf(String(rule.match).toLowerCase()) !== -1) {
      return {
        skill: rule.match,
        suggestedModel: rule.model,
        suggestedEffort: rule.effort || null,
        reason: rule.reason || ("skill trigger: " + rule.match)
      };
    }
  }
  return null;
}

// v3.2.0: Agent Teams role detection. Claude Code 2.1+ ships Agent Teams
// (multi-agent orchestrator). When a prompt sounds like a "team lead"
// orchestrating teammates, route to opus + high effort. When it's a
// "teammate worker" doing focused work, sonnet/haiku is enough.
//
// Heuristic: orchestrator phrases are present-tense imperatives describing
// coordination ("coordinate", "delegate", "synthesize findings"); teammate
// phrases are receiver-style ("you are teammate X", "your task is",
// "report your findings to lead").
function detectAgentTeamsRole(promptLower) {
  var leadPhrases = [
    "as team lead", "you are the team lead", "coordinate the team",
    "delegate to teammate", "delegate to teammates", "synthesize the findings",
    "merge teammate", "as orchestrator", "you orchestrate", "split the work",
    "as the lead", "csapatvezetőként", "koordináld",
    "verteile an teammates"
  ];
  var teammatePhrases = [
    "you are teammate", "as teammate", "report to lead", "your subtask is",
    "as a worker", "focused subtask", "report findings back",
    "te vagy a teammate", "csapattag vagy",
    "du bist teammate"
  ];
  for (var i = 0; i < leadPhrases.length; i++) {
    if (promptLower.indexOf(leadPhrases[i]) !== -1) {
      return { role: "lead", suggestedModel: "opus", suggestedEffort: "high", reason: "team lead phrase: '" + leadPhrases[i] + "'" };
    }
  }
  for (var j = 0; j < teammatePhrases.length; j++) {
    if (promptLower.indexOf(teammatePhrases[j]) !== -1) {
      return { role: "teammate", suggestedModel: "sonnet", suggestedEffort: "medium", reason: "teammate phrase: '" + teammatePhrases[j] + "'" };
    }
  }
  return null;
}

// v3.1.0: Subagent parallel dispatch detection. The user explicitly asking for
// parallel work signals an orchestration task — orchestrator should be opus,
// workers can be sonnet. Returns null when not detected.
function detectParallelDispatch(promptLower) {
  var phrases = [
    "in parallel", "párhuzamosan", "egyidejűleg", "egy időben",
    "dispatch ", "spawn ", "indíts el több",
    "futtass több", "multiple agents", "több ügynököt"
  ];
  var multiAgentPhrases = ["agents", "ügynök", "subagent", "alügynök", "worker"];
  var hasParallelPhrase = phrases.some(function(p) { return promptLower.indexOf(p) !== -1; });
  var hasAgentPhrase = multiAgentPhrases.some(function(p) { return promptLower.indexOf(p) !== -1; });
  if (hasParallelPhrase && hasAgentPhrase) {
    return { active: true, suggestion: "orchestrator: opus, workers: sonnet" };
  }
  return { active: false };
}

module.exports = {
  detectLanguage: detectLanguage,
  scoreKeywords: scoreKeywords,
  scoreKeywordsMultiLang: scoreKeywordsMultiLang,
  scoreKeywordsEngine: scoreKeywordsEngine,
  scoreMcpToolDensity: scoreMcpToolDensity,
  detectSkillTrigger: detectSkillTrigger,
  detectParallelDispatch: detectParallelDispatch,
  detectAgentTeamsRole: detectAgentTeamsRole,
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
  preflightCheck: preflightCheck,
  determineEffort: determineEffort,
  // Exported for use by explain mode
  _DEFAULT_HIGH_CATEGORIES: DEFAULT_HIGH_CATEGORIES,
  _DEFAULT_LOW_CATEGORIES: DEFAULT_LOW_CATEGORIES
};
