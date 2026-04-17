"use strict";

var assert = require("assert");
var path = require("path");
var h = require("./harness");
var scoring = require("../scripts/lib/scoring");

// Minimal fixture config for keyword tests. Mirrors the real task-routing.json
// structure without requiring the full file.
var fixtureConfig = {
  models: {
    haiku: {
      scoreRange: [1, 3],
      categories: {
        typo_fix: { label: "Typo fixes", keywords: ["fix typo", "typo"] },
        formatting: { label: "Formatting", keywords: ["format", "formatting"] }
      }
    },
    sonnet: {
      scoreRange: [4, 7],
      categories: {
        bug_fixing: { label: "Bug fixing", keywords: ["fix bug", "debug", "fix the bug"] },
        testing: { label: "Testing", keywords: ["write test", "add test"] }
      }
    },
    opus: {
      scoreRange: [8, 10],
      categories: {
        architecture: { label: "Architecture", keywords: ["architecture", "system design"] }
      }
    }
  },
  translations: {
    hu: {
      bug_fixing: ["javítsd a hibát", "hibakeresés"],
      architecture: ["architektúra", "rendszertervezés"]
    },
    de: {
      bug_fixing: ["fehler beheben", "debug"],
      architecture: ["architektur"]
    }
  }
};

// ---- scoreWordCount ----

h.describe("scoreWordCount", function(it) {
  it("tiny prompt (3 words) -> 1", function() {
    assert.strictEqual(scoring.scoreWordCount(3), 1);
  });
  it("8 words (boundary) -> 2", function() {
    assert.strictEqual(scoring.scoreWordCount(8), 2);
  });
  it("20 words -> 4 (15 < n <= 30 bin)", function() {
    assert.strictEqual(scoring.scoreWordCount(20), 4);
  });
  it("60 words -> 5", function() {
    assert.strictEqual(scoring.scoreWordCount(60), 5);
  });
  it("huge prompt (500 words) -> 9 (top bin)", function() {
    assert.strictEqual(scoring.scoreWordCount(500), 9);
  });
});

// ---- scoreCodeBlocks ----

h.describe("scoreCodeBlocks", function(it) {
  it("no fences -> 0", function() {
    assert.strictEqual(scoring.scoreCodeBlocks("plain text"), 0);
  });
  it("one fence pair -> 2", function() {
    assert.strictEqual(scoring.scoreCodeBlocks("```js\ncode\n```"), 2);
  });
  it("two fence pairs -> 4", function() {
    assert.strictEqual(scoring.scoreCodeBlocks("```a\n```\n```b\n```"), 4);
  });
  it("many fences (4 pairs) -> 6 (top bin)", function() {
    var input = "```a\n```\n```b\n```\n```c\n```\n```d\n```";
    assert.strictEqual(scoring.scoreCodeBlocks(input), 6);
  });
});

// ---- scoreMultiFileIndicators ----

h.describe("scoreMultiFileIndicators", function(it) {
  it("no indicators -> 0", function() {
    assert.strictEqual(scoring.scoreMultiFileIndicators("fix the typo", fixtureConfig), 0);
  });
  it("one indicator ('components') -> 3", function() {
    assert.strictEqual(scoring.scoreMultiFileIndicators("refactor all components", fixtureConfig), 3);
  });
  it("two indicators ('all files' + 'components') -> 5", function() {
    assert.strictEqual(scoring.scoreMultiFileIndicators("across all files and components", fixtureConfig), 5);
  });
  it("3+ indicators -> 7", function() {
    assert.strictEqual(scoring.scoreMultiFileIndicators("rewrite all files across components and services", fixtureConfig), 7);
  });
});

// ---- scoreStructuralComplexity ----

