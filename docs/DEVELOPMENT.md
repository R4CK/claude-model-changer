# Claude Model Changer - Development History & Architecture

## Project Overview

**Name**: Claude Model Changer
**Version**: 2.2.0
**Author**: NEON
**License**: MIT
**Platform**: Claude Code CLI plugin (Node.js, zero npm dependencies)

A plugin that automatically analyzes prompt complexity and routes tasks to the optimal Claude model (haiku/sonnet/opus), reducing costs while maintaining quality.

---

## Architecture

### Hook System

```
User Prompt
    |
    v
[UserPromptSubmit Hook] --> analyze-complexity.js
    |                          |
    |                          +-- lib/config.js (load + validate + migrate)
    |                          +-- lib/scoring.js (keyword, structure, code blocks)
    |                          +-- lib/stats.js (patterns, adaptive weights, quality)
    |                          +-- lib/session.js (stickiness, history, project type)
    |                          +-- lib/context-monitor.js (token estimation, compaction)
    |                          +-- lib/monitors.js (budget, rate limit, anomalies)
    |                          +-- lib/auto-tune.js (category reclassification)
    |                          +-- lib/health.js (diagnostics)
    |                          +-- session-utils.js (session state, progress bars)
    |
    v
[Routing Decision] --> User confirms or auto-routes
    |
    v
[Subagent Worker] --> haiku-worker / sonnet-worker / opus-worker
    |
    v
[SubagentComplete Hook] --> detect-fallback.js
    |                          |
    |                          +-- Auto-log subagent model usage
    |                          +-- Detect [FALLBACK:model] markers
    |                          +-- Trigger re-delegation if needed
    |
    v
[Stop Hook] --> enforce-stats.js
                   |
                   +-- Remind Claude to display session stats
```

### Module Dependency Graph

```
analyze-complexity.js
  +-- lib/io.js           (file I/O, logging, paths, caching)
  +-- lib/config.js       (config loading, validation, caching)
  |     +-- lib/config-migrate.js (v1.0 -> v1.1 -> v2.0 migration)
  +-- lib/scoring.js      (complexity scoring engine)
  |     +-- lib/search.js (binary search for timestamp indexes)
  +-- lib/stats.js        (usage stats, patterns, adaptive weights)
  |     +-- lib/search.js
  |     +-- lib/benchmark-cache.js (model benchmarks)
  +-- lib/session.js      (session management, topic similarity)
  |     +-- session-utils.js (shared state utilities)
  +-- lib/context-monitor.js (context window tracking)
  +-- lib/monitors.js     (budget, rate limits, anomalies)
  +-- lib/auto-tune.js    (automatic config tuning)
  +-- lib/health.js       (diagnostics)
```

### File Locking Strategy

All session state writes use a shared lock file (`session-state.json.lock`):

1. **Acquire**: `fs.writeFileSync` with `{ flag: "wx" }` (exclusive create)
2. **Stale detection**: Lock older than 10s + PID liveness check via `process.kill(pid, 0)`
3. **Read-modify-write**: Read under lock, merge with `Math.max` for counters, atomic temp+rename write
4. **Release**: Always in `finally` block

### Data Flow

```
config/task-routing.json  <-- Configuration (28 categories, weights, thresholds)
config/patterns.json      <-- Saved routing patterns

logs/usage.jsonl          <-- All routing decisions (capped at 1000 entries)
logs/overrides.jsonl      <-- User model overrides (capped at 500)
logs/fallbacks.jsonl      <-- Subagent fallback events (capped at 500)
logs/quality.jsonl        <-- User quality ratings (capped at 500)
logs/benchmarks.jsonl     <-- Model benchmark results (capped at 200)
logs/session-state.json   <-- Current session counters and state
logs/status.json          <-- Last routing result (for VS Code extension)
logs/hook-debug.log       <-- Hook invocation debug log (rotated at 500 lines)
```

---

## Development Timeline & Bug Fix History

### Phase 1: Core Development (v1.0 - v2.0)

