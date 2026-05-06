---
description: "Show current weekly + 5-hour rolling quota usage with downgrade pressure indicators."
argument-hint: ""
---

The user wants to inspect their plugin-tracked quota state.

Run:

```bash
echo '{"prompt":"--quota"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Display as:

```
📊 Weekly quota
  Haiku   ████░░░░░░  41% (15/100)
  Sonnet  ██████░░░░  60% (12/50)   ← warning >70%
  Opus    █████████░  87% (26/30)   ← downgrade triggered

⏱  5-hour rolling
  All     ███░░░░░░░  28% (14/50)

Auto-downgrade: opus → sonnet active (Opus 87% >= threshold 80%)
```

Key flags from the JSON:
- `overWeeklyOpus`: true when opus week limit hit
- `pressure.opus`: 0..1 ratio
- `weeklyPct.{model}`: percentages
- `burstPct.all`: 5h rolling window percentage

Tune via `config.quotaAware`:
- `enabled` (default true)
- `opusDowngradeThreshold` (default 0.8)
- `opusFallbackModel` (default "sonnet")
- `respectBurstLimit` (default true)
