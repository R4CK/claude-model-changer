---
description: "Export the current model routing configuration as a shareable bundle"
argument-hint: "[output-path]"
---

The user wants to export their model routing configuration.

**Steps:**
1. Read these files and bundle them:
   - `${CLAUDE_PLUGIN_ROOT}/config/task-routing.json` (main config)
   - `${CLAUDE_PLUGIN_ROOT}/config/patterns.json` (saved patterns, if exists)
   - Override analysis from `${CLAUDE_PLUGIN_ROOT}/logs/overrides.jsonl` (summary only, not raw logs)

2. Create a bundle JSON:
```json
{
  "exportVersion": "1.0",
  "exportDate": "2024-01-15T10:30:00Z",
  "pluginVersion": "4.0",
  "config": { ...task-routing.json contents... },
  "patterns": { ...patterns.json contents... },
  "overrideSummary": { "totalOverrides": 15, "suggestions": [...] }
}
```

3. Write to the specified path (default: `${CLAUDE_PLUGIN_ROOT}/config/export-YYYY-MM-DD.json`)

4. Confirm: "Configuration exported to config/export-2024-01-15.json"

**Usage:** `/export-config` or `/export-config /path/to/output.json`

This bundle can be imported in another project with `/import-config`.
