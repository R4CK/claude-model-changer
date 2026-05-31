---
description: "Show the auto-synced external skills/agents/commands: per-repo inventory, enabled state, last-synced commit, and the context-token cost each repo adds."
argument-hint: ""
---

The user wants to inspect the external skill sync state (the repos pulled in on SessionStart).

Run:

```bash
echo '{"prompt":"--skills-status"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Or directly, for a formatted view:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/skills-status.js"
```

Present the JSON as a table:

```
External skills sync status

✓  open-design            [od-]        sha=abc1234   131 skills · ~3.1k ctx
✓  everything-claude-code [ecc-]       sha=def5678   249 skills, 60 agents, 75 cmds · ~9.4k ctx
✗  ruflo (disabled)       [rf-, rfp-]  sha=...        0 (pruned)

ACTIVE TOTAL: 643 skills + 217 agents + 153 commands · ~28k context tokens
Last external sync: 2026-05-31T...   Self-update check: 2026-05-31T...
```

Key points to explain when relevant:
- **approxContextTokens** is a rough estimate of the context overhead each repo's
  items add (Claude Code loads every skill name + description). The whole point
  of this plugin is cost savings, so a large total here is worth curating.
- To **disable a heavy repo**: set `"enabled": false` on it in
  `config/external-skills.json`. The next sync runs a prune step that removes its
  already-installed items, freeing that context.
- To prune immediately without waiting for the throttle:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-external-skills.js" "${CLAUDE_PLUGIN_ROOT}" --prune
  ```
- `lastSyncedSha` is the cached repo's current commit; the sync only re-copies
  when the remote HEAD differs from it.
