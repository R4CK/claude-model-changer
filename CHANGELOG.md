# Changelog

## v2.5.0 (second of two PRs: config completeness + error visibility)

### New categories (T2.3)

Added **2 new sonnet categories** to address routing gaps identified in the audit:

* **`performance_debug`** (sonnet) — debugging slow code / performance regressions.
  Keywords: `slow`, `lag`, `bottleneck`, `why is this slow`,
  `investigate performance`, `timing issue`, `perf regression`, `laggy`, `too slow`.
  Previously, prompts like "investigate the performance bottleneck" matched
  the opus `performance` category even though they're medium-complexity
  debugging, not full optimization audits.

* **`investigation`** (sonnet) — code-reading / trace-through tasks.
  Keywords: `trace execution`, `how does`, `walk me through`, `explain the flow`,
  `understand this code`, `trace through`, `what does this do`,
  `explain this function`.
  Previously these had no category and fell through to word-count-only scoring.

### Renamed opus category

* **`performance` -> `performance_audit`** (opus). More specific label to
  distinguish from the new sonnet-level `performance_debug`. Keywords narrowed
  to audit/profiling focus (kept: `performance audit`, `profiling`, `benchmark`,
  `optimize across`, `performance optimization`; removed generic `bottleneck`
  which now lives in sonnet).

### HU / DE translations
Added Hungarian and German keyword translations for both new categories,
matching the existing multi-language structure.

### Total: 30 categories now (was 28)
- haiku: 9
- sonnet: 12 (+2)
- opus: 9 (renamed `performance` -> `performance_audit`)

### CI behavioral tests added
Three new tests in `.github/workflows/preflight.yml`:
- "investigate the performance bottleneck..." -> sonnet
- "audit authentication performance across microservices" -> opus
- "trace execution of fetchUser and walk me through it" -> sonnet

Category-count check relaxed from `=== 28` to `>= 28` so future
`/learn-promoted` additions don't break CI.

### Error visibility in hooks (T2.4)

New module **`scripts/lib/error-log.js`** following the same pattern as
`learn-log.js`: append-only JSONL, auto-trim to 200 entries, summarize
helper.

Wired into the main catch blocks of all four hook scripts:
- `analyze-complexity.js` (UserPromptSubmit)
- `enforce-stats.js` (Stop)
- `detect-fallback.js` (SubagentComplete)
- `runtime-check.js` (SessionStart)

When a hook caught an exception, the error is:
1. Written to `logs/hook-errors.jsonl` with timestamp, script, phase,
   message, stack, and a preview of the input that triggered it
