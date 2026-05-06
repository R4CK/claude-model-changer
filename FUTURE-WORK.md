# Future Work — Out of Scope for v3.1.0

This document captures three improvement directions from the v3.1.0 plan that
were intentionally deferred. Each requires substantially more design or
architectural change than the in-process v3.1.0 enhancements.

## L — Cron + /loop integration (`/anomaly-watch`)

**Status:** Partially enabled via existing infrastructure, no code added.

The plugin already exposes the data needed for this:
- `node scripts/analyze-complexity.js < <(echo '{"prompt":"--metrics"}')` emits
  Prometheus metrics (v3.1.0).
- `--auto-tune-dry` returns auto-tune suggestions (existing).
- `--errors` returns recent hook errors (existing).

To run any of these on a schedule, the user can use Claude Code's built-in
`/loop` or the `scheduled-tasks` MCP. We deliberately do **not** ship a cron
hook because:
1. The plugin is per-project; a cron job is per-machine. They have different
   lifecycles.
2. Output destinations (Slack/email/file) are user-specific. A general default
   would be a leaky abstraction.

**Recommended user setup** (manual, one-time):
```
/loop 30m node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js" <<< '{"prompt":"--metrics"}' > ~/.claude/metrics.prom
```

Or for anomaly notifications, pipe through `jq` and `curl` to a webhook.

## O — Multi-provider routing (Anthropic / Bedrock / Vertex)

**Status:** Architecturally out of scope.

The plugin is a **routing hint provider** — it analyzes the user prompt and
recommends a model, but it does **not** make the API call. Claude Code itself
handles the request to whichever provider the user has configured. Therefore:
- Provider selection happens in Claude Code's settings, not the plugin.
- The plugin can only emit `modelIds` aliases (already done in v3.1.0); the
  actual provider mapping (Bedrock inference profile ARN, Vertex endpoint, etc.)
  belongs in `~/.claude/settings.json` under `modelOverrides`.

**Recommended user setup** for Bedrock fallback:
```json
{
  "modelOverrides": {
    "claude-haiku-4-5": "arn:aws:bedrock:us-east-1:123:inference-profile/haiku",
    "claude-sonnet-4-6": "arn:aws:bedrock:us-east-1:123:inference-profile/sonnet"
  }
}
```

The plugin's `modelIds` config field stays consistent with whatever the user's
Claude Code instance can resolve.

## P — Web Artifact dashboard (React + shadcn/ui)

**Status:** Deferred — significant rewrite, low marginal value.

The current `live-dashboard.js` HTTP+SSE dashboard works zero-dependency and
loads instantly. A React rewrite via `anthropic-skills:web-artifacts-builder`
would offer:
- Better mobile responsiveness
- Component reusability
- Modern shadcn/ui aesthetic

But it would also:
- Add a ~200KB bundle (vs the current ~5KB inline)
- Require a build step (vs zero-dep today)
- Diverge from the plugin's "no npm dependencies" architectural rule
  (`package.json` has zero `dependencies`)

If/when this is implemented, it should be a **separate optional bundle**
(`scripts/live-dashboard-react.js`) the user can opt into via config:

```json
"liveDashboard": {
  "preferReact": true,
  "port": 3847
}
```

The classic dashboard remains the default.

---

## What landed in v3.1.0

For reference, these items from the plan were implemented:

- **A** — Updated Haiku/Sonnet/Opus pricing + `modelIds` config block
- **B** — Per-model context window (1M for `claude-opus-4-7[1m]`)
- **C** — Fast mode integration (effort forced low when active)
- **D** — Effort → extended-thinking budget mapping (low/medium/high → 0/5K/16K)
- **E** — MCP tool density sub-score (browser/github/slack/etc. detection)
- **F** — Skill trigger detection (10 default rules: superpowers, frontend-design, etc.)
- **G** — Plan mode awareness (hook input + keyword detection)
- **H** — Parallel subagent dispatch detection (orchestrator pattern)
- **I** — Hungarian morphology in keyword matching (suffix-aware regex)
- **J** — Hungarian IT-jargon keyword expansion (~25 new keywords)
- **K** — Prometheus text-format metrics export (`--metrics` / `/metrics`)
- **M** — Auto-memory file integration (terse/thorough preference detection)
- **N** — Health check fix for nested hooks.json structure

Files added: `scripts/lib/memory.js`, `scripts/export-prometheus.js`, `commands/metrics.md`.
