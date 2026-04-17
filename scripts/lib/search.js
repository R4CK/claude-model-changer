#!/usr/bin/env node
/**
 * search.js - Shared search utilities (binary search, timestamp matching)
 * Extracted from stats.js and scoring.js to eliminate code duplication.
 */
"use strict";

/**
 * Binary search for the closest entry by timestamp.
 *
 * @param {Array} sortedEntries - Entries sorted by timestamp ascending
 * @param {Array<number>} timestamps - Pre-extracted timestamps (parallel array)
 * @param {number} targetTime - Target time in ms since epoch
 * @param {number} maxDiffMs - Maximum time difference to accept a match
 * @returns {Object|null} The closest entry within maxDiffMs, or null
 */
function findClosestByTimestamp(sortedEntries, timestamps, targetTime, maxDiffMs) {
  if (!timestamps || timestamps.length === 0) return null;

  var lo = 0, hi = timestamps.length - 1;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (timestamps[mid] < targetTime) lo = mid + 1;
    else hi = mid;
  }

  var bestIdx = lo;
  var bestDiff = Math.abs(timestamps[lo] - targetTime);

  if (lo > 0) {
    var prevDiff = Math.abs(timestamps[lo - 1] - targetTime);
    if (prevDiff < bestDiff) {
      bestIdx = lo - 1;
      bestDiff = prevDiff;
    }
  }

  return bestDiff < maxDiffMs ? sortedEntries[bestIdx] : null;
}

/**
 * Prepare a sorted entry set for timestamp matching.
 *
 * @param {Array} entries - Raw entries with timestamp field
 * @param {Function} [filterFn] - Optional filter predicate
 * @returns {{ sorted: Array, timestamps: Array<number> }}
 */
function prepareTimestampIndex(entries, filterFn) {
  var filtered = filterFn ? entries.filter(filterFn) : entries.slice();
  filtered.sort(function(a, b) {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
  var timestamps = filtered.map(function(e) {
    return new Date(e.timestamp).getTime();
  });
  return { sorted: filtered, timestamps: timestamps };
}

module.exports = {
  findClosestByTimestamp: findClosestByTimestamp,
  prepareTimestampIndex: prepareTimestampIndex
};
