#!/usr/bin/env node
/**
 * log-subagent.js - DEPRECATED
 *
 * Subagent usage is now automatically tracked by the SubagentComplete hook
 * in detect-fallback.js. This script is no longer needed.
 */
"use strict";

process.stderr.write("[log-subagent] WARNING: This script is deprecated. Subagent usage is now auto-tracked by the SubagentComplete hook.\n");
process.stderr.write("[log-subagent] Running this script may cause double-counting. Exiting.\n");
process.exit(0);
