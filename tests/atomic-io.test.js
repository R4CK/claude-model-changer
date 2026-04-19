"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var h = require("./harness");
var atomicIo = require("../scripts/lib/atomic-io");

// Create a fresh temp file per test to avoid cross-test contamination
var TMP_DIR = path.join(os.tmpdir(), "cmc-atomic-io-tests");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function newTmp(suffix) {
  return path.join(TMP_DIR, "t-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "-" + suffix + ".json");
}

function cleanup(p) {
  try { fs.unlinkSync(p); } catch (e) {}
}

h.describe("atomicWriteJson", function(it) {
  it("creates a new file with correct content", function() {
    var p = newTmp("create");
    try {
      var ok = atomicIo.atomicWriteJson(p, { a: 1, b: "hello" });
      assert.strictEqual(ok, true);
      var content = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.strictEqual(content.a, 1);
      assert.strictEqual(content.b, "hello");
    } finally { cleanup(p); }
  });

  it("overwrites an existing file atomically", function() {
    var p = newTmp("overwrite");
    try {
      fs.writeFileSync(p, JSON.stringify({ old: true }));
      var ok = atomicIo.atomicWriteJson(p, { fresh: "yes" });
      assert.strictEqual(ok, true);
      var content = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.strictEqual(content.fresh, "yes");
      assert.strictEqual(content.old, undefined);
    } finally { cleanup(p); }
  });

  it("creates parent directory if missing", function() {
    var dir = path.join(TMP_DIR, "nested-" + Date.now());
    var p = path.join(dir, "file.json");
    try {
      var ok = atomicIo.atomicWriteJson(p, { nested: true });
      assert.strictEqual(ok, true);
      assert.ok(fs.existsSync(p));
    } finally {
      try { fs.unlinkSync(p); fs.rmdirSync(dir); } catch (e) {}
    }
  });

  it("leaves no .tmp file behind after success", function() {
    var p = newTmp("clean");
    try {
      atomicIo.atomicWriteJson(p, { x: 1 });
      var parent = path.dirname(p);
      var base = path.basename(p);
      var strays = fs.readdirSync(parent).filter(function(f) {
        return f.indexOf(base + ".tmp.") === 0;
      });
      assert.strictEqual(strays.length, 0);
    } finally { cleanup(p); }
  });
});

h.describe("safeReadJson", function(it) {
  it("returns null when file is missing", function() {
    var p = newTmp("missing");
    assert.strictEqual(atomicIo.safeReadJson(p), null);
  });

  it("returns null on invalid JSON (no throw)", function() {
    var p = newTmp("corrupt");
    try {
      fs.writeFileSync(p, "{this is not json");
      assert.strictEqual(atomicIo.safeReadJson(p), null);
    } finally { cleanup(p); }
  });

  it("strips UTF-8 BOM", function() {
    var p = newTmp("bom");
    try {
      fs.writeFileSync(p, "\uFEFF{\"a\":1}", "utf8");
      var data = atomicIo.safeReadJson(p);
      assert.strictEqual(data.a, 1);
    } finally { cleanup(p); }
  });
});

h.describe("atomicMergeJson", function(it) {
  it("initializes with default on missing file", function() {
    var p = newTmp("init");
    try {
      var result = atomicIo.atomicMergeJson(p, function(cur) {
        return { initialized: true, count: (cur.count || 0) + 1 };
      }, { count: 0 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.initialized, true);
      assert.strictEqual(result.data.count, 1);
    } finally { cleanup(p); }
  });

  it("merges counter increment from existing file", function() {
    var p = newTmp("counter");
    try {
      atomicIo.atomicWriteJson(p, { count: 5 });
      var result = atomicIo.atomicMergeJson(p, function(cur) {
        return { count: (cur.count || 0) + 10 };
      }, { count: 0 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.count, 15);
    } finally { cleanup(p); }
  });

  it("returns ok:false with error message if mergeFn throws", function() {
    var p = newTmp("throws");
    try {
      atomicIo.atomicWriteJson(p, { x: 1 });
      var result = atomicIo.atomicMergeJson(p, function() {
        throw new Error("mergefn broke");
      });
      assert.strictEqual(result.ok, false);
      assert.ok(/mergefn broke/.test(result.error));
    } finally { cleanup(p); }
  });

  it("preserves Math.max merge semantics in mergeFn", function() {
    var p = newTmp("maxmerge");
    try {
      atomicIo.atomicWriteJson(p, { counts: { haiku: 10, sonnet: 5, opus: 2 } });
      var proposed = { counts: { haiku: 8, sonnet: 20, opus: 3 } };
      var result = atomicIo.atomicMergeJson(p, function(cur) {
        var merged = { counts: { haiku: 0, sonnet: 0, opus: 0 } };
        ["haiku", "sonnet", "opus"].forEach(function(m) {
          merged.counts[m] = Math.max((cur.counts && cur.counts[m]) || 0, proposed.counts[m]);
        });
        return merged;
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.counts.haiku, 10);   // disk wins
      assert.strictEqual(result.data.counts.sonnet, 20);  // proposed wins
      assert.strictEqual(result.data.counts.opus, 3);     // proposed wins
    } finally { cleanup(p); }
  });
});

h.describe("atomicAppendJsonLine", function(it) {
  it("appends a JSON object as a new line", function() {
    var p = newTmp("append");
    try {
      atomicIo.atomicAppendJsonLine(p, { event: "first" });
      atomicIo.atomicAppendJsonLine(p, { event: "second" });
      var lines = fs.readFileSync(p, "utf8").trim().split("\n");
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(JSON.parse(lines[0]).event, "first");
      assert.strictEqual(JSON.parse(lines[1]).event, "second");
    } finally { cleanup(p); }
  });

  it("creates parent dir if missing", function() {
    var dir = path.join(TMP_DIR, "append-nested-" + Date.now());
    var p = path.join(dir, "log.jsonl");
    try {
      var ok = atomicIo.atomicAppendJsonLine(p, { x: 1 });
      assert.strictEqual(ok, true);
      assert.ok(fs.existsSync(p));
    } finally {
      try { fs.unlinkSync(p); fs.rmdirSync(dir); } catch (e) {}
    }
  });
});
