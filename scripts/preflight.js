#!/usr/bin/env node

/**
 * Claude Model Changer - Preflight Check
 *
 * Validates all prerequisites BEFORE installation.
 * Used by:
 *  - install.sh / install.ps1 / install.bat (mandatory pre-install gate)
 *  - Manual invocation: `node scripts/preflight.js`
 *  - Runtime self-check (--runtime mode, lightweight subset)
 *
 * Exit codes:
 *   0 = all fatal checks passed
 *   1 = one or more fatal checks failed
 *
 * CLI flags:
 *   --quiet    : suppress per-check output, only summary
 *   --json     : emit JSON result instead of human-readable text
 *   --runtime  : runtime mode (skips claude CLI / hook dry-run for speed)
 */

"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var MIN_NODE_MAJOR = 16; // matches package.json engines
var PLUGIN_ROOT = path.resolve(__dirname, "..");

var args = process.argv.slice(2);
var QUIET   = args.indexOf("--quiet")   !== -1;
var JSON_OUT= args.indexOf("--json")    !== -1;
var RUNTIME = args.indexOf("--runtime") !== -1;

// Detect CI environment. In CI we validate the source tree's integrity, but
// skip checks that require an actual Claude Code installation on the runner
// (~/.claude directory, `claude` CLI on PATH, hook dry-run that needs them).
var CI = (process.env.CI === "true") ||
         (process.env.GITHUB_ACTIONS === "true") ||
         (process.env.RUNNER_OS !== undefined) ||
         (args.indexOf("--ci") !== -1);

var results = [];

function add(name, ok, detail, fatal) {
  results.push({
    name: name,
    ok: !!ok,
    detail: detail || "",
    fatal: fatal !== false
  });
}

function log(line) {
  if (QUIET || JSON_OUT) return;
  process.stderr.write(line + "\n");
}

// ---- Required artifacts (mirrors package.json `files` + actual hook references) ----

var REQUIRED_FILES = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "package.json",
  // Scripts referenced directly by hooks/hooks.json
  "scripts/analyze-complexity.js",
  "scripts/enforce-stats.js",
  "scripts/detect-fallback.js",
  // Core supporting scripts
  "scripts/session-utils.js",
  "scripts/log-subagent.js",
  "scripts/generate-dashboard.js",
  "scripts/live-dashboard.js",
  "scripts/install-plugin.js",
  "scripts/uninstall-plugin.js",
  // lib/ modules required by the hook scripts
  "scripts/lib/config.js",
  "scripts/lib/scoring.js",
  "scripts/lib/session.js",
  "scripts/lib/stats.js",
  "scripts/lib/io.js",
  "scripts/lib/health.js",
  "scripts/lib/context-monitor.js",
  // Config files
  "config/task-routing.json",
  "config/patterns.json"
];

var REQUIRED_DIRS = [
  "agents",
  "commands",
  "skills",
  "config",
  "hooks",
  "scripts",
  "scripts/lib",
  ".claude-plugin"
];

var JSON_FILES = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "config/task-routing.json",
  "config/patterns.json",
  "package.json"
];

// ---- Individual checks ----

function checkNode() {
  var v = process.versions.node;
  var major = parseInt(v.split(".")[0], 10);
  if (isNaN(major)) {
    add("Node.js version", false, "could not parse version: " + v);
    return;
  }
  if (major < MIN_NODE_MAJOR) {
    add("Node.js version", false,
      "found v" + v + ", need >= " + MIN_NODE_MAJOR + ".0.0");
    return;
  }
  add("Node.js version", true, "v" + v);
}

function checkClaudeCli() {
  try {
    var out = cp.execFileSync("claude", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000
    });
    add("Claude Code CLI", true, String(out).trim());
  } catch (err) {
    // Non-fatal: install-plugin.js can run without `claude` on PATH; CLI is
    // only needed at runtime to actually use the plugin.
    add("Claude Code CLI", false,
      "`claude --version` failed - install Claude Code before using the plugin",
      false);
  }
}

