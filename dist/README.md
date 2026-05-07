# Claude Model Changer v3.4.0 - Self-Contained Installer

A single-file, portable installer. No source tree required - everything is
embedded.

## Install

```bash
node install.js
```

## Uninstall

```bash
node install.js --uninstall
```

## What This Does

The installer extracts 52 plugin files into your Claude Code plugins
directory and registers the Claude Model Changer plugin under a
**per-user marketplace namespace**.

After installation, **restart Claude Code** to activate the plugin.

## Where It Lands

```
~/.claude/plugins/cache/<OWNER>/claude-model-changer/<VERSION>/
```

Registered in:
```
~/.claude/plugins/installed_plugins.json   # under "claude-model-changer@<OWNER>"
~/.claude/settings.json                    # enabledPlugins["claude-model-changer@<OWNER>"] = true
```

### `<OWNER>` resolution (per-machine, portable)

| Environment | `<OWNER>` resolves to |
|---|---|
| `CMC_MARKETPLACE_OWNER=foo` env var set | `foo` (explicit override) |
| Username available (USER / USERNAME / USERPROFILE) | `<lowercase-username>-local` |
| No username at all | `user-local` |

Examples:
- Username `NEON` → `neon-local`
- Username `alice` → `alice-local`
- `CMC_MARKETPLACE_OWNER=acme-corp node install.js` → `acme-corp`

The installer prints the resolved owner at start, e.g.:
```
Files: 52 | Marketplace: neon-local (auto-detected from username)
```

### Legacy `@local` cleanup

A previous buggy version of the installer hardcoded the marketplace key to
`claude-model-changer@local` (not matching the cache subdir). The current
installer **automatically detects and removes that legacy entry** from both
`installed_plugins.json` and `enabledPlugins` on next install.

## Requirements

- Node.js >= 16.0
- Claude Code installed (the `~/.claude` directory must exist)

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

## Routing Logic

- 28 task categories mapped to 3 models (haiku / sonnet / opus)
- 4 hooks active: `UserPromptSubmit`, `Stop`, `SubagentComplete`, `SessionStart`
- The `SessionStart` hook performs a runtime integrity check (silent on success,
  warns on missing files)

## Differences vs. Source Tree Installer

The source tree (`G:/LM_Studio_Workdir/Claude Modell Changer/`) ships with
launchers that perform a **full preflight** (10 checks) before installing:

- `install.sh` (Linux / macOS / Git Bash)
- `install.ps1` (Windows PowerShell)
- `install.bat` (Windows cmd)

The bundled `install.js` here is **simpler** - it just extracts and registers,
no preflight UI. Use this for distribution; use the source-tree installers for
development.

## Documentation

Full docs in the source tree:
- `INSTALL.md` - Detailed installation guide with preflight info
- `docs/USER-MANUAL.md` - Complete user manual
- `docs/DEVELOPMENT.md` - Architecture, history, and bug fixes
