#!/usr/bin/env node
/**
 * build-installer.js - Generates a self-extracting install.js
 *
 * Collects all plugin files, base64-encodes them, and embeds them
 * into a single install.js that can be run with: node install.js
 *
 * The installer uses the marketplace system for proper command/skill discovery.
 */

"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var OUTPUT = path.join(ROOT, "install.js");

// Directories and files to include
var DIRS_TO_INCLUDE = ["scripts", "config", "commands", "agents", "skills", "hooks", ".claude-plugin"];
var FILES_TO_INCLUDE = ["README.md", "LICENSE", "CHANGELOG.md", "CLAUDE.md"];
// Exclude mutable/generated files
var EXCLUDE = [
  "logs/", "node_modules/", ".git/", "vscode-extension/",
  "install.js", "package.json", ".gitignore", "marketplace.json",
  // Auto-synced items (fetched at runtime by sync-external-skills.js
  // and sync-karpathy-skills.js). Only built-in items ship in the
  // bundle; every prefix below is gitignored and must NOT be embedded,
  // or the bundle balloons and reproducibility differs per dev machine.
  "skills/acs-", "skills/ecc-", "skills/od-", "skills/nlb-", "skills/karpathy-",
  "skills/sp-", "skills/rf-", "skills/rfp-", "skills/rfc-", "skills/obs-",
  "agents/ecc-", "agents/rf-", "agents/rfp-",
  "commands/ecc-", "commands/rf-", "commands/rfp-"
];

function shouldExclude(relPath) {
  for (var i = 0; i < EXCLUDE.length; i++) {
    if (relPath.indexOf(EXCLUDE[i]) !== -1) return true;
  }
  return false;
}

// Text file extensions whose line endings get normalized to LF before base64
// encoding. This guarantees the bundle is byte-identical regardless of which
// OS built it (Windows checkouts have CRLF; Linux has LF). Binary files are
// passed through unchanged.
var TEXT_EXTENSIONS = [".js", ".json", ".md", ".sh", ".ps1", ".bat", ".yml", ".yaml", ".txt", ".html", ".css"];

function isTextFile(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.indexOf(ext) !== -1) return true;
  // Files without extension (LICENSE, etc.) - treat as text by default
  if (ext === "") return true;
  return false;
}

// Returns { content: <base64>, size: <normalized-byte-length> }
// IMPORTANT: size MUST be the post-normalization length, NOT the on-disk
// stat.size. fs.statSync() reports the disk size (CRLF-aware on Windows,
// LF on Linux), which produces different bundles per OS even when the
// content is identical after normalization.
function readFileForBundle(filePath) {
  if (isTextFile(filePath)) {
    var text = fs.readFileSync(filePath, "utf8");
    text = text.replace(/\r\n/g, "\n");
    var buf = Buffer.from(text, "utf8");
    return { content: buf.toString("base64"), size: buf.length };
  }
  var raw = fs.readFileSync(filePath);
  return { content: raw.toString("base64"), size: raw.length };
}

function collectFiles(dir, base) {
  var results = [];
  if (!fs.existsSync(dir)) return results;
  // IMPORTANT: explicit sort. fs.readdirSync's order is OS-dependent
  // (Windows: alphabetical; Linux: directory-insertion). Without sort, the
  // bundle's embedded file order differs across platforms and the
  // reproducibility check fails.
  var entries = fs.readdirSync(dir).sort();
  for (var i = 0; i < entries.length; i++) {
    var fullPath = path.join(dir, entries[i]);
    var relPath = path.join(base, entries[i]).replace(/\\/g, "/");
    if (shouldExclude(relPath)) continue;
    var stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(collectFiles(fullPath, relPath));
    } else {
      var bundled = readFileForBundle(fullPath);
      results.push({
        path: relPath,
        content: bundled.content,
        size: bundled.size  // normalized byte length (cross-OS reproducible)
      });
    }
  }
  return results;
}

// Collect all files
var allFiles = [];
var totalSize = 0;

DIRS_TO_INCLUDE.forEach(function(d) {
  var dirPath = path.join(ROOT, d);
  if (fs.existsSync(dirPath)) {
    allFiles = allFiles.concat(collectFiles(dirPath, d));
  }
});

