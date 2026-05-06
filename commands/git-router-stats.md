---
description: "Stats from the git commit/push routing hook: diff sizes, model recommendations, and any force-push warnings issued."
argument-hint: ""
---

The user wants the git router stats.

Run:

```bash
echo '{"prompt":"--git-router-stats"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Display:

```
🔀 Git Router Stats (last 30 days)

Total commits: 47
By recommended model:
  haiku   28  (60%)  small diffs
  sonnet  14  (30%)  moderate diffs
  opus     5  (11%)  large diffs

Total pushes: 12
Force pushes flagged: 2

Avg diff size: 38 lines per commit
Largest diff: 1,247 lines (opus-routed)
```

Source: `logs/git-router-stats.jsonl`.
Toggle: `config.gitHooks.enabled` (default true).
Override message model: `config.gitHooks.autoMessageModel` ("haiku"|"sonnet"|"opus"|"auto").
