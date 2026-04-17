---
description: "List or manage saved prompt patterns for model routing"
argument-hint: "[delete <index>]"
---

The user wants to view or manage their saved prompt patterns.

**No arguments - List all patterns:**
1. Read `${CLAUDE_PLUGIN_ROOT}/config/patterns.json`
2. Display patterns in a numbered table:

| # | Pattern | Model | Label |
|---|---------|-------|-------|
| 1 | deploy to production | opus | Production deploy |
| 2 | run tests | haiku | Test runner |

If no patterns exist, show: "No saved patterns yet. Use `/save-pattern` to add one."

**`delete <index>` - Remove a pattern:**
1. Parse the index number
2. Read patterns.json
3. Remove the pattern at that index (1-based)
4. Write back
5. Confirm: "Deleted pattern #2: 'run tests'"

**Pattern matching info:**
Patterns are matched as substring (case-insensitive) against the user's prompt. They take priority over keyword scoring but not manual overrides (@model).
