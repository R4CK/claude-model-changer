# Updating the plugin

This page explains how to receive new versions of `claude-model-changer`
depending on how you originally installed it.

## Decision tree

```
How did you install this plugin?
│
├─ Via Claude Code marketplace (github source)
│  → Auto-updates work. See "GitHub-source marketplace" below.
│
├─ Via local clone / path source
│  → Manual update. See "Path-source marketplace" below.
│
└─ Via the self-extracting installer (dist/install.js)
   → Re-run install.js to upgrade. See "Self-extracting installer" below.
```

## GitHub-source marketplace (recommended)

The simplest setup. In your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "r4ck": {
      "source": {
        "source": "github",
        "repo": "R4CK/claude-model-changer"
      },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "claude-model-changer@r4ck": true
  }
}
```

**Behavior:**
- `autoUpdate: true` → Claude Code refreshes the marketplace on each session
  start. New tags (e.g. `v3.2.2`) are picked up automatically.
- `autoUpdate: false` (or omitted) → manual refresh via the `/plugin` UI or
  by deleting `~/.claude/plugins/cache/r4ck/`.

## Path-source marketplace (advanced — local development)

Use this if you want to edit the plugin yourself or run a fork. Your
`extraKnownMarketplaces` entry points to a local directory:

```json
"deutschpeter-local": {
  "source": {
    "source": "path",
    "path": "/path/to/your/local/marketplace-root"
  }
}
```

**Behavior:**
- The marketplace tree is your source of truth. Claude Code does NOT pull
  from GitHub.
- New upstream releases require either a manual `git pull` of your local
  repo OR the helper script described below.

### Helper: `update-from-github.js`

The plugin ships `scripts/update-from-github.js` for path-source users
who still want occasional updates from upstream:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-from-github.js"            # latest tag
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-from-github.js" --tag v3.2.1  # pin
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-from-github.js" --dry       # show diff
```

The script:
1. Clones (or fetches) `https://github.com/R4CK/claude-model-changer.git`
   into `~/.claude/plugins/cache/<owner>/external/claude-model-changer/`
2. Checks out the requested tag (default: most recent `v*` tag)
3. Copies the upstream tree over your marketplace source, EXCLUDING
   `logs/`, `.git/`, `node_modules/`, and any path listed in a
   `.update-preserve` file at the marketplace root (one path per line).

After running, restart Claude Code (or trigger a plugin reload) for the
cache to refresh.

### `.update-preserve` example

If you have local edits you want to keep across updates, create
`<marketplace>/plugins/claude-model-changer/.update-preserve`:

```
# Don't overwrite my custom config or HU keyword expansions
config/task-routing.json
config/patterns.json
```

## Self-extracting installer

If you originally installed via `node install.js` from a release artifact:

```bash
# Download the latest dist/install.js from a GitHub release
curl -LO https://github.com/R4CK/claude-model-changer/releases/latest/download/install.js
node install.js
```

Re-running the installer:
- Detects existing install
- Cleans up old versioned cache directories (keeps newest + 1 previous)
- Re-registers hooks (idempotent)

## Verifying your installed version

```bash
echo '{"prompt":"--health"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js" | jq '.checks.config'
```

Or simply check the version file:

```bash
cat ~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/.claude-plugin/plugin.json | jq '.version'
```

## Recommended autoUpdate setting

We recommend `autoUpdate: true` for github-source marketplaces because:
- Releases follow semver — patch versions (3.2.x) are bug fixes only
- Backward compat is enforced (every feature is config-gated)
- The `Preflight` GitHub Action runs on every PR, so tagged releases pass
  79+ unit tests + integrity checks before they ship

If you want to pin a specific version, omit `autoUpdate` and use a release
tag URL or the self-extracting installer for that specific version.