function checkClaudeHomeDir() {
  // The plugin installs into ~/.claude/plugins/cache/<owner>/<plugin>/<version>/
  // The ~/.claude directory must exist (it's created by Claude Code on first run).
  // In CI this is skipped because the runner doesn't have Claude Code installed -
  // CI's job is to validate the SOURCE TREE, not to fully install the plugin.
  if (CI) {
    add("Central .claude directory", true,
      "skipped in CI (no local Claude Code install on runner)", false);
    return;
  }
  var home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    add("Central .claude directory", false,
      "neither $HOME nor %USERPROFILE% is set - cannot locate user home");
    return;
  }
  var claudeDir = path.join(home, ".claude");
  if (!fs.existsSync(claudeDir)) {
    add("Central .claude directory", false,
      "not found at " + claudeDir + " - run Claude Code at least once first");
    return;
  }
  // Try to ensure plugins/ subtree is writable (will be created if absent)
  try {
    var pluginsDir = path.join(claudeDir, "plugins");
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }
    var probe = path.join(pluginsDir, ".write-probe");
    fs.writeFileSync(probe, "probe");
    fs.unlinkSync(probe);
    add("Central .claude directory", true, claudeDir + " (writable)");
  } catch (err) {
    add("Central .claude directory", false,
      "found at " + claudeDir + " but plugins/ is not writable: " + err.message);
  }
}

function checkInstallerPresent() {
  // The install scripts delegate the actual cache copy + registration to
  // scripts/install-plugin.js. It MUST exist or we cannot install.
  var p = path.join(PLUGIN_ROOT, "scripts", "install-plugin.js");
  if (!fs.existsSync(p)) {
    add("install-plugin.js present", false, "missing: " + p);
  } else {
    add("install-plugin.js present", true, p);
  }
}

function checkMarketplaceOwner() {
  // Mirror the same detection logic as install-plugin.js so the user sees
  // up-front which owner namespace will be used.
  var owner;
  var source;
  if (process.env.CMC_MARKETPLACE_OWNER) {
    owner = process.env.CMC_MARKETPLACE_OWNER;
    source = "from CMC_MARKETPLACE_OWNER env";
  } else {
    var user = process.env.USER ||
               process.env.USERNAME ||
               (process.env.USERPROFILE ? path.basename(process.env.USERPROFILE) : "") ||
               (process.env.HOME ? path.basename(process.env.HOME) : "") ||
               "user";
    var slug = user.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!slug) slug = "user";
    owner = slug + "-local";
    source = "auto-detected from username '" + user + "'";
  }
  // This is purely informational - never fails.
  add("Marketplace owner", true, owner + " (" + source + ")", false);
}

function checkRequiredDirs() {
  var missing = [];
  for (var i = 0; i < REQUIRED_DIRS.length; i++) {
    var full = path.join(PLUGIN_ROOT, REQUIRED_DIRS[i]);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      missing.push(REQUIRED_DIRS[i]);
    }
  }
  if (missing.length) {
    add("Required directories", false, "missing: " + missing.join(", "));
  } else {
    add("Required directories", true, REQUIRED_DIRS.length + " present");
  }
}

function checkRequiredFiles() {
  var missing = [];
  for (var i = 0; i < REQUIRED_FILES.length; i++) {
    var full = path.join(PLUGIN_ROOT, REQUIRED_FILES[i]);
    if (!fs.existsSync(full)) missing.push(REQUIRED_FILES[i]);
  }
  if (missing.length) {
    add("Required files", false, "missing (" + missing.length + "): " + missing.slice(0, 5).join(", ") + (missing.length > 5 ? ", ..." : ""));
  } else {
    add("Required files", true, REQUIRED_FILES.length + " present");
  }
}

