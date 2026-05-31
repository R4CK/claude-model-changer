"use strict";

/**
 * atomic-io.js — atomic write + read primitives (v3.0.0)
 *
 * Replaces the manual spin-lock + PID-check pattern in session-utils.js /
 * detect-fallback.js. Uses the write-temp-then-rename idiom which is atomic
 * on both POSIX (rename) and Windows (MoveFileEx with replace flag).
 *
 * Key operations:
 *   atomicWriteJson(filepath, data)      // one-shot replace
 *   atomicMergeJson(filepath, mergeFn)   // read-modify-write with bounded retry
 *
 * Retries (not locks): if a concurrent writer replaced the file between read
 * and write, retry up to N times with exponential backoff. Bounded by wall time.
 */

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var MAX_RETRIES = 5;
var INITIAL_BACKOFF_MS = 10;
var MAX_BACKOFF_MS = 200;
var MAX_TOTAL_WAIT_MS = 2000;

function _tmpPathFor(target) {
  // Unique per-process + per-call to avoid collisions across concurrent writers
  var rand = crypto.randomBytes(6).toString("hex");
  return target + ".tmp." + process.pid + "." + Date.now() + "." + rand;
}

function _sleepSync(ms) {
  // Synchronous sleep via Atomics.wait (from existing scripts/lib/sleep.js pattern).
  // Inlined here to keep atomic-io self-contained.
  try {
    var buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch (e) {
    // Fallback: busy-wait (only reached on very old Node or restricted envs)
    var end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Atomically write JSON to filepath. Writes to a temp file first, then
 * renames into place. Never leaves a partial file visible to readers.
 *
 * @param {string} filepath
 * @param {*} data  any JSON-serializable value
 * @returns {boolean} true on success, false on failure
 */
function atomicWriteJson(filepath, data) {
  var tmp = _tmpPathFor(filepath);
  try {
    // Ensure directory exists
    var dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // v3.8.0: fsync the temp file's data to disk BEFORE the rename. Without
    // this, the rename can become durable while the file's bytes are still in
    // the OS page cache — an OS crash/power loss right after could leave a
    // zero-length or truncated JSON. fsync is best-effort (some filesystems
    // reject it) and never changes the success path.
    var json = JSON.stringify(data, null, 2);
    var fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, json, null, "utf8");
      try { fs.fsyncSync(fd); } catch (e) { /* best-effort durability */ }
    } finally {
      fs.closeSync(fd);
    }
    // rename is atomic on both POSIX and Windows (with replace semantics in Node >= 18)
    fs.renameSync(tmp, filepath);
    return true;
  } catch (err) {
    // Clean up stray temp file
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
    return false;
  }
}

/**
 * Read a JSON file; return null if missing, parse-error, or any I/O error.
 * Never throws.
 */
function safeReadJson(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    var raw = fs.readFileSync(filepath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Read-modify-write with concurrency safety.
 *
 * Flow:
 *   1. Read current file (or default if missing).
 *   2. Call mergeFn(currentData) to produce newData.
 *   3. Write newData atomically.
 *   4. If another process wrote between our read and our write (detected via
 *      re-reading + checking mtime hash), retry up to MAX_RETRIES times with
 *      exponential backoff.
 *
 * Guarantees:
 *   - No partial reads: readers never see a half-written file.
 *   - Last-write-wins semantics, but every write was applied to the latest
 *     state the writer saw at the moment of the write.
 *   - Never hangs: bounded by MAX_RETRIES and MAX_TOTAL_WAIT_MS.
 *
 * @param {string} filepath
 * @param {function(currentData): newData} mergeFn
 *        called with parsed JSON (or the provided default if file missing)
 * @param {*} [defaultValue={}] used when file doesn't exist yet
 * @returns {{ok: boolean, retries: number, data: any}} - data is the final written state, or null on failure
 */
function atomicMergeJson(filepath, mergeFn, defaultValue) {
  if (defaultValue === undefined) defaultValue = {};
  var startedAt = Date.now();
  var backoff = INITIAL_BACKOFF_MS;

  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    var current = safeReadJson(filepath);
    if (current === null) current = defaultValue;

    // Take a snapshot hash of the file we read (for optimistic concurrency)
    var beforeHash = "";
    try {
      if (fs.existsSync(filepath)) {
        var beforeStat = fs.statSync(filepath);
        beforeHash = beforeStat.mtimeMs + ":" + beforeStat.size;
      }
    } catch (e) { /* file just appeared/disappeared; re-read */ }

    var next;
    try {
      next = mergeFn(current);
    } catch (err) {
      return { ok: false, retries: attempt, data: null, error: "mergeFn threw: " + (err && err.message || err) };
    }

    // Before writing, check if file changed under us since our read
    var currentHash = "";
    try {
      if (fs.existsSync(filepath)) {
        var currStat = fs.statSync(filepath);
        currentHash = currStat.mtimeMs + ":" + currStat.size;
      }
    } catch (e) {}

    if (beforeHash === currentHash) {
      // No concurrent modification detected; write
      if (atomicWriteJson(filepath, next)) {
        return { ok: true, retries: attempt, data: next };
      }
      // write failed: maybe transient; retry
    }
    // else: someone else wrote; retry with fresh read

    if (Date.now() - startedAt > MAX_TOTAL_WAIT_MS) break;
    _sleepSync(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  return { ok: false, retries: MAX_RETRIES, data: null, error: "exceeded retries/timeout" };
}

/**
 * Atomic append to a JSONL (newline-delimited JSON) log file.
 * Uses fs.appendFileSync which is atomic on POSIX; on Windows it's best-effort
 * but at least prevents torn writes for entries smaller than ~4KB.
 *
 * This is a convenience wrapper; the append itself doesn't need
 * read-modify-write since we're only adding a line.
 */
function atomicAppendJsonLine(filepath, entry) {
  try {
    var dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filepath, JSON.stringify(entry) + "\n", "utf8");
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  atomicWriteJson: atomicWriteJson,
  atomicMergeJson: atomicMergeJson,
  atomicAppendJsonLine: atomicAppendJsonLine,
  safeReadJson: safeReadJson,
  _internal: {
    MAX_RETRIES: MAX_RETRIES,
    MAX_TOTAL_WAIT_MS: MAX_TOTAL_WAIT_MS
  }
};
