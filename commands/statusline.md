---
description: "Generate a custom Claude Code statusline showing the current routed model, context %, weekly quota %, and estimated session cost."
argument-hint: "[install|remove|format <compact|minimal|verbose>]"
---

The user wants to manage the model-router statusline.

If no argument or `install`: emit the snippet to add to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js\""
}
```

If `remove`: tell the user to delete that block.

If `format <name>`: edit `config/task-routing.json` `statusline.format` to one of `compact|minimal|verbose`.

Otherwise demo the output:

```bash
echo '{}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"
```

Output formats:
- `compact` (default): `🟢 sonnet │ ctx 23% │ wk 12% │ $0.42`
- `minimal`: `🟢 sonnet ctx 23%`
- `verbose`: includes prompt count and full cost

Disable cost display: set `statusline.includeCost: false` in config.
Disable color icons: set `statusline.includeIcon: false`.
