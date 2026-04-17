#!/usr/bin/env node
"use strict";

/**
 * Helper child process for llm-classifier.js.
 *
 * The parent (analyze-complexity.js, via llm-classifier) needs the LLM
 * response synchronously, but Node's https module is async-only. Spawning
 * this helper as a synchronous child (cp.spawnSync) lets us do an async
 * HTTP request inside an isolated process while the parent waits.
 *
 * Reads JSON {apiKey, body, timeoutMs} from stdin.
 * Writes JSON {ok, body|error} to stdout.
 * Always exits 0 with a JSON envelope; never crashes the parent.
 */

var https = require("https");

var input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function(c) { input += c; });
process.stdin.on("end", function() {
  var req;
  try { req = JSON.parse(input); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "bad input json: " + e.message }));
    process.exit(0);
  }

  var data = JSON.stringify(req.body);
  var r = https.request({
    hostname: "api.anthropic.com",
    port: 443,
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01"
    },
    timeout: req.timeoutMs || 8000
  }, function(res) {
    var chunks = "";
    res.on("data", function(c) { chunks += c; });
    res.on("end", function() {
      try {
        var parsed = JSON.parse(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          process.stdout.write(JSON.stringify({ ok: true, body: parsed }));
        } else {
          process.stdout.write(JSON.stringify({ ok: false, error: "HTTP " + res.statusCode + ": " + (parsed.error && parsed.error.message || chunks.substring(0, 200)) }));
        }
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: "response parse: " + e.message }));
      }
      process.exit(0);
    });
  });
  r.on("error", function(err) {
    process.stdout.write(JSON.stringify({ ok: false, error: "network: " + err.message }));
    process.exit(0);
  });
  r.on("timeout", function() {
    r.destroy();
    process.stdout.write(JSON.stringify({ ok: false, error: "timeout" }));
    process.exit(0);
  });
  r.write(data);
  r.end();
});
