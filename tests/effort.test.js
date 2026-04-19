"use strict";

var assert = require("assert");
var h = require("./harness");
var scoring = require("../scripts/lib/scoring");

// Minimal config with effort enabled
function makeConfig(overrides) {
  var cfg = {
    effort: {
      enabled: true,
      emitInOutput: true,
      defaultLevel: "medium",
      rules: {
        highCategories: ["architecture", "security", "planning"],
        lowCategories: ["typo_fix", "formatting", "rename"],
        lowConfidenceThreshold: 40,
        multiFileThreshold: 4,
        structuralHighThreshold: 6,
        lowEffortConfidenceThreshold: 70
      }
    },
    models: {
      haiku: { categories: {} },
      sonnet: { categories: {} },
      opus: { categories: {} }
    }
  };
  if (overrides) {
    for (var k in overrides) cfg[k] = overrides[k];
  }
  return cfg;
}

h.describe("determineEffort - disabled feature", function(it) {
  it("returns null when effort.enabled === false", function() {
    var cfg = makeConfig();
    cfg.effort.enabled = false;
    var r = scoring.determineEffort({}, 80, "typo_fix", cfg);
    assert.strictEqual(r, null);
  });

  it("returns null when effort block missing", function() {
    var r = scoring.determineEffort({}, 80, "typo_fix", { models: {} });
    assert.strictEqual(r, null);
  });
});

h.describe("determineEffort - HIGH triggers", function(it) {
  it("multi-file >= threshold -> high", function() {
    var r = scoring.determineEffort({ multiFile: 5 }, 80, "something", makeConfig());
    assert.strictEqual(r.level, "high");
    assert.ok(/multi-file/.test(r.reason));
  });

  it("high category (architecture) -> high", function() {
    var r = scoring.determineEffort({ multiFile: 0 }, 80, "Architecture", makeConfig(), "architecture");
    assert.strictEqual(r.level, "high");
    assert.ok(/highCategories|architecture/.test(r.reason));
  });

  it("low confidence with keyword match -> high", function() {
    var r = scoring.determineEffort({ keyword: 5 }, 35, "some category", makeConfig());
    assert.strictEqual(r.level, "high");
    assert.ok(/confidence/.test(r.reason));
  });

  it("highly structured prompt (structure >= 6) -> high", function() {
    var r = scoring.determineEffort({ structure: 7 }, 80, "random category", makeConfig());
    assert.strictEqual(r.level, "high");
    assert.ok(/structure/.test(r.reason));
  });
});

h.describe("determineEffort - LOW triggers", function(it) {
  it("trivial category + high confidence -> low", function() {
    // Pass categoryKey explicitly (matches real usage from analyze-complexity.js)
    var r = scoring.determineEffort({}, 85, "Typo fixes", makeConfig(), "typo_fix");
    assert.strictEqual(r.level, "low");
    assert.ok(/trivial|typo_fix/.test(r.reason));
  });

  it("trivial category + medium confidence -> medium (not low)", function() {
    var r = scoring.determineEffort({}, 55, "Typo fixes", makeConfig(), "typo_fix");
    assert.strictEqual(r.level, "medium");
  });

  it("very short + confident keyword -> low", function() {
    var r = scoring.determineEffort({ wordCount: 2, keyword: 8 }, 85, "something", makeConfig());
    assert.strictEqual(r.level, "low");
    assert.ok(/short/.test(r.reason));
  });

  it("trivial category + keyword match (even low confidence) -> low", function() {
    // Relaxed rule: typo/rename prompts are naturally short so confidence
    // can't reach the high threshold; category match is sufficient signal.
    var r = scoring.determineEffort({ keyword: 2 }, 40, "Typo fixes", makeConfig(), "typo_fix");
    assert.strictEqual(r.level, "low");
    assert.ok(/trivial|keyword match/.test(r.reason));
  });
});

h.describe("determineEffort - DEFAULT (medium)", function(it) {
  it("no triggers fired -> medium", function() {
    var r = scoring.determineEffort({ keyword: 5, wordCount: 10, multiFile: 0, structure: 2 }, 70, "Bug fixing", makeConfig());
    assert.strictEqual(r.level, "medium");
    assert.ok(/default/.test(r.reason));
  });

  it("uses config.effort.defaultLevel override", function() {
    var cfg = makeConfig();
    cfg.effort.defaultLevel = "high";
    var r = scoring.determineEffort({ keyword: 5 }, 70, "Bug fixing", cfg);
    assert.strictEqual(r.level, "high");
  });
});

h.describe("determineEffort - per-category override", function(it) {
  it("category with defaultEffort='low' beats HIGH trigger", function() {
    var cfg = makeConfig();
    cfg.models.sonnet.categories.my_cat = { label: "My Cat", keywords: [], defaultEffort: "low" };
    // multi-file would normally trigger high, but per-cat override wins
    var r = scoring.determineEffort({ multiFile: 5 }, 80, "My Cat", cfg, "my_cat");
    assert.strictEqual(r.level, "low");
    assert.ok(/per-category/.test(r.reason));
  });

  it("invalid defaultEffort value falls through to rules", function() {
    var cfg = makeConfig();
    cfg.models.sonnet.categories.weird = { label: "Weird", keywords: [], defaultEffort: "banana" };
    var r = scoring.determineEffort({ multiFile: 5 }, 80, "Weird", cfg, "weird");
    assert.strictEqual(r.level, "high");  // multi-file trigger wins
  });
});

h.describe("determineEffort - priority order (HIGH wins over LOW)", function(it) {
  it("multi-file 5 + trivial category + high conf -> high (multi-file wins)", function() {
    var r = scoring.determineEffort({ multiFile: 5 }, 85, "Typo fixes", makeConfig(), "typo_fix");
    assert.strictEqual(r.level, "high");
  });

  it("short prompt + high category -> high (category wins)", function() {
    var r = scoring.determineEffort({ wordCount: 2, keyword: 8 }, 85, "Architecture", makeConfig(), "architecture");
    assert.strictEqual(r.level, "high");
  });
});