function checkJsonValid() {
  var bad = [];
  for (var i = 0; i < JSON_FILES.length; i++) {
    var full = path.join(PLUGIN_ROOT, JSON_FILES[i]);
    if (!fs.existsSync(full)) continue;
    try {
      JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      bad.push(JSON_FILES[i] + " (" + err.message + ")");
    }
  }
  if (bad.length) {
    add("JSON validity", false, bad.join("; "));
  } else {
    add("JSON validity", true, JSON_FILES.length + " files parse cleanly");
  }
}

function checkHooksReference() {
  // Cross-check: every script referenced from hooks/hooks.json must exist
  var hooksPath = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
  if (!fs.existsSync(hooksPath)) {
    add("Hook script references", false, "hooks/hooks.json missing", false);
    return;
  }
  try {
    var raw = fs.readFileSync(hooksPath, "utf8");
    // Find all references like "scripts/something.js"
    var matches = raw.match(/scripts\/[A-Za-z0-9_-]+\.js/g) || [];
    var unique = [];
    for (var i = 0; i < matches.length; i++) {
      if (unique.indexOf(matches[i]) === -1) unique.push(matches[i]);
    }
    var missing = [];
    for (var j = 0; j < unique.length; j++) {
      if (!fs.existsSync(path.join(PLUGIN_ROOT, unique[j]))) {
        missing.push(unique[j]);
      }
    }
    if (missing.length) {
      add("Hook script references", false, "hooks reference missing scripts: " + missing.join(", "));
    } else {
      add("Hook script references", true, unique.length + " referenced, all present");
    }
  } catch (err) {
    add("Hook script references", false, err.message, false);
  }
}

function checkLogsWritable() {
  var logsDir = path.join(PLUGIN_ROOT, "logs");
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    var probe = path.join(logsDir, ".write-probe");
    fs.writeFileSync(probe, "probe");
    fs.unlinkSync(probe);
    add("logs/ writable", true, logsDir);
  } catch (err) {
    add("logs/ writable", false, err.message, false);
  }
}

function checkHookExecutes() {
  // Dry-run analyze-complexity.js with a dummy prompt
  var script = path.join(PLUGIN_ROOT, "scripts", "analyze-complexity.js");
  if (!fs.existsSync(script)) {
    add("Hook dry-run (analyze-complexity)", false, "script missing", false);
    return;
  }
  try {
    var result = cp.spawnSync(process.execPath, [script], {
      input: JSON.stringify({ prompt: "preflight test", cwd: PLUGIN_ROOT }),
      encoding: "utf8",
      timeout: 15000
    });
    if (result.status !== 0) {
      add("Hook dry-run (analyze-complexity)", false,
        "exit " + result.status + ": " + (result.stderr || "").slice(0, 300),
        false);
    } else {
      add("Hook dry-run (analyze-complexity)", true, "exit 0");
    }
  } catch (err) {
    add("Hook dry-run (analyze-complexity)", false, err.message, false);
  }
}

// ---- Runner ----

function run() {
  // Always-on checks (also valid in --runtime mode)
  checkNode();
  checkRequiredDirs();
  checkRequiredFiles();
  checkJsonValid();
  checkHooksReference();
  checkLogsWritable();

  // Install-time only (slow / external)
  if (!RUNTIME) {
    checkClaudeHomeDir();
    checkInstallerPresent();
    checkMarketplaceOwner();
    checkClaudeCli();
    checkHookExecutes();
  }

  var allFatalPassed = true;
  var anyFailed = false;

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var mark = r.ok ? "[OK]  " : (r.fatal ? "[FAIL]" : "[WARN]");
    log(mark + " " + r.name + (r.detail ? " - " + r.detail : ""));
    if (!r.ok) {
      if (r.fatal) allFatalPassed = false;
      anyFailed = true;
    }
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      passed: allFatalPassed,
      anyFailed: anyFailed,
      results: results
    }));
  } else if (!QUIET) {
    log("");
    if (allFatalPassed) {
      log(anyFailed
        ? "All fatal checks passed (see warnings above)."
        : "All checks passed.");
    } else {
      log("One or more fatal checks failed. Installation cannot proceed.");
    }
  }

  process.exit(allFatalPassed ? 0 : 1);
}

run();
