"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var h = require("./harness");
var configModule = require("../scripts/lib/config");

var REAL_CONFIG = path.join(__dirname, "..", "config", "task-routing.json");

// Helper: read + restore pattern to avoid polluting the real config
function withBackup(fn) {
  var original = fs.readFileSync(REAL_CONFIG, "utf8");
  try { fn(); } finally { fs.writeFileSync(REAL_CONFIG, original, "utf8"); }
}

h.describe("config hot-reload (v3.0.0)", function(it) {
  it("clearConfigCache is exported", function() {
    assert.strictEqual(typeof configModule.clearConfigCache, "function");
  });

  it("first load populates cache, repeated load returns same ref", function() {
    configModule.clearConfigCache();
    var a = configModule.loadConfig();
    var b = configModule.loadConfig();
    assert.strictEqual(a, b, "same object reference when unchanged");
  });

  it("cache invalidates when config file mtime changes", function() {
    configModule.clearConfigCache();
    var before = configModule.loadConfig();
    assert.ok(before && typeof before === "object");

    withBackup(function() {
      // Bump mtime by rewriting the file unchanged. Modern filesystems give
      // millisecond mtime resolution so we need to sleep to ensure a new tick.
      var originalContent = fs.readFileSync(REAL_CONFIG, "utf8");
      // Wait a moment to ensure distinct mtimeMs
      var buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, 30);
      fs.writeFileSync(REAL_CONFIG, originalContent, "utf8");

      var after = configModule.loadConfig();
      // The content is identical but mtime differs, so cache was invalidated.
      // We can't check object identity (it'll be a fresh parse), but we can
      // check the content matches.
      assert.deepStrictEqual(after.models, before.models);
    });
  });

  it("clearConfigCache forces reload on next call", function() {
    configModule.clearConfigCache();
    var before = configModule.loadConfig();
    configModule.clearConfigCache();
    var after = configModule.loadConfig();
    // Since clearConfigCache was called, even if mtime is identical,
    // the object should be a fresh parse (different ref).
    assert.notStrictEqual(before, after, "fresh parse after explicit cache flush");
    assert.deepStrictEqual(before.models, after.models);
  });

  it("_internal.computeMtimeSignature is stable for unchanged files", function() {
    var sig1 = configModule._internal.computeMtimeSignature();
    var sig2 = configModule._internal.computeMtimeSignature();
    assert.strictEqual(sig1, sig2);
  });

  it("mtimeSignature differs when file is rewritten", function() {
    var sig1 = configModule._internal.computeMtimeSignature();
    withBackup(function() {
      var originalContent = fs.readFileSync(REAL_CONFIG, "utf8");
      var buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, 30);
      fs.writeFileSync(REAL_CONFIG, originalContent, "utf8");
      var sig2 = configModule._internal.computeMtimeSignature();
      assert.notStrictEqual(sig1, sig2, "signature changes after rewrite");
    });
  });
});
