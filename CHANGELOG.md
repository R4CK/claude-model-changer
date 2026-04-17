# Changelog

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
