---
description: "Show current session summary - model usage percentages, skills used, and prompt count"
argument-hint: ""
---

The user wants to see their current session's model and skill usage summary.

Run the analyzer with --session-summary to get session data:
```bash
echo '{"prompt":"--session-summary","session_id":"$SESSION_ID"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Parse the JSON output and display in a clean format:

**Session Summary:**
- Session start time (if available)
- Total prompts analyzed in this session

**Model Usage Distribution:**
- Haiku: count and percentage (with bar visualization)
- Sonnet: count and percentage (with bar visualization)
- Opus: count and percentage (with bar visualization)

**Skills Used:**
- List of /commands invoked during this session with counts
- If none, show: "No skills used yet in this session."

**Estimated Token Usage:**
- Total estimated tokens consumed in this session

If no data exists, show: "No session data yet. The summary will populate as you use the model router."

For full historical stats, suggest: "Use `/stats` for all-time statistics or `/dashboard` for visual charts."
