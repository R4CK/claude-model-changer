---
description: "Show current effort configuration and recent effort distribution. View how the plugin decides reasoning budget (Low/Medium/High) alongside model selection."
argument-hint: ""
---

The user wants to inspect the plugin's Effort recommendation system (v2.7.0+).

Effort is **orthogonal to model selection** — it represents the reasoning/thinking budget the model should use for a task. The plugin suggests LOW / MEDIUM / HIGH in the hook output; the user can honor it via the Claude Code Effort UI control (Ctrl+E) or let the subagent naturally adapt (worker agents read the hint from their context).

## How it's computed

Pure function of sub-scores + confidence + matched category + config rules.

**HIGH triggers:**
- `multiFile >= 4` (many files involved)
- category is in `effort.rules.highCategories` (architecture / security / planning / performance_audit / large_refactoring / multi_file_work / algorithms / tech_debt)
- `confidence < 40` with keyword match (uncertain but signal present - needs more deliberation)
- `structure >= 6` (highly structured complex prompt)

**LOW triggers:**
- category is in `effort.rules.lowCategories` (typo_fix / formatting / rename / comments / status / imports / search_list) with keyword match
- `wordCount <= 2` with confident keyword match

**MEDIUM:** default when neither fires.

Per-category override: add `defaultEffort: "low"|"medium"|"high"` to any `models.<model>.categories.<key>` block in `config/task-routing.json`.

## Display current effort config

Read and show the relevant portion:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/config/task-routing.json" | node -e "
var fs = require('fs'); var raw = ''; process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  var cfg = JSON.parse(raw);
  console.log(JSON.stringify(cfg.effort || {}, null, 2));
});
"
```

Also run `--explain` on a sample prompt to show the effort breakdown:

```bash
echo '{"prompt":"--explain <user sample or default>"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

## Typical discussion points

If the user wants to:
- **Suppress effort emission** → set `effort.enabled: false` in the config
- **Only advise, not hint to subagent** → `effort.emitInSubagentHint: false`, keep `emitInOutput: true`
- **Force HIGH on a specific category** → add `defaultEffort: "high"` to that category's config block
- **Relax LOW thresholds** → lower `rules.lowEffortConfidenceThreshold` below 70

## Show last 20 effort decisions from usage log

```bash
tail -20 "${CLAUDE_PLUGIN_ROOT}/logs/usage.jsonl" | node -e "
var lines = require('fs').readFileSync(0, 'utf8').trim().split('\n');
var counts = { low: 0, medium: 0, high: 0, none: 0 };
lines.forEach(l => {
  try {
    var e = JSON.parse(l);
    var lvl = (e.effort && e.effort.level) || 'none';
    counts[lvl] = (counts[lvl] || 0) + 1;
  } catch(x){}
});
console.log('Last 20 prompts effort distribution:', JSON.stringify(counts, null, 2));
"
```

**Important:** Do not modify task-routing.json directly; guide the user to edit it via `/configure` or a PR. Effort is advisory — the plugin cannot force the Claude Code UI Effort selector to change.
