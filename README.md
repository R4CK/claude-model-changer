# Claude Model Changer

> **Stop paying Opus prices for typo fixes.** Automatic Claude Code plugin that routes each task to the right model — Haiku for trivia, Sonnet for the middle ground, Opus only when you actually need it. Now with quota awareness, statusline, context bloat detection, agent teams support, git hooks, and more.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](package.json)
[![Plugin Version](https://img.shields.io/badge/plugin-v3.10.0-blue)](.claude-plugin/plugin.json)
[![CI](https://github.com/R4CK/claude-model-changer/actions/workflows/preflight.yml/badge.svg)](https://github.com/R4CK/claude-model-changer/actions/workflows/preflight.yml)
[![Latest Release](https://img.shields.io/github/v/release/R4CK/claude-model-changer)](https://github.com/R4CK/claude-model-changer/releases/latest)

---

## What it does

On every prompt, this plugin:

1. **Scores the task** on a 1–10 complexity scale using a weighted heuristic (keywords, file paths, code blocks, multi-file indicators, structural cues, language, MCP-tool density).
2. **Maps the score to a model**: Haiku 4.5 (1–3), Sonnet 4.6 (4–7), Opus 4.7 (8–10) — with optional 1M context for Opus.
3. **Recommends a thinking budget** (low / medium / high) so downstream tooling can set `thinking.budget_tokens` appropriately.
4. **Routes the work** to the matching subagent — automatically for high-confidence cases, with a confirmation prompt for borderline scores.
5. **Watches your quota** — auto-downgrades Opus → Sonnet when your weekly Opus usage approaches the limit.
6. **Tracks context bloat** — flags repeated reads of the same file so you don't waste tokens.
7. **Tracks everything** in local logs — see real cost savings via `/stats`, `/dashboard`, `/quota`, `/context-audit`, and `/tune`.

It runs entirely on your machine. No telemetry, no external API calls, no data leaves your laptop.

### Why it exists

A typical Claude Code session mixes trivial edits ("rename this variable") with hard architectural work. Running both through Opus is wasteful — Haiku is ~10× cheaper and just as capable for the easy stuff. This plugin makes the choice for you.

Real numbers from the included example log:
- Average cost reduction on mixed workloads: **40–60%**
- Time spent thinking about which model to use: **0**

---

## What's new

The plugin has matured significantly since v3.0.0. Quick tour:

| Version | Theme | Key features |
|---|---|---|
| **v3.4.0** | Keyword expansion + bugfix | Vocabulary expanded by **+232 IT-jargon keywords** across all 30 categories (EN +81, HU +75, DE +76). Fix for `reaktorozd` → `refaktoráld` (the original word was nuclear-reactor jargon, not software). HU/DE language detection threshold lowered from 3 → 2 with stem-based heuristics so terse 2-3 word prompts (`refaktorozd a kódot`, `Bug beheben`) reliably trigger their language path. |
| **v3.3.0** | 7 community features | Fallback feedback loop (auto-learn from `[FALLBACK:sonnet]`), `/whatif` config simulator, proactive compact suggestion (context % + topic-shift), `/undo` last routing, token estimator preview, weekly digest (markdown narrative), multi-profile / multi-account switching |
| **v3.2.3** | README refresh | Documentation only — covers v3.0.0 → v3.2.2 features |
| **v3.2.2** | Update flow | `UPDATING.md` guide, `update-from-github.js` helper for path-source users |
| **v3.2.1** | Harmony fixes | Skill trigger and Agent Teams overrides now actually win when they should; consolidated PreToolUse hook |
| **v3.2.0** | 8 community features | Quota-aware routing, custom statusline, context bloat detector, git commit hooks, Agent Teams role detection, auto-benchmark, CC 2.1+ awareness, `/quota` /`/context-audit` /`/git-router-stats` /`/auto-benchmark` /`/statusline` commands |
| **v3.1.1** | Karpathy auto-sync | SessionStart hook silently keeps `karpathy-guidelines` skill fresh from upstream |
| **v3.1.0** | Claude 4.x | Updated Haiku 4.5 / Sonnet 4.6 / Opus 4.7 pricing + IDs, 1M context for `opus-1m`, effort → thinking budget mapping, MCP-tool density scoring, skill trigger detection (10 default rules), plan-mode awareness, fast-mode awareness, parallel dispatch detection, Hungarian morphology + IT-jargon expansion, auto-memory integration, Prometheus telemetry exporter |
| v3.0.0 | Architecture | Atomic I/O, config hot-reload, optimistic concurrency for session state |
| v2.7.0 | Effort | Low / Medium / High reasoning budget recommendation, orthogonal to model |
| v2.x | Foundation | 30 task categories, multi-language (EN/HU/DE), LLM-fallback classifier, anomaly detection, adaptive weights, sticky sessions, project-aware boost |

See [CHANGELOG.md](CHANGELOG.md) for the full release notes.

---

## Quick install

### Option A — From the marketplace (recommended)

```bash
claude plugin marketplace add https://github.com/R4CK/claude-model-changer
claude plugin install claude-model-changer@r4ck
```

Restart Claude Code. Done. With `autoUpdate: true` set on the marketplace, new releases land automatically on the next session start.

```json
"extraKnownMarketplaces": {
  "r4ck": {
    "source": { "source": "github", "repo": "R4CK/claude-model-changer" },
    "autoUpdate": true
  }
}
```

Manual update:

```bash
claude plugin update claude-model-changer
```

### Option B — Self-contained installer (offline, single file)

Download [`dist/install.js`](dist/install.js) and run:

```bash
node install.js
```

The bundle is ~600 KB, embeds all plugin files, and registers the plugin in your central `~/.claude` directory. Works without internet, without `git`, without the Claude CLI being on `PATH` (it falls back to manual registration).

To uninstall:

```bash
node install.js --uninstall
```

### Option C — From source (for development)

```bash
git clone https://github.com/R4CK/claude-model-changer
cd claude-model-changer

./install.sh        # Linux / macOS / Git Bash
.\install.ps1       # Windows PowerShell
install.bat         # Windows cmd
```

The source-tree installers run a **10-point preflight** before installing (Node version, `~/.claude` writability, JSON validity, hook script references, dry-run of the analyzer). If anything fails, installation aborts with a precise error.

If Node.js is missing, the installer attempts auto-install via the right tool for your OS (winget / choco on Windows; apt / dnf / pacman / brew elsewhere).

### Updating

See [UPDATING.md](UPDATING.md) for the full update flow per install method.

---

## Requirements

- **Claude Code** 2.x (any recent version with plugin support; CC 2.1+ unlocks extra features)
- **Node.js ≥ 16** (LTS recommended)
- ~2 MB free disk in `~/.claude/plugins/cache/`

### Compatibility Matrix

| Component | Minimum | Tested | Notes |
|---|---|---|---|
| Claude Code | 2.x | 2.1.117+ | CC 2.1+ feature flags auto-detected (native binary, persistent model selection, inline thinking, fast MCP startup) |
| Node.js | 16 LTS | 16 / 18 / 20 / 22 / 25 | Auto-install via source installer |
| Windows | 10+ | 11 | PowerShell + cmd installers work; WSL also supported |
| macOS | 12+ | 13–15 | Source installer preferred |
| Linux | any distro with Node ≥16 | Ubuntu 22.04 | CI runs here |

---

## Getting Started (30 seconds)

After installing (see above) and restarting Claude Code:

1. Type any prompt — `fix the typo on line 5`
2. Plugin routes to **haiku** automatically:
   ```
   [Model Router] Complexity: SIMPLE (score 1/10) -> Recommended: haiku
   Tokens preview: ~7 in + ~1500 out → $0.0075 at haiku (haiku $0.0075 · sonnet $0.0225 · opus $0.1126)
   Effort: low (trivial category 'typo_fix') | thinking budget: 0 tokens
   ```
3. Try a harder one — `design a multi-tenant cache invalidation strategy`
4. Plugin routes to **opus** (automatic at high confidence):
   ```
   [Model Router] Complexity: COMPLEX (score 9/10) -> Recommended: opus
   Effort: high (category 'system_design' is in highCategories) | thinking budget: 16000 tokens
   ```
5. Run `/stats` to see the saved cost so far. Run `/quota` to see your weekly budget. Run `/dashboard` for a visual.

That's it. The plugin is now invisible infrastructure; focus on your actual work.

---

## Cost Model (Claude 4.x pricing)

**No new billing.** Model routing is free; you already pay for your own Claude Code usage. The plugin just picks the cheapest model capable of the task.

Typical savings on mixed workloads:

| Workload | Without plugin (all Opus) | With plugin | Savings |
|---|---|---|---|
| 100 typo fixes + 20 bug fixes + 10 architecture tasks | ~$90 | ~$28 | **~69%** |
| Heavy refactor session (mostly Sonnet-level) | ~$45 | ~$22 | **~51%** |
| Pure architecture sprint (mostly Opus) | ~$90 | ~$85 | ~5% |

Run `/stats` in a Claude Code session to see your actual savings vs an all-Opus baseline.

| Model | Input $/1M | Output $/1M | Relative | Context |
|---|---|---|---|---|
| Haiku 4.5 | $1.00 | $5.00 | 1× | 200K |
| Sonnet 4.6 | $3.00 | $15.00 | 3× | 200K |
| Opus 4.7 | $15.00 | $75.00 | 15× | 200K |
| Opus 4.7 [1m] | $15.00 | $75.00 | 15× | **1M** |

---

## How routing works (v3.2.x pipeline)

```
Your prompt
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Manual override? (@haiku, @sonnet, @opus)            │  early return
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Saved pattern match? (config/patterns.json)          │  early return + quota check
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ analyze-complexity.js                                │
│  ├─ Score (1–10) from 5 sub-scores                   │
│  ├─ Match category (30 total)                        │
│  ├─ Detect language (EN/HU/DE) + Hungarian morphology│
│  ├─ Fallback boost (+0..N, v3.3.0 R30)               │
│  │   from logs/fallbacks.jsonl learning              │
│  ├─ Confidence + borderline check                    │
│  ├─ contextBoost layers:                             │
│  │   • project type (+0..3)                          │
│  │   • prompt history (+0..3)                        │
│  │   • plan mode (+1 if active)                      │
│  │   • MCP tool density (+0..3)                      │
│  │   • parallel dispatch (+2 unless Agent Teams lead)│
│  └─ keywordInfluence override (configurable)         │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Skill trigger override? (10 default rules, v3.2.1)   │
│  e.g., superpowers:debugging → sonnet+high           │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Agent Teams role override? (CC 2.1+)                 │
│  "as team lead" → opus+high                          │
│  "as teammate"  → sonnet+medium                      │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Sticky session? (only if not auto-routing)           │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Quota-aware downgrade (final word)                   │
│  Opus weekly ≥80%? → opus → sonnet automatically     │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ Effort decision (parallel pipeline)                  │
│  determineEffort → memory hint nudge → fast mode     │
│   → low / medium / high + thinking budget hint       │
└──────────────────────────────────────────────────────┘
```

### Scoring weights (configurable in `config/task-routing.json`)

| Factor | Weight | What it catches |
|--------|--------|-----------------|
| Keyword match | 35% | "refactor", "typo", "architecture", etc. |
| Multi-file indicators | 20% | "across all files", "project-wide" |
| Structural complexity | 20% | Numbered lists, file paths, bullets |
| Word count | 15% | Longer prompts trend higher |
| Code blocks | 10% | Number of ` ``` ` fences |
| contextBoost | additive | Project type + history + plan mode + MCP + parallel |

Questions get a 20% reduction (asking *about* code is usually easier than writing it).

### The 30 task categories

Predefined buckets, each with example keywords:

- **Haiku (9):** typo, formatting, comments, imports, quick questions, search/list, single-line edits, status checks, renames
- **Sonnet (12):** bug fixing, configuration, testing, code review, small refactoring, component creation, integration, error handling, documentation, feature addition, performance debugging, code investigation
- **Opus (9):** architecture, large refactoring, multi-file work, algorithms, security, performance audit, planning, system design, tech debt

Multi-language (EN/HU/DE) with **Hungarian morphology** support for proper handling of inflected forms (`elgépelést`, `refaktoráld`, etc.).

Edit `config/task-routing.json` to add your own categories or move keywords between models.

---

## Commands

### Core

| Command | Description |
|---------|-------------|
| `/stats` | Usage breakdown (per model, per category, today/week, cost estimate) |
| `/dashboard` | Generate an interactive HTML dashboard |
| `/summary` | Current-session quick summary |
| `/configure` | Settings wizard — adjust thresholds, weights, auto-mode behavior |
| `/health` | Plugin self-diagnostics |
| `/effort` | Show current Effort recommendation config + last 20 decisions |

### Diagnostic & analysis

| Command | Description |
|---------|-------------|
| `/complexity <text>` | Score a prompt without routing |
| `/benchmark <text>` | Compare how all three models would handle the same task |
| `/auto-benchmark` | Run the canonical 10-prompt benchmark + drift detection (v3.2.0) |
| `/quota` | Weekly + 5-hour rolling quota state with downgrade pressure indicators (v3.2.0) |
| `/context-audit` | Heatmap: what's eating your context window (v3.2.0) |
| `/git-router-stats` | Git commit/push hook statistics (v3.2.0) |
| `/metrics` | Prometheus text-format metrics export (v3.1.0) |
| `/whatif <op>` | Simulate a config change against last 500 prompts (v3.3.0) |
| `/weekly-digest` | Generate a narrative weekly cost + usage report (v3.3.0) |
| `/fallback-learn` | Show categories auto-boosted from `[FALLBACK:sonnet]` events (v3.3.0) |

### Routing & overrides

| Command | Description |
|---------|-------------|
| `/route <model> <task>` | Manual override |
| `/save-pattern <pattern> <model> [label]` | Save a routing rule |
| `/patterns` | List or manage saved patterns |
| `/rate <1-5>` | Rate the last routing decision (feeds the auto-tuner) |
| `/tune` | Get suggestions to improve your routing config |
| `/learn` | Review LLM-fallback classification suggestions and keyword candidates |
| `/statusline` | Manage the custom statusline integration (v3.2.0) |
| `/undo` | Re-route the previous prompt to next-tier model + auto-rate as poor (v3.3.0) |

### Configuration

| Command | Description |
|---------|-------------|
| `/export-config [path]` | Export current config as a shareable bundle |
| `/import-config <path>` | Import a config bundle |
| `/profile [list\|current\|switch <name>\|clear]` | Manage routing profiles (multi-account / multi-context) (v3.3.0) |

### Manual override (any prompt)

```
@haiku what does this regex do?
@opus design a multi-tenant cache invalidation strategy
@sonnet add input validation to the signup form
```

---

## Hooks

The plugin registers five hooks in `hooks/hooks.json`:

| Hook | Script | Timeout | Purpose |
|------|--------|---------|---------|
| `SessionStart` | `runtime-check.js` | 10s | Cached integrity check + Karpathy skills auto-sync (v3.1.1) |
| `UserPromptSubmit` | `analyze-complexity.js` | 60s | Score & route every prompt |
| `PreToolUse` (Read\|Bash) | `pre-tool-router.js` | 8s | Context bloat detection + git commit/push routing (v3.2.1) |
| `Stop` | `enforce-stats.js` | 15s | Append the mandatory stats footer |
| `SubagentStop` | `detect-fallback.js` | 30s | Detect if a routed subagent fell back to a different model |

The `SessionStart` hook is silent on success and never blocks session start. Karpathy auto-sync runs detached in the background (24h throttle).

---

## Configuration

### Per-user (global)

Edit `~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/config/task-routing.json`.

The file is hot-reloaded at runtime via mtime+size signature, so changes take effect on the next prompt. Restart not required.

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

### v3.x feature config blocks

All new behavior is config-gated. Set any to `enabled: false` to revert to legacy behavior:

```json
{
  "modelIds": { "haiku": "claude-haiku-4-5", "sonnet": "claude-sonnet-4-6", "opus": "claude-opus-4-7", "opus-1m": "claude-opus-4-7[1m]" },
  "contextWindows": { "haiku": 200000, "sonnet": 200000, "opus": 200000, "opus-1m": 1000000 },

  "fastMode": { "enabled": true, "detectFromUserSettings": true },
  "memoryIntegration": { "enabled": true, "influenceEffort": true },
  "karpathySync": { "enabled": true, "intervalHours": 24, "background": true },
  "quotaAware": { "enabled": true, "opusDowngradeThreshold": 0.8, "opusFallbackModel": "sonnet", "respectBurstLimit": true },
  "statusline": { "format": "compact", "includeCost": true, "includeIcon": true },
  "contextBloat": { "enabled": true, "duplicateThreshold": 2, "windowMinutes": 30 },
  "gitHooks": { "enabled": true, "autoMessageModel": "auto", "warnForcePush": true, "trackStats": true, "diffThresholds": { "sonnet": 50, "opus": 500 } },
  "claudeCodeFeatures": { "detectVersion": true, "useInlineThinkingProgress": true, "trustFastMcpStartup": true },

  "mcpToolAwareness": { "enabled": true, "tools": ["playwright","github","slack", "..."] },
  "skillIntegration": { "enabled": true, "overrideRouting": true, "rules": [...] },

  "planMode": { "enabled": true, "scoreBoost": 1, "detectFromKeywords": true, "keywords": [...] },

  "fallbackLearning": { "enabled": true, "windowDays": 30, "rateThreshold": 0.3, "minSamples": 5, "boostPoints": 2 },
  "tokenPreview": { "enabled": true, "avgResponseTokens": 1500 },
  "proactiveCompact": { "enabled": true, "topicShiftThresholdPercent": 50 },
  "undo": { "enabled": true, "maxAgeSec": 600 },
  "profiles": { "enabled": true, "autoSwitchByCwd": true },
  "weeklyDigest": { "enabled": true, "writeToLogs": true },

  "effort": {
    "enabled": true,
    "thinkingBudgets": { "low": 0, "medium": 5000, "high": 16000 }
  }
}
```

### Routing pipeline overlay order (v3.3.0)

```
base task-routing.json
  → learned-keywords.json (auto-learned vocabulary, gitignored)
  → R43 profile (~/.claude/profiles/<active>.json)            [v3.3.0]
  → per-project .claude/model-routing.json                     ← strongest, project-specific wins
```

Profiles are global "personal vs work" overlays. Per-project rules still trump them — that's by design for project specificity.

### Auto-mode tuning

```json
"autoMode": {
  "enabled": true,
  "autoThresholds": {
    "haiku": [1, 2],
    "opus":  [9, 10]
  },
  "borderlineZones": [3, 4, 7, 8],
  "llmFallback": { "enabled": false }
}
```

- `autoThresholds`: score ranges that auto-delegate without asking
- `borderlineZones`: scores that trigger a confirmation prompt
- `enabled: false` → always ask, never auto-route

### LLM-fallback classifier (opt-in, v2.4.0+)

When the deterministic scorer can't classify a prompt confidently (`confidence < 40` or no keyword match), the hook outputs an instruction for Claude to use the existing **`haiku-worker` subagent** to classify the prompt before routing. **The hook itself makes no API call.** Cost: zero extra. Enable via `autoMode.llmFallback.enabled = true`.

### Skill trigger rules (v3.1.0)

Default `skillIntegration.rules` map common skill invocations to optimal model + effort:

| Trigger | → Model | Effort |
|---|---|---|
| `superpowers:debugging` | sonnet | high |
| `superpowers:systematic-debugging` | sonnet | high |
| `superpowers:test-driven-development` | sonnet | medium |
| `superpowers:writing-plans` | opus | high |
| `superpowers:brainstorming` | opus | high |
| `frontend-design` | sonnet | medium |
| `feature-dev:code-architect` | opus | high |
| `code-review:code-review` | sonnet | medium |
| `anthropic-skills:web-artifacts-builder` | sonnet | medium |
| `anthropic-skills:skill-creator` | opus | high |

Add your own in config.

---

## What gets installed where

```
~/.claude/
├── plugins/
│   ├── cache/<owner>/claude-model-changer/<version>/   ← plugin files live here
│   ├── cache/<owner>/external/andrej-karpathy-skills/  ← auto-synced karpathy upstream
│   ├── installed_plugins.json                           ← registration entry
│   └── marketplaces/<owner>/                            ← only via marketplace install
└── settings.json                                        ← enabledPlugins entry
```

`<owner>` is the marketplace name. Via the marketplace install (Option A) it's `r4ck`. Via the bundled installer (Option B) or source installer (Option C) it auto-detects from your username (`<lowercase-username>-local`), or you can override with `CMC_MARKETPLACE_OWNER=foo`.

The plugin is **user-scope**: available in every Claude Code session you start, in any project. Not project-scoped.

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
├── commands/                    # 27 slash commands
├── config/
│   ├── task-routing.json        # 30 categories, weights, thresholds, all v3.x feature blocks
│   └── patterns.json            # User-saved prompt → model mappings
├── hooks/
│   └── hooks.json               # 5 hook definitions (SessionStart, UserPromptSubmit, PreToolUse, Stop, SubagentStop)
├── scripts/
│   ├── analyze-complexity.js    # ~70 KB - the scoring engine
│   ├── enforce-stats.js         # Stats footer for every response
│   ├── detect-fallback.js       # Subagent fallback detection
│   ├── runtime-check.js         # SessionStart integrity check + karpathy spawn
│   ├── pre-tool-router.js       # PreToolUse hook (combined v3.2.1)
│   ├── context-bloat-detect.js  # Tool call dedup detector (v3.2.0)
│   ├── git-commit-hook.js       # Git commit/push routing (v3.2.0)
│   ├── statusline.js            # Custom Claude Code statusline (v3.2.0)
│   ├── auto-benchmark.js        # Routing benchmark suite (v3.2.0)
│   ├── export-prometheus.js     # Telemetry exporter (v3.1.0)
│   ├── whatif.js                # Config-change simulator (v3.3.0)
│   ├── weekly-digest.js         # Markdown weekly cost report (v3.3.0)
│   ├── karpathy-session-sync.js # Throttled karpathy sync (v3.1.1)
│   ├── sync-karpathy-skills.js  # Karpathy upstream pull
│   ├── update-from-github.js    # Plugin self-update for path-source users (v3.2.2)
│   ├── update-central-claude-md.js  # Manage karpathy block in ~/.claude/CLAUDE.md
│   ├── preflight.js             # 10-point install validation
│   ├── install-plugin.js        # Manual installer
│   ├── uninstall-plugin.js      # Cleanup
│   ├── build-installer.js       # Generates dist/install.js bundle
│   ├── generate-dashboard.js    # /dashboard backing script
│   ├── live-dashboard.js        # Live HTML dashboard
│   └── lib/                     # Shared modules:
│       ├── scoring.js           # Sub-scores, MCP/skill/agent-teams detectors
│       ├── quota-tracker.js     # Weekly + 5h rolling tracking (v3.2.0)
│       ├── cc-version.js        # Claude Code 2.1+ feature detection (v3.2.0)
│       ├── context-audit.js     # Bloat audit helper (v3.2.0)
│       ├── memory.js            # Auto-memory MEMORY.md reader (v3.1.0)
│       ├── atomic-io.js         # Concurrency-safe state I/O (v3.0.0)
│       ├── fallback-learn.js    # Auto-boost from [FALLBACK:sonnet] events (v3.3.0)
│       ├── last-routing.js      # Persisted last decision for /undo (v3.3.0)
│       ├── profile-manager.js   # Multi-profile overlay (v3.3.0)
│       ├── config.js, session.js, stats.js, io.js, health.js, etc.
├── skills/
│   └── model-router/            # Skill bundle exposed via SKILL.md
│   └── karpathy-guidelines/     # Auto-installed from upstream (v3.1.1+)
├── dist/
│   ├── install.js               # Self-contained ~600 KB installer (Option B)
│   └── README.md                # Bundle install docs
├── docs/                        # Architecture & user-manual docs
├── tests/                       # 79 unit tests (atomic-io, config-hot-reload, scoring, effort)
├── install.sh / install.ps1 / install.bat  # Source installers
├── INSTALL.md                   # Detailed install guide with preflight info
├── UPDATING.md                  # Update flow guide (v3.2.2)
├── CHANGELOG.md                 # Full version history
├── package.json
└── README.md                    # ← you are here
```

---

## FAQ

**Q: Why did it pick Haiku for my "complex" task?**
Run `/complexity --explain <your prompt>`. You'll see exactly which sub-scores contributed. Usually the fix is adding a keyword to `config/task-routing.json` (or its project-local override). You can also use `@sonnet` / `@opus` as a prefix to override for one task.

**Q: Can I force a specific model for certain files or keywords?**
Yes. Drop a `.claude/model-routing.json` in your project root. See the `docs/examples/` directory for three copy-paste configs: `security-critical.json`, `startup-lean.json`, `ml-heavy.json`.

**Q: Does my team share the config?**
The repo-level config (`config/task-routing.json`) is shared via git. Per-user auto-learned keywords live in `logs/learned-keywords.json` (gitignored). Per-project overrides go in `.claude/model-routing.json` (typically committed). Export/import via `/export-config` and `/import-config`.

**Q: What happens when I hit my Opus weekly quota?**
The plugin auto-downgrades opus → sonnet (configurable threshold, default 80%). You'll see `⚠ Quota downgrade: opus → sonnet (Opus weekly quota exhausted)` in the routing output. Run `/quota` for current state. Disable via `quotaAware.enabled: false`.

**Q: How do I see what's bloating my context window?**
Run `/context-audit`. It lists the top 10 files and bash commands by estimated token cost over the last hour, with recommendations to `/clear` or pin frequent files into a skill.

**Q: Does the plugin add a statusline?**
Optionally. Run `/statusline install` for the snippet to add to `~/.claude/settings.json`. Output format: `🟢 sonnet │ ctx 23% │ wk 12% │ $0.42`.

**Q: What if I'm on a slow machine and the hook times out?**
Default `UserPromptSubmit` timeout is 60s (plenty). If you see `[Model Router - ERROR]` in the session, run `node scripts/preflight.js` to diagnose. The error log lives at `logs/hook-errors.jsonl`.

**Q: Does it call any external services?**
No. All scoring is local. The opt-in LLM fallback uses your existing `haiku-worker` subagent — no API keys, no extra billing. The Karpathy auto-sync clones from a public GitHub repo (read-only, no auth).

**Q: What gets logged? Can I audit it?**
`logs/usage.jsonl` keeps the last 5000 routing decisions (score, model, category, confidence, effort). `logs/learn-suggestions.jsonl` stores LLM fallback suggestions. `logs/hook-errors.jsonl` captures failures. `logs/tool-history.jsonl` (capped 200) tracks tool calls for context bloat detection. `logs/git-router-stats.jsonl` (v3.2.0+) tracks git commit/push routing decisions. All JSONL, human-readable, auto-trimmed. Export Prometheus metrics via `/metrics`.

**Q: How do I reset everything?**
```bash
rm ~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/logs/*.jsonl
```
(Keep `.gitkeep`.) Usage stats, learned keywords, error history, tool history, git stats all reset.

**Q: Will this work alongside other Claude Code plugins?**
Yes. The plugin uses standard hook mechanisms and doesn't touch settings it doesn't own. Multiple plugins can contribute hooks to the same event.

**Q: Routing was wrong — can I fix it after the fact? (v3.3.0)**
Yes. Run `/undo`. The previous prompt is re-routed to the next-tier model (haiku → sonnet → opus), and the original decision is auto-rated as quality 1 (poor) so adaptive weights learn from your correction. There's a 10-minute staleness limit (configurable via `undo.maxAgeSec`).

**Q: Does the plugin learn from haiku-worker fallbacks? (v3.3.0)**
Yes. When a haiku-worker emits `[FALLBACK:sonnet]` (signaling it can't handle the task), the plugin logs it. After enough samples, it auto-boosts the keyword score for that category so future prompts skip ahead. Run `/fallback-learn` to see what's been learned. This is *machine* feedback complementing the *human* feedback from `/rate`.

**Q: I want to test a config change before applying it. (v3.3.0)**
Run `/whatif move <keyword> <fromModel> <toModel>` (or `threshold`, `add-keyword`, `disable`, `enable`). The simulator replays the last 500 prompts under your hypothetical change and reports cost delta + distribution diff. **Read-only** — never modifies actual config.

**Q: Can I have separate configs for personal vs work use? (v3.3.0)**
Yes. Profiles. Create `~/.claude/profiles/work.json` with overrides like `{ "planLimits": { "weeklyOpus": 100 } }`. Switch via `/profile switch work` or auto-switch by cwd via `~/.claude/profiles/.project-map.json`. Per-project `.claude/model-routing.json` still wins for project-specific rules — profiles are a layer below that.

**Q: Can I get a weekly cost summary? (v3.3.0)**
Yes. Run `/weekly-digest` or schedule it: `/loop 7d node "${CLAUDE_PLUGIN_ROOT}/scripts/weekly-digest.js"`. Output is markdown comparing this week to last week, with model distribution, top categories, anomalies, and git activity.

**Q: How do I uninstall?**
```bash
claude plugin uninstall claude-model-changer@r4ck
```
Or delete from `~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/` and remove the entry from `~/.claude/plugins/installed_plugins.json` + `~/.claude/settings.json`.

**Q: How do I update?**
See [UPDATING.md](UPDATING.md). TL;DR: GitHub-source marketplace with `autoUpdate: true` is zero-touch. Path-source users run `node scripts/update-from-github.js`.

---

## Diagnostics & troubleshooting

### "Nothing happens when I prompt"

```bash
node scripts/preflight.js
```

Runs all 10 checks and prints exactly what's broken. Common culprits:
- Node not on PATH inside Claude Code's hook environment
- `task-routing.json` has a JSON syntax error
- Hook script was modified or deleted

### `/health` command

Same checks, but inside Claude Code with a nicer formatted output. As of v3.1.0 reads the plugin's own `hooks/hooks.json` correctly (was a false-positive warning before).

### Hook timing out

Default timeout is 60s for `UserPromptSubmit`. If your machine is genuinely slow on Node startup (cold cache, antivirus scanning), bump it in `hooks/hooks.json`.

### Wrong model being chosen

Run `/tune` — it analyzes your override history (when you said "use opus instead") and suggests config tweaks. Use `/auto-benchmark` to detect drift over time. Use `/complexity --explain <prompt>` to see why a specific prompt scored the way it did.

### Quota downgrade firing too aggressively

Lower `quotaAware.opusDowngradeThreshold` from 0.8 to 0.9 (only downgrade at 90%+) or set `quotaAware.enabled: false` to disable.

---

## Development

```bash
git clone https://github.com/R4CK/claude-model-changer
cd claude-model-changer

# Run preflight (no install)
node scripts/preflight.js

# Test the analyzer directly
echo '{"prompt":"refactor the auth module"}' | node scripts/analyze-complexity.js

# Run unit test suite (79 tests)
node tests/run-all.js

# Run the auto-benchmark
node scripts/auto-benchmark.js

# Rebuild the bundled installer after changing source
node scripts/build-installer.js
cp install.js dist/install.js

# Install from source for live testing
./install.sh
```

After source changes, reinstall and restart Claude Code to pick them up.

### CI

Every PR runs the [Preflight workflow](.github/workflows/preflight.yml):
- 10-point preflight check
- 79 unit tests
- 3 behavioral tests (typo → haiku, security audit → opus, perf debug → sonnet)
- Bundle reproducibility check (dist/install.js sync)
- Version sync check (plugin.json is source of truth)

---

## How it compares

| Approach | This plugin | Manual model picking | Always-Opus | Always-Haiku |
|----------|-------------|----------------------|-------------|--------------|
| Cost on simple tasks | ~10× cheaper | Same as picked | Always max | Cheap (hits ceiling on hard) |
| Cognitive overhead | None | High (every prompt) | None | None |
| Catches "obvious" hard tasks | Yes (auto-opus) | Depends on you | N/A | Misses, struggles |
| Quota-aware downgrade | Yes (v3.2.0) | No | No | N/A |
| Context bloat warnings | Yes (v3.2.0) | No | No | No |
| Multi-language input | EN/HU/DE detected + HU morphology | N/A | N/A | N/A |
| Project-specific rules | Yes | Manual | N/A | N/A |
| Override when wrong | `@haiku`/`@opus` prefix | N/A | N/A | N/A |
| Visible cost tracking | `/stats`, `/dashboard`, `/metrics` | None | None | None |
| Statusline integration | Yes (v3.2.0) | N/A | N/A | N/A |
| Git commit hook | Yes (v3.2.0) | N/A | N/A | N/A |
| Skills/Agent Teams aware | Yes (v3.1.0+) | N/A | N/A | N/A |
| Auto-learn from fallback events | Yes (v3.3.0) | No | No | No |
| Undo last routing | Yes (v3.3.0) | N/A | N/A | N/A |
| Per-prompt token cost preview | Yes (v3.3.0) | No | No | No |
| What-if config simulator | Yes (v3.3.0) | No | No | No |
| Multi-account / profile switching | Yes (v3.3.0) | Manual | N/A | N/A |
| Weekly cost digest | Yes (v3.3.0) | None | None | None |

---

## Contributing

PRs welcome. Please:

1. Run `node scripts/preflight.js` and `node tests/run-all.js` before opening — must be all green.
2. If you change `task-routing.json` keywords, include a `/tune` rationale in the PR description.
3. For new categories, add 3+ example keywords and a clear `label`.
4. Hook script changes: include a manual test command in the PR (e.g., `echo '{...}' | node scripts/your-script.js`).
5. New features: add a config block with `enabled: true` default; document in CHANGELOG and update README.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Credits

- Authored by [R4CK](https://github.com/R4CK).
- Karpathy guidelines skill auto-synced from [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills) (MIT).
- Inspired by community discussions on [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/) and [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/) about Claude Code cost optimization.
