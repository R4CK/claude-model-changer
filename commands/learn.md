---
description: "Review LLM-fallback classification suggestions, auto-applied learned keywords, and propose task-routing.json updates"
argument-hint: "[--promote]"
---

The user wants to review what the LLM-fallback classifier (Claude Haiku via the haiku-worker subagent) has been suggesting for prompts that the deterministic scorer couldn't classify.

## Without arguments — review summary

Run the show-learn-suggestions script:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/show-learn-suggestions.js"
```

The output shows:
- Total LLM-fallback suggestions logged
- Distribution by suggested model (haiku / sonnet / opus)
- **How many keywords have been auto-applied** to `logs/learned-keywords.json` (per-user, gitignored)
- Top categories the LLM has been suggesting (frequency-sorted)
- Top keywords suggested for each model (frequency-sorted)
- The most recent 10 suggestions with prompts and detected language

After showing the output, help the user **decide what to do**:

1. **Auto-applied keywords** are already active in this user's runtime config (deep-merged into `task-routing.json` at load time). The user may want to **promote** them to the shared `task-routing.json` so other users / machines also benefit. See "--promote" below.

2. **Suggestions not yet auto-applied** (count below `learn.autoApply.minOccurrences`, default 5): the user can manually copy them to `task-routing.json` via PR if they want to short-circuit the auto-apply threshold. Show the proposed diff as a code block; never auto-modify.

3. If `learn.autoApply.enabled` is **false** in `task-routing.json`, mention that the user can enable it to let high-confidence suggestions auto-apply locally.

## With `--promote` — generate diff for sharing

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/show-learn-suggestions.js" --promote
```

This emits a human-readable diff showing exactly what the per-user `learned-keywords.json` would add to the shared `task-routing.json`. The user reviews, then incorporates the diff into a PR (which the CI will validate).

## Multi-language note

Each suggestion records the detected language (`en` / `hu` / `de`). When auto-applied, English keywords land in `models.<model>.categories.<key>.keywords`, while Hungarian/German land in `translations.<lang>.<key>` arrays — matching the existing multi-language structure of `task-routing.json`.

**Important:** Never auto-modify `task-routing.json`. The auto-apply only writes to `logs/learned-keywords.json` (per-user). Promotion to the shared config is always a deliberate, PR-reviewed change.