- Basic complexity scoring with 5 sub-scores
- 28 task categories across 3 models
- Multi-language support (EN/HU/DE)
- Session stickiness and context-aware routing
- Budget and rate limit monitoring
- Anomaly detection
- Adaptive weights from quality ratings
- GSD-inspired preflight checks and task splitting
- Self-extracting installer (`build-installer.js`)

### Phase 2: Plugin Integration (v2.0 - v2.2)

- Marketplace-based plugin system
- Deploy script with file integrity manifests
- Per-session state isolation
- Config migration system (v1.0 -> v1.1 -> v2.0)
- Benchmark caching
- Auto-tune with keyword discovery

### Phase 3: Comprehensive Review & Hardening (v2.2.0)

8 review iterations (code review + chaos engineering) found and fixed **28 bugs**:

#### Round 1 (8 fixes)
| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 1 | CRITICAL | agents/*.md + detect-fallback.js | Double counting: subagents counted by both hook AND manual script | Removed manual `log-subagent.js` calls from workers; hook is sole counter |
| 2 | CRITICAL | detect-fallback.js | Lock leak: no `try/finally` for lock release | Added `try/finally` pattern |
| 3 | HIGH | detect-fallback.js | `promptCount` inflated by subagent events | Removed promptCount increment from subagent path |
| 4 | HIGH | session-utils.js | Fallback field mismatch: read `to`/`targetModel` but written as `toModel` | Added `toModel` as first read option |
| 5 | HIGH | session-utils.js | Read-modify-write race: state loaded without lock | `saveSessionState` re-reads + merges under lock with `Math.max` |
| 6 | MEDIUM | detect-fallback.js | `indexOf` false positives for agent names | Word-boundary regex `\bhaiku\b` |
| 7 | MEDIUM | analyze-complexity.js | Weight normalization: config says 1.0, runtime uses 0.90 | Normalize to `1.0 - contextBoostWeight` |
| 8 | MEDIUM | analyze-complexity.js | `contextBoost` weight hardcoded at 0.10 | Configurable via `config.scoring.weights.contextBoost` |

#### Round 2 (6 fixes)
| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 9 | HIGH | analyze-complexity.js | `contextBoostWeight` not validated (negative/NaN possible) | Clamped to [0, 0.5] + NaN guard |
| 10 | MEDIUM | session-utils.js | `skillsUsed` merge only copied missing keys, didn't `Math.max` existing | `Math.max` for existing skill counters |
| 11 | MEDIUM | config.js | Weight validation summed `contextBoost` key (false warnings) | Excluded from sub-score sum |
| 12 | MEDIUM | health.js | Same false positive in health check | Updated message: "contextBoost is separate" |
| 13 | MEDIUM | session-utils.js | Stale lock recovery lacked PID liveness check | Added `process.kill(pid, 0)` check |
| 14 | MEDIUM | session-utils.js | Weekly usage double-counted fallback events | Removed `fallbacks.jsonl` from `getWeeklyUsage` |

#### Round 3 (4 fixes)
| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 15 | HIGH | io.js | `trimLog` used non-atomic write (data loss on disk-full) | Atomic temp+rename pattern |
| 16 | MEDIUM | session.js | `saveSessionState` leaked temp files on error | Added cleanup in catch block |
| 17 | MEDIUM | stats.js | Adaptive weights divide-by-zero if `totalWeight` = 0 | Guard: `return null` if `totalWeight <= 0` |
| 18 | MEDIUM | scoring.js | File-path regex O(n^2) on pathological prompts | Truncated input to 10K chars |

#### Round 4 (9 fixes — 2 MEDIUM + 7 LOW)
| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 19 | MEDIUM | scoring.js | Fractional code block count from odd backtick triples | Added `Math.floor` |
| 20 | MEDIUM | detect-fallback.js, context-monitor.js | String concatenation if modelCounts corrupted to string type | `Number()` coercion before increment |
| 21 | LOW | log-subagent.js | 170 lines of dead code after `process.exit(0)` | Stripped to 13-line deprecation stub |
| 22 | LOW | context-monitor.js | `resetSessionState` missing `subagentCounts` init | Added `subagentCounts: { haiku: 0, sonnet: 0, opus: 0 }` |
| 23 | LOW | configure.md | Display showed hardcoded balanced ranges instead of config | Changed to dynamic "read from config" |
| 24 | LOW | session-store.js | 170-line unused dead code module | Deleted entirely |
| 25 | LOW | generate-dashboard.js | 1-day trend chart rendered full-width bar | Fixed width calculation |

#### Round 6 (1 fix)
| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 26-28 | LOW | io.js, session-utils.js, detect-fallback.js, config.js, session.js, stats.js | UTF-8 BOM in JSON files causes silent parse failure + session reset | Added `.replace(/^\uFEFF/, "")` to all critical JSON readers |

#### Rounds 5, 7, 8: CLEAN
All previous fixes verified correct. No new issues found. Project confirmed production-ready.

---

## Configuration Reference

### `config/task-routing.json` Structure

```json
{
  "version": "2.0",
  "schemaVersion": "2.0",
  "behavior": "suggest",
  "preferenceProfile": "custom|cost-saver|balanced|quality-first",

  "models": {
    "haiku": { "scoreRange": [1, 2], "categories": { ... } },
    "sonnet": { "scoreRange": [3, 6], "categories": { ... } },
    "opus": { "scoreRange": [7, 10], "categories": { ... } }
  },

  "scoring": {
    "weights": {
      "keyword": 0.35,
      "multiFile": 0.20,
      "structure": 0.20,
      "wordCount": 0.15,
      "codeBlocks": 0.10,
      "contextBoost": 0.10
    },
    "questionReduction": 0.8,
    "keywordInfluence": "override|boost|none"
  },

  "autoMode": {
    "enabled": true,
    "autoThresholds": {
      "haiku": [1, 2],
      "opus": [8, 10]
    },
    "borderlineZones": [3, 4, 7, 8],
    "minConfidence": 40
  },

  "budgets": { "enabled": false, "limits": { ... } },
  "rateLimiting": { "enabled": true, "requestsPerMinute": 30 },
  "anomalyDetection": { "enabled": true, "thresholds": { ... } },
  "adaptiveWeights": { "enabled": true, "minWeight": 0.05 },
  "sessionStickiness": { "enabled": true, "threshold": 3 },
  "contextAware": { "enabled": true, "projectSignals": { ... } },

  "planLimits": {
    "sessionLimit": 50,
    "weeklyHaiku": 100,
    "weeklySonnet": 50,
    "weeklyOpus": 30,
    "weeklyAllModels": 200
  }
}
```

### Preference Profiles

| Profile | Haiku Range | Sonnet Range | Opus Range | Philosophy |
|---------|-------------|--------------|------------|------------|
| cost-saver | [1, 5] | [6, 8] | [9, 10] | Maximize haiku usage |
| balanced | [1, 3] | [4, 7] | [8, 10] | Equal distribution |
| quality-first | [1, 2] | [3, 6] | [7, 10] | Maximize opus usage |
| custom | User-defined | User-defined | User-defined | Full control |

---

## Testing

### Syntax Verification
```bash
cd "path/to/Claude Modell Changer"
for f in scripts/*.js scripts/lib/*.js; do node --check "$f" && echo "OK: $f"; done
```

### Functional Tests
```bash
# Test routing
echo '{"prompt":"fix the typo","session_id":"test","cwd":"."}' | node scripts/analyze-complexity.js

# Test subagent logging
echo '{"agent_name":"haiku-worker","response":"done","session_id":"test"}' | node scripts/detect-fallback.js

# Test deprecation guard
node scripts/log-subagent.js haiku

# Test dashboard generation
node scripts/generate-dashboard.js

# Test deploy
node scripts/deploy.js

# Test build installer
node scripts/build-installer.js
```

### Health Check
```
/health
```

---

## Security Considerations

- No npm dependencies (zero supply chain risk)
- All file paths use `path.join` (no injection)
- No user input used in regex construction
- File-path regex truncated to 10K chars (ReDoS prevention)
- All JSON parsers strip UTF-8 BOM
- NaN/Infinity guards on all numeric calculations
- Atomic writes with temp+rename pattern
- File locking with PID liveness checks
- No network calls (fully offline)
