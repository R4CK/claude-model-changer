---
description: "Check the complexity score of a prompt without routing - shows the score breakdown and recommended model"
argument-hint: "<prompt text to analyze>"
---

The user wants to check the complexity score for a given prompt text without actually routing it.

Run the complexity analyzer on the provided arguments:

```bash
echo '{"prompt": "ARGUMENTS_HERE"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Replace `ARGUMENTS_HERE` with the user's arguments, properly escaped for JSON.

Show the user the results in a clear format:
- Complexity score (1-10)
- Complexity level (SIMPLE / MEDIUM / COMPLEX)
- Recommended model (haiku / sonnet / opus)
- Matched category
- Scoring breakdown

This is **informational only** - it does not route or delegate anything.
The user can use this to understand how the router would classify a task,
or to fine-tune their `config/task-routing.json` settings.