h.describe("scoreStructuralComplexity", function(it) {
  it("empty/plain -> 0", function() {
    assert.strictEqual(scoring.scoreStructuralComplexity("just a simple prompt"), 0);
  });
  it("numbered list 5+ items -> 3", function() {
    var input = "1. one\n2. two\n3. three\n4. four\n5. five";
    var score = scoring.scoreStructuralComplexity(input);
    assert.ok(score >= 3, "expected >=3 for 5 numbered items, got " + score);
  });
  it("file paths present (3+) -> 2+", function() {
    var input = "update src/foo.js and src/bar.ts and lib/baz.py";
    var score = scoring.scoreStructuralComplexity(input);
    assert.ok(score >= 2, "expected >=2 for 3 file paths, got " + score);
  });
  it("is capped at 8", function() {
    // Intentionally over-stuffed input to exceed cap
    var input = "1. a\n2. b\n3. c\n4. d\n5. e\n- x\n- y\n- z\n? ? ? ? ?\nsrc/a.js src/b.js src/c.js src/d.js src/e.js";
    assert.ok(scoring.scoreStructuralComplexity(input) <= 8);
  });
});

// ---- detectLanguage ----

h.describe("detectLanguage", function(it) {
  it("plain English -> en", function() {
    assert.strictEqual(scoring.detectLanguage("please fix the bug in this function"), "en");
  });
  it("clear Hungarian (diacritics + function words) -> hu", function() {
    assert.strictEqual(scoring.detectLanguage("javítsd a hibát ebben a függvényben, kérlek"), "hu");
  });
  it("clear German (diacritics + function words) -> de", function() {
    assert.strictEqual(scoring.detectLanguage("bitte behebe den Fehler in dieser Funktion"), "de");
  });
  it("mixed (insufficient signal) -> en", function() {
    assert.strictEqual(scoring.detectLanguage("fix typo"), "en");
  });
});

// ---- classifyQuestionVsTask ----

h.describe("classifyQuestionVsTask", function(it) {
  it("'what ...' -> question", function() {
    assert.strictEqual(scoring.classifyQuestionVsTask("what does this function do"), "question");
  });
  it("ends with '?' -> question", function() {
    assert.strictEqual(scoring.classifyQuestionVsTask("does this work right?"), "question");
  });
  it("imperative 'fix' -> task", function() {
    assert.strictEqual(scoring.classifyQuestionVsTask("fix the bug in parseUser"), "task");
  });
});

// ---- detectManualOverride ----

h.describe("detectManualOverride", function(it) {
  it("@haiku marker -> haiku", function() {
    assert.strictEqual(scoring.detectManualOverride("@haiku do this quick task", fixtureConfig), "haiku");
  });
  it("@opus marker -> opus", function() {
    assert.strictEqual(scoring.detectManualOverride("@opus design the system", fixtureConfig), "opus");
  });
  it("'use sonnet' phrase -> sonnet", function() {
    assert.strictEqual(scoring.detectManualOverride("please use sonnet for this", fixtureConfig), "sonnet");
  });
  it("no override marker -> null", function() {
    assert.strictEqual(scoring.detectManualOverride("fix the bug", fixtureConfig), null);
  });
});

// ---- scoreKeywords / scoreKeywordsMultiLang ----

