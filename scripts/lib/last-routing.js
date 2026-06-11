#!/usr/bin/env node
/**
 * last-routing.js — Persist the last routing decision so /undo can re-route.
 *
 * Every successful UserPromptSubmit hook saves a record:
 *   {
 *     timestamp, sessionId, prompt, model, level, score, category, effort
 *   }
 *
 * /undo reads it, escalates to the next-tier model (haiku → sonnet → opus),
 * outputs an instruction to Claude to re-route, and auto-rates the original
 * decision as quality 1 (poor) for adaptive-learning purposes.
 *
 * Single-record file (logs/last-routing.json) — overwritten on each prompt.
 * Path-source users could expand this to a stack if multi-undo is desired.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
var LAST_FILE = path.join(PLUGIN_ROOT, "logs", "last-routing.json");

function save(record) {
  try {
    var dir = path.dirname(LAST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = LAST_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(tmp, LAST_FILE);
  } catch (e) { /* swallow */ }
}

function load() {
  try {
    if (!fs.existsSync(LAST_FILE)) return null;
    return JSON.parse(fs.readFileSync(LAST_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) { return null; }
}

// Escalate haiku → sonnet → opus. (Opus has no escalation; return null.)
function nextTier(model) {
  if (model === "haiku") return "sonnet";
  if (model === "sonnet") return "opus";
  return null;
}

// Build the /undo response payload.
function buildUndoPayload(config) {
  var last = load();
  if (!last) {
    return {
      ok: false,
      message: "No previous routing decision to undo. Run a prompt first."
    };
  }
  var ageSec = Math.round((Date.now() - Date.parse(last.timestamp)) / 1000);
  var maxAge = (config && config.undo && typeof config.undo.maxAgeSec === "number") ? config.undo.maxAgeSec : 600;
  if (ageSec > maxAge) {
    return {
      ok: false,
      message: "Last routing decision is " + ageSec + "s old (limit " + maxAge + "s). Too stale to undo automatically."
    };
  }
  var newModel = nextTier(last.model);
  if (!newModel) {
    return {
      ok: false,
      message: "Last routing was already at opus (the highest tier). Nothing to escalate to."
    };
  }
  return {
    ok: true,
    previousModel: last.model,
    newModel: newModel,
    prompt: last.prompt,
    category: last.category,
    instruction: "[Model Router /undo] Re-routing previous prompt to **" + newModel + "-worker** (escalated from " + last.model + "). Use this prompt:\n\n" +
                 "> " + (last.prompt || "(prompt unavailable)") + "\n\n" +
                 "The previous response is in your transcript; re-running with " + newModel + " will give a more thorough answer."
  };
}

module.exports = {
  save: save,
  load: load,
  nextTier: nextTier,
  buildUndoPayload: buildUndoPayload
};
