---
description: "Generate a narrative weekly cost + usage digest. Auto-saves to logs/ and prints to stdout."
argument-hint: "[--week N] [--json] [--stdout]"
---

The user wants the weekly cost digest report.

```bash
echo '{"prompt":"--weekly-digest"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Or call the script directly for more options:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/weekly-digest.js" $ARGUMENTS
```

### Output

Markdown report with:
- Total prompts this week (vs last week)
- Cost estimate (vs last week)
- Saved vs all-opus baseline
- Active profile (if R43 in use)
- Model distribution + percentages
- Effort breakdown (low / medium / high)
- Top 5 categories
- Quality avg + fallback events count
- Git activity (commits, pushes, force-pushes)
- Anomalies (opus usage spikes)

### Periodic runs

For a weekly cron, hook to `/loop`:

```
/loop 7d node "${CLAUDE_PLUGIN_ROOT}/scripts/weekly-digest.js" --stdout
```

Or use the `scheduled-tasks` MCP for a true cron schedule.

### Comparison with /stats and /metrics

| Tool | Format | Audience |
|---|---|---|
| `/stats` | JSON | Real-time, programmatic |
| `/metrics` | Prometheus text | Scraping / dashboards |
| `/weekly-digest` | Markdown narrative | Humans, weekly review |

All three read the same `logs/usage.jsonl` source.
