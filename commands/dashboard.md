---
description: "Generate and display an HTML statistics dashboard for model routing"
argument-hint: ""
---

The user wants to see a visual statistics dashboard.

**Steps:**
1. Run the dashboard generator:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/generate-dashboard.js"
```
2. This generates `${CLAUDE_PLUGIN_ROOT}/logs/dashboard.html`
3. Tell the user the dashboard has been generated and provide the file path
4. If possible, open it in the default browser:
```bash
start "${CLAUDE_PLUGIN_ROOT}/logs/dashboard.html"
```

**The dashboard shows:**
- Model distribution pie chart (haiku/sonnet/opus usage percentages)
- Top categories bar chart
- Daily usage trend (last 30 days)
- Score histogram (distribution of complexity scores)
- Cost savings summary
- Quality ratings per model (if quality data exists)
- Budget usage status (if budgets are configured)
- Context window usage trend

If no usage data exists, show: "No usage data yet. The dashboard will populate as you use the model router."
