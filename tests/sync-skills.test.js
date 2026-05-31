"use strict";

/**
 * Tests for scripts/sync-external-skills.js — pure config/path logic and the
 * .md walker (the frontmatter filter that keeps doc files from masquerading
 * as agents/commands).
 */

var h = require("./harness");
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var sync = require("../scripts/sync-external-skills");

h.describe("sync.resolvePluginRoot", function (it) {
  it("strips a trailing /skills (legacy v3.5.0 caller convention)", function () {
    var got = sync.resolvePluginRoot(path.join("/some", "plugin", "skills"));
    assert.strictEqual(path.basename(got), "plugin");
  });
  it("leaves a non-skills path as the plugin root", function () {
    var got = sync.resolvePluginRoot(path.join("/some", "plugin"));
    assert.strictEqual(path.basename(got), "plugin");
  });
  it("returns null for empty arg", function () {
    assert.strictEqual(sync.resolvePluginRoot(null), null);
  });
});

h.describe("sync.getRepoSources", function (it) {
  it("passes through an explicit sources array, defaulting kind to skill", function () {
    var repo = { name: "r", sources: [{ layout: "subfolder", skillsPath: "skills" }, { kind: "agent", layout: "flat-md", skillsPath: "agents" }] };
    var srcs = sync.getRepoSources(repo);
    assert.strictEqual(srcs.length, 2);
    assert.strictEqual(srcs[0].kind, "skill");
    assert.strictEqual(srcs[1].kind, "agent");
  });
  it("synthesizes a single skill source from the legacy flat format", function () {
    var repo = { name: "r", layout: "root-multi" };
    var srcs = sync.getRepoSources(repo);
    assert.strictEqual(srcs.length, 1);
    assert.strictEqual(srcs[0].kind, "skill");
    assert.strictEqual(srcs[0].layout, "root-multi");
  });
});

h.describe("sync.walkMdFiles", function (it) {
  // Build a small fixture tree in a temp dir.
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "cmc-walk-"));
  fs.writeFileSync(path.join(root, "real-agent.md"), "---\nname: a\n---\nbody");
  fs.writeFileSync(path.join(root, "doc-table.md"), "# Capability Matrix\n\n| a | b |\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Readme");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "nested-agent.md"), "---\nname: n\n---\nx");
  fs.writeFileSync(path.join(root, "sub", "nested-doc.md"), "no frontmatter here");

  it("non-recursive lists only top-level .md (minus repo docs)", function () {
    var names = sync.walkMdFiles(root, false, false).map(function (m) { return m.relPath; }).sort();
    assert.deepStrictEqual(names, ["doc-table.md", "real-agent.md"]);
  });

  it("requireFrontmatter keeps only files starting with ---", function () {
    var names = sync.walkMdFiles(root, false, true).map(function (m) { return m.relPath; }).sort();
    assert.deepStrictEqual(names, ["real-agent.md"]);
  });

  it("recursive walks subdirs and prefixes relPath with the subdir", function () {
    var names = sync.walkMdFiles(root, true, true).map(function (m) { return m.relPath; }).sort();
    assert.deepStrictEqual(names, ["real-agent.md", "sub/nested-agent.md"]);
  });

  it("recursive without frontmatter filter includes doc files too", function () {
    var names = sync.walkMdFiles(root, true, false).map(function (m) { return m.relPath; }).sort();
    assert.deepStrictEqual(names, ["doc-table.md", "real-agent.md", "sub/nested-agent.md", "sub/nested-doc.md"]);
  });

  // Cleanup
  it("(cleanup fixture)", function () {
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!fs.existsSync(root));
  });
});

h.describe("sync.getCacheRoot", function (it) {
  it("ends with /external under the marketplace owner", function () {
    var cr = sync.getCacheRoot().replace(/\\/g, "/");
    assert.ok(/\/plugins\/cache\/[^/]+\/external$/.test(cr), "got: " + cr);
  });
});

h.describe("sync.readItemName (agent identity)", function (it) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmc-rin-"));
  it("reads frontmatter name", function () {
    var f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: architect\ndescription: x\n---\nbody");
    assert.strictEqual(sync.readItemName(f, "a.md"), "architect");
  });
  it("falls back to filename without .md when no frontmatter name", function () {
    var f = path.join(dir, "b.md");
    fs.writeFileSync(f, "# no frontmatter");
    assert.strictEqual(sync.readItemName(f, "b.md"), "b");
  });
  it("(cleanup)", function () { fs.rmSync(dir, { recursive: true, force: true }); assert.ok(true); });
});

h.describe("sync.reconcile (manifest-based prune)", function (it) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "cmc-recon-"));
  ["skills", "agents", "commands"].forEach(function (d) { fs.mkdirSync(path.join(root, d)); });
  // Built-ins (never in a manifest → must survive)
  fs.mkdirSync(path.join(root, "skills", "model-router"));
  fs.writeFileSync(path.join(root, "agents", "haiku-worker.md"), "x");
  fs.writeFileSync(path.join(root, "commands", "stats.md"), "x");
  // Synced items: one still wanted, one now-disabled, one deleted-upstream
  fs.mkdirSync(path.join(root, "skills", "color-expert"));      // active
  fs.mkdirSync(path.join(root, "skills", "python-patterns"));   // disabled repo
  fs.writeFileSync(path.join(root, "agents", "architect.md"), "x"); // deleted upstream

  var oldManifest = {
    "open-design": { skill: ["color-expert"] },
    "everything-claude-code": { skill: ["python-patterns"], agent: ["architect.md"] }
  };
  var newManifest = {
    "open-design": { skill: ["color-expert"] }
    // ecc gone (disabled) → its items must be removed
  };
  var removed = sync.reconcile(root, oldManifest, newManifest);

  it("removes items no longer in the new manifest", function () {
    assert.strictEqual(removed, 2); // python-patterns + architect.md
    assert.ok(!fs.existsSync(path.join(root, "skills", "python-patterns")));
    assert.ok(!fs.existsSync(path.join(root, "agents", "architect.md")));
  });
  it("keeps active synced items", function () {
    assert.ok(fs.existsSync(path.join(root, "skills", "color-expert")));
  });
  it("never touches built-ins (not in any manifest)", function () {
    assert.ok(fs.existsSync(path.join(root, "skills", "model-router")));
    assert.ok(fs.existsSync(path.join(root, "agents", "haiku-worker.md")));
    assert.ok(fs.existsSync(path.join(root, "commands", "stats.md")));
  });
  it("(cleanup fixture)", function () {
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!fs.existsSync(root));
  });
});
