#!/usr/bin/env node
/**
 * live-dashboard.js - Real-time telemetry dashboard with SSE (Server-Sent Events)
 *
 * Usage: node scripts/live-dashboard.js [port]
 * Default port: 3847
 *
 * Opens a lightweight HTTP server that serves an auto-refreshing dashboard.
 * Uses SSE for zero-dependency real-time updates.
 * Note: All data is local-only (no external sources), so DOM updates are safe.
 */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");

var PORT = parseInt(process.argv[2], 10) || 3847;
var LOGS_DIR = path.join(__dirname, "..", "logs");
var CONFIG_DIR = path.join(__dirname, "..", "config");
var REFRESH_INTERVAL = 3000;

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").trim().split("\n")
      .filter(function(l) { return l.length > 0; })
      .map(function(l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (e) { return null; }
}

function gatherData() {
  var usage = readJsonl(path.join(LOGS_DIR, "usage.jsonl"));
  var quality = readJsonl(path.join(LOGS_DIR, "quality.jsonl"));
  var fallbacks = readJsonl(path.join(LOGS_DIR, "fallbacks.jsonl"));
  var session = readJson(path.join(LOGS_DIR, "session-state.json"));
  var status = readJson(path.join(LOGS_DIR, "status.json"));

  var mc = { haiku: 0, sonnet: 0, opus: 0 };
  var categories = {};
  var subagents = { haiku: 0, sonnet: 0, opus: 0 };

  usage.forEach(function(e) {
    mc[e.model] = (mc[e.model] || 0) + 1;
    if (e.category) categories[e.category] = (categories[e.category] || 0) + 1;
    if (e.source === "subagent") subagents[e.model] = (subagents[e.model] || 0) + 1;
  });

  var topCats = Object.entries(categories).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);

  return {
    timestamp: new Date().toISOString(),
    total: usage.length,
    models: mc,
    subagents: subagents,
    topCategories: topCats,
    qualityCount: quality.length,
    fallbackCount: fallbacks.length,
    session: session ? { promptCount: session.promptCount, modelCounts: session.modelCounts, subagentCounts: session.subagentCounts } : null,
    context: status ? { usage: status.contextUsage, lastModel: status.lastModel } : null
  };
}

