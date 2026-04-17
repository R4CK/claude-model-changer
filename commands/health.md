---
name: health
description: Run plugin health diagnostics - check config, logs, agents, hooks, and session state
allowed-tools: Bash

---

# /health - Plugin Health Check

Run a comprehensive health check of the Claude Model Changer plugin.

## Steps

1. Execute the health check:
```bash
echo "--health" | node "PLUGIN_ROOT/scripts/analyze-complexity.js"
```
(Replace PLUGIN_ROOT with the actual plugin installation path from the hook configuration)

2. Display the results in a clear format:

### Status indicators:
- ✅ **ok** - Component is healthy
- ⚠️ **warn** - Minor issue, plugin still works
- ❌ **error** - Critical issue, fix required

### Report sections:
- **Config**: JSON validity, required sections, scoring weights
- **Logs**: File existence, size, data integrity
- **Agents**: Worker files exist with proper frontmatter
- **Hooks**: hooks.json valid, scripts referenced exist
- **Session**: Current session state, staleness

3. If issues are found, suggest specific fixes for each one.
