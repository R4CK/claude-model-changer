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
    var repo = { name: "r", layout: "root-multi", destPrefix: "x-" };
    var srcs = sync.getRepoSources(repo);
    assert.strictEqual(srcs.length, 1);
    assert.strictEqual(srcs[0].kind, "skill");
    assert.strictEqual(srcs[0].layout, "root-multi");
    assert.strictEqual(srcs[0].destPrefix, "x-");
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

h.describe("sync.ownedPrefixes", function (it) {
  it("collects destPrefix from each source", function () {
    var repo = { name: "ruflo", sources: [
      { kind: "skill", destPrefix: "rf-" },
      { kind: "agent", destPrefix: "rf-" },
      { kind: "skill", destPrefix: "rfp-" }
    ] };
    assert.deepStrictEqual(sync.ownedPrefixes(repo).sort(), ["rf-", "rfp-"]);
  });
  it("derives a leading prefix from destFolderName", function () {
    var repo = { name: "x", sources: [{ kind: "skill", layout: "root-single", destFolderName: "nlb-ui-ux-pro-max" }] };
    assert.deepStrictEqual(sync.ownedPrefixes(repo), ["nlb-"]);
  });
});

h.describe("sync.pruneInactive", function (it) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "cmc-prune-"));
  ["skills", "agents", "commands"].forEach(function (d) { fs.mkdirSync(path.join(root, d)); });
  // Built-in (must survive) + active repo item + disabled repo item.
  fs.mkdirSync(path.join(root, "skills", "model-router"));
  fs.mkdirSync(path.join(root, "skills", "od-color-expert"));     // active (open-design enabled)
  fs.mkdirSync(path.join(root, "skills", "ecc-python-patterns"));  // disabled (ecc off)
  fs.writeFileSync(path.join(root, "agents", "haiku-worker.md"), "x");   // built-in
  fs.writeFileSync(path.join(root, "agents", "ecc-architect.md"), "x");  // disabled
  fs.writeFileSync(path.join(root, "commands", "stats.md"), "x");        // built-in
  fs.writeFileSync(path.join(root, "commands", "rf-foo.md"), "x");       // disabled (ruflo off)

  var cfg = { repos: [
    { name: "open-design", enabled: true, sources: [{ kind: "skill", destPrefix: "od-" }] },
    { name: "everything-claude-code", enabled: false, sources: [{ kind: "skill", destPrefix: "ecc-" }] },
    { name: "ruflo", enabled: false, sources: [{ kind: "skill", destPrefix: "rf-" }, { kind: "skill", destPrefix: "rfp-" }] }
  ] };

  var removed = sync.pruneInactive(root, cfg);

  it("removes the right number of inactive items", function () {
    assert.strictEqual(removed, 3); // ecc-python-patterns, ecc-architect.md, rf-foo.md
  });
  it("keeps built-in items (model-router, haiku-worker, stats)", function () {
    assert.ok(fs.existsSync(path.join(root, "skills", "model-router")), "model-router removed!");
    assert.ok(fs.existsSync(path.join(root, "agents", "haiku-worker.md")), "haiku-worker removed!");
    assert.ok(fs.existsSync(path.join(root, "commands", "stats.md")), "stats.md removed!");
  });
  it("keeps active-repo items (od-)", function () {
    assert.ok(fs.existsSync(path.join(root, "skills", "od-color-expert")), "active od- item removed!");
  });
  it("removes disabled-repo items (ecc-, rf-)", function () {
    assert.ok(!fs.existsSync(path.join(root, "skills", "ecc-python-patterns")));
    assert.ok(!fs.existsSync(path.join(root, "agents", "ecc-architect.md")));
    assert.ok(!fs.existsSync(path.join(root, "commands", "rf-foo.md")));
  });
  it("(cleanup fixture)", function () {
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!fs.existsSync(root));
  });
});
