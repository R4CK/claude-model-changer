---
description: "Check the complexity score of a prompt without routing - shows the score breakdown and recommended model. Add --explain to see the full scoring internals."
argument-hint: "[--explain] <prompt text to analyze>"
---

The user wants to check the complexity score for a given prompt text without actually routing it.

## Normal mode

Run the complexity analyzer on the provided arguments:

```bash
echo '{"prompt": "ARGUMENTS_HERE"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Replace `ARGUMENTS_HERE` with the user's arguments, properly escaped for JSON.

## Explain mode (v2.5.0+)

If the user prefixed their arguments with `--explain`, pass it through so the analyzer emits the full internal breakdown:

```bash
echo '{"prompt": "--explain ARGUMENTS_HERE"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

The explain block shows:
- Input tokens: word count, detected language, task type
- Sub-scores with weights (keyword, wordCount, codeBlocks, multiFile, structure, contextBoost)
- Which keyword matched (category + matched text + length)
- Keyword-influence mode (override / boost / none)
- rawScore -> finalScore calculation
- Final model + level
- Confidence breakdown
- Whether adaptive weights or session stickiness kicked in

## Output format

Show the user the results in a clear format:
- Complexity score (1-10)
- Complexity level (SIMPLE / MEDIUM / COMPLEX)
- Recommended model (haiku / sonnet / opus)
- Matched category
- Scoring breakdown
- **(--explain only)** Full ROUTING EXPLANATION block from the analyzer

This is **informational only** - it does not route or delegate anything.
The user can use this to:
- Understand how the router would classify a task
- Fine-tune their `config/task-routing.json` settings
- Debug why a prompt routed to an unexpected model (use `--explain`)
