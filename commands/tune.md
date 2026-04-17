---
description: "Analyze override patterns to get tuning suggestions for your model routing configuration"
argument-hint: ""
---

The user wants to analyze their override history to get tuning suggestions.

Run the analyze-complexity.js script with the `--tune` special command to get override analysis:

```bash
echo '{"prompt":"--tune"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Parse the JSON output and display it in a readable format:

**Override Analysis:**
- Total overrides recorded
- Per-category breakdown: how many times each category was overridden up vs down

**Tuning Suggestions:**
For each suggestion, show:
- Category name
- Recommended action (UPGRADE or DOWNGRADE)
- Reason (e.g., "Overridden upward 8/10 times")
- Suggested change (e.g., "Move 'bug_fixing' from sonnet to opus")

If there are no override records yet, explain:
"No override data yet. When you choose a different model than recommended, the override is logged. After 3+ overrides, patterns will be analyzed here."

After showing suggestions, ask if the user wants to apply any of the suggested changes to `config/task-routing.json`.
