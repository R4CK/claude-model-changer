---
description: "Import a model routing configuration bundle from a file"
argument-hint: "<path-to-bundle>"
---

The user wants to import a configuration bundle.

**Steps:**
1. Read the bundle file at the specified path
2. Validate it has `exportVersion` and `config` fields
3. Show a summary of what will change:
   - Number of model categories being imported
   - Number of patterns being imported
   - Key config differences (e.g., "scoring weights differ", "new categories found")

4. **Ask for confirmation** before applying: "This will merge the imported config with your current config. Existing values will be overwritten by imported values. Proceed?"

5. If confirmed:
   - Deep-merge imported config into `${CLAUDE_PLUGIN_ROOT}/config/task-routing.json`
   - Merge patterns into `${CLAUDE_PLUGIN_ROOT}/config/patterns.json`
   - Create a backup of current config: `config/task-routing.backup.json`

6. Confirm: "Configuration imported successfully. Backup saved to config/task-routing.backup.json"

**If path is missing**, show: "Usage: `/import-config <path-to-bundle.json>`"
**If file doesn't exist or is invalid**, show an error message.
