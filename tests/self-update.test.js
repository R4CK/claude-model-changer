"use strict";

/**
 * Tests for scripts/plugin-self-update.js — the pure, side-effect-free logic:
 * SemVer parsing/compare and the installed-cache-copy guard.
 */

var h = require("./harness");
var assert = require("assert");
var su = require("../scripts/plugin-self-update");

h.describe("plugin-self-update.parseSemver", function (it) {
  it("parses a plain X.Y.Z", function () {
    assert.deepStrictEqual(su.parseSemver("3.7.1"), [3, 7, 1]);
  });
  it("strips a leading v", function () {
    assert.deepStrictEqual(su.parseSemver("v3.7.1"), [3, 7, 1]);
  });
  it("parses a prerelease prefix numerically", function () {
    assert.deepStrictEqual(su.parseSemver("4.0.0-beta.1"), [4, 0, 0]);
  });
  it("returns null for garbage", function () {
    assert.strictEqual(su.parseSemver("not-a-version"), null);
  });
  it("returns null for a non-string", function () {
    assert.strictEqual(su.parseSemver(null), null);
  });
});

h.describe("plugin-self-update.isNewer", function (it) {
  it("patch bump is newer", function () {
    assert.strictEqual(su.isNewer("3.6.2", "3.6.1"), true);
  });
  it("equal is not newer", function () {
    assert.strictEqual(su.isNewer("3.6.2", "3.6.2"), false);
  });
  it("older is not newer", function () {
    assert.strictEqual(su.isNewer("3.6.1", "3.6.2"), false);
  });
  it("numeric compare: 3.10.0 > 3.9.9 (not string compare)", function () {
    assert.strictEqual(su.isNewer("3.10.0", "3.9.9"), true);
  });
  it("major bump dominates", function () {
    assert.strictEqual(su.isNewer("4.0.0", "3.99.99"), true);
  });
  it("v-prefix on either side still compares", function () {
    assert.strictEqual(su.isNewer("v3.7.0", "3.6.2"), true);
  });
  it("unparseable version is never 'newer' (safe default)", function () {
    assert.strictEqual(su.isNewer("bad", "3.6.2"), false);
    assert.strictEqual(su.isNewer("3.7.0", "bad"), false);
  });
});

h.describe("plugin-self-update.isInstalledCacheCopy", function (it) {
  // isInstalledCacheCopy() reads the module's own PLUGIN_ROOT (the test
  // checkout), which has a .git — so it must report false here. This is the
  // dev-checkout guard that prevents the updater from clobbering a working tree.
  it("returns false from a dev checkout (has .git)", function () {
    assert.strictEqual(su.isInstalledCacheCopy(), false);
  });
});

h.describe("plugin-self-update.copyTree", function (it) {
  // Exercises the actual copy loop — catches runtime ReferenceErrors (e.g. the
  // v3.9.0 regression where a removed SYNCED_PREFIXES var was still referenced,
  // which `node -c` can't catch since it's not a syntax error).
  var fs = require("fs"), path = require("path"), os = require("os");
  var src = fs.mkdtempSync(path.join(os.tmpdir(), "cmc-ct-src-"));
  var dst = fs.mkdtempSync(path.join(os.tmpdir(), "cmc-ct-dst-"));
  fs.writeFileSync(path.join(src, "a.txt"), "hello");
  fs.mkdirSync(path.join(src, "sub"));
  fs.writeFileSync(path.join(src, "sub", "b.txt"), "world");
  fs.mkdirSync(path.join(src, ".git"));
  fs.writeFileSync(path.join(src, ".git", "x"), "skip me");

  it("copies a tree without throwing and skips COPY_SKIP entries", function () {
    su.copyTree(src, dst);
    assert.strictEqual(fs.readFileSync(path.join(dst, "a.txt"), "utf8"), "hello");
    assert.strictEqual(fs.readFileSync(path.join(dst, "sub", "b.txt"), "utf8"), "world");
    assert.ok(!fs.existsSync(path.join(dst, ".git")), ".git should be skipped");
  });
  it("(cleanup)", function () {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
    assert.ok(true);
  });
});

h.describe("plugin-self-update.detectMarketplaceOwner", function (it) {
  it("honors CMC_MARKETPLACE_OWNER override", function () {
    var prev = process.env.CMC_MARKETPLACE_OWNER;
    process.env.CMC_MARKETPLACE_OWNER = "explicit-owner";
    try {
      assert.strictEqual(su.detectMarketplaceOwner(), "explicit-owner");
    } finally {
      if (prev === undefined) delete process.env.CMC_MARKETPLACE_OWNER;
      else process.env.CMC_MARKETPLACE_OWNER = prev;
    }
  });
  it("derives a '-local' suffixed slug otherwise", function () {
    var prev = process.env.CMC_MARKETPLACE_OWNER;
    delete process.env.CMC_MARKETPLACE_OWNER;
    try {
      var owner = su.detectMarketplaceOwner();
      assert.ok(/-local$/.test(owner), "owner should end with -local, got: " + owner);
      assert.ok(/^[a-z0-9_-]+$/.test(owner), "owner should be sanitized, got: " + owner);
    } finally {
      if (prev !== undefined) process.env.CMC_MARKETPLACE_OWNER = prev;
    }
  });
});
