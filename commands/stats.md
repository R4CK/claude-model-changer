---
description: "Show usage statistics for model routing - how often each model was used, top categories, auto-routed vs manual counts"
argument-hint: ""
---

The user wants to see their model routing usage statistics.

Run the analyzer with --stats to get computed statistics:
```bash
echo '{"prompt":"--stats"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Parse the JSON output and display in a clean table format:

**Summary:**
- Total prompts analyzed (all time, today, this week)
- Average complexity score

**Model Distribution:**
- Haiku: count and percentage
- Sonnet: count and percentage
- Opus: count and percentage

**Routing Behavior:**
- Auto-routed (high confidence): count
- Borderline (required user input): count
- Manual overrides (@haiku/@sonnet/@opus): count

**Top 5 Categories:**
- Most frequently matched categories with counts

**Cost Savings:**
- Estimated actual cost vs if all tasks used opus
- Amount saved and savings percentage

**Quality Ratings** (if available):
- Average rating per model (1-5 scale)
- Warnings for low-rated model+category combos
- Use `/rate <1-5>` to add ratings

**Budget Status** (if budgets enabled):
- Current usage vs daily/weekly limit per model
- Warning if approaching limits

If no data exists, show: "No usage data yet. The statistics will populate as you use the model router."

For visual charts, suggest: "Use `/dashboard` to generate an interactive HTML dashboard."