2. For the main `analyze-complexity.js` hook, a visible warning is also
   emitted to stdout (visible in Claude Code's session context):
   `[Model Router - ERROR] analyze-complexity.js caught an exception. See logs/hook-errors.jsonl or run /health for details.`

New **`--errors`** special command in the dispatch table. Returns a
JSON summary: `totalErrors`, `byScript`, `byPhase`, `recent` (last 10).
Intended for use by `/health` slash command or a future `/errors`
command.

Previously hook failures were **silent** - users got "always ask"
behavior with no indication why. Now failures are visible and
diagnosable.

**.gitignore:** excludes `logs/hook-errors.jsonl` (per-user runtime data).

## v2.5.0 (first of two PRs: tests + explain)

### New feature: `/complexity --explain` mode (T2.1)

Prefix the prompt with `--explain` to get a full ROUTING EXPLANATION block
in the analyzer output:

```bash
echo '{"prompt":"--explain refactor auth module"}' | node scripts/analyze-complexity.js
```

The explain block shows:
- Input parameters (word count, detected language, task type)
- Every sub-score (keyword, wordCount, codeBlocks, multiFile, structure,
  contextBoost) with its configured weight and applied normalization factor
- Which keyword matched (category + matched text + length)
- Keyword-influence mode (override / boost / none)
- `rawScore` -> `finalScore` transformation
- Final model and level
- Confidence breakdown (signals + agreement)
- Whether adaptive weights or session stickiness took effect

Use cases:
- Debugging "why did this prompt route to opus?" without diving into the code
- Tuning `config/task-routing.json` based on observed keyword matches
- Verifying custom weight configurations behave as expected

The `/complexity` slash command docstring was updated to explain this flag.

### New: Zero-dependency unit test suite (T2.2)

Added `tests/` with a minimal zero-dep test harness (`tests/harness.js`,
`tests/run-all.js`) and **44 unit tests for `scripts/lib/scoring.js`**
covering:
- `scoreWordCount` - 5 cases (boundaries + huge prompt)
- `scoreCodeBlocks` - 4 cases (none / 1 / 2 / many pairs)
- `scoreMultiFileIndicators` - 4 cases (0 / 1 / 2 / 3+ indicators)
- `scoreStructuralComplexity` - 4 cases (empty / numbered / file paths / capped)
- `detectLanguage` - 4 cases (en / hu / de / mixed)
- `classifyQuestionVsTask` - 3 cases
- `detectManualOverride` - 4 cases (@haiku, @opus, "use sonnet", none)
- `scoreKeywords` / `scoreKeywordsMultiLang` - 8 cases (incl. specificity tie-break, multi-lang, case-contract)
- `calculateConfidence` - 3 cases
- `detectBorderline` - 3 cases
- `getCostEstimate` - 2 cases

CI integration: new `Unit tests (scoring library)` step in
`.github/workflows/preflight.yml` runs `node tests/run-all.js`. Tests use
only Node's built-in `assert` module - no Jest/Mocha dependency.

### Internals exposed (needed for --explain)
`analyzeComplexity()` now returns a richer object with `result.explain.*`
fields (wordCount, weights, wNorm, contextBoostWeight, keywordResult,
keywordInfluenceMode, usingAdaptiveWeights). Backward compatible -
existing callers that read `result.model`/`score`/`confidence` are unaffected.

## v2.4.1

### Audit fixes (no behavior changes beyond fixing bugs)

* **[T1.1]** `scripts/lib/config.js`: `loadConfig()` now always returns an
  object (never `null`). A corrupt or missing `task-routing.json` no longer
  risks null propagation into validators or callers.
* **[T1.2]** `scripts/analyze-complexity.js`: stdin JSON structure validated
  before field access. Malformed hook inputs now exit cleanly with a
  `stderr` warning (visible in `hook-debug.log`) instead of silently treating
  `data.prompt` as `""`.
* **[T1.3]** `scripts/analyze-complexity.js`: fixed weight-normalization
  semantics. Previously weights that summed to 1.0 were silently scaled by
  0.9 (because `targetSubScoreSum = 1.0 - contextBoostWeight`). Now the
  normalizer accepts weights summing to either 1.0 or 0.9 as-is, and only
  renormalizes if the user wrote a non-standard sum. Deterministic signals
  are no longer silently weakened by ~10%.
* **[T1.4]** `hooks/hooks.json`: removed hardcoded fallback paths
  (`.../neon-local/.../2.0.0`). `${CLAUDE_PLUGIN_ROOT}` is always set by
  Claude Code; if it ever isn't, the hook fails fast and the SessionStart
  integrity check surfaces the problem. Non-NEON users no longer hit a
  bogus fallback path on edge-case first-run.
* **[T1.5]** `.github/workflows/preflight.yml`: version-sync check for
  `dist/README.md` heading now requires the full pattern
  `# Claude Model Changer vX.Y.Z - Self-Contained Installer`. Previously a
  heading rename would silently match `undefined`.
* **[T1.6]** (no-op) `config/patterns.json` confirmed as actively used by
  `/save-pattern`, `/patterns`, and `stats.loadPatterns`. Documented in
  CHANGELOG so it's not mistaken for dead code in future audits.

### Verification
- All 11 preflight checks green
- Bundle reproducibility md5-stable across builds
- CI behavioral tests (typo→haiku, architecture→opus, bug→sonnet) still pass
- New edge case handled: `echo '{}' | node scripts/analyze-complexity.js`
  exits cleanly with no crash

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
- `en` -> `models.<model>.categories.<key>.keywords`
- `hu` -> `translations.hu.<key>`
- `de` -> `translations.de.<key>`

This matches the existing multi-language structure of `task-routing.json`.

### Tier 2 auto-apply: per-user learned keywords

When `learn.autoApply.enabled = true` AND a keyword has been suggested
N+ times (default 5), the hook auto-appends it to a per-user
`logs/learned-keywords.json` file. This file is gitignored AND
deep-merged into the runtime config by `lib/config.js`, so the keyword
takes effect IMMEDIATELY on the next prompt.

The shared `task-routing.json` stays clean and reviewed - per-user
adaptations live separately. Run `/learn --promote` to get a diff for
incorporating learned keywords into `task-routing.json` via PR.

**New config:**
```json
"learn": {
  "autoApply": {
    "enabled": false,
    "minOccurrences": 5
  }
}
```

**Files: `scripts/lib/learned-config.js` (new), modified
`scripts/lib/io.js` (getLearnedConfigPath), `scripts/lib/config.js`
(deep-merge), `scripts/lib/learn-log.js` (lang field),
`scripts/show-learn-suggestions.js` (--promote flag),
`scripts/analyze-complexity.js` (--learn-promote command + auto-apply
trigger), `commands/learn.md` (documents --promote), `.gitignore`
(excludes learned-keywords.json).

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
