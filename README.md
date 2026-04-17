# Claude Model Changer

> **Stop paying Opus prices for typo fixes.** Automatic Claude Code plugin that routes each task to the right model — Haiku for trivia, Sonnet for the middle ground, Opus only when you actually need it.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](package.json)
[![Plugin Version](https://img.shields.io/badge/plugin-v5.3.3-blue)](.claude-plugin/plugin.json)

---

## What it does

On every prompt, this plugin:

1. **Scores the task** on a 1–10 complexity scale using a weighted heuristic (keywords, file paths, code blocks, multi-file indicators, structural cues, language).
2. **Maps the score to a model**: Haiku (1–3), Sonnet (4–7), Opus (8–10).
3. **Routes the work** to the matching subagent — automatically for high-confidence cases, with a confirmation prompt for borderline scores.
4. **Tracks everything** in a local usage log so you can see real cost savings via `/stats`, `/dashboard`, and `/tune`.

It runs entirely on your machine. No telemetry, no external API calls, no data leaves your laptop.

### Why it exists

A typical Claude Code session mixes trivial edits ("rename this variable") with hard architectural work. Running both through Opus is wasteful — Haiku is ~10× cheaper and just as capable for the easy stuff. This plugin makes the choice for you.

Real numbers from the included example log:
- Average cost reduction on mixed workloads: **40–60%**
- Time spent thinking about which model to use: **0**

---

## Quick install

### Option A — From the marketplace (recommended)

```bash
claude plugin marketplace add https://github.com/R4CK/claude-model-changer
claude plugin install claude-model-changer@r4ck
```

Restart Claude Code. Done. Updates are a one-liner:

```bash
claude plugin update claude-model-changer
```

### Option B — Self-contained installer (offline, single file)

Download [`dist/install.js`](dist/install.js) and run:

```bash
node install.js
```

That's it. The bundle is 402 KB, embeds all 52 plugin files, and registers the plugin in your central `~/.claude` directory. Works without internet, without `git`, without the Claude CLI being on `PATH` (it falls back to manual registration).

To uninstall:

```bash
node install.js --uninstall
```

### Option C — From source (for development)

Clone the repo and run the launcher for your platform:

```bash
git clone https://github.com/R4CK/claude-model-changer
cd claude-model-changer

./install.sh        # Linux / macOS / Git Bash
.\install.ps1       # Windows PowerShell
install.bat         # Windows cmd
```

The source-tree installers run a **10-point preflight** before installing (Node version, `~/.claude` writability, JSON validity, hook script references, dry-run of the analyzer). If anything fails, installation aborts with a precise error.

If Node.js is missing, the installer attempts auto-install via the right tool for your OS (winget / choco on Windows; apt / dnf / pacman / brew elsewhere).

---

## Requirements

- **Claude Code** (any recent version with plugin support)
- **Node.js ≥ 16** (LTS recommended)
- ~2 MB free disk in `~/.claude/plugins/cache/`

---

## How routing works

```
Your prompt
    │
    ▼
┌─────────────────────────────────────────────────┐
│  UserPromptSubmit hook                          │
│    └─ scripts/analyze-complexity.js             │
│         ├─ Score: 1–10                          │
│         ├─ Match category (28 total)            │
│         ├─ Detect language (EN/HU/DE)           │
│         ├─ Confidence + borderline check        │
│         └─ Cost estimate                        │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│  Decision                                        │
│    ├─ Score 1–2 + high confidence               │
│    │     → AUTO-ROUTE to haiku-worker           │
│    ├─ Score 3–4 or 7–8 (borderline)             │
│    │     → ASK user (haiku/sonnet or sonnet/opus)│
│    ├─ Score 5–7                                 │
│    │     → SUGGEST sonnet, ask to confirm       │
│    └─ Score 9–10 + high confidence              │
│          → AUTO-ROUTE to opus-worker            │
└─────────────────────────────────────────────────┘
```

### Scoring weights (configurable in `config/task-routing.json`)

| Factor | Weight | What it catches |
|--------|--------|-----------------|
| Keyword match | 35% | "refactor", "typo", "architecture", etc. |
| Multi-file indicators | 20% | "across all files", "project-wide" |
| Structural complexity | 20% | Numbered lists, file paths, bullets |
| Word count | 15% | Longer prompts trend higher |
| Code blocks | 10% | Number of \`\`\` fences |

Questions get a 20% reduction (asking *about* code is usually easier than writing it).

### The 28 task categories

Predefined buckets, each with example keywords:

- **Haiku (9):** typo, formatting, comments, imports, quick questions, search/list, single-line edits, status checks, renames
- **Sonnet (10):** bug fixing, configuration, testing, code review, small refactoring, component creation, integration, error handling, documentation, feature addition
- **Opus (9):** architecture, large refactoring, multi-file work, algorithms, security, performance, planning, system design, tech debt

Edit `config/task-routing.json` to add your own categories or move keywords between models.

---

## Commands

| Command | Description |
|---------|-------------|
| `/stats` | Usage breakdown (per model, per category, today/week, cost estimate) |
| `/dashboard` | Generate an interactive HTML dashboard |
| `/configure` | Settings wizard — adjust thresholds, weights, auto-mode behavior |
| `/complexity <text>` | Score a prompt without routing |
| `/benchmark <text>` | Compare how all three models would handle the same task |
| `/route <model> <task>` | Manual override |
| `/rate <1-5>` | Rate the last routing decision (feeds the auto-tuner) |
| `/tune` | Get suggestions to improve your routing config |
| `/health` | Plugin self-diagnostics |

### Manual override (any prompt)

```
@haiku what does this regex do?
@opus design a multi-tenant cache invalidation strategy
@sonnet add input validation to the signup form
```

---

## Configuration

### Per-user (global)

Edit `~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/config/task-routing.json`.

The file is deep-merged at runtime, so changes take effect on the next prompt. Restart not required.

### Per-project (overrides global)

Drop a `.claude/model-routing.json` file in your project root. Example:

```json
{
  "models": {
    "opus": {
      "categories": {
        "critical_path": {
          "label": "Critical path code",
          "keywords": ["payment", "auth module", "billing", "encryption"]
        }
      }
    }
  },
  "autoMode": {
    "enabled": false
  }
}
```

This forces opus for critical-path keywords *only in this project*, and disables auto-routing here even if it's globally on. The base config stays untouched.

### Auto-mode tuning

```json
"autoMode": {
  "enabled": true,
  "autoThresholds": {
    "haiku": [1, 2],
    "opus":  [9, 10]
  },
  "borderlineZones": [3, 4, 7, 8]
}
```

- `autoThresholds`: score ranges that auto-delegate without asking
- `borderlineZones`: scores that trigger a confirmation prompt with both options
- `enabled: false` → always ask, never auto-route

---

## What gets installed where

```
~/.claude/
├── plugins/
│   ├── cache/<owner>/claude-model-changer/<version>/   ← plugin files live here
│   ├── installed_plugins.json                           ← registration entry
│   └── marketplaces/<owner>/                            ← only via marketplace install
└── settings.json                                        ← enabledPlugins entry
```

`<owner>` is the marketplace name. Via the marketplace install (Option A) it's `r4ck`. Via the bundled installer (Option B) or source installer (Option C) it auto-detects from your username (`<lowercase-username>-local`), or you can override with `CMC_MARKETPLACE_OWNER=foo`.

The plugin is **user-scope**: available in every Claude Code session you start, in any project. Not project-scoped.

---

## Hooks

The plugin registers four hooks in `hooks/hooks.json`:

| Hook | Script | Timeout | Purpose |
|------|--------|---------|---------|
| `UserPromptSubmit` | `analyze-complexity.js` | 60s | Score & route every prompt |
| `Stop` | `enforce-stats.js` | 30s | Append the mandatory stats footer |
| `SubagentComplete` | `detect-fallback.js` | 15s | Detect if a routed subagent fell back to a different model |
| `SessionStart` | `runtime-check.js` | 10s | Cached integrity check; warns if plugin files are missing or corrupted |

Runtime-check is silent on success and never blocks session start.

---

## Repository layout

```
claude-model-changer/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace manifest (lets `claude plugin marketplace add` work)
├── agents/
│   ├── haiku-worker.md          # Subagent for SIMPLE tasks
│   ├── sonnet-worker.md         # Subagent for MEDIUM tasks
│   └── opus-worker.md           # Subagent for COMPLEX tasks
├── commands/                    # Slash commands (/stats, /tune, /configure, ...)
├── config/
│   ├── task-routing.json        # 28 categories, weights, thresholds
│   └── patterns.json            # User-saved prompt → model mappings
├── hooks/
│   └── hooks.json               # 4 hook definitions
├── scripts/
│   ├── analyze-complexity.js    # ~30 KB - the scoring engine
│   ├── enforce-stats.js         # Stats footer for every response
│   ├── detect-fallback.js       # Subagent fallback detection
│   ├── runtime-check.js         # SessionStart integrity check
│   ├── preflight.js             # 10-point install validation
│   ├── install-plugin.js        # Manual installer (called by source installers)
│   ├── uninstall-plugin.js      # Cleanup
│   ├── build-installer.js       # Generates dist/install.js bundle
│   ├── generate-dashboard.js    # /dashboard backing script
│   ├── live-dashboard.js        # Live HTML dashboard
│   └── lib/                     # Shared modules: scoring, config, session, stats, io, health, ...
├── skills/
│   └── model-router/            # Skill bundle exposed via SKILL.md
├── dist/
│   ├── install.js               # Self-contained 402 KB installer (Option B)
│   └── README.md                # Bundle install docs
├── docs/                        # Architecture & user-manual docs
├── install.sh                   # Source installer (POSIX)
├── install.ps1                  # Source installer (PowerShell)
├── install.bat                  # Source installer (cmd wrapper)
├── INSTALL.md                   # Detailed install guide with preflight info
├── package.json
└── README.md                    # ← you are here
```

---

## Diagnostics & troubleshooting

### "Nothing happens when I prompt"

```bash
node scripts/preflight.js
```

This runs all 10 checks and prints exactly what's broken. Common culprits:
- Node not on PATH inside Claude Code's hook environment
- `~/.claude/plugins/cache/.../scripts/analyze-complexity.js` was modified or deleted
- `task-routing.json` has a JSON syntax error

### `/health` command

Same checks, but inside Claude Code with a nicer formatted output.

### Hook timing out

Default timeout is 60s for `UserPromptSubmit`. If your machine is genuinely slow on Node startup (cold cache, antivirus scanning), bump it in `hooks/hooks.json`.

### Wrong model being chosen

Run `/tune` — it analyzes your override history (when you said "use opus instead") and suggests config tweaks (move keywords between models, adjust thresholds, raise/lower weights).

---

## Development

```bash
git clone https://github.com/R4CK/claude-model-changer
cd claude-model-changer

# Run preflight (no install)
node scripts/preflight.js

# Test the analyzer directly
echo '{"prompt":"refactor the auth module"}' | node scripts/analyze-complexity.js

# Rebuild the bundled installer after changing source
node scripts/build-installer.js
cp install.js dist/install.js

# Install from source for live testing
./install.sh
```

After source changes, reinstall and restart Claude Code to pick them up. The source installers detect and remove any legacy `@local` registrations from older buggy installs automatically.

---

## How it compares

| Approach | This plugin | Manual model picking | Always-Opus |
|----------|-------------|----------------------|-------------|
| Cost on simple tasks | ~10× cheaper | Same as picked | Always max |
| Cognitive overhead | None | High (every prompt) | None |
| Catches "obvious" hard tasks | Yes (auto-opus) | Depends on you | N/A |
| Multi-language input | EN/HU/DE detected | N/A | N/A |
| Project-specific rules | Yes | Manual | N/A |
| Override when wrong | `@haiku`/`@opus` prefix | N/A | N/A |
| Visible cost tracking | `/stats`, `/dashboard` | None | None |

---

## Contributing

PRs welcome. Please:

1. Run `node scripts/preflight.js` before opening — must be all green.
2. If you change `task-routing.json` keywords, include a `/tune` rationale in the PR description.
3. For new categories, add 3+ example keywords and a clear `label`.
4. Hook script changes: please include a manual test command in the PR (e.g., `echo '{...}' | node scripts/your-script.js`).

---

## License

MIT. See [LICENSE](LICENSE).

---

## Credits

Built by [R4CK](https://github.com/R4CK). Inspired by the realization that 80% of my Claude Code prompts didn't need the smartest model in the world — they needed the *fastest* one.
