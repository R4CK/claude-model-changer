---
description: "Manage routing profiles (multi-account / multi-context config switching). List, switch, or clear active profile."
argument-hint: "[list | current | switch <name> | clear]"
---

The user wants to manage routing profiles. Profiles are partial configs at `~/.claude/profiles/<name>.json` that overlay on top of the base `task-routing.json`. The active profile applies in addition to per-project `.claude/model-routing.json` (project-level still wins).

Sub-commands:

### `list` (default)

```bash
echo '{"prompt":"--profile-list"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Shows all profiles in `~/.claude/profiles/` and which is active.

### `current`

```bash
echo '{"prompt":"--profile-current"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Reports both:
- The cwd-mapped profile (from `.project-map.json`)
- The globally active profile (from `active.txt`)
- The resolved profile (cwd wins over global)

### `switch <name>`

```bash
echo '{"prompt":"--profile-switch personal"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Sets `~/.claude/profiles/active.txt` to `<name>`. Requires `~/.claude/profiles/<name>.json` to exist.

### `clear`

```bash
echo '{"prompt":"--profile-clear"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

Deletes the active marker so the base config applies.

### Creating a profile

Create `~/.claude/profiles/<name>.json` with any subset of `task-routing.json`. Example:

```json
{
  "planLimits": {
    "weeklyOpus": 100,
    "weeklySonnet": 200,
    "weeklyAllModels": 500
  },
  "quotaAware": {
    "opusDowngradeThreshold": 0.9
  }
}
```

This profile loosens quotas for an account that has higher limits, and only downgrades opus at 90% pressure.
