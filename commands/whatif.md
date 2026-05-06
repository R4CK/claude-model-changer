---
description: "Replay recent prompts under a hypothetical config change to see what would change. Read-only preview — never modifies actual config."
argument-hint: "<op> [args...]"
---

The user wants to simulate a config change before applying it.

Pass arguments through to the simulator:

```bash
echo '{"prompt":"--whatif '"$ARGUMENTS"'"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Or call the simulator directly for richer output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/whatif.js" $ARGUMENTS
```

Supported operations:

| Op | Args | Example |
|---|---|---|
| `move` | `<keyword> <fromModel> <toModel>` | `move refactor sonnet opus` |
| `threshold` | `<model> '[low,high]'` | `threshold opus '[7,10]'` |
| `add-keyword` | `<model> <category> <keyword>` | `add-keyword sonnet bug_fixing "investigate timeout"` |
| `disable` | `<featureName>` | `disable quotaAware` |
| `enable` | `<featureName>` | `enable contextBloat` |

Output shows:
- How many of the last 500 prompts would have changed routing
- Cost delta over the replay window + extrapolated weekly impact
- Distribution before/after per model
- Sample changed prompts (top 10)

The simulator uses a simplified routing path (keyword + scoreRange only); skill triggers, agent teams, quota downgrade, stickiness etc. are NOT replayed because they depend on session state. Use this for keyword/threshold tuning, not for predicting auto-overrides.
