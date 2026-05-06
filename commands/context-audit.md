---
description: "Audit what's eating your context window. Lists top file reads + bash commands by estimated token cost, with recommendations to /clear or pin to skills."
argument-hint: "[windowMinutes=60]"
---

The user wants a context-bloat audit.

Run:

```bash
echo '{"prompt":"--context-audit"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Display as:

```
🔍 Context Audit (last 60 min)

Total: 47 tool calls, ~78,500 tokens estimated
By kind:
  read       28
  bash-read   8
  bash-grep   9
  bash-other  2

📂 Top files (token cost):
  1. src/auth.js                    8 reads → ~24,000 tokens
  2. config/task-routing.json       4 reads → ~12,000 tokens
  3. CHANGELOG.md                   3 reads → ~9,000 tokens

💡 Recommendations:
  • Consider extracting 'src/auth.js' into a pinned skill (read 8x)
  • Session heavy on tool use — /clear if switching tasks
```

Window can be tuned: `[windowMinutes=60]` argument adjusts lookback period.
The history is built from `logs/tool-history.jsonl` (capped at 200 lines).
Disable tracking via `config.contextBloat.enabled: false`.
