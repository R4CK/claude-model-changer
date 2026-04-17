# Installation

The installer **mandates a full preflight check before installing**. If any
prerequisite fails, installation aborts with a clear error message and the
plugin is NOT registered.

## Quick start

| Platform | Command |
|---|---|
| Linux / macOS / Git Bash | `./install.sh` |
| Windows PowerShell | `.\install.ps1` |
| Windows cmd.exe | `install.bat` |

All three converge on the same logic via `scripts/preflight.js`.

## Installation target (where it lands)

The plugin is installed to the **central, user-scope** Claude directory — NOT
into the current project. Specifically:
```
~/.claude/plugins/cache/<OWNER>/claude-model-changer/<VERSION>/
```
And registered in:
```
~/.claude/plugins/installed_plugins.json     # under "claude-model-changer@<OWNER>"
~/.claude/settings.json                      # enabledPlugins["claude-model-changer@<OWNER>"] = true
```
Result: the plugin is available in **every** Claude Code session on the user
account, regardless of which project you open.

### `<OWNER>` resolution (per-machine, portable)

The marketplace owner name is **derived per-machine** so the same source
directory installs cleanly on any user account:

| Environment | `<OWNER>` resolves to |
|---|---|
| `CMC_MARKETPLACE_OWNER=foo` env var set | `foo` (explicit override wins) |
| Username available (`USER` / `USERNAME` / `USERPROFILE`) | `<lowercase-sanitized-username>-local` |
| No username at all | `user-local` |

Examples:
- Username `NEON` → `neon-local` → `~/.claude/plugins/cache/neon-local/...`
- Username `alice` → `alice-local` → `~/.claude/plugins/cache/alice-local/...`
- `CMC_MARKETPLACE_OWNER=acme-corp` → `acme-corp` → `~/.claude/plugins/cache/acme-corp/...`

The installer prints the resolved owner before installing, so it's never a
surprise. **Backward-compatible:** on the original author's machine
(username `NEON`), the dynamic value resolves to `neon-local`, which exactly
matches the existing registration — no duplicate is created.

### Legacy `@local` cleanup

A previous buggy version of `install-plugin.js` hardcoded the owner to `local`,
which could create a `claude-model-changer@local` duplicate alongside the real
`@<owner>` registration. The fixed installer **detects and removes that legacy
entry** automatically on the next run, from both `installed_plugins.json` and
`enabledPlugins`.

## What the installer checks

1. **Node.js >= 16** (matches `package.json` engines). If missing, attempts
   auto-install via:
   - **Linux:** apt-get / dnf / pacman
   - **macOS:** Homebrew
   - **Windows:** winget, then Chocolatey
2. **Central `~/.claude` directory exists and is writable** (created by Claude
   Code on first run — if you've never run Claude Code, do that once first)
3. **Claude Code CLI on PATH** (warning only — install-time copy works without
   it, but you need `claude` to actually use the plugin)
4. **Required directories** (8): `agents/`, `commands/`, `skills/`, `config/`,
   `hooks/`, `scripts/`, `scripts/lib/`, `.claude-plugin/`
5. **Required files** (21) — every file referenced by hooks plus all `lib/`
   modules
6. **JSON validity** of `plugin.json`, `hooks.json`, `task-routing.json`,
   `patterns.json`, `package.json`
7. **Hook script references** — every script mentioned in `hooks/hooks.json`
   must exist on disk
8. **`logs/` writable** (write-probe + delete)
9. **`scripts/install-plugin.js` present** (the actual cache-copier)
10. **Hook dry-run** — actually executes `analyze-complexity.js` with a dummy
    payload; must return exit 0

If all checks pass, the installer delegates to the project's own installer:
```
node scripts/install-plugin.js
```
which performs the file copy + manifest registration described above.

## Standalone preflight (no install)

```bash
node scripts/preflight.js              # human-readable
node scripts/preflight.js --json       # machine-readable
node scripts/preflight.js --runtime    # subset (skip claude CLI / hook dry-run)
```

## Runtime self-check

A `SessionStart` hook (in `hooks/hooks.json`) runs `scripts/runtime-check.js`
once per session. It calls preflight in `--runtime` mode and:
- **Stays silent** if everything is fine (no overhead, no noise)
- **Emits a warning into the session context** if any file is missing or any
  JSON is corrupt, with the exact problem and a hint to re-run the installer

The runtime check **never blocks** session start - even on internal failure it
exits 0.

## PowerShell-specific options

```powershell
.\install.ps1 -SkipAutoInstall   # skip Node.js auto-install attempt
```

## Troubleshooting

**"Claude Code CLI not found on PATH"** — Install Claude Code from
<https://docs.claude.com/en/docs/claude-code> and reopen your shell.

**"Auto-install completed but Node.js still < 16"** — Open a fresh shell so
`PATH` refreshes. On Windows, this is required after winget/choco installs.

**"Hook dry-run (analyze-complexity) - exit 1: Cannot find module ..."** — The
plugin directory is incomplete. Re-clone or restore from backup; a partial copy
is the most common cause of this error.

**Manual install (bypasses all preflight checks - not recommended):**
```bash
node scripts/install-plugin.js
```
Same end result, but no validation that the plugin tree is intact or that
`~/.claude` is writable.
