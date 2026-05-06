---
description: "Export plugin telemetry as Prometheus text-format metrics for scraping or pushgateway."
argument-hint: "[output-file]"
---

The user wants Prometheus-format metrics from the model router plugin.

If an argument is given, treat it as an output file path. Otherwise emit to stdout.

```bash
echo '{"prompt":"--metrics"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Or run the exporter directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/export-prometheus.js" $ARGUMENTS
```

After running, briefly summarize what metrics are exposed:
- `model_routing_total` — counter per model + auto-route flag
- `model_routing_score_bucket` — histogram of complexity scores
- `effort_distribution` — counter per effort level (low/medium/high)
- `subagent_fallback_total` — counter of fallback events between models
- `user_quality_rating_avg` — gauge of average quality rating per model
- `session_tokens_estimated_used`, `session_prompt_count`, `session_model_count` — current-session gauges

The output is plain text, ready for Prometheus scraping or `curl --data-binary @file.txt http://pushgw/metrics/job/claude-router`.
