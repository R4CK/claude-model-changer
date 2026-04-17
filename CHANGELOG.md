# Changelog

## v2.4.0

### New feature: LLM-fallback classification via the haiku-worker subagent (opt-in)

When the deterministic scorer cannot classify a prompt confidently
(`confidence < 40` OR no keyword match), the hook now outputs a structured
**instruction to Claude** to use the existing **`haiku-worker` subagent**
(shipped with this plugin) to classify the prompt before routing.

**Architecture: hook-driven, Claude-executed.** The hook itself does NOT
make any network calls or use any API keys. It outputs a text instruction
that Claude reads and acts on, using the same `Task`-tool / subagent
infrastructure the plugin already uses for routing. After Claude gets the
classification from haiku-worker, it (a) routes the user's actual task to
the model haiku-worker chose, and (b) logs the classification back via the
new `--log-llm-suggestion` special command.

**Cost:** zero extra. The Haiku usage counts against the user's normal
Claude Code subagent usage - no separate API key, no separate billing.

**Opt-in:** disabled by default. To enable:
1. In `config/task-routing.json`, set `autoMode.llmFallback.enabled = true`
2. Restart Claude Code

**Files added:**
- `scripts/lib/learn-log.js` - append-only log of LLM suggestions
- `scripts/show-learn-suggestions.js` - backing script for the new `/learn` slash command
- `commands/learn.md` - the `/learn` command definition

**Modified:**
- `scripts/analyze-complexity.js` - emits an "LLM-FALLBACK SUGGESTED" hint
  in the hook output when deterministic confidence is low AND llmFallback
  is enabled. Also handles the new `--log-llm-suggestion` special command.
- `config/task-routing.json` - new `autoMode.llmFallback` config block
  (just `{ enabled: false, _comment: "..." }`).

**Behavior:**
- Hook stays completely synchronous and zero-network
- All real LLM work is done by Claude in-context using Task tool with
  subagent_type="haiku-worker"
- Suggestions log auto-trims to 500 entries; `/learn` shows top categories,
  top keywords, auto-applied count, and the recent 10 entries

### Multi-language support in LLM fallback

The hook detects user prompt language (en / hu / de) and instructs Claude
to ask haiku-worker to suggest keywords IN THE USER'S LANGUAGE. The
`--log-llm-suggestion` command takes a `<lang>` parameter and routes
keywords to the right place:
- `en` -> `models.<model>.categories.<key>.keywords` (English keywords)
- `hu` -> `translations.hu.<key>` (Hungarian keyword array)
- `de` -> `translations.de.<key>` (German keyword array)

This matches the existing multi-language structure of `task-routing.json`
(189 English + ~80 Hungarian + ~80 German keywords today).

### Tier 2 auto-apply: per-user learned keywords

When `learn.autoApply.enabled = true` AND a keyword has been suggested
N+ times (default 5), the hook auto-appends it to a per-user
`logs/learned-keywords.json` file. This file is gitignored AND
deep-merged into the runtime config by `lib/config.js`, so the keyword
takes effect IMMEDIATELY on the next prompt.

The shared `task-routing.json` stays clean and reviewed - per-user
adaptations live separately. To share learned keywords across machines
or with teammates, run `/learn --promote` to get a diff that can be
incorporated into `task-routing.json` via a PR (which the CI will
validate).

**New config:**
```json
"learn": {
  "autoApply": {
    "enabled": false,
    "minOccurrences": 5
  }
}
```

**New files (in addition to v2.4.0 base):**
- `scripts/lib/learned-config.js` - manage learned-keywords.json
- new `--learn-promote` special command and `--promote` flag on
  `show-learn-suggestions.js`

**Modified:**
- `scripts/lib/io.js` - new `getLearnedConfigPath()`
- `scripts/lib/config.js` - deep-merges learned-keywords.json between
  base and project override
- `scripts/lib/learn-log.js` - persists `lang` field on every suggestion
- `commands/learn.md` - documents `--promote` mode
- `.gitignore` - excludes `logs/learned-keywords.json`

### Version sync
All version numbers consolidated under **2.4.0** (was: plugin.json 2.3.0,
package.json 2.3.0, marketplace.json plugin entry 2.3.0). `plugin.json`
remains the single source of truth; `install-plugin.js` reads from it at
runtime; CI enforces consistency.

## v2.3.0

### Distribution
- **Marketplace plugin**: Repo is now a canonical Claude Code marketplace.
  Install via `claude plugin marketplace add https://github.com/R4CK/claude-model-changer`
  + `claude plugin install claude-model-changer@r4ck`.
- **Self-contained bundle**: `dist/install.js` (411 KB, 52 files embedded) for
  offline / single-file install. Falls back to manual registration if the
  Claude CLI isn't available.
- **Cross-platform source installers**: `install.sh` (POSIX), `install.ps1`
  (PowerShell), `install.bat` (cmd wrapper). Auto-install Node.js (>=16) via
  winget / choco / apt / dnf / pacman / brew.

### New checks
- **`scripts/preflight.js`**: 11-point pre-install validator (Node version,
  `~/.claude` writability, JSON validity, hook script references, hook dry-run,
  marketplace owner resolution, etc.). CI-aware: skips local-only checks
  under `CI=true` / `GITHUB_ACTIONS=true`.
- **`scripts/runtime-check.js`**: New `SessionStart` hook performs a cached
  (1h) integrity check on every session start. Silent on success; emits a
  warning into the session context if plugin files are missing or corrupted.