// Dashboard HTML is a static template; all dynamic content is rendered
// client-side via SSE data using safe DOM manipulation (textContent).
function generateHTML() {
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8"><title>Claude Model Changer - Live Dashboard</title>',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:20px}',
    'h1{color:#58a6ff;margin:0 0 5px}h2{color:#8b949e;font-size:14px;margin:0 0 20px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px}',
    '.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}',
    '.card h3{margin:0 0 12px;color:#58a6ff;font-size:14px}',
    '.metric{font-size:32px;font-weight:700;color:#f0f6fc}.metric-label{font-size:12px;color:#8b949e}',
    '.bar{height:20px;border-radius:4px;margin:4px 0;display:flex;overflow:hidden}',
    '.bar-h{background:#3fb950}.bar-s{background:#58a6ff}.bar-o{background:#bc8cff}',
    '.legend{display:flex;gap:16px;margin:8px 0;font-size:12px}',
    '.cat-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d;font-size:13px}',
    '.live-dot{width:8px;height:8px;background:#3fb950;border-radius:50%;display:inline-block;animation:pulse 2s infinite}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}',
    '</style></head><body>',
    '<h1>Claude Model Changer <span class="live-dot"></span></h1>',
    '<h2>Live Telemetry Dashboard - Auto-refreshes every 3s</h2>',
    '<div class="grid">',
    '  <div class="card"><h3>Total Prompts</h3><div class="metric" id="total">-</div><div class="metric-label">All time</div></div>',
    '  <div class="card"><h3>Session</h3><div class="metric" id="session">-</div><div class="metric-label">Current session prompts</div></div>',
    '  <div class="card"><h3>Context Window</h3><div class="metric" id="context">-</div><div class="metric-label">Estimated usage</div></div>',
    '  <div class="card"><h3>Subagents</h3><div class="metric" id="subTotal">-</div><div class="metric-label" id="subDetail">H:0 S:0 O:0</div></div>',
    '</div>',
    '<div class="grid">',
    '  <div class="card"><h3>Model Distribution</h3>',
    '    <div class="bar"><div class="bar-h" id="barH"></div><div class="bar-s" id="barS"></div><div class="bar-o" id="barO"></div></div>',
    '    <div class="legend" id="legend"></div>',
    '  </div>',
    '  <div class="card"><h3>Top Categories</h3><div id="cats"></div></div>',
    '  <div class="card"><h3>Quality & Fallbacks</h3><div id="qf"></div></div>',
    '</div>',
    '<div id="updated" style="color:#484f58;font-size:11px;margin-top:20px"></div>',
    '<script>',
    'var es=new EventSource("/events");',
    'es.onmessage=function(e){',
    '  var d=JSON.parse(e.data),t=d.total||1;',
    '  var hp=Math.round((d.models.haiku/t)*100),sp=Math.round((d.models.sonnet/t)*100),op=Math.round((d.models.opus/t)*100);',
    '  var subT=(d.subagents.haiku||0)+(d.subagents.sonnet||0)+(d.subagents.opus||0);',
    '  document.getElementById("total").textContent=d.total;',
    '  document.getElementById("session").textContent=d.session?d.session.promptCount||0:0;',
    '  document.getElementById("context").textContent=d.context?d.context.usage+"%":"N/A";',
    '  document.getElementById("subTotal").textContent=subT;',
    '  document.getElementById("subDetail").textContent="H:"+d.subagents.haiku+" S:"+d.subagents.sonnet+" O:"+d.subagents.opus;',
    '  document.getElementById("barH").style.width=hp+"%";',
    '  document.getElementById("barS").style.width=sp+"%";',
    '  document.getElementById("barO").style.width=op+"%";',
    '  document.getElementById("legend").textContent="Haiku "+hp+"% ("+d.models.haiku+") | Sonnet "+sp+"% ("+d.models.sonnet+") | Opus "+op+"% ("+d.models.opus+")";',
    '  var catsEl=document.getElementById("cats");catsEl.textContent="";',
    '  (d.topCategories||[]).forEach(function(c){',
    '    var row=document.createElement("div");row.className="cat-row";',
    '    var n=document.createElement("span");n.textContent=c[0];',
    '    var v=document.createElement("span");v.textContent=c[1];',
    '    row.appendChild(n);row.appendChild(v);catsEl.appendChild(row);',
    '  });',
    '  var qfEl=document.getElementById("qf");qfEl.textContent="";',
    '  [{l:"Quality ratings",v:d.qualityCount},{l:"Fallback events",v:d.fallbackCount}].forEach(function(item){',
    '    var row=document.createElement("div");row.className="cat-row";',
    '    var n=document.createElement("span");n.textContent=item.l;',
    '    var v=document.createElement("span");v.textContent=item.v;',
    '    row.appendChild(n);row.appendChild(v);qfEl.appendChild(row);',
    '  });',
    '  document.getElementById("updated").textContent="Updated: "+d.timestamp+" | Port: ' + PORT + '";',
    '};',
    'es.onerror=function(){document.getElementById("updated").textContent="Connection lost. Refresh to reconnect.";};',
    '</script></body></html>'
  ].join('\n');
}

var server = http.createServer(function(req, res) {
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    function send() {
      try { res.write("data: " + JSON.stringify(gatherData()) + "\n\n"); } catch (e) {}
    }
    send();
    var interval = setInterval(send, REFRESH_INTERVAL);
    req.on("close", function() { clearInterval(interval); });
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generateHTML());
  }
});

server.listen(PORT, function() {
  console.log("[Live Dashboard] Running at http://localhost:" + PORT);
  console.log("[Live Dashboard] Press Ctrl+C to stop");
});
