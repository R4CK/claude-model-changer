# Claude Model Changer v2.2.0 - Installer

## Install

```bash
node install.js
```

## Uninstall

```bash
node install.js --uninstall
```

## What This Does

The installer extracts 50 plugin files into your Claude Code plugins directory and registers the Claude Model Changer plugin. After installation, restart Claude Code.

## Requirements

- Node.js >= 16.0
- Claude Code installed

## After Install

The plugin activates automatically on every prompt. Available commands:

| Command | Description |
|---------|-------------|
| `/stats` | Usage statistics |
| `/dashboard` | Visual HTML dashboard |
| `/configure` | Settings wizard |
| `/health` | Plugin diagnostics |
| `/complexity <prompt>` | Check score without routing |
| `/benchmark <prompt>` | Compare all models |
| `/rate <1-5>` | Rate routing quality |
| `/tune` | Get tuning suggestions |

Override model: `@haiku`, `@sonnet`, or `@opus` before your prompt.

## Documentation

Full docs in the `docs/` directory:
- `INSTALL.md` - Detailed installation guide
- `USER-MANUAL.md` - Complete user manual
- `DEVELOPMENT.md` - Architecture, history, and all 28 bug fixes
