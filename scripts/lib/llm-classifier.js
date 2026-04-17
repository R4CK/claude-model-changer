"use strict";

/**
 * LLM-based fallback classifier (Haiku).
 *
 * Called from analyze-complexity.js ONLY when the deterministic scorer's
 * confidence is low (no keyword match or confidence < threshold). Sends a
 * minimal classification prompt to Claude Haiku via the Anthropic API.
 *
 * Always degrades gracefully:
 *   - No API key in env       -> returns null (caller falls back to deterministic)
 *   - Network error / timeout -> returns null
 *   - Malformed response      -> returns null
 *
 * Never throws. The hook MUST stay reliable.
 *
 * Cost note: each call is ~200 input tokens + ~100 output tokens of Haiku.
 * At Haiku rates ($0.25/$1.25 per 1M), one call is ~$0.000175. A user with
 * 100 unmatched prompts/day pays ~$0.02/day for this feature.
 */

var https = require("https");

var DEFAULT_MODEL = "claude-haiku-4-5"; // cheapest model, best for classification
var DEFAULT_TIMEOUT_MS = 8000;
var DEFAULT_MAX_TOKENS = 200;

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY ||
         process.env.CLAUDE_API_KEY ||
         null;
}

function buildClassificationPrompt(userPrompt) {
  // Trim very long prompts so we don't pay for huge input
  var trimmed = userPrompt.length > 2000 ? userPrompt.substring(0, 2000) + "...[truncated]" : userPrompt;
  return [
    "You are classifying a software-engineering prompt for routing to one of three Claude models.",
    "",
    "Routing rules:",
    "- haiku  : trivial tasks (typo fixes, formatting, single-line edits, quick lookups, status checks, simple questions)",
    "- sonnet : medium tasks (bug fixes, feature additions, refactoring, testing, code review, documentation, integration)",
    "- opus   : complex tasks (architecture, large multi-file refactors, security audits, performance optimization, system design, algorithms)",
    "",
    "Classify this prompt:",
    "",
    "<prompt>",
    trimmed,
    "</prompt>",
    "",
    "Respond with ONE JSON object and NOTHING else. Schema:",
    "{",
    '  "model": "haiku" | "sonnet" | "opus",',
    '  "category": "<short category label, 2-4 words>",',
    '  "suggestedKeywords": ["<keyword1>", "<keyword2>", "<keyword3>"],',
    '  "confidence": <integer 0-100>,',
    '  "reasoning": "<one short sentence>"',
    "}",
    "",
    "The suggestedKeywords are short, lowercase, distinctive words/phrases that future similar prompts might contain.",
    "Return ONLY the JSON object. No prose, no markdown fences."
  ].join("\n");
}

function callAnthropicApi(apiKey, body, timeoutMs) {
  return new Promise(function(resolve) {
    var data = JSON.stringify(body);
    var req = https.request({
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      timeout: timeoutMs
    }, function(res) {
      var chunks = "";
      res.on("data", function(c) { chunks += c; });
      res.on("end", function() {
        try {
          var parsed = JSON.parse(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, body: parsed });
          } else {
            resolve({ ok: false, error: "HTTP " + res.statusCode + ": " + (parsed.error && parsed.error.message || chunks.substring(0, 200)) });
          }
        } catch (e) {
          resolve({ ok: false, error: "parse error: " + e.message });
        }
      });
    });
    req.on("error", function(err) { resolve({ ok: false, error: "network error: " + err.message }); });
    req.on("timeout", function() {
      req.destroy();
      resolve({ ok: false, error: "timeout after " + timeoutMs + "ms" });
    });
    req.write(data);
    req.end();
  });
}

function extractJsonFromText(text) {
  // Strip markdown fences if the model added them despite instruction
  var cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  // Find the outermost {...}
  var first = cleaned.indexOf("{");
  var last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(cleaned.substring(first, last + 1));
  } catch (e) {
    return null;
  }
}

function validateClassification(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (["haiku", "sonnet", "opus"].indexOf(obj.model) === -1) return null;
  if (typeof obj.category !== "string" || obj.category.length === 0) return null;
  if (!Array.isArray(obj.suggestedKeywords)) obj.suggestedKeywords = [];
  obj.suggestedKeywords = obj.suggestedKeywords
    .filter(function(k) { return typeof k === "string" && k.length > 0; })
    .map(function(k) { return k.toLowerCase().trim(); })
    .slice(0, 10);
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 100) {
    obj.confidence = 75;
  }
  if (typeof obj.reasoning !== "string") obj.reasoning = "";
  return obj;
}

/**
 * Classify a prompt synchronously (blocks until response or timeout).
 * Returns null on any failure (caller MUST fall back to deterministic).
 *
 * @param {string} prompt        - user's prompt text
 * @param {object} llmConfig     - { enabled, model, timeoutMs, maxTokens }
 * @returns {object|null}        - { model, category, suggestedKeywords, confidence, reasoning, latencyMs } or null
 */
function classify(prompt, llmConfig) {
  if (!llmConfig || !llmConfig.enabled) return null;
  var apiKey = getApiKey();
  if (!apiKey) return null;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) return null;

  var model = llmConfig.model || DEFAULT_MODEL;
  var timeoutMs = llmConfig.timeoutMs || DEFAULT_TIMEOUT_MS;
  var maxTokens = llmConfig.maxTokens || DEFAULT_MAX_TOKENS;

  var startedAt = Date.now();

  var body = {
    model: model,
    max_tokens: maxTokens,
    messages: [
      { role: "user", content: buildClassificationPrompt(prompt) }
    ]
  };

  // The hook must stay sync-friendly. Use a deasync-style wait via the
  // event loop (this script reads stdin then exits; we can wait for the
  // promise inline by spinning a small sync HTTP call and parsing).
  // To keep zero-dep + sync semantics, we do the request via a sync
  // child invocation pattern below.
  return classifySync(apiKey, body, timeoutMs, model, startedAt);
}

/**
 * Sync wrapper: spawn a tiny child node process to perform the HTTP
 * request and print the result, then parse stdout.
 * This keeps the hook flow synchronous (caller doesn't need async/await).
 */
function classifySync(apiKey, body, timeoutMs, model, startedAt) {
  var cp = require("child_process");
  var path = require("path");
  var helperScript = path.join(__dirname, "llm-classifier-helper.js");

  var result;
  try {
    result = cp.spawnSync(process.execPath, [helperScript], {
      input: JSON.stringify({ apiKey: apiKey, body: body, timeoutMs: timeoutMs }),
      encoding: "utf8",
      timeout: timeoutMs + 2000  // give helper a little extra
    });
  } catch (e) {
    return null;
  }

  if (!result || result.status !== 0 || !result.stdout) return null;

  var helperOut;
  try { helperOut = JSON.parse(result.stdout); } catch (e) { return null; }
  if (!helperOut.ok) return null;

  // helperOut.body is the parsed Anthropic API response
  var content = helperOut.body && helperOut.body.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  var textBlock = content.find(function(b) { return b.type === "text"; });
  if (!textBlock || !textBlock.text) return null;

  var classification = extractJsonFromText(textBlock.text);
  classification = validateClassification(classification);
  if (!classification) return null;

  classification.latencyMs = Date.now() - startedAt;
  classification.modelUsed = model;
  return classification;
}

module.exports = {
  classify: classify,
  // Exported for testing
  _internal: {
    getApiKey: getApiKey,
    buildClassificationPrompt: buildClassificationPrompt,
    extractJsonFromText: extractJsonFromText,
    validateClassification: validateClassification
  }
};
