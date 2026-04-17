---
description: "Review LLM-fallback classification suggestions and propose task-routing.json updates"
argument-hint: ""
---

The user wants to review what the LLM-fallback classifier (Claude Haiku) has been suggesting for prompts that the deterministic scorer couldn't classify.

Run the show-learn-suggestions script:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/show-learn-suggestions.js"
```

The output shows:
- Total LLM-fallback suggestions logged
- Distribution by suggested model (haiku / sonnet / opus)
- Top categories the LLM has been suggesting (frequency-sorted)
- Top keywords suggested for each model (frequency-sorted)
- The most recent 10 suggestions with prompts

After showing the output, help the user **decide what to add to `config/task-routing.json`**:

1. **High-frequency keywords** (count >= 3) are good candidates to add to existing categories. Identify which existing category in the user's `task-routing.json` is most semantically similar to the LLM-suggested category, and propose adding the keyword to that category's `keywords` array.

2. **High-frequency categories** that don't match any existing category may warrant creating a new entry. Propose: under `models.<model>.categories.<new_key>`, add `{ "label": "<Display Label>", "keywords": ["kw1", "kw2", "kw3"] }`.

3. **Show the diff** as a code block (don't apply automatically). The user reviews and edits manually, then opens a PR.

If the LLM fallback is disabled or there are no suggestions yet, the script tells the user how to enable it (set `ANTHROPIC_API_KEY` env var, set `autoMode.llmFallback.enabled = true` in `task-routing.json`).

**Important:** Never auto-modify `task-routing.json`. Always show the proposed changes and let the user apply them via a PR (which will be CI-checked for routing behavior).