### Fixes
- **Marketplace owner is now dynamic per-machine**: `install-plugin.js` and
  the bundled `install.js` derive the owner from `<lowercase-username>-local`
  by default (overridable via `CMC_MARKETPLACE_OWNER` env). Previously
  hardcoded to `neon-local`, which was nonsensical on other users' machines.
- **Plugin version is now read from `plugin.json` at runtime**: removed the
  hardcoded `PLUGIN_VERSION = "5.3.3"` from `install-plugin.js`. There's a
  single source of truth for the version now (`.claude-plugin/plugin.json`).
- **Legacy `@local` entry cleanup**: an earlier buggy installer wrote the
  registration key as `claude-model-changer@local` (mismatched against the
  cache subdir). The fixed installer auto-removes that legacy entry from
  both `installed_plugins.json` and `enabledPlugins` on next run.

### Repository hygiene
- **Branch protection on `main`**: PRs only, required CI status check,
  Code Owner review, conversation resolution, linear history, no force
  pushes, no deletions, no bypass.
- **GitHub Actions CI** (`.github/workflows/preflight.yml`): preflight,
  behavioral routing tests (typo→haiku, architecture→opus, bug fix→sonnet),
  category count check, hook reference check, bundle reproducibility check,
  marketplace.json structure check, and version sync check.
- **CODEOWNERS, PR template, CONTRIBUTING.md**: structured contribution flow.

### Documentation
- Completely rewritten **README.md** for GitHub readers: 3 install paths,
  scoring weights table, hook table, repo layout, troubleshooting.
- New **INSTALL.md** with detailed install reference and `<OWNER>` resolution.
- New **CONTRIBUTING.md** with local dev setup, testing requirements, code
  style, and PR workflow.
- Rewritten **dist/README.md** documenting the bundle's behavior.

### Version sync
All version numbers consolidated under **2.3.0** (was: plugin.json 2.2.0,
package.json 5.1.0, install-plugin.js hardcoded 5.3.3, marketplace.json
plugin entry 5.3.3). `plugin.json` is now the single source of truth;
`install-plugin.js` reads from it at runtime; CI enforces consistency.

## v5.1.0

### Fixes
- **Hook now fires from Claude Code**: Added `CLAUDE_PLUGIN_ROOT` fallback and increased timeout to 60s
- **Session stats display**: Stats line (`📊 Session:`) now appears at top of hook output with mandatory formatting
- **Direct hook registration**: Hooks registered in `.claude/settings.local.json` for reliable activation

### Refactoring
- **Shared session-utils.js**: Extracted `getSessionSummaryLine`, `loadSessionState`, `saveSessionState` to shared module
- **Constants extracted**: All magic numbers (WEEK_MS, token ratios, log limits) moved to `CONSTANTS` object
- **Error handling**: Silent `catch(err) {}` blocks now write to stderr for debuggability
- **File I/O caching**: `readLogCached()` prevents redundant reads of usage.jsonl and quality.jsonl
- **Shared cost estimation**: `estimateModelCost()` replaces duplicated cost calculation
- **enforce-stats.js simplified**: Now delegates to session-utils.js (was 50 lines, now 16)
- **Session ID check removed**: `loadSessionState()` no longer requires exact session ID match

## v5.0.0

### New Features
- **Adaptive weights (D1)**: Scoring weights auto-adjust based on quality rating history (needs 10+ ratings via `/rate`)
- **Multi-language detection (D2)**: Hungarian and German prompt recognition with translated keywords for all 28 categories
- **Interactive configurator (E1)**: `/configure` wizard for toggling features and adjusting settings
- **Model benchmark (E4)**: `/benchmark <prompt>` sends same prompt to all 3 models for comparison
- **Anomaly detection (F1)**: Alerts on opus usage spikes, cost spikes, and score drift vs 7-day average
- **API rate limit monitor (F4)**: Tracks RPM/TPM, downgrades model when approaching API limits
- **VS Code extension (G2)**: Status bar showing model, score, context %, confidence with color coding

### Improvements
- Usage log now stores individual sub-scores for adaptive learning
- New `--adaptive-stats` command for weight analysis
- Language detection shown in routing output
- `logs/status.json` auto-updated for external tool integration

## v4.0.0

### New Features
- **Config validation (A1)**: Validates task-routing.json on load with graceful degradation
- **Score confidence metric (A2)**: 0-100% confidence, low confidence disables auto-routing
- **Fallback chain (A3)**: haiku->sonnet->opus agent escalation
- **Token budget limits (A4)**: Daily/weekly budget per model with warnings
- **Rate limiting (A5)**: Max auto-routes per minute
- **Safe mode / dry-run (A6)**: Disable auto-routing for testing
- **Prompt patterns (B2)**: Save prompt patterns with fixed model assignments
- **Quality feedback (B3)**: Rate results 1-5, automatic tuning suggestions
- **Prompt hints (B6)**: Model-specific tips for better prompts
- **Context window monitor (C1)**: Track token usage, auto-downgrade when context is tight
- **HTML dashboard**: Visual charts via `/dashboard`
- **Config export/import**: Share configs between projects

## v3.0.0

### New Features
- Override learning with `/tune` analysis
- Context-aware routing (Python/JS/TS/Rust/Go detection)
- Session stickiness via Jaccard similarity
- Savings tracking with cost comparison

## v2.0.0

### New Features
- Borderline detection for ambiguous scores
- Cost estimation per model
- Auto mode for high-confidence routing
- Usage logging (JSONL)
- Project-specific config overrides

## v1.0.0

### Initial Release
- Complexity scoring (1-10 scale)
- 28 task categories across 3 models
- Configurable keyword matching with specificity priority
- Manual override markers (@haiku/@sonnet/@opus)
- Sub-agent delegation architecture
