---
description: "Re-route the previous prompt to the next-tier model (haiku → sonnet → opus). Auto-rates the original decision as quality 1 (poor) for adaptive learning."
argument-hint: ""
---

The user wants to undo the last routing decision and re-run with a stronger model.

```bash
echo '{"prompt":"--undo"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Parse the JSON output:

- If `ok: true`:
  - Read `instruction` and follow it (delegate to `<newModel>-worker` using the original prompt).
  - Tell the user: "Re-routing your previous prompt to **<newModel>**. The previous response stays in transcript."
- If `ok: false`:
  - Show the `message` to the user (e.g., "No previous routing", "Already at opus", "Too stale").

Configurable: `config.undo.maxAgeSec` (default 600s = 10 minutes — older decisions are not auto-undoable).

The /undo command writes a `quality: 1` entry to `logs/quality.jsonl` for the previous decision, so the adaptive-weights tuner learns from your corrections.
