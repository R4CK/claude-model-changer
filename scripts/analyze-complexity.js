#!/usr/bin/env node

/**
 * Claude Model Changer - Complexity Analyzer v2.0
 *
 * Features:
 * - Complexity scoring (1-10) with weighted heuristics
 * - Configurable task-to-model mappings (config/task-routing.json)
 * - Project-specific config override (.claude/model-routing.json)
 * - Borderline score detection with warnings
 * - Cost estimation display
 * - Auto mode for high-confidence scores
 * - Usage statistics logging
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---- CONFIG LOADING ----

function loadConfig(cwd) {
  // 1. Load base config from plugin directory
  var baseConfig = null;
  var configPath = path.join(__dirname, "..", "config", "task-routing.json");
  try {
    baseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    baseConfig = null;
  }

  // 2. Check for project-specific override at .claude/model-routing.json
  if (cwd) {
    var projectConfigPath = path.join(cwd, ".claude", "model-routing.json");
    try {
      var projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf8"));
      // Deep merge: project config overrides base config
      baseConfig = deepMerge(baseConfig || {}, projectConfig);
    } catch (err) {
      // No project override, use base config
    }
  }

  return baseConfig;
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

// ---- USAGE LOGGING ----

function getLogPath() {
  return path.join(__dirname, "..", "logs", "usage.jsonl");
}

function logUsage(entry) {
  try {
    var logDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    var logPath = getLogPath();
    var logLine = JSON.stringify(entry) + "\n";

    // Append to log file
    fs.appendFileSync(logPath, logLine, "utf8");

    // Trim if over max entries
    trimLog(logPath, 1000);
  } catch (err) {
    // Silent fail - logging should never break the main flow
  }
}

function trimLog(logPath, maxEntries) {
  try {
    var content = fs.readFileSync(logPath, "utf8");
    var lines = content.trim().split("\n").filter(function(l) { return l.length > 0; });
    if (lines.length > maxEntries) {
      // Keep only the most recent entries
      var trimmed = lines.slice(lines.length - maxEntries);
      fs.writeFileSync(logPath, trimmed.join("\n") + "\n", "utf8");
    }
  } catch (err) {
    // Silent fail
  }
}

function getStats() {
  try {
    var logPath = getLogPath();
    if (!fs.existsSync(logPath)) return null;

    var content = fs.readFileSync(logPath, "utf8");
    var lines = content.trim().split("\n").filter(function(l) { return l.length > 0; });
    var entries = lines.map(function(l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(function(e) { return e !== null; });

    if (entries.length === 0) return null;

    // Calculate stats
    var total = entries.length;
    var modelCounts = { haiku: 0, sonnet: 0, opus: 0 };
    var categoryCounts = {};
    var autoRouted = 0;
    var borderline = 0;
    var overrides = 0;
    var scoreSum = 0;

    // Time-based stats
    var now = Date.now();
    var todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    var weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);
    var todayCount = 0;
    var weekCount = 0;

    entries.forEach(function(e) {
      modelCounts[e.model] = (modelCounts[e.model] || 0) + 1;
      if (e.category) {
        categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
      }
      if (e.autoRouted) autoRouted++;
      if (e.borderline) borderline++;
      if (e.override) overrides++;
      scoreSum += (e.score || 0);

      var ts = new Date(e.timestamp);
      if (ts >= todayStart) todayCount++;
      if (ts >= weekStart) weekCount++;
    });

    // Top categories
    var topCategories = Object.entries(categoryCounts)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 5);

    return {
      total: total,
      today: todayCount,
      thisWeek: weekCount,
      models: modelCounts,
      modelPercentages: {
        haiku: total > 0 ? Math.round(modelCounts.haiku / total * 100) : 0,
        sonnet: total > 0 ? Math.round(modelCounts.sonnet / total * 100) : 0,
        opus: total > 0 ? Math.round(modelCounts.opus / total * 100) : 0
      },
      avgScore: total > 0 ? (scoreSum / total).toFixed(1) : "0",
      autoRouted: autoRouted,
      borderline: borderline,
      overrides: overrides,
      topCategories: topCategories
    };
  } catch (err) {
    return null;
  }
}

// ---- SCORING FUNCTIONS ----

function scoreWordCount(wordCount) {
  if (wordCount <= 10) return 1;
  if (wordCount <= 25) return 2;
  if (wordCount <= 50) return 3;
  if (wordCount <= 100) return 4;
  if (wordCount <= 200) return 6;
  return 7;
}

function scoreKeywords(promptLower, config) {
  if (!config || !config.models) return { score: 0, matchedModel: "none", matchedCategory: "none" };

  var modelScores = {
    opus: 8,
    sonnet: 5,
    haiku: 2
  };

  // Collect ALL keyword matches across all models
  var allMatches = [];

  for (var m = 0; m < ["opus", "sonnet", "haiku"].length; m++) {
    var modelName = ["opus", "sonnet", "haiku"][m];
    var modelDef = config.models[modelName];
    if (!modelDef || !modelDef.categories) continue;

    var catEntries = Object.entries(modelDef.categories);
    for (var c = 0; c < catEntries.length; c++) {
      var catKey = catEntries[c][0];
      var catDef = catEntries[c][1];
      if (!catDef.keywords) continue;
      for (var k = 0; k < catDef.keywords.length; k++) {
        var kwLower = catDef.keywords[k].toLowerCase();
        if (promptLower.includes(kwLower)) {
          allMatches.push({
            keyword: kwLower,
            length: kwLower.length,
            model: modelName,
            score: modelScores[modelName],
            category: catDef.label || catKey
          });
        }
      }
    }
  }

  if (allMatches.length === 0) {
    return { score: 0, matchedModel: "none", matchedCategory: "none" };
  }

  // Sort by keyword length descending (most specific first),
  // then by model score descending (higher complexity wins ties)
  allMatches.sort(function(a, b) {
    if (b.length !== a.length) return b.length - a.length;
    return b.score - a.score;
  });

  var best = allMatches[0];
  return {
    score: best.score,
    matchedModel: best.model,
    matchedCategory: best.category
  };
}

function scoreCodeBlocks(prompt) {
  var codeBlockCount = (prompt.match(/```/g) || []).length / 2;
  if (codeBlockCount === 0) return 0;
  if (codeBlockCount <= 1) return 1;
  if (codeBlockCount <= 3) return 2;
  return 3;
}

function scoreMultiFileIndicators(promptLower, config) {
  var indicators = (config && config.scoring && config.scoring.multiFileIndicators)
    ? config.scoring.multiFileIndicators
    : [
        "multiple files", "several files", "all files", "across files",
        "many files", "each file", "every file", "throughout",
        "project-wide", "codebase-wide", "repo-wide",
        "components", "modules", "services", "layers",
        "frontend and backend", "client and server"
      ];

  var count = 0;
  for (var i = 0; i < indicators.length; i++) {
    if (promptLower.includes(indicators[i].toLowerCase())) count++;
  }
  if (count === 0) return 0;
  if (count === 1) return 2;
  return 4;
}

function scoreStructuralComplexity(prompt) {
  var score = 0;

  var numberedItems = (prompt.match(/^\s*\d+[.)]/gm) || []).length;
  if (numberedItems >= 5) score += 3;
  else if (numberedItems >= 3) score += 2;
  else if (numberedItems >= 1) score += 1;

  var bulletItems = (prompt.match(/^\s*[-*]/gm) || []).length;
  if (bulletItems >= 5) score += 2;
  else if (bulletItems >= 3) score += 1;

  var questionMarks = (prompt.match(/\?/g) || []).length;
  if (questionMarks >= 3) score += 1;

  var filePaths = (prompt.match(/[\w/\\]+\.\w{1,5}/g) || []).length;
  if (filePaths >= 5) score += 3;
  else if (filePaths >= 3) score += 2;
  else if (filePaths >= 1) score += 1;

  return Math.min(score, 4);
}

function classifyQuestionVsTask(promptLower) {
  var questionPatterns = [
    /^what /, /^how /, /^why /, /^where /, /^when /,
    /^is /, /^are /, /^can /, /^could /, /^should /,
    /^does /, /^do /, /^will /, /^would /,
    /\?$/
  ];

  for (var i = 0; i < questionPatterns.length; i++) {
    if (questionPatterns[i].test(promptLower.trim())) {
      return "question";
    }
  }
  return "task";
}

function detectManualOverride(prompt, config) {
  var markers = (config && config.overrideMarkers)
    ? config.overrideMarkers
    : ["@haiku", "@sonnet", "@opus"];

  for (var i = 0; i < markers.length; i++) {
    if (prompt.toLowerCase().includes(markers[i].toLowerCase())) {
      return markers[i].replace("@", "").toLowerCase();
    }
  }

  var useMatch = prompt.match(/\buse\s+(haiku|sonnet|opus)\b/i);
  if (useMatch) return useMatch[1].toLowerCase();

  return null;
}

// ---- BORDERLINE DETECTION ----

function detectBorderline(score, config) {
  var zones = (config && config.autoMode && config.autoMode.borderlineZones)
    ? config.autoMode.borderlineZones
    : [3, 4, 7, 8];

  if (zones.indexOf(score) !== -1) {
    if (score === 3 || score === 4) {
      return { isBorderline: true, between: "haiku/sonnet", lower: "haiku", upper: "sonnet" };
    }
    if (score === 7 || score === 8) {
      return { isBorderline: true, between: "sonnet/opus", lower: "sonnet", upper: "opus" };
    }
  }
  return { isBorderline: false };
}

// ---- AUTO MODE DETECTION ----

function shouldAutoRoute(score, config) {
  if (!config || !config.autoMode || !config.autoMode.enabled) return false;

  var thresholds = config.autoMode.autoThresholds;
  if (!thresholds) return false;

  // Check haiku auto range
  if (thresholds.haiku && score >= thresholds.haiku[0] && score <= thresholds.haiku[1]) {
    return true;
  }
  // Check opus auto range
  if (thresholds.opus && score >= thresholds.opus[0] && score <= thresholds.opus[1]) {
    return true;
  }

  return false;
}

// ---- COST ESTIMATION ----

function getCostEstimate(model, config) {
  if (!config || !config.costEstimates || !config.costEstimates[model]) {
    var defaults = {
      haiku: "~10x cheaper than opus",
      sonnet: "balanced cost/performance",
      opus: "most capable, highest cost"
    };
    return defaults[model] || "";
  }

  var cost = config.costEstimates[model];
  return cost.label + " ($" + cost.inputPer1M + "/$" + cost.outputPer1M + " per 1M tokens in/out)";
}

// ---- MAIN ANALYSIS ----

function analyzeComplexity(prompt, config) {
  // Check for manual override first
  var override = detectManualOverride(prompt, config);
  if (override) {
    var scoreMap = { haiku: 2, sonnet: 5, opus: 9 };
    var levelMap = { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" };
    return {
      score: scoreMap[override],
      level: levelMap[override],
      model: override,
      override: true,
      matchedCategory: "Manual override",
      reason: "User requested " + override,
      borderline: { isBorderline: false },
      autoRoute: false
    };
  }

  var promptLower = prompt.toLowerCase();
  var words = prompt.split(/\s+/).filter(function(w) { return w.length > 0; });
  var wordCount = words.length;

  var weights = (config && config.scoring && config.scoring.weights)
    ? config.scoring.weights
    : { keyword: 0.35, multiFile: 0.20, structure: 0.20, wordCount: 0.15, codeBlocks: 0.10 };

  var questionReduction = (config && config.scoring && config.scoring.questionReduction)
    ? config.scoring.questionReduction
    : 0.8;

  var wordScore = scoreWordCount(wordCount);
  var keywordResult = scoreKeywords(promptLower, config);
  var codeBlockScore = scoreCodeBlocks(prompt);
  var multiFileScore = scoreMultiFileIndicators(promptLower, config);
  var structuralScore = scoreStructuralComplexity(prompt);
  var taskType = classifyQuestionVsTask(promptLower);

  var rawScore = 0;
  rawScore += wordScore * weights.wordCount;
  rawScore += keywordResult.score * weights.keyword;
  rawScore += codeBlockScore * weights.codeBlocks;
  rawScore += multiFileScore * weights.multiFile;
  rawScore += structuralScore * weights.structure;

  if (taskType === "question" && rawScore > 3) {
    rawScore *= questionReduction;
  }

  var finalScore = Math.max(1, Math.min(10, Math.round(rawScore)));

  var level, model;
  if (config && config.models) {
    if (config.models.haiku && finalScore >= config.models.haiku.scoreRange[0] && finalScore <= config.models.haiku.scoreRange[1]) {
      level = "SIMPLE"; model = "haiku";
    } else if (config.models.sonnet && finalScore >= config.models.sonnet.scoreRange[0] && finalScore <= config.models.sonnet.scoreRange[1]) {
      level = "MEDIUM"; model = "sonnet";
    } else {
      level = "COMPLEX"; model = "opus";
    }
  } else {
    if (finalScore <= 3) { level = "SIMPLE"; model = "haiku"; }
    else if (finalScore <= 7) { level = "MEDIUM"; model = "sonnet"; }
    else { level = "COMPLEX"; model = "opus"; }
  }

  if (keywordResult.matchedModel !== "none" && keywordResult.score > 0) {
    model = keywordResult.matchedModel;
    if (model === "haiku") {
      level = "SIMPLE";
      if (finalScore > 3) finalScore = Math.max(1, Math.min(3, Math.round(rawScore * 0.5)));
    } else if (model === "sonnet") {
      level = "MEDIUM";
      if (finalScore < 4) finalScore = Math.max(4, Math.round(rawScore + 2));
      if (finalScore > 7) finalScore = 7;
    } else {
      level = "COMPLEX";
      if (finalScore < 8) finalScore = Math.max(8, Math.round(rawScore + 4));
    }
    finalScore = Math.max(1, Math.min(10, finalScore));
  }

  // Borderline detection
  var borderline = detectBorderline(finalScore, config);

  // Auto mode detection
  var autoRoute = shouldAutoRoute(finalScore, config);

  return {
    score: finalScore,
    level: level,
    model: model,
    override: false,
    matchedCategory: keywordResult.matchedCategory,
    reason: "Words: " + wordCount + " (" + wordScore + "), " +
            "Keyword: " + keywordResult.matchedCategory + " (" + keywordResult.score + "), " +
            "Code blocks: " + codeBlockScore + ", " +
            "Multi-file: " + multiFileScore + ", " +
            "Structure: " + structuralScore + ", " +
            "Type: " + taskType,
    borderline: borderline,
    autoRoute: autoRoute
  };
}

// ---- STDIN READING & OUTPUT ----

var input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function(chunk) { input += chunk; });
process.stdin.on("end", function() {
  try {
    var data = JSON.parse(input);
    var prompt = data.prompt || "";
    var cwd = data.cwd || process.cwd();

    // Skip very short prompts
    if (prompt.trim().length < 3) {
      process.exit(0);
    }

    // Skip slash command invocations
    if (prompt.trim().startsWith("/")) {
      process.exit(0);
    }

    // Special command: --stats (used by /stats command)
    if (prompt.trim() === "--stats") {
      var stats = getStats();
      if (stats) {
        process.stdout.write(JSON.stringify(stats, null, 2));
      } else {
        process.stdout.write("No usage data yet.");
      }
      process.exit(0);
    }

    var config = loadConfig(cwd);
    var result = analyzeComplexity(prompt, config);

    // Log usage
    if (!config || !config.logging || config.logging.enabled !== false) {
      logUsage({
        timestamp: new Date().toISOString(),
        score: result.score,
        level: result.level,
        model: result.model,
        category: result.matchedCategory,
        override: result.override,
        borderline: result.borderline.isBorderline,
        autoRouted: result.autoRoute,
        promptPreview: prompt.substring(0, 80).replace(/\n/g, " ")
      });
    }

    // Build the context message
    var lines = [];
    var costInfo = getCostEstimate(result.model, config);

    lines.push("[Model Router] Complexity: " + result.level + " (score " + result.score + "/10) -> Recommended: " + result.model);

    if (result.override) {
      lines.push("Override: User explicitly requested " + result.model + ".");
    } else {
      lines.push("Matched category: \"" + result.matchedCategory + "\"");
      lines.push("Analysis: " + result.reason);
    }

    // Cost estimate
    lines.push("Cost: " + costInfo);

    // Borderline warning
    if (result.borderline.isBorderline) {
      lines.push("BORDERLINE: Score " + result.score + " is on the " + result.borderline.between + " boundary. Both " + result.borderline.lower + " and " + result.borderline.upper + " could work here.");
    }

    lines.push("");

    // Auto mode vs suggest mode
    if (result.autoRoute && !result.override) {
      lines.push("AUTO-ROUTING: High confidence score (" + result.score + "/10). Automatically delegate this task to the **" + result.model + "-worker** agent without asking. Just do it.");
      lines.push("If the task is trivially simple (like a direct question), you may answer directly without delegating.");
    } else if (result.borderline.isBorderline) {
      lines.push("ROUTING SUGGESTION (BORDERLINE): This task scored " + result.score + "/10, near the " + result.borderline.between + " boundary.");
      lines.push("Ask the user: \"This is a borderline task (score " + result.score + "/10, category: " + result.matchedCategory + ") between **" + result.borderline.lower + "** and **" + result.borderline.upper + "**. Which model should I use?\"");
      lines.push("If the user confirms the recommended model or says yes, delegate to " + result.model + "-worker.");
      lines.push("If the user chooses a different model, use that model's worker agent instead.");
    } else {
      lines.push("ROUTING SUGGESTION: This task is rated " + result.level + " complexity.");
      lines.push("Before proceeding, ask the user: \"This looks like a " + result.level.toLowerCase() + " complexity task (score " + result.score + "/10, category: " + result.matchedCategory + "). Shall I route this to the **" + result.model + "-worker** agent for " + (result.model === "haiku" ? "fast" : result.model === "sonnet" ? "balanced" : "thorough") + " handling, or would you prefer a different model (haiku/sonnet/opus)?\"");
      lines.push("If the user confirms or says yes, delegate the task to the " + result.model + "-worker agent using the Agent tool.");
      lines.push("If the user chooses a different model, use that model's worker agent instead.");
      lines.push("If the task is trivially simple (like a direct question), you may answer directly without delegating.");
    }

    process.stdout.write(lines.join("\n"));
    process.exit(0);

  } catch (err) {
    // On any error, silently allow the prompt through
    process.exit(0);
  }
});
