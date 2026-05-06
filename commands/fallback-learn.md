---
description: "Show the fallback-learning report: which categories the plugin auto-boosted because of frequent haiku→sonnet fallback events."
argument-hint: ""
---

The user wants to see what the fallback feedback loop has learned.

```bash
echo '{"prompt":"--fallback-learn"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

### Output

JSON with:
- `boosts` — per-category score boost currently applied (empty if no category exceeded the threshold)
- `summary.categories` — per-category fallback rate, sample count, and `boosted: true/false`
- `summary.threshold` — current fallback rate threshold (default 0.3)
- `computedAt` — last recompute timestamp (cache TTL is 6 hours)

### How it works

The plugin reads `logs/fallbacks.jsonl` (populated by the SubagentStop hook when a worker emits `[FALLBACK:sonnet]`) and `logs/usage.jsonl` over the last 30 days. For each category:

1. If `fallback_count / total_count >= 0.3` AND `total_count >= 5`, boost the category's keyword score by +2.
2. The boost auto-routes future prompts in that category to a higher tier.

### Configuration

```json
"fallbackLearning": {
  "enabled": true,           // master switch
  "windowDays": 30,          // recent history window
  "rateThreshold": 0.3,      // 30% fallback rate triggers
  "minSamples": 5,           // need at least 5 events
  "boostPoints": 2           // score boost amount
}
```

### Composition with /tune

`/tune` analyzes user override patterns (when you said "use opus instead").
`/fallback-learn` analyzes auto-fallback patterns (when haiku-worker emitted [FALLBACK:sonnet]).

The two are complementary signals: /tune is *human* feedback, fallback-learn is *machine* feedback.
