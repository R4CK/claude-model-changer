---
description: "Save a prompt pattern with a fixed model assignment for automatic routing"
argument-hint: "\"<pattern>\" <model> [label]"
---

The user wants to save a prompt pattern for automatic model routing.

**Parse the argument:**
- Pattern: quoted string (the text pattern to match in prompts)
- Model: haiku, sonnet, or opus
- Label (optional): descriptive name for the pattern

**Example:** `/save-pattern "deploy to production" opus "Production deploy"`

**Steps:**
1. Read `${CLAUDE_PLUGIN_ROOT}/config/patterns.json` (create if doesn't exist with `{"patterns":[]}`)
2. Validate: model must be haiku/sonnet/opus, pattern must be non-empty
3. Check for duplicate patterns (warn if pattern already exists, offer to update)
4. Append new entry: `{"pattern": "deploy to production", "model": "opus", "label": "Production deploy"}`
5. Write back to patterns.json
6. Confirm: "Pattern saved: 'deploy to production' -> opus (Production deploy)"

**If arguments are missing**, show usage: `/save-pattern "<pattern>" <model> [label]`

Patterns are checked before keyword scoring. Priority order:
1. Manual override (@haiku/@sonnet/@opus)
2. Saved patterns (this feature)
3. Keyword scoring