FILES_TO_INCLUDE.forEach(function(f) {
  var filePath = path.join(ROOT, f);
  if (fs.existsSync(filePath)) {
    var bundled = readFileForBundle(filePath);
    allFiles.push({
      path: f,
      content: bundled.content,
      size: bundled.size  // normalized byte length
    });
  }
});

allFiles.forEach(function(f) { totalSize += f.size; });

// Read plugin.json for version
var pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
var version = pluginJson.version || "0.0.0";

// Marketplace.json template - the `name` and `owner.name` fields are filled
// at install time from the runtime-detected marketplace owner. We embed a
// template here that the generated installer will customize per-machine.
var marketplaceJsonTemplate = {
  name: "__OWNER__",
  description: "Local marketplace for Claude Model Changer plugin",
  owner: { name: "__OWNER__" },
  plugins: [{
    name: "claude-model-changer",
    description: pluginJson.description || "Automatic model routing based on task complexity",
    source: "./plugins/claude-model-changer",
    category: "development"
  }]
};

// Build the installer source code as a string
var lines = [];
lines.push('#!/usr/bin/env node');
lines.push('/**');
lines.push(' * Claude Model Changer v' + version + ' - Self-Extracting Installer');
lines.push(' *');
lines.push(' * Usage:');
lines.push(' *   node install.js              # Install plugin');
lines.push(' *   node install.js --uninstall  # Remove plugin');
lines.push(' *');
// v3.6.2: Pin the banner to the plugin version (NOT the build date). Embedding
// `new Date()` made the bundle non-reproducible: a CI re-run on a different UTC
// day than the committed dist/install.js produced a different byte and failed
// the "bundle is reproducible" check. Version is already deterministic.
lines.push(' * Generated by build-installer.js for v' + version);
lines.push(' */');
lines.push('');
lines.push('"use strict";');
lines.push('');
lines.push('var fs = require("fs");');
lines.push('var path = require("path");');
lines.push('var crypto = require("crypto");');
lines.push('var childProcess = require("child_process");');
lines.push('');
lines.push('var PLUGIN_NAME = "claude-model-changer";');
lines.push('var PLUGIN_VERSION = "' + version + '";');
lines.push('');
lines.push('// ---- Marketplace owner detection (runtime, per-machine) ----');
lines.push('// Resolution order:');
lines.push('//   1. CMC_MARKETPLACE_OWNER env var (explicit override)');
lines.push('//   2. <lowercase-sanitized-username>-local');
lines.push('//   3. "user-local" if no username detectable');
lines.push('function detectMarketplaceOwner() {');
lines.push('  if (process.env.CMC_MARKETPLACE_OWNER) return process.env.CMC_MARKETPLACE_OWNER;');
lines.push('  var u = process.env.USER || process.env.USERNAME ||');
lines.push('          (process.env.USERPROFILE ? path.basename(process.env.USERPROFILE) : "") ||');
lines.push('          (process.env.HOME ? path.basename(process.env.HOME) : "") || "user";');
lines.push('  var s = u.toLowerCase().replace(/[^a-z0-9_-]/g, "");');
lines.push('  return (s || "user") + "-local";');
lines.push('}');
lines.push('var MARKETPLACE_NAME = detectMarketplaceOwner();');
lines.push('var MARKETPLACE_OWNER_SOURCE = process.env.CMC_MARKETPLACE_OWNER');
lines.push('  ? "CMC_MARKETPLACE_OWNER env" : "auto-detected from username";');
lines.push('var PLUGIN_KEY = PLUGIN_NAME + "@" + MARKETPLACE_NAME;');
lines.push('var LEGACY_PLUGIN_KEY = PLUGIN_NAME + "@local";  // legacy from buggy installs');
lines.push('var FILE_COUNT = ' + allFiles.length + ';');
lines.push('');
lines.push('// ---- Embedded files (base64) ----');
lines.push('var FILES = ' + JSON.stringify(allFiles) + ';');
lines.push('');
lines.push('// Marketplace JSON template - placeholders replaced at install time');
lines.push('var MARKETPLACE_JSON_TEMPLATE = ' + JSON.stringify(marketplaceJsonTemplate) + ';');
lines.push('function buildMarketplaceJson() {');
lines.push('  var t = JSON.parse(JSON.stringify(MARKETPLACE_JSON_TEMPLATE));');
lines.push('  t.name = MARKETPLACE_NAME;');
lines.push('  t.owner.name = MARKETPLACE_NAME;');
lines.push('  return JSON.stringify(t, null, 2);');
lines.push('}');
lines.push('');
lines.push('// ---- Utility functions ----');
lines.push('');
lines.push('function getClaudeDir() {');
lines.push('  var home = process.env.HOME || process.env.USERPROFILE;');
lines.push('  return path.join(home, ".claude");');
lines.push('}');
lines.push('');
lines.push('function mkdirp(dir) {');
lines.push('  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }');
lines.push('}');
lines.push('');
lines.push('function rmrf(dir) {');
lines.push('  if (!fs.existsSync(dir)) return;');
lines.push('  var entries = fs.readdirSync(dir);');
lines.push('  for (var i = 0; i < entries.length; i++) {');
lines.push('    var p = path.join(dir, entries[i]);');
lines.push('    if (fs.statSync(p).isDirectory()) { rmrf(p); } else { fs.unlinkSync(p); }');
lines.push('  }');
lines.push('  fs.rmdirSync(dir);');
lines.push('}');
lines.push('');
lines.push('function sha256(filePath) {');
lines.push('  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");');
lines.push('}');
lines.push('');
lines.push('function runCli(args) {');
lines.push('  try {');
lines.push('    var result = childProcess.execFileSync("claude", args.split(" "), {');
lines.push('      encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"]');
lines.push('    });');
lines.push('    return { ok: true, output: result.trim() };');
lines.push('  } catch (e) {');
lines.push('    return { ok: false, output: (e.stderr || e.message || "").trim() };');
lines.push('  }');
lines.push('}');
lines.push('');
lines.push('function log(msg) { console.log("[install] " + msg); }');
lines.push('function logOk(msg) { console.log("[install] \\u2714 " + msg); }');
lines.push('function logErr(msg) { console.error("[install] \\u2718 " + msg); }');
lines.push('');
lines.push('// ---- Install ----');
lines.push('');
lines.push('function install() {');
lines.push('  console.log("");');
lines.push('  console.log("  Claude Model Changer v" + PLUGIN_VERSION);');
lines.push('  console.log("  ===================================");');
lines.push('  console.log("  Automatic model routing for Claude Code");');
lines.push('  console.log("  Files: " + FILE_COUNT + " | Marketplace: " + MARKETPLACE_NAME + " (" + MARKETPLACE_OWNER_SOURCE + ")");');
lines.push('  console.log("");');
lines.push('');
lines.push('  var claudeDir = getClaudeDir();');
lines.push('  if (!fs.existsSync(claudeDir)) {');
lines.push('    logErr("Claude Code directory not found: " + claudeDir);');
lines.push('    logErr("Install Claude Code first: https://claude.ai/download");');
lines.push('    process.exit(1);');
lines.push('  }');
lines.push('');
lines.push('  // Step 1: Create marketplace structure');
lines.push('  log("Creating marketplace structure...");');
lines.push('  var marketplaceDir = path.join(claudeDir, "plugins", "marketplaces", MARKETPLACE_NAME);');
lines.push('  var pluginDir = path.join(marketplaceDir, "plugins", PLUGIN_NAME);');
lines.push('  mkdirp(path.join(marketplaceDir, ".claude-plugin"));');
lines.push('  mkdirp(pluginDir);');
lines.push('  fs.writeFileSync(path.join(marketplaceDir, ".claude-plugin", "marketplace.json"), buildMarketplaceJson());');
lines.push('  logOk("Marketplace created");');
lines.push('');
lines.push('  // Step 2: Extract plugin files');
lines.push('  log("Extracting " + FILE_COUNT + " plugin files...");');
lines.push('  var extracted = 0;');
lines.push('  FILES.forEach(function(f) {');
lines.push('    var destPath = path.join(pluginDir, f.path);');
lines.push('    mkdirp(path.dirname(destPath));');
lines.push('    fs.writeFileSync(destPath, Buffer.from(f.content, "base64"));');
lines.push('    extracted++;');
lines.push('  });');
lines.push('  mkdirp(path.join(pluginDir, "logs"));');
lines.push('  logOk("Extracted " + extracted + " files");');
lines.push('');
lines.push('  // Step 3: Try CLI-based installation');
lines.push('  log("Registering via CLI...");');
lines.push('  var cliOk = runCli("--version").ok;');
lines.push('  var installed = false;');
lines.push('');
lines.push('  if (cliOk) {');
lines.push('    runCli("plugin marketplace add " + marketplaceDir);');
lines.push('    var r = runCli("plugin install " + PLUGIN_KEY);');
lines.push('    if (r.ok || r.output.indexOf("already") !== -1) {');
lines.push('      logOk("Plugin installed via CLI");');
lines.push('      installed = true;');
lines.push('    }');
lines.push('  }');
lines.push('');
lines.push('  if (!installed) {');
lines.push('    log("CLI not available, using manual registration...");');
lines.push('    manualRegister(claudeDir);');
lines.push('  }');
lines.push('');
lines.push('  // Step 4: Generate manifest');
lines.push('  log("Generating file integrity manifest...");');
lines.push('  var cacheDir = path.join(claudeDir, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION);');
lines.push('  var sourceDir = fs.existsSync(cacheDir) ? cacheDir : pluginDir;');
lines.push('  var manifestDir = path.join(claudeDir, "plugins", ".install-manifests");');
lines.push('  mkdirp(manifestDir);');
lines.push('  var manifest = { pluginId: PLUGIN_KEY, createdAt: new Date().toISOString(), files: {} };');
lines.push('  FILES.forEach(function(f) {');
lines.push('    var fp = path.join(sourceDir, f.path);');
lines.push('    if (fs.existsSync(fp)) { manifest.files[f.path.replace(/\\//g, "\\\\\\\\")] = sha256(fp); }');
lines.push('  });');
lines.push('  fs.writeFileSync(path.join(manifestDir, PLUGIN_KEY + ".json"), JSON.stringify(manifest, null, 2));');
lines.push('  logOk("Manifest: " + Object.keys(manifest.files).length + " file hashes");');
lines.push('');
lines.push('  console.log("");');
lines.push('  console.log("  \\u2714 Installation complete!");');
lines.push('  console.log("  Restart Claude Code to activate.");');
lines.push('  console.log("");');
lines.push('  console.log("  Commands: /stats /configure /complexity /benchmark /dashboard /tune /rate");');
lines.push('  console.log("  Override: @haiku @sonnet @opus");');
lines.push('  console.log("  Auto-routing is active on every prompt.");');
lines.push('  console.log("");');
lines.push('}');
lines.push('');
lines.push('// v3.6.1: Remove orphan version directories from prior installs.');
lines.push('// Each install lives under .../<MARKETPLACE>/<PLUGIN_NAME>/<VERSION>/ —');
lines.push('// older versions were never cleaned up, so 3.4.2, 3.5.0, 3.6.0 would');
lines.push('// accumulate side-by-side and waste a few MB per release. This sweeps');
lines.push('// everything in the parent dir except the version we are installing.');
lines.push('// External skill cache (cache/<owner>/external/) is intentionally');
lines.push('// untouched — it lives in a different parent and is shared across');
lines.push('// versions for the smart-skip sync logic.');
lines.push('function cleanupOldVersions(cacheDir) {');
lines.push('  var parent = path.dirname(cacheDir);');
lines.push('  if (!fs.existsSync(parent)) return;');
lines.push('  var entries;');
lines.push('  try { entries = fs.readdirSync(parent); } catch (e) { return; }');
lines.push('  var removed = 0;');
lines.push('  for (var i = 0; i < entries.length; i++) {');
lines.push('    var name = entries[i];');
lines.push('    if (name === PLUGIN_VERSION) continue;');
lines.push('    // Only touch entries that look like SemVer version dirs to be safe.');
lines.push('    if (!/^\\d+\\.\\d+\\.\\d+([.\\-+].*)?$/.test(name)) continue;');
lines.push('    var p = path.join(parent, name);');
lines.push('    try {');
lines.push('      if (fs.statSync(p).isDirectory()) {');
lines.push('        rmrf(p);');
lines.push('        logOk("Removed orphan v" + name);');
lines.push('        removed++;');
lines.push('      }');
lines.push('    } catch (e) { /* skip on permission error etc. */ }');
lines.push('  }');
lines.push('  if (removed === 0) return;');
lines.push('  // Also prune stale entries from installed_plugins.json that point to');
lines.push('  // the now-deleted version dirs (same plugin, different version).');
lines.push('  try {');
lines.push('    var pfPath = path.join(getClaudeDir(), "plugins", "installed_plugins.json");');
lines.push('    if (!fs.existsSync(pfPath)) return;');
lines.push('    var pdRaw = JSON.parse(fs.readFileSync(pfPath, "utf8"));');
lines.push('    if (!pdRaw.plugins || !pdRaw.plugins[PLUGIN_KEY]) return;');
lines.push('    pdRaw.plugins[PLUGIN_KEY] = pdRaw.plugins[PLUGIN_KEY].filter(function (e) {');
lines.push('      return e && e.version === PLUGIN_VERSION;');
lines.push('    });');
lines.push('    fs.writeFileSync(pfPath, JSON.stringify(pdRaw, null, 2));');
lines.push('  } catch (e) { /* never block install on bookkeeping */ }');
lines.push('}');
lines.push('');
lines.push('function manualRegister(claudeDir) {');
lines.push('  var cacheDir = path.join(claudeDir, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION);');
lines.push('  cleanupOldVersions(cacheDir);');
lines.push('  mkdirp(cacheDir);');
lines.push('  FILES.forEach(function(f) {');
lines.push('    var dp = path.join(cacheDir, f.path);');
lines.push('    mkdirp(path.dirname(dp));');
lines.push('    fs.writeFileSync(dp, Buffer.from(f.content, "base64"));');
lines.push('  });');
lines.push('  mkdirp(path.join(cacheDir, "logs"));');
lines.push('  fs.writeFileSync(path.join(cacheDir, ".cli-installed"), new Date().toISOString() + "\\n");');
lines.push('  fs.writeFileSync(path.join(cacheDir, ".install-version"),');
lines.push('    JSON.stringify({ version: PLUGIN_VERSION, bun: null, uv: null, installedAt: new Date().toISOString() }));');
lines.push('');
lines.push('  var pf = path.join(claudeDir, "plugins", "installed_plugins.json");');
lines.push('  var pd = { version: 2, plugins: {} };');
lines.push('  try { if (fs.existsSync(pf)) pd = JSON.parse(fs.readFileSync(pf, "utf8")); } catch(e) {}');
lines.push('  if (!pd.plugins) pd.plugins = {};');
lines.push('  pd.plugins[PLUGIN_KEY] = [{ scope: "user", installPath: cacheDir, version: PLUGIN_VERSION,');
lines.push('    installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }];');
lines.push('  // Migrate: drop legacy "@local" entry from older buggy installs');
lines.push('  if (LEGACY_PLUGIN_KEY !== PLUGIN_KEY && pd.plugins[LEGACY_PLUGIN_KEY]) {');
lines.push('    delete pd.plugins[LEGACY_PLUGIN_KEY];');
lines.push('    logOk("Removed legacy " + LEGACY_PLUGIN_KEY + " entry");');
lines.push('  }');
lines.push('  mkdirp(path.dirname(pf));');
lines.push('  fs.writeFileSync(pf, JSON.stringify(pd, null, 2));');
lines.push('');
lines.push('  var sf = path.join(claudeDir, "settings.json");');
lines.push('  var s = {};');
lines.push('  try { if (fs.existsSync(sf)) s = JSON.parse(fs.readFileSync(sf, "utf8")); } catch(e) {}');
lines.push('  if (!s.enabledPlugins) s.enabledPlugins = {};');
lines.push('  s.enabledPlugins[PLUGIN_KEY] = true;');
lines.push('  if (LEGACY_PLUGIN_KEY !== PLUGIN_KEY && s.enabledPlugins[LEGACY_PLUGIN_KEY]) {');
lines.push('    delete s.enabledPlugins[LEGACY_PLUGIN_KEY];');
lines.push('  }');
lines.push('  // v3.7.1: wire the terminal statusline so the routed model / context% /');
lines.push('  // quota% / cost show in the Claude Code status bar. Absolute path to this');
lines.push('  // install (CLAUDE_PLUGIN_ROOT is not reliably expanded in a statusLine');
lines.push('  // command); kept current by plugin-self-update.js on each version change.');
lines.push('  // Conservative: only set if absent or already ours — a custom statusLine');
lines.push('  // is left untouched.');
lines.push('  try {');
lines.push('    var existingSL = s.statusLine;');
lines.push('    var slIsOurs = existingSL && existingSL.command &&');
lines.push('      existingSL.command.indexOf("statusline.js") !== -1 &&');
lines.push('      existingSL.command.indexOf("claude-model-changer") !== -1;');
lines.push('    if (!existingSL || slIsOurs) {');
lines.push('      s.statusLine = { type: "command", command: "node \\"" + cacheDir.replace(/\\\\/g, "/") + "/scripts/statusline.js\\"" };');
lines.push('      logOk("Configured terminal statusLine");');
lines.push('    } else {');
lines.push('      logOk("Custom statusLine present - left untouched");');
lines.push('    }');
lines.push('  } catch (e) { /* statusLine is best-effort */ }');
lines.push('  fs.writeFileSync(sf, JSON.stringify(s, null, 2));');
lines.push('  logOk("Manual registration complete");');
lines.push('}');
lines.push('');
lines.push('// ---- Uninstall ----');
lines.push('');
lines.push('function uninstall() {');
lines.push('  console.log("");');
lines.push('  console.log("  Claude Model Changer - Uninstaller");');
lines.push('  console.log("  ===================================");');
lines.push('  console.log("");');
lines.push('  var claudeDir = getClaudeDir();');
lines.push('  if (runCli("--version").ok) {');
lines.push('    runCli("plugin uninstall " + PLUGIN_KEY);');
lines.push('    logOk("Plugin uninstalled via CLI");');
lines.push('  }');
lines.push('  var cd = path.join(claudeDir, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME);');
lines.push('  if (fs.existsSync(cd)) { rmrf(cd); logOk("Removed cache"); }');
lines.push('  var mp = path.join(claudeDir, "plugins", "marketplaces", MARKETPLACE_NAME, "plugins", PLUGIN_NAME);');
lines.push('  if (fs.existsSync(mp)) { rmrf(mp); logOk("Removed marketplace copy"); }');
lines.push('  var mf = path.join(claudeDir, "plugins", ".install-manifests", PLUGIN_KEY + ".json");');
lines.push('  if (fs.existsSync(mf)) { fs.unlinkSync(mf); logOk("Removed manifest"); }');
lines.push('  try {');
lines.push('    var pf = path.join(claudeDir, "plugins", "installed_plugins.json");');
lines.push('    if (fs.existsSync(pf)) {');
lines.push('      var pd = JSON.parse(fs.readFileSync(pf, "utf8"));');
lines.push('      if (pd.plugins) { delete pd.plugins[PLUGIN_KEY]; delete pd.plugins[PLUGIN_NAME + "@local"]; }');
lines.push('      fs.writeFileSync(pf, JSON.stringify(pd, null, 2));');
lines.push('    }');
lines.push('  } catch(e) {}');
lines.push('  try {');
lines.push('    var sf = path.join(claudeDir, "settings.json");');
lines.push('    if (fs.existsSync(sf)) {');
lines.push('      var s = JSON.parse(fs.readFileSync(sf, "utf8"));');
lines.push('      if (s.enabledPlugins) { delete s.enabledPlugins[PLUGIN_KEY]; delete s.enabledPlugins[PLUGIN_NAME + "@local"]; }');
lines.push('      fs.writeFileSync(sf, JSON.stringify(s, null, 2));');
lines.push('    }');
lines.push('  } catch(e) {}');
lines.push('  console.log("");');
lines.push('  logOk("Uninstall complete. Restart Claude Code.");');
lines.push('  console.log("");');
lines.push('}');
lines.push('');
lines.push('if (process.argv.indexOf("--uninstall") !== -1) { uninstall(); } else { install(); }');

fs.writeFileSync(OUTPUT, lines.join("\n"));
var outputStat = fs.statSync(OUTPUT);
console.log("[build] Generated: install.js");
console.log("[build] Size: " + Math.round(outputStat.size / 1024) + " KB");
console.log("[build] Files embedded: " + allFiles.length);
console.log("[build] Source size: " + Math.round(totalSize / 1024) + " KB");
console.log("");
console.log("[build] Usage:");
console.log("  node install.js              # Install plugin");
console.log("  node install.js --uninstall  # Remove plugin");
