# Claude Model Changer - Installation Guide

## Requirements

- **Claude Code** (CLI) installed and working
- **Node.js** >= 16.0.0
- **Operating System**: Windows, macOS, or Linux

## Quick Install

### Option 1: Self-Extracting Installer (Recommended)

Copy `dist/install.js` to any directory and run:

```bash
node install.js
```

This will:
1. Create the marketplace structure in `~/.claude/plugins/`
2. Extract all 50+ plugin files
3. Register the plugin via Claude CLI (or manual fallback)
4. Generate a file integrity manifest
5. Display available commands

### Option 2: Deploy from Source

If you have the source repository:

```bash
cd "path/to/Claude Modell Changer"
node scripts/deploy.js
```

This copies files to the plugin cache at `~/.claude/plugins/cache/neon-local/claude-model-changer/2.2.0/`.

### Option 3: Manual Installation

1. Copy the entire plugin directory to:
   ```
   ~/.claude/plugins/marketplaces/neon-local/plugins/claude-model-changer/
   ```

2. Create `~/.claude/plugins/marketplaces/neon-local/.claude-plugin/marketplace.json`:
   ```json
   {
     "name": "neon-local",
     "description": "Local marketplace for Claude Model Changer plugin",
     "owner": { "name": "NEON" },
     "plugins": [{
       "name": "claude-model-changer",
       "source": "./plugins/claude-model-changer",
       "category": "development"
     }]
   }
   ```

3. Restart Claude Code

## Uninstall

```bash
node install.js --uninstall
```

Or manually:
```bash
# Remove cache
rm -rf ~/.claude/plugins/cache/neon-local/claude-model-changer

# Remove marketplace entry
rm -rf ~/.claude/plugins/marketplaces/neon-local/plugins/claude-model-changer

# Remove manifest
rm -f ~/.claude/plugins/.install-manifests/claude-model-changer@neon-local.json
```

## Verify Installation

After restarting Claude Code, run:

```
/health
```

This runs full diagnostics: config validation, log integrity, agent checks, hook verification, and session state health.

## Post-Install Configuration

The plugin works out of the box with sensible defaults. To customize:

```
/configure
```

This opens an interactive wizard for:
- Preference profiles (cost-saver / balanced / quality-first)
- Score ranges per model
- Keyword category management
- Auto-routing thresholds

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin not detected | Restart Claude Code after installation |
| Hooks not firing | Run `/health` to verify hook registration |
| Stats not displaying | Check `logs/session-state.json` exists |
| Config errors | Run `/health` to validate config |
| Double counting | Ensure `settings.local.json` has no duplicate hooks |

## File Structure After Install

```
~/.claude/plugins/
  cache/neon-local/claude-model-changer/2.2.0/
    scripts/
      analyze-complexity.js    # Main routing hook
      detect-fallback.js       # Subagent tracking hook
      enforce-stats.js         # Stats display hook
      session-utils.js         # Session state management
      lib/                     # Modular libraries (14 modules)
    config/
      task-routing.json        # Main configuration
    agents/
      haiku-worker.md          # Simple task worker
      sonnet-worker.md         # Moderate task worker
      opus-worker.md           # Complex task worker
    commands/                  # 14 slash commands
    skills/model-router/       # Routing skill definition
    hooks/hooks.json           # Hook registrations
    logs/                      # Runtime logs (auto-created)
```
