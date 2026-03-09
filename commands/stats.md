---
description: "Show usage statistics for model routing - how often each model was used, top categories, auto-routed vs manual counts"
argument-hint: ""
---

The user wants to see their model routing usage statistics.

Read the log file at `${CLAUDE_PLUGIN_ROOT}/logs/usage.jsonl` and parse each line as JSON.

Calculate and display these statistics in a clean table format:

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

If the log file doesn't exist or is empty, tell the user:
"No usage data yet. The statistics will populate as you use the model router."

Format the output as a clear, readable summary with aligned columns.
