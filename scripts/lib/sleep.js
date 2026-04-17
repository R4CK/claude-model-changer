#!/usr/bin/env node
/**
 * sleep.js - Synchronous sleep without CPU burn
 *
 * Uses Atomics.wait on a SharedArrayBuffer. Unlike a busy-wait loop,
 * this yields to the OS scheduler and consumes no CPU while sleeping.
 * Safe to call from the Node main thread (unlike in browsers).
 */
"use strict";

var _buf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  try { Atomics.wait(_buf, 0, 0, ms); }
  catch (e) {
    // Fallback: yield via setImmediate-equivalent sync wait if Atomics unavailable
    var end = Date.now() + ms;
    while (Date.now() < end) {
      try { require("fs").readFileSync(require("os").devNull || "/dev/null"); } catch (x) { break; }
    }
  }
}

module.exports = { sleepSync: sleepSync };
