#!/usr/bin/env node
/**
 * model-constants.js — Single source of truth for the semantic haiku/sonnet/opus
 * tier mappings that were previously duplicated as inline object literals.
 * Centralizing the model→level, model→score and model→persona maps removes a
 * maintenance hazard: those mappings used to be repeated across the main hook
 * and had to be kept in sync by hand.
 *
 * Scope note: plain zeroed counters (`{ haiku: 0, sonnet: 0, opus: 0 }`) are
 * intentionally NOT centralized here — that literal is self-documenting and
 * pulling it behind a factory would add cross-file coupling for no real gain.
 * Only the maps that encode actual semantics live in this module.
 *
 * Keep this module dependency-free and pure so any script can require it.
 */
"use strict";

// Canonical tier order, cheapest → most capable.
var MODELS = ["haiku", "sonnet", "opus"];

// Complexity level label per model (the most-duplicated literal in the repo).
var LEVEL_BY_MODEL = { haiku: "SIMPLE", sonnet: "MEDIUM", opus: "COMPLEX" };

// Representative center score per tier (used for stickiness / target nudging).
var SCORE_BY_MODEL = { haiku: 2, sonnet: 5, opus: 9 };

// Short handling persona shown in routing prompts.
var PERSONA_BY_MODEL = { haiku: "fast", sonnet: "balanced", opus: "thorough" };

module.exports = {
  MODELS: MODELS,
  LEVEL_BY_MODEL: LEVEL_BY_MODEL,
  SCORE_BY_MODEL: SCORE_BY_MODEL,
  PERSONA_BY_MODEL: PERSONA_BY_MODEL
};
