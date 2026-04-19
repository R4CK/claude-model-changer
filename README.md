# Claude Model Changer

> **Stop paying Opus prices for typo fixes.** Automatic Claude Code plugin that routes each task to the right model — Haiku for trivia, Sonnet for the middle ground, Opus only when you actually need it.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](package.json)
[![Plugin Version](https://img.shields.io/badge/plugin-v3.0.0-blue)](.claude-plugin/plugin.json)
[![CI](https://github.com/R4CK/claude-model-changer/actions/workflows/preflight.yml/badge.svg)](https://github.com/R4CK/claude-model-changer/actions/workflows/preflight.yml)
[![Latest Release](https://img.shields.io/github/v/release/R4CK/claude-model-changer)](https://github.com/R4CK/claude-model-changer/releases/latest)

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

### Compatibility Matrix

| Component | Minimum | Tested | Notes |
|---|---|---|---|
| Claude Code | 2.x | 2.1.76+ | Plugin API + marketplace support required |
| Node.js | 16 LTS | 16 / 18 / 20 / 22 | Auto-install via source installer |
| Windows | 10+ | 11 | PowerShell + cmd installers work; WSL also supported |
| macOS | 12+ | 13–15 | Source installer preferred |
| Linux | any distro with Node ≥16 | Ubuntu 22.04 | CI runs here |

---

## Getting Started (30 seconds)

After installing (see above) and restarting Claude Code:

1. Type any prompt — `fix the typo on line 5`
2. Plugin routes to **haiku** automatically. You'll see:
   ```
   [Model Router] Complexity: SIMPLE (score 1/10) -> Recommended: haiku
   ```
3. Try a harder one — `design a multi-tenant cache invalidation strategy`
4. Plugin routes to **opus** (automatic at high confidence):
   ```
   [Model Router] Complexity: COMPLEX (score 9/10) -> Recommended: opus
   ```
5. Run `/stats` to see the saved cost so far.

That's it. The plugin is now invisible infrastructure; focus on your actual work.

---

## Cost Model

**No new billing.** Model routing is free; you already pay for your own Claude Code usage. The plugin just picks the cheapest model capable of the task.

Typical savings on mixed workloads:

| Workload | Without plugin (all Opus) | With plugin | Savings |
|---|---|---|---|
| 100 typo fixes + 20 bug fixes + 10 architecture tasks | ~$90 | ~$35 | **~60%** |
| Heavy refactor session (mostly Sonnet-level) | ~$45 | ~$25 | **~45%** |
| Pure architecture sprint (mostly Opus) | ~$90 | ~$85 | ~5% |

Run `/stats` in a Claude Code session to see your actual savings vs an all-Opus baseline.

| Model | Input $/1M | Output $/1M | Relative |
|---|---|---|---|
| Haiku | $0.25 | $1.25 | 1× |
| Sonnet | $3.00 | $15.00 | 12× |
| Opus | $15.00 | $75.00 | 60× |

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
| `/learn` | Review LLM-fallback classification suggestions and keyword candidates |
| `/effort` | Show current Effort recommendation config + last 20 decisions (v2.7.0+) |
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
  "borderlineZones": [3, 4, 7, 8],
  "llmFallback": {
    "enabled": false
  }
}
```

- `autoThresholds`: score ranges that auto-delegate without asking
- `borderlineZones`: scores that trigger a confirmation prompt with both options
- `enabled: false` → always ask, never auto-route

### LLM-fallback classifier (opt-in, v2.4.0+)

When the deterministic scorer can't classify a prompt confidently
(`confidence < 40` or no keyword match), the hook outputs a structured
**instruction to Claude** to use the existing **`haiku-worker` subagent**
(shipped with this plugin) to classify the prompt before routing.

**The hook itself makes no API call.** It just emits a text instruction.
Claude reads it, uses its built-in `Task` tool with `subagent_type="haiku-worker"`
to classify, then routes the user's actual task to the chosen model. The
classification result is also logged via the `--log-llm-suggestion`
special command, so you can later review keyword candidates via `/learn`.

**To enable:**
1. In `config/task-routing.json`, set `autoMode.llmFallback.enabled = true`
2. Restart Claude Code

**Cost:** zero extra — the Haiku usage counts against your normal Claude
Code subagent usage, not against a separate API key. No billing surprises.

**Failure modes:** zero. The hook only suggests; Claude only acts if it
receives the suggestion. There's no network call, no timeout, no auth flow
to break.

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

## FAQ

**Q: Why did it pick Haiku for my "complex" task?**
Run `/complexity --explain <your prompt>`. You'll see exactly which sub-scores contributed. Usually the fix is adding a keyword to `config/task-routing.json` (or its project-local override). You can also use `@sonnet` / `@opus` as a prefix to override for one task.

**Q: Can I force a specific model for certain files or keywords?**
Yes. Drop a `.claude/model-routing.json` in your project root. See the `docs/examples/` directory for three copy-paste configs: `security-critical.json`, `startup-lean.json`, `ml-heavy.json`.

**Q: Does my team share the config?**
The repo-level config (`config/task-routing.json`) is shared via git. Per-user auto-learned keywords live in `logs/learned-keywords.json` (gitignored). Per-project overrides go in `.claude/model-routing.json` (typically committed). Export/import via `/export-config` and `/import-config`.

**Q: What if I'm on a slow machine and the hook times out?**
Default `UserPromptSubmit` timeout is 60s (plenty). If you see `[Model Router - ERROR]` in the session, run `node scripts/preflight.js` to diagnose. The error log lives at `logs/hook-errors.jsonl`.

**Q: Does it call any external services?**
No. All scoring is local. The opt-in LLM fallback uses your existing `haiku-worker` subagent — no API keys, no extra billing.

**Q: What gets logged? Can I audit it?**
`logs/usage.jsonl` keeps the last 5000 routing decisions (score, model, category, confidence). `logs/learn-suggestions.jsonl` stores LLM fallback suggestions. `logs/hook-errors.jsonl` captures failures. All JSONL, human-readable, auto-trimmed.

**Q: How do I reset everything?**
```bash
rm ~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/logs/*.jsonl
```
(Keep `.gitkeep`.) Usage stats, learned keywords, and error history reset.

**Q: Will this work alongside other Claude Code plugins?**
Yes. The plugin uses the standard hook mechanism and doesn't touch settings it doesn't own. Multiple plugins can contribute hooks to the same event (UserPromptSubmit, etc.).

**Q: How do I uninstall?**
```bash
claude plugin uninstall claude-model-changer@r4ck
```
Or delete from `~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/` and remove the entry from `~/.claude/plugins/installed_plugins.json` + `~/.claude/settings.json`.

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