h.describe("scoreKeywords", function(it) {
  it("matches haiku keyword 'fix typo' -> haiku", function() {
    var r = scoring.scoreKeywords("please fix typo in readme", fixtureConfig);
    assert.strictEqual(r.matchedModel, "haiku");
    assert.strictEqual(r.matchedCategory, "Typo fixes");
  });
  it("matches opus keyword 'architecture' -> opus", function() {
    var r = scoring.scoreKeywords("design the overall architecture of the system", fixtureConfig);
    assert.strictEqual(r.matchedModel, "opus");
  });
  it("no keyword match -> none", function() {
    var r = scoring.scoreKeywords("random text with no familiar terms", fixtureConfig);
    assert.strictEqual(r.matchedModel, "none");
    assert.strictEqual(r.score, 0);
  });
  it("longer keyword wins over shorter (specificity)", function() {
    // "fix the bug" (11 chars) should beat "fix bug" (7 chars) in specificity
    var r = scoring.scoreKeywords("please fix the bug in this code", fixtureConfig);
    assert.strictEqual(r.matchedModel, "sonnet");
    assert.strictEqual(r.matchedCategory, "Bug fixing");
  });
  it("expects already-lowercased input (contract with caller)", function() {
    // scoreKeywords is called with promptLower from analyze-complexity.js.
    // If passed uppercase, it won't match - this is the expected contract.
    var rUpper = scoring.scoreKeywords("ARCHITECTURE of the platform", fixtureConfig);
    var rLower = scoring.scoreKeywords("architecture of the platform", fixtureConfig);
    assert.strictEqual(rUpper.matchedModel, "none", "uppercase input should not match");
    assert.strictEqual(rLower.matchedModel, "opus", "lowercase input should match");
  });
});

h.describe("scoreKeywordsMultiLang", function(it) {
  it("Hungarian prompt matches HU translation", function() {
    var r = scoring.scoreKeywordsMultiLang("javítsd a hibát a kódban", fixtureConfig, "hu");
    assert.strictEqual(r.matchedModel, "sonnet");
  });
  it("German prompt matches DE translation", function() {
    var r = scoring.scoreKeywordsMultiLang("architektur des systems", fixtureConfig, "de");
    assert.strictEqual(r.matchedModel, "opus");
  });
  it("EN lang falls back to English keywords", function() {
    var r = scoring.scoreKeywordsMultiLang("fix bug in parser", fixtureConfig, "en");
    assert.strictEqual(r.matchedModel, "sonnet");
  });
});

// ---- calculateConfidence ----

h.describe("calculateConfidence", function(it) {
  it("single active signal -> low confidence", function() {
    var r = scoring.calculateConfidence({ keyword: 0, wordCount: 2, codeBlocks: 0, multiFile: 0, structure: 0 });
    assert.ok(r.confidence <= 50, "expected <=50 for 1 signal, got " + r.confidence);
    assert.strictEqual(r.signals, 1);
  });
  it("three agreeing signals -> high confidence", function() {
    var r = scoring.calculateConfidence({ keyword: 8, wordCount: 6, codeBlocks: 0, multiFile: 4, structure: 3 });
    assert.ok(r.confidence >= 70, "expected >=70 for agreeing signals, got " + r.confidence);
  });
  it("no signals -> minimum confidence", function() {
    var r = scoring.calculateConfidence({ keyword: 0, wordCount: 0, codeBlocks: 0, multiFile: 0, structure: 0 });
    assert.strictEqual(r.signals, 0);
  });
});

// ---- detectBorderline ----

h.describe("detectBorderline", function(it) {
  it("score 4 -> borderline (haiku/sonnet)", function() {
    var r = scoring.detectBorderline(4, fixtureConfig);
    assert.strictEqual(r.isBorderline, true);
  });
  it("score 8 -> borderline (sonnet/opus)", function() {
    var r = scoring.detectBorderline(8, fixtureConfig);
    assert.strictEqual(r.isBorderline, true);
  });
  it("score 2 -> not borderline (clear haiku)", function() {
    var r = scoring.detectBorderline(2, fixtureConfig);
    assert.strictEqual(r.isBorderline, false);
  });
});

// ---- getCostEstimate ----

h.describe("getCostEstimate", function(it) {
  it("returns string containing 'cheaper' for haiku default", function() {
    var s = scoring.getCostEstimate("haiku", null);
    assert.ok(/cheaper|low|\$/i.test(s), "expected cost-related string, got: " + s);
  });
  it("returns string containing opus indication", function() {
    var s = scoring.getCostEstimate("opus", null);
    assert.ok(/capable|high|\$/i.test(s), "expected cost-related string, got: " + s);
  });
});
