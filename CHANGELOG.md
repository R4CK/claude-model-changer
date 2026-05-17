# Changelog

## v3.6.0 — Multi-source auto-sync (agents + commands + 3 new repos)

Extends the v3.5.0 external-sync system in two directions:

1. **The syncer can now mirror agents and commands**, not just skills.
   Each repo declares a `sources` array; every entry has a `kind`
   (`skill` / `agent` / `command` / `hook`) which routes the item to
   the matching plugin dir (`skills/` / `agents/` / `commands/` /
   `hooks/`).
2. **Three new repos** join the auto-sync set:
   [obra/superpowers](https://github.com/obra/superpowers),
   [ruvnet/ruflo](https://github.com/ruvnet/ruflo),
   [pablo-mano/Obsidian-CLI-skill](https://github.com/pablo-mano/Obsidian-CLI-skill).
   The existing `everything-claude-code` repo also picks up its 60
   agents and 75 commands that v3.5.0 missed.

### Summary of synced inventory (per-run measurements)

| Repo | Skills | Agents | Commands | Prefix |
|---|---:|---:|---:|---|
| open-design | 131 | – | – | `od-` |
| ui-ux-pro-max-skill | 1 | – | – | `nlb-` |
| awesome-claude-skills | 28 | – | – | `acs-` |
| everything-claude-code | 230 | 60 | 75 | `ecc-` |
| **superpowers** | 14 | – | – | `sp-` |
| **ruflo** (main) | 134 | 107 | 153 | `rf-` |
| **ruflo** (`plugins/*`) | 104 | 45 | 40 | `rfp-` |
| **obsidian-cli-skill** | 1 | – | – | `obs-` |
| **Total** | **643** | **212** | **268** | |

Total per-session footprint: ~1100 items across 7 repos. The whole
batch syncs in ~3 seconds when nothing changed remotely (one
`git ls-remote` per repo, no other I/O).

### New layout types

| `layout` | Behavior |
|---|---|
| `subfolder` | each child folder of `<skillsPath>/` = one item (existing) |
| `root-multi` | each top-level folder that has SKILL.md/skill.json (existing) |
| `root-single` | the repo (or `<skillsPath>`) itself = one item (existing) |
| **`flat-md`** | each `.md` file directly under `<skillsPath>/` = one item |
| **`nested-md`** | recursively walk `<skillsPath>/`; each `.md` file = one item (subdir parts become dashed name segments) |
| **`plugin-multi`** | iterate `<skillsPath>/<plugin>/<innerPath>/...` per sub-plugin, prefixing items with `<plugin>-` (used for ruflo `plugins/` ecosystem) |

README/CHANGELOG/LICENSE-style docs are auto-skipped in `flat-md` /
`nested-md` so they don't accidentally appear as fake agents/commands.

### Config schema v2

```jsonc
{
  "sync": { "enabled": true, "intervalHours": 24, "background": true },
  "repos": [
    {
      "name": "everything-claude-code",
      "url": "https://github.com/affaan-m/everything-claude-code",
      "enabled": true,
      "sources": [
        { "kind": "skill",   "layout": "subfolder", "skillsPath": "skills",   "destPrefix": "ecc-" },
        { "kind": "agent",   "layout": "flat-md",   "skillsPath": "agents",   "destPrefix": "ecc-" },
        { "kind": "command", "layout": "flat-md",   "skillsPath": "commands", "destPrefix": "ecc-" }
      ]
    }
  ]
}
```

The legacy v3.5.0 single-source format (`layout` + `skillsPath` at the
repo root, no `sources` array) still works — it's transparently
synthesized into a single-source array at load time.

### CLI contract change

`sync-external-skills.js` now takes the **plugin root** (not just
`skills/`). The session-sync wrapper was updated accordingly. For
backward compat the syncer auto-strips a trailing `/skills` from the
arg, so v3.5.0 callers don't break.

### Files

- **Modified:** `scripts/sync-external-skills.js` — multi-source
  iteration, `flat-md`/`nested-md`/`plugin-multi` layout support,
  kind-based dest routing
- **Modified:** `scripts/external-skills-session-sync.js` — passes
  plugin root instead of `skills/`
- **Modified:** `config/external-skills.json` — v2 schema with
  `sources` arrays; +3 new repos
- **Modified:** `.gitignore` — added `agents/<prefix>` and
  `commands/<prefix>` patterns for the new auto-synced items
- **Modified:** `scripts/build-installer.js` — EXCLUDE list extended
  with `agents/`, `commands/`, and the new prefixes so the bundle
  stays at ~870KB

---

## v3.5.0 — External skills auto-sync (4 new repos)

Extends the karpathy-style "always-latest" skill sync pattern to four
additional upstream skill collections. Every SessionStart now spawns a
detached background child that, throttled to once per 24h, walks the
configured repo list and pulls each one **only when its remote HEAD has
actually changed**.

### New skill sources

Seeded in `config/external-skills.json`:

| Repo | Prefix | Skills | Layout |
|---|---|---|---|
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | `od-` | ~107 | `skills/` subfolder |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | (single) | 1 | whole repo is one skill |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | `acs-` | ~28 | top-level dirs with `SKILL.md` |
| [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | `ecc-` | ~228 | `skills/` subfolder |

Per-repo prefixes keep names from colliding with existing karpathy
skills or each other (e.g. `brand-guidelines` appears in 3 of the 4
repos).

### Smart-update: two-tier "only if changed"

1. **Time throttle** (`external-skills-session-sync.js`) — skips the
   whole spawn if the last successful sync stamp is < 24h old.
   Configurable via `sync.intervalHours` in the config.
2. **Per-repo HEAD diff** (`sync-external-skills.js`) — for each
   enabled repo, runs `git ls-remote origin HEAD` (a few KB, no
   object download) and compares to the local `HEAD` sha. If shas
   match **and** every dest skill folder still exists, the repo is
   skipped entirely. No fetch, no reset, no copy. Measured full
   no-op run across 4 repos: ~2 seconds.

When a remote sha differs, the script does a shallow `fetch --depth 1`,
hard-resets to `FETCH_HEAD`, discovers skill folders per the repo's
declared `layout` (`subfolder` / `root-multi` / `root-single`), and
mirrors them into the plugin's `skills/` directory.

### Layout discovery rules

- `subfolder`: every directory under `<repo>/<skillsPath>/`
- `root-multi`: every top-level directory that contains `SKILL.md`
  or `skill.json` (auto-excludes README/CI/dotfiles and any name
  in the repo's `excludeFolders`)
- `root-single`: the repo root is treated as one skill

Symlinks are dereferenced rather than recreated, so dest folders are
self-contained on Windows (where `ui-ux-pro-max-skill` uses symlinks
for shared data).

### Files

- **New:** `config/external-skills.json` — repo list + sync config
- **New:** `scripts/sync-external-skills.js` — generic syncer with
  smart HEAD-diff and layout-aware skill discovery
- **New:** `scripts/external-skills-session-sync.js` — throttled
  background spawner (mirrors `karpathy-session-sync.js`)
- **Modified:** `scripts/runtime-check.js` — SessionStart now spawns
  the external sync alongside the existing karpathy sync
- **Modified:** `.gitignore` — auto-synced skill dirs (`acs-*`,
  `ecc-*`, `od-*`, `nlb-*`, `karpathy-*`) and last-sync stamps are
  no longer tracked

### Manual refresh

```
node scripts/sync-external-skills.js skills           # all repos
node scripts/sync-external-skills.js skills --force   # bypass smart-skip
node scripts/sync-external-skills.js skills --repo=open-design
```

---

## v3.4.2 — Stats footer reliability fix + statusline TUI mode hint

User reported that after restart, the stats summary was still not
appearing at the end of responses, and the statusline wasn't visible
either. Diagnosis:

1. **Stats footer:** The "MANDATORY STATS DISPLAY" instruction was at
   the START of the routing hook output. By the time Claude composed
   its long response, that instruction was buried under tens of
   sub-score / category / Effort / context / quota lines and got
   forgotten about. Result: Claude rarely appended the footer.

2. **Statusline:** Claude Code 2.1.x has two TUI renderers — `default`
   (classic main-screen) and `fullscreen` (alt-screen, flicker-free,
   virtualized scrollback). The statusline is most reliably rendered
   in **fullscreen** mode. The user's `~/.claude/settings.json` had
   no `tui` field set, defaulting to `default` mode where the
   statusline can be invisible or sporadic depending on terminal.

### Fix 1: Stats footer moved to END + `<system-reminder>` formatting

`scripts/analyze-complexity.js` — the stats block was relocated from
the **top** of the hook output to the **bottom** so it's the last
thing Claude reads before composing the reply. Empirically much more
reliable in 2.1.x.

Format also changed from a plain-text "MANDATORY STATS DISPLAY"
banner to a proper `<system-reminder>` block:

```
<system-reminder>
After completing the user's request, append these exact lines as the last
lines of your response (no other text after them):

📊 haiku 75%(2🤖) ████████░░ | sonnet 13% █░░░░░░░░░ | opus 13% █░░░░░░░░░ | …
🔋 Context █░░░░░░░░░ 11% | Session ██░░░░░░░░ 16% (42 left)
📈 Weekly: Haiku █░░░░░░░░░ 14% | Sonnet ██░░░░░░░░ 17% | Opus ████░░░░░░ 38%
📊 Total: ███████░░░░░░░░░░░░░ 36% (72/200)
</system-reminder>
```

`<system-reminder>` is the same wrapper Claude Code uses internally
for high-priority instructions; Claude treats it as imperative.

### Fix 2: `tui: "fullscreen"` for statusline reliability

User's `~/.claude/settings.json` updated to add `"tui": "fullscreen"`.
This activates the alt-screen renderer where the statusline appears
reliably at the bottom of the TUI.

The statusline command itself (added in v3.2.0) was already correct —
the issue was purely the renderer mode. Manual verification:

```
🟡 sonnet │ ctx 12% │ wk 35% │ $0.20
```

### No code-behavior changes for routing

Routing logic, scoring, all v3.x features unchanged. Only the visual
output format changed (stats footer position + wrapper) and a
settings.json adjustment.

Tests: 79/79 unit tests pass; preflight green.

Version sync 3.4.1 → 3.4.2.

## v3.4.1 — Keyword cleanup (post-v3.4.0 audit)

User-requested vocabulary review of the v3.4.0 keyword expansion. The
audit caught 9 questionable Hungarian entries — broken language, English
in HU lists, wrong loanword forms, malformed grammar. v3.4.1 fixes them.

### Hungarian cleanup (9 fixes)

| Category | Before | After | Reason |
|---|---|---|---|
| `typo_fix` | `betű csere` | `betűcsere` | one-word per Hungarian orthography |
| `feature_addition` | `fícsör` | _(deleted)_ | broken loanword; `új funkció` already covers |
| `testing` | `tesztsuit` | `tesztkészlet` | wrong transliteration of "test suite" |
| `code_review` | `PR review` | `pull request átnézése` | English phrase, not Hungarian |
| `small_refactoring` | `függvényké alakítsd` | `függvénnyé alakítsd` | grammar (-é vs -nyé suffix) |
| `small_refactoring` | `DRY-osítsd` | `DRY elv alkalmazása` | broken hybrid; clean form |
| `component_creation` | `kompo` | _(deleted)_ | truncated stem, not a word |
| `error_handling` | `retry logika` | `retry-logika` | hyphenated compound (HU rule) |
| `planning` | `release plan` | `kiadási terv` | English phrase → Hungarian |

### What stayed

The audit listed several "ASCII-only" entries that LOOK English but are
actually proper Hungarian IT vocabulary or accepted loanwords:

* Real Hungarian words: `algoritmus`, `adatszerkezet`, `elemezd`,
  `csatlakoztasd`, `elosztott rendszer`, `rendszerterv`, `adatfolyam`,
  `mi az`, `hol van`, `hogyan`, `mutasd meg`, `keresd ki`, `teljes
  projekt`
* Established loanwords used in HU IT jargon: `webhook`, `bug`,
  `benchmark`, `komment`, `debugold`, `mock objektum`, `OWASP`,
  `OAuth`, `JWT`, `CQRS`

### Result

- HU vocabulary: 242 → **240** entries (2 deletions: `fícsör`,
  `kompo`; the rest were replacements)
- EN/DE: unchanged
- All replaced/added entries verified to route correctly:
  - `betűcsere` → Typo fixes (haiku) ✓
  - `tesztkészlet írása` → Testing (sonnet) ✓
  - `pull request átnézése` → Code review (sonnet) ✓
  - `DRY elv alkalmazása` → Small refactoring (sonnet) ✓
  - `kiadási terv készítése` → Planning (opus) ✓

### No code-behavior changes

Files modified: `config/task-routing.json` only.

Tests: 79/79 still pass; preflight green.

Version sync 3.4.0 → 3.4.1.

## v3.4.0 — Keyword expansion (+232 IT-jargon keywords) + `reaktorozd` typo fix

User-reported issue: the README v3.3.x example "Hungarian morphology
(`elgépelést`, `reaktorozd`)" used **`reaktorozd`** as an IT-jargon
example. That word does not exist in software context — it's a
verbalization of "reaktor" (nuclear reactor). The correct Hungarian
verb for code refactoring is **`refaktoráld`** / **`refaktorozd`**
(both valid, both now in the dictionary).

Plus: a substantial vocabulary expansion across all three languages.

### Bug fix: `reaktorozd` → `refaktoráld`

- `README.md`: the morphology example replaced
- `config/task-routing.json` HU `small_refactoring`: removed
  `reaktorozás`, added the correct forms (`refaktoráld`,
  `refaktorálás`, `refaktorozd`, `refaktorozás`) plus broader IT
  context (`absztraháld`, `kiemelni metódusba`, `függvényké
  alakítsd`, `törd szét kisebb függvényekre`, `duplikáció
  eltávolítása`, `DRY-osítsd`)

### Keyword expansion: +232 entries across all 30 categories

| Language | Before | After | New |
|---|---|---|---|
| English | 205 | 286 | **+81** |
| Hungarian | 167 | 242 | **+75** |
| German | 130 | 206 | **+76** |
| **Total** | **502** | **734** | **+232** |

Every category got 2-5 new keywords spanning typical IT-jargon:

* **Haiku tier:** `lint`, `auto-format`, `case fix`, `javadoc`,
  `tsdoc`, `git stash`, `git diff`, `tell me`, `look up`, etc.
  HU: `kódformázás`, `behúzás javítás`, `kódkommentárok`, etc.
  DE: `Code formatieren`, `Einrückung`, `Lint-Fehler`, etc.

* **Sonnet tier:** `mock`, `stub`, `fixture`, `snapshot test`,
  `extract method`, `inline`, `factory`, `builder`, `service`,
  `webhook`, `polling`, `env vars`, `feature flag`, `try-catch`,
  `retry`, `profile`, `trace`, `metrics`, `deep dive`, etc.
  HU: `egységteszt`, `mock objektum`, `tesztsuit`, `kivételkezelés`,
  `retry logika`, `memóriaszivárgás`, etc.
  DE: `Unit-Test schreiben`, `Mock-Objekt`, `Methode extrahieren`,
  `API-Integration`, `Ausnahmebehandlung`, etc.

* **Opus tier:** `domain model`, `bounded context`, `OWASP`,
  `OAuth`, `JWT`, `csrf`, `xss`, `event sourcing`, `CQRS`,
  `microservice`, `data structure`, `graph`, `tree`, `hash map`,
  `load test`, `stress test`, etc.
  HU: `rendszerarchitektúra`, `OWASP`, `terheléses teszt`,
  `elosztott rendszer`, `esemény alapú architektúra`, etc.
  DE: `Systemarchitektur`, `OWASP`, `Sicherheitsaudit`,
  `Verteiltes System`, `Lasttest`, etc.

### Language detection threshold lowered (HU/DE: 3 → 2)

Pre-v3.4.0 the language detector required 3 matching tokens to flag
HU/DE. Terse 2-3 word IT prompts like `refaktorozd a kódot` or `Bug
beheben` only matched 1-2 tokens and fell through to English keyword
matching, which had no entries for these words → "none" category →
default haiku routing.

v3.4.0:
- Lowered HU/DE threshold from 3 to 2
- Extended `huWords` and `deWords` lists in `detectLanguage()` with
  IT-jargon stems (`refaktor`, `kódot`, `vizsgáld`, `memória`,
  `rendszer`, `behebe`, `bug`, `lasttest`, `komponente`, `audit`,
  etc.)

Result: terse 2-3 word HU/DE prompts now reliably trigger their
language path. Verified against 6 prompts that pre-v3.4.0 fell
through to "none":

| Prompt | Pre-v3.4.0 | v3.4.0 |
|---|---|---|
| `refaktorozd a kódot` | none → haiku | Small refactoring → sonnet |
| `vizsgáld a memóriaszivárgást` | none → haiku | Performance debugging → sonnet |
| `Bug beheben` | none → haiku | Bug fixing → sonnet |
| `Lasttest durchführen` | none → haiku | Testing → sonnet |
| `elemezd a teljesítményt` | none → haiku | Code investigation → sonnet |
| `implementiere ein Modul` | none → haiku | Feature addition → sonnet |

### No code-behavior changes for existing prompts

All 79 unit tests still pass; preflight green. Existing keyword matches
continue to work — only new vocabulary added. The lowered language
threshold is mitigated by the IT-stem-biased word lists (English short
prompts won't accidentally match 2 IT-specific HU/DE stems).

Files modified: `config/task-routing.json` (vocabulary),
`scripts/lib/scoring.js` (detectLanguage),
`README.md` (typo + version table).

Version sync 3.3.2 → 3.4.0.

## v3.3.2 — Patch release: version consistency, Stop hook architecture, statusline docs

A small but meaningful housekeeping release with three improvements
discovered during a post-v3.3.1 audit.

### Bug fixes

**Stop hook stdout never reached the assistant turn (architectural fix)**

`scripts/enforce-stats.js` was emitting plain text to stdout (`REMINDER:
Append these stats lines...`), but Claude Code's Stop hook stdout is
**not injected into the assistant response that just ended** — Claude
already finished its turn. This is by design.

Pre-v3.3.2 behavior: stats reminder only landed in `logs/hook-debug.log`,
never in the conversation. The user-facing stats footer was thus a
"best effort" on the UserPromptSubmit hook output, which Claude usually
but not always followed.

v3.3.2 changes the Stop hook to emit `hookSpecificOutput.additionalContext`
JSON. Claude Code's hook spec specifies this field is fed back into the
**next** user turn as additional context — so the stats appear at the
start of the next response instead of disappearing.

For real-time stats display, **use the statusline** (the only mechanism
Claude Code provides for always-visible per-tick info). Wire it via:

```json
"statusLine": {
  "type": "command",
  "command": "node \"<plugin-cache>/scripts/statusline.js\""
}
```

A header comment was added to `enforce-stats.js` documenting this
architectural reality.

### Documentation

**Standalone PreToolUse scripts now flag their status**

`scripts/context-bloat-detect.js` and `scripts/git-commit-hook.js` were
consolidated into `pre-tool-router.js` in v3.2.1, but the standalone
scripts were retained for direct invocation / testing. v3.3.2 adds an
explicit "STATUS (v3.2.1+): standalone-only" header comment to each so
new contributors don't wire them into hooks.json by mistake.

**README slash commands count: 17 → 27**

The Repository layout section had `# 17 slash commands` left over from
v3.2.3. Actual count is now 27 (v3.3.0 added five new commands: /undo,
/whatif, /profile, /weekly-digest, /fallback-learn). Fixed.

### Version consistency sweep

Pre-v3.3.2 had stale version strings in:
- Local cache `plugin.json`: 3.2.3 (should be 3.3.1+)
- Local marketplace `plugin.json`: 3.2.3 (should be 3.3.1+)
- Marketplace.json plugin entry: still 3.2.1 (mirrored "v3.2.1" in description)
- Marketplace.json plugin description: outdated feature list ("28 categories, 4 hooks")

All bumped to 3.3.2. Marketplace description rewritten to reflect the
current feature set (30 categories, 5 hooks, 27 commands, all v3.x feats).

### No code-behavior changes

Routing logic, scoring, all v3.3.0 features unchanged. Stats footer
mechanism shifted from soft-instruction-on-routing to next-turn-context
via Stop hook JSON output — strictly an improvement, no regression.

Tests: 79/79 still pass; preflight green.

Version sync 3.3.1 → 3.3.2.

## v3.3.1 — README refresh (covers v3.3.0 features)

Documentation-only release. The v3.3.0 PR bumped the README badge but
did not refresh the actual content with the 7 new features. v3.3.1 fixes
that omission.

### README changes

- "What's new" table: added v3.3.0 row (7 community features) + v3.2.3 row
- Pipeline diagram: added "Fallback boost (+0..N, v3.3.0 R30)" stage
  before contextBoost layers; clarified parallel dispatch +2 skip
  condition for Agent Teams lead
- Commands table: 17 → 22 entries
  - Diagnostic & analysis: added `/whatif`, `/weekly-digest`, `/fallback-learn`
  - Routing & overrides: added `/undo`
  - Configuration: added `/profile`
- Configuration JSON example: added 6 new feature blocks
  (`fallbackLearning`, `tokenPreview`, `proactiveCompact`, `undo`,
   `profiles`, `weeklyDigest`)
- New "Routing pipeline overlay order (v3.3.0)" subsection documenting
  base → learned → profile → per-project overlay
- Repository layout: added 5 new scripts (`whatif.js`, `weekly-digest.js`,
  `lib/fallback-learn.js`, `lib/last-routing.js`, `lib/profile-manager.js`)
- Getting Started example: added Tokens preview line to demo output
- Comparison table: 6 new feature rows (auto-learn fallback, undo,
  per-prompt cost, what-if, multi-profile, weekly digest)
- FAQ: 5 new entries (undo, fallback learning, /whatif, profiles, digest)

### No code changes

Bundle (`dist/install.js`) rebuilt to embed the updated README.

Tests: 79/79 still pass; preflight green.

Version sync 3.3.0 → 3.3.1.

## v3.3.0 — Seven community-driven features (fallback learning, whatif, undo, token preview, weekly digest, profiles, proactive compact)

A coordinated batch of features driven by community research and the v3.2.x
audit. Every addition is config-gated and harmonized with the existing
pipeline — see "Harmonization audit" at the end.

### R30 — Fallback feedback loop

`scripts/lib/fallback-learn.js` (new). When the haiku-worker emits
`[FALLBACK:sonnet]` and the SubagentStop hook logs it, this loop reads
those events from `logs/fallbacks.jsonl` over the last 30 days, computes
per-category fallback rates, and auto-boosts the keyword score by +2 for
any category exceeding 30% fallback rate (with ≥5 samples).

The boost runs IMMEDIATELY AFTER the keyword score is computed, so it
flows into the rest of the pipeline naturally. Completely separate from
adaptive weights (which learn from `quality.jsonl` user ratings) — the
two signals are complementary: human feedback vs machine feedback.

* New slash command: `/fallback-learn`
* Config: `fallbackLearning.{enabled, windowDays, rateThreshold, minSamples, boostPoints}`
* 6h cache TTL on `logs/fallback-learn.json` for fast hot-path lookup

### R31 — `/whatif` config simulator

`scripts/whatif.js` (new). Replays the last 500 prompts under a hypothetical
config change to preview routing impact before you commit.

```
node scripts/whatif.js move "refactor" sonnet opus
node scripts/whatif.js threshold opus '[7,10]'
node scripts/whatif.js add-keyword sonnet bug_fixing "investigate timeout"
node scripts/whatif.js disable mcpToolAwareness
```

Output: routing changes count, cost delta with weekly extrapolation,
distribution before/after, sample changed prompts. **Read-only** — never
modifies the real config.

* New slash command: `/whatif`
* Uses a simplified routing path (keyword + scoreRange only); session-
  state-dependent overrides like skill triggers, agent teams, and quota
  downgrade are NOT replayed (documented in the slash command).

### R32 — Proactive compact suggestion

`scripts/lib/context-monitor.js` extended with `detectTopicShift()` and
`computeProactiveSuggestion()`. Combines context window % with topic-
similarity drop (Jaccard against last 3 prompts' topic words):

| Trigger | Suggestion level |
|---|---|
| Context ≥ 75% | `force` (auto-compact imminent) |
| Context ≥ 65% | `warn` (strongly recommend) |
| Topic shift + ≥ 50% | `suggest` (you switched tasks) |
| Context ≥ 55% | `suggest` (gentle) |
| Topic shift + < 50% | `topic` (just FYI) |

Output line uses icons (⛔ / ⚠ / 💡). Composes with the existing
`isCompact{Suggest, Warn, Force}` flags — this is the unified user-
facing message.

* Config: `proactiveCompact.{enabled, topicShiftThresholdPercent}`

### R33 — `/undo` last routing

`scripts/lib/last-routing.js` (new). Every routing decision is persisted
to `logs/last-routing.json`. The `/undo` slash command:

1. Reads the last decision (with 10-minute staleness limit)
2. Escalates to the next-tier model: haiku → sonnet → opus
3. Auto-rates the original decision as quality 1 (poor) in
   `logs/quality.jsonl` so adaptive weights learn from your correction
4. Outputs a re-route instruction for Claude to follow

* New slash command: `/undo`
* Config: `undo.{enabled, maxAgeSec}`

### R35 — Token estimator preview

`analyze-complexity.js` extended. Every routing decision now emits:

```
Tokens preview: ~7 in + ~1500 out → $0.0225 at sonnet (haiku $0.0075 · sonnet $0.0225 · opus $0.1126)
```

Composes with `/quota` and `/context-audit` for full cost visibility.

* Config: `tokenPreview.{enabled, avgResponseTokens}`

### R36 — Weekly cost digest

`scripts/weekly-digest.js` (new). Generates a narrative markdown report
comparing this week to last week:

- Total prompts (week-over-week)
- Cost estimate (vs last week, vs all-opus baseline, savings %)
- Active profile (R43 integration)
- Model distribution + percentages
- Effort breakdown (low / medium / high)
- Top 5 categories
- Quality avg + fallback events count
- Git activity (commits, pushes, force-pushes)
- Anomalies (opus usage spikes)

Saves to `logs/weekly-digest-YYYY-MM-DD.md`. Designed for `/loop 7d` or
the `scheduled-tasks` MCP.

* New slash command: `/weekly-digest`
* Config: `weeklyDigest.{enabled, writeToLogs}`

### R43 — Multi-profile / multi-account switching

`scripts/lib/profile-manager.js` (new). Profiles are partial config files
at `~/.claude/profiles/<name>.json` that overlay on top of the base
`task-routing.json`.

**Overlay order (longest-specificity wins):**

```
base task-routing.json
  → learned-keywords.json (auto-learned vocabulary)
  → R43 profile (~/.claude/profiles/<active>.json)         ← NEW
  → per-project .claude/model-routing.json                  ← still strongest
```

The profile is applied in `lib/config.js:loadConfig()` between
learned-keywords and per-project overrides — so per-project files still
win for project-specific rules, but profiles let you switch global
"personal vs work" or "cost-saver vs quality-first" stances.

* New slash command: `/profile` (sub-commands: `list`, `current`, `switch`, `clear`)
* Config: `profiles.{enabled, autoSwitchByCwd}`
* Resolution order: cwd-mapped (in `.project-map.json`) > globally active > none

Auto-switch by cwd via `~/.claude/profiles/.project-map.json` (longest path-
prefix wins). Use `--profile-switch <name>` to set globally active.

### Harmonization audit

All 7 features were checked against the v3.2.x pipeline. Findings:

| Interaction | Resolution |
|---|---|
| R30 boost vs adaptive weights | Different sources (fallback log vs quality log); both add boost cleanly |
| R30 boost vs auto-tune | Auto-tune SUGGESTS new keywords; R30 BOOSTS existing categories |
| R31 quickRoute vs full pipeline | Documented limit: skill triggers/agent teams/quota not replayed (session-state-dependent) |
| R32 proactive vs context-monitor flags | Combined into single user-facing line; flags retained for downstream |
| R33 /undo vs manual override | Manual = pre-decision; undo = post-decision; no conflict |
| R35 token preview vs context-monitor | Per-prompt cost ADD; context-monitor stays for cumulative % |
| R36 digest vs /stats | /stats real-time JSON; digest weekly markdown narrative |
| R43 profile vs per-project override | Per-project still wins (overlay order: base → learned → profile → project) |

### Files added (12)

- `scripts/lib/fallback-learn.js`
- `scripts/lib/last-routing.js`
- `scripts/lib/profile-manager.js`
- `scripts/whatif.js`
- `scripts/weekly-digest.js`
- `commands/undo.md`, `commands/whatif.md`, `commands/profile.md`, `commands/weekly-digest.md`, `commands/fallback-learn.md`

### Files modified (3)

- `scripts/analyze-complexity.js` — integrate fallback boost, token preview,
  /undo persistence, profile annotation; new special commands
- `scripts/lib/config.js` — apply profile overlay between learned and project
- `scripts/lib/context-monitor.js` — proactive suggestion + topic-shift

Tests: 79/79 still pass; preflight green.

Version sync 3.2.3 → 3.3.0.

## v3.2.3 — Comprehensive README refresh

A documentation-only release that brings the README up to date with everything
shipped between v3.0.0 and v3.2.2. The pre-v3.2.3 README still showed
`v3.0.0` badge, listed only 4 hooks, 28 categories, and the old Claude 3.5
Haiku pricing — none of the v3.x features were documented.

Changes (README.md):
- Badge updated v3.0.0 → v3.2.3
- New "What's new in v3.2.x" version-by-version tour section
- Cost model updated to Claude 4.x pricing (Haiku 4.5 = $1/$5)
- Context window table now shows Opus 4.7 1M option
- Routing pipeline diagram covers all v3.2.x stages
- Commands table 11 → 17 entries, grouped by purpose
- Hooks table 4 → 5 (PreToolUse added)
- v3.x feature config blocks reference added
- Skill trigger rules table added
- Repository layout updated with all new scripts
- 4 new FAQ entries (quota, context bloat, statusline, karpathy upstream)
- Comparison table extended with quota-aware / context-bloat / statusline /
  git hook / skills-aware columns

No code changes. Files-only release.

Tests: 79/79 still pass; preflight green.

Version sync 3.2.2 → 3.2.3.

## v3.2.2 — Update flow documentation + path-source helper

A documentation-and-helper release that fills a gap from earlier versions:
how to actually update the plugin once it's been installed.

### New: `UPDATING.md`

Decision-tree-style document explaining the three install paths and how
each one updates:
- **GitHub-source marketplace** — `autoUpdate: true` is the zero-touch path
- **Path-source marketplace** — manual or via the new helper script
- **Self-extracting installer** — re-run `install.js` to upgrade

### New: `scripts/update-from-github.js`

Helper for path-source marketplace users (the original-author dev setup
where `extraKnownMarketplaces.<owner>.source = "path"` rather than
`"github"`). Pulls the latest tagged release from upstream and overwrites
the local marketplace tree.

```bash
node scripts/update-from-github.js               # latest tag
node scripts/update-from-github.js --tag v3.2.1  # specific version
node scripts/update-from-github.js --dry         # preview without applying
```

Skips `logs/`, `.git/`, `node_modules/`, and any path listed in a
`.update-preserve` file at the marketplace root (for users who keep local
config edits).

### Background — why this matters

The original local-development setup used `"source": "path"`, which is great
for editing the plugin locally but means GitHub releases NEVER reach the
running plugin without manual intervention. Pre-v3.2.2 the only paths to
"update" were:
1. Hand-copy files from the GitHub repo
2. Re-run `install.js` from a release download

v3.2.2 adds a single-command path that's reliable, dry-runnable, and
preserve-list-aware — closing the loop for path-source users.

### No code-behavior changes

This release adds files only. No routing logic, scoring, or hook code is
modified. v3.2.1 → v3.2.2 is a no-op for runtime behavior.

Tests: 79/79 still pass; preflight green.

Version sync 3.2.1 → 3.2.2.

## v3.2.1 — Feature harmony fixes (post-v3.2.0 audit)

A self-audit found three feature interaction issues introduced in v3.2.0
where new signals were silently overridden or duplicated. v3.2.1 fixes them.

### Bug 1 (CRITICAL): Skill trigger and Agent Teams overrides ignored

**Symptom:** A prompt like `superpowers:debugging fix the typo` would emit
the line `Skill trigger: "superpowers:debugging" → sonnet` but route to
`haiku` anyway.

**Root cause:** Skill trigger override (line ~298) and Agent Teams override
(line ~305) ran BEFORE keywordInfluence override (line ~329). When a keyword
matched (`Typo fixes` → haiku in the example), keywordInfluence reverted the
skill/teams decision, making the v3.1.0 skill rules and v3.2.0 agent teams
features no-ops in many real-world cases.

**Fix:** Both overrides now run AFTER keywordInfluence, immediately before
stickiness/quota. Order: score-based → keywordInfluence → skill trigger →
agent teams → stickiness → quota downgrade.

**Verification:**
- `superpowers:debugging fix typo` → sonnet (was haiku) ✓
- `feature-dev:code-architect fix typo` → opus (was haiku) ✓
- `as team lead fix typo` → opus (was haiku) ✓
- `as teammate fix typo` → sonnet (was haiku) ✓

### Bug 2 (MEDIUM): Parallel dispatch + Agent Teams double-counting

**Symptom:** A prompt like `as team lead dispatch agents in parallel` triggered
both signals, adding +2 contextBoost from parallel dispatch AND a model
override from Agent Teams. Both target the same orchestrator pattern;
parallel's score boost was redundant.

**Fix:** When `agentTeamsRole.role === "lead"`, skip the +2 parallelDispatch
contextBoost. Both signals are still emitted in the output for visibility,
but only one impacts scoring.

### Bug 3 (LOW): Pattern match short-circuited too aggressively

**Symptom:** A saved pattern would early-return without computing quota state
or effort, so a saved opus pattern fired even when weekly opus quota was
exhausted, and never emitted a thinking-budget hint.

**Fix:** Pattern match path now computes `quotaState` + `quotaDowngrade` and
synthesizes an `effort` decision based on the matched model's tier
(haiku=low, sonnet=medium, opus=high). The pattern still wins routing, but
quota-aware downgrade still applies.

### Performance: Two PreToolUse hooks merged

**Issue:** v3.2.0 wired `Read|Bash` to context-bloat-detect AND `Bash` to
git-commit-hook. On every Bash command, both ran sequentially, spawning two
Node processes (cumulative 5s + 8s timeout, ~0.5s wall clock locally).

**Fix:** New `scripts/pre-tool-router.js` is a single hook that delegates to
both detectors internally. `hooks/hooks.json` now wires only this one hook
on `Read|Bash`. The original two scripts are retained for direct invocation
but no longer auto-fire.

**Result:** ~50% fewer process spawns on Bash commands; output messages
merged into one combined `systemMessage`.

### Tests

- 79/79 unit tests pass (no regressions)
- All 4 bug-1 cases now route correctly
- Auto-benchmark drift: 0 cases (still 8/10 baseline pass)
- Combined PreToolUse hook output verified

### Files modified

- `scripts/analyze-complexity.js` — pipeline reordering, pattern-match enrichment
- `hooks/hooks.json` — single PreToolUse entry
- `scripts/pre-tool-router.js` (new) — combined hook router

### Backward compatibility

All v3.2.0 config blocks remain valid. The two original PreToolUse scripts
(`context-bloat-detect.js`, `git-commit-hook.js`) still work standalone for
testing, just not invoked automatically anymore.

Version sync 3.2.0 → 3.2.1.

## v3.2.0 — Quota awareness, statusline, context bloat, agent teams, git hooks, auto-benchmark

Eight new features driven by community research (Reddit r/ClaudeAI / r/ClaudeCode,
GitHub issues, dev blogs). Every addition is config-gated and defaults
conservatively — `enabled: false` reverts to v3.1.1 behavior per feature.

### Quota-aware routing (R1)

The plugin now tracks weekly + 5-hour rolling usage windows from
`logs/usage.jsonl` and automatically downgrades opus → sonnet when weekly
opus usage crosses a threshold. Eliminates "Opus weekly quota exhausted"
mid-task surprises that hit the [r/ClaudeAI community hard in March-April 2026](https://www.productcompass.pm/p/stop-hitting-claude-code-limits).

* New module: `scripts/lib/quota-tracker.js`
* New slash command: `/quota`
* Config: `quotaAware.{enabled, opusDowngradeThreshold, opusFallbackModel, respectBurstLimit}`
* Routing pipeline: quota downgrade applied LAST so it can't be reverted by
  keyword-influence override on architecture/security keywords.

### Custom statusline (R2)

The plugin ships a Claude Code statusline script that displays the current
routed model, context %, weekly quota %, and estimated session cost. Wires
into `~/.claude/settings.json` via `statusLine.command`.

* New script: `scripts/statusline.js`
* New slash command: `/statusline`
* Config: `statusline.{format, includeCost, includeIcon}`
* Three formats: `compact` (default) / `minimal` / `verbose`

Example output: `🟢 sonnet │ ctx 23% │ wk 12% │ $0.42`

### Context bloat detector (R3 + R9)

Hook into `PreToolUse` for Read|Bash. Tracks every tool call into
`logs/tool-history.jsonl` (capped 200) and flags repeated reads of the same
file as token waste. Addresses the [#1 Claude Code cost driver](https://buildtolaunch.substack.com/p/claude-code-token-optimization):
"every file read adds full content to context permanently."

* New hook: `scripts/context-bloat-detect.js` (PreToolUse, matcher `Read|Bash`)
* New slash command: `/context-audit` — heatmap of token-cost-by-file
* Helper module: `scripts/lib/context-audit.js`
* Config: `contextBloat.{enabled, duplicateThreshold, windowMinutes}`

### Git commit/push hook (R5)

Closes [GitHub issue #4834](https://github.com/anthropics/claude-code/issues/4834)
("Add Hooks for Git Workflow Automation"). Pre-tool hook on `Bash` matches
`git commit` and `git push` commands:

* On commit: reads `git diff --cached --shortstat`, recommends model based on
  diff size (small → haiku, moderate → sonnet, large → opus)
* On push: warns when `--force` is used against main/master
* Tracks stats in `logs/git-router-stats.jsonl`

* New hook: `scripts/git-commit-hook.js` (PreToolUse, matcher `Bash`)
* New slash command: `/git-router-stats`
* Config: `gitHooks.{enabled, autoMessageModel, warnForcePush, trackStats, diffThresholds}`

### Agent Teams role detection (R7)

Claude Code 2.1+ ships [Agent Teams](https://code.claude.com/docs/en/agent-teams)
(multi-agent orchestrator). The plugin detects "team lead" vs "teammate" role
phrasing and routes accordingly: lead → opus + high effort, teammate → sonnet +
medium effort.

* Extends `scripts/lib/scoring.js` with `detectAgentTeamsRole()`
* Recognizes EN/HU/DE phrasing
* Wired into the main routing pipeline (overrides keyword-based model assignment)

### Auto-benchmark (R8)

Canonical 10-prompt routing benchmark with drift detection against the
previous run. Designed for weekly cron runs via `/loop` or
`scheduled-tasks` MCP.

* New script: `scripts/auto-benchmark.js` (`--quiet|--json|--no-append`)
* New slash command: `/auto-benchmark`
* History stored in `logs/benchmarks.jsonl` (capped 50)
* Drift > 1 score point on any case raises a warning

Cases cover all three tiers (haiku/sonnet/opus), Hungarian morphology, and
the architecture/security/planning opus categories.

### Claude Code 2.1+ feature awareness (R13)

New module `scripts/lib/cc-version.js` detects the host Claude Code version
via `claude --version` (or env var / settings override) and infers feature
flags: `nativeBinary`, `persistentModelSelection`, `inlineThinkingProgress`,
`fastMcpStartup`, `resumeRewrite`. Hook output is included in routing
decisions so downstream tooling can adapt.

* Config: `claudeCodeFeatures.{detectVersion, useInlineThinkingProgress, trustFastMcpStartup}`
* Cached for the lifetime of the Node process

### New hooks

`hooks/hooks.json` adds two `PreToolUse` entries:
* `Read|Bash` matcher → context-bloat-detect.js
* `Bash` matcher → git-commit-hook.js

Both are <8s timeout and emit `systemMessage` for advisory output (never block).

### New files

* `scripts/lib/quota-tracker.js`, `scripts/lib/cc-version.js`, `scripts/lib/context-audit.js`
* `scripts/statusline.js`, `scripts/context-bloat-detect.js`, `scripts/git-commit-hook.js`, `scripts/auto-benchmark.js`
* `commands/statusline.md`, `commands/quota.md`, `commands/context-audit.md`, `commands/git-router-stats.md`, `commands/auto-benchmark.md`

### Backward compatibility

Every new feature has a config block with `enabled: true` default. Setting
any to `enabled: false` reverts to v3.1.1 behavior for that feature.

Tests: 79/79 still pass; preflight green.

Version sync 3.1.1 → 3.2.0.

## v3.1.1 — Karpathy skills auto-sync on SessionStart

Closes the gap where karpathy-guidelines was only installed when the user
manually ran `scripts/install-plugin.js` — marketplace-installed users (the
default Claude Code workflow) never got the skill.

### New: `scripts/karpathy-session-sync.js`

Throttled, fire-and-forget helper that keeps `skills/karpathy-guidelines/`
in sync with the upstream [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills)
repository.

* **Throttle:** stamp file at `logs/karpathy-last-sync.json`. If the last sync
  was within `intervalHours` (default 24h), the script no-ops immediately.
* **Background:** spawns a detached child for the actual `git fetch` so the
  hook returns in milliseconds. The user's session is never blocked by a
  slow network.
* **Silent:** all output goes to `/dev/null`. Errors land in
  `logs/hook-errors.jsonl` via `error-log` for diagnosability.
* **Configurable** via `config.karpathySync` (`enabled`, `intervalHours`,
  `background`).

### `scripts/runtime-check.js` integration

The existing SessionStart hook now spawns the karpathy sync child on every
session start (subject to throttle). Measured cost: <0.3s wall-clock added
to session start in the worst case (cold first run on a fast network).
Subsequent starts within the throttle window are essentially free.

### Behavior matrix

| State | Behavior |
|---|---|
| Marketplace install (no installer run) | First session triggers initial clone in background |
| Existing install, sync stamp <24h | Skip — no work done |
| Existing install, sync stamp >24h | Detached `git fetch` in background, stamp updated |
| `karpathySync.enabled: false` | All session-start syncs disabled |
| Network failure | Stamp still updated, retry next interval (no error surfaced) |

### Why this matters

Before v3.1.1, the karpathy-guidelines skill required users to manually run
`node scripts/install-plugin.js` after marketplace install. Most users never
did this, so the skill — which is the headline feature of v3.0.1 — was
silently absent for them. v3.1.1 makes it just-in-time and zero-effort.

Files added: `scripts/karpathy-session-sync.js`.
Files modified: `scripts/runtime-check.js`, `config/task-routing.json`.

Version sync 3.1.0 → 3.1.1.

## v3.1.0 — Claude 4.x awareness, Hungarian morphology, MCP/Skills integration

User-facing improvements driven by the 2025–2026 Claude Code feature set: the
plugin now knows about the current model lineup (Haiku 4.5, Sonnet 4.6, Opus
4.7 with a 1M context option), reasons about effort as an extended-thinking
budget, integrates with Skills/MCP/Plan-mode/Memory, and handles Hungarian
inflection in keyword matching. Backward compatible: all new behavior is
config-gated and defaults conservatively.

### Model awareness (Claude 4.x)

* **Updated cost estimates** in `config/task-routing.json:costEstimates`. Haiku
  bumped from `$0.25/$1.25` (3.5) to `$1/$5` (4.5). Sonnet ($3/$15) and Opus
  ($15/$75) unchanged. Affects savings reporting in `/stats`.
* **New `modelIds` block** maps the haiku/sonnet/opus aliases to concrete
  Claude 4.x IDs: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`.
  An `opus-1m` entry covers the 1M-context variant `claude-opus-4-7[1m]`.
* **Per-model context window** (`contextWindows`): 200K for haiku/sonnet/opus,
  1M for opus-1m. `context-monitor.js` now picks the window based on
  `state.lastModel` and the `[1m]` suffix in the model ID, so the 75%
  auto-compact warning no longer fires prematurely on a 1M Opus session.

### Effort → extended-thinking budget mapping

Effort levels now carry an explicit token budget (configurable via
`config.effort.thinkingBudgets`):

| Effort | Default budget |
|---|---|
| low    | 0 (no thinking)    |
| medium | 5 000 tokens       |
| high   | 16 000 tokens      |

Hook output appends `| thinking budget: N tokens` to the Effort line so the
suggestion can flow downstream into a `thinking.budget_tokens` parameter.
Toggle via `config.effort.emitThinkingBudget`.

### Plan mode awareness (G)

`detectPlanMode(prompt, hookInput, config)` reads the harness-provided
`permission_mode` field (or `plan_mode` / `permissionMode`) and falls back to
keyword detection (`tervezd meg`, `make a plan`, `step-by-step plan`, etc.).
When active, contextBoost is incremented by `config.planMode.scoreBoost`
(default `+1`), nudging boundary prompts toward sonnet/opus.

### Fast mode integration (C)

`detectFastMode(hookInput, config)` recognizes `fast_mode: true` from the
hook input or `fastMode: true` in `~/.claude/settings.json`. When active,
effort is forced to `low` regardless of category — matches the user's
"prefer speed" intent without recommending expensive thinking.

### MCP tool density sub-score (E)

`scoreMcpToolDensity()` detects mentions of common MCP integrations
(playwright, github, slack, gmail, vercel, netlify, firefox/fox_,
context7, scheduled tasks). Each unique tool above 1 adds a small
contextBoost (capped at +3). Surfaced in the hook output as
`MCP tools detected: N (...)`.

### Skills system integration (F)

`detectSkillTrigger()` matches explicit skill references in the prompt
against `config.skillIntegration.rules`. Default rules:

| Skill trigger | Routes to | Effort |
|---|---|---|
| `superpowers:debugging` / `systematic-debugging` | sonnet | high |
| `superpowers:test-driven-development` | sonnet | medium |
| `superpowers:writing-plans` / `brainstorming` | opus | high |
| `frontend-design` | sonnet | medium |
| `feature-dev:code-architect` | opus | high |
| `code-review:code-review` | sonnet | medium |
| `anthropic-skills:web-artifacts-builder` | sonnet | medium |
| `anthropic-skills:skill-creator` | opus | high |

Triggered skills override routing unless `skillIntegration.overrideRouting:
false` is set.

### Parallel subagent dispatch detection (H)

`detectParallelDispatch()` recognizes "in parallel" / "párhuzamosan" /
"dispatch N agents" patterns combined with multi-agent vocabulary. When
detected, contextBoost adds `+2` (orchestration is opus-territory) and
the hook emits `Parallel dispatch detected — orchestration pattern
(orchestrator: opus, workers: sonnet)`.

### Hungarian morphology + keyword expansion (I + J)

* **Suffix-aware matching** for `lang === "hu"` translations. The new
  `matchKeyword()` in `scripts/lib/scoring.js` builds a cached regex per
  keyword that allows common Hungarian inflectional suffixes after the
  match: accusative (`-t`/`-ot`/`-et`/`-öt`), locative (`-ban`/`-ben`),
  dative (`-nak`/`-nek`), instrumental (`-val`/`-vel`), elative (`-ról`/
  `-ről`), sublative (`-ra`/`-re`), illative (`-ba`/`-be`), causal (`-ért`),
  plural (`-k` and variants), imperative (`-d`, `-sd`, `-jd`, `-dd`), and
  possessives. Word-boundary aware via Unicode property escapes.
* `bug_fixing` Hungarian keywords cleaned up: removed the over-broad
  `javítsd ki` (which matched any inflected object) and added more
  specific phrases (`javítsd a hibát`, `javítsd ki a bugot`, `bug`,
  `hibajavítás`).
* **~25 new IT-jargon keywords** added across `code_review`,
  `small_refactoring`, `component_creation`, `integration`,
  `configuration`, `investigation`, `architecture` — covering common
  Hungarian developer phrasing (`reaktorozás`, `vizsgáld ki`, `nézz
  utána`, `kódellenőrzés`, `kód-review`, `endpoint`, `adatfolyam`,
  `tárd fel`, `magas szintű terv`, etc.).

### Memory file integration (M)

New module `scripts/lib/memory.js` reads Claude Code's auto-memory
directory (`~/.claude/projects/<sanitized-cwd>/memory/MEMORY.md`) and
classifies user preferences as terse/thorough. When `effortDecision.level
=== "medium"` and a clear preference is detected, effort is nudged to
low/high accordingly. Skipped on HIGH-category decisions to avoid
softening genuinely complex tasks.

Includes `sanitizeCwd()` matching the harness's empirical sanitization
(non-alphanumeric → `-`, no collapse).

### Prometheus metrics export (K)

New `scripts/export-prometheus.js` and `--metrics` special command emit
Prometheus text-format metrics from the existing JSONL logs. Slash
command `/metrics` (commands/metrics.md) wires it up. Metrics:

* `model_routing_total{model,auto}` — counter
* `model_routing_score_bucket{le}` — histogram
* `effort_distribution{level}` — counter
* `subagent_fallback_total{from,to}` — counter
* `user_quality_rating_avg{model}` — gauge
* `session_tokens_estimated_used`, `session_prompt_count`,
  `session_model_count{model}` — gauges

Designed for periodic scraping or Pushgateway one-shot snapshots; ready
to drive Grafana dashboards or alertmanager rules.

### Health check fix (N)

`scripts/lib/health.js:checkHooks` previously read `hooks.UserPromptSubmit`
expecting the events at the top level, but the plugin's `hooks/hooks.json`
nests events under a `hooks` key (matching Claude Code's settings format).
The health check now accepts both shapes — and unwraps the nested
`{ hooks: [{ command, ... }] }` event entries for script-existence checks.
Eliminates the long-standing `No UserPromptSubmit hooks defined` false
positive.

### New files

* `scripts/lib/memory.js` — auto-memory integration
* `scripts/export-prometheus.js` — telemetry exporter
* `commands/metrics.md` — `/metrics` slash command
* `FUTURE-WORK.md` — documents three intentionally-deferred items
  (cron/loop integration, multi-provider routing, React dashboard)

### Backward compatibility

All new behavior is gated by per-feature config blocks (`fastMode`,
`planMode`, `mcpToolAwareness`, `skillIntegration`, `memoryIntegration`,
`modelIds`, `contextWindows`, `effort.thinkingBudgets`). Any of them set
to `enabled: false` reverts to v3.0.1 behavior for that feature. Existing
configs continue to work — the plugin reads missing fields as defaults.

Version sync 3.0.1 → 3.1.0.

## v3.0.0 — Architecture refactor (concurrency-safe + hot-reload)

Major release addressing the architectural concerns from the v2.5.0 audit.
No breaking changes to the user-visible API: hook output, config schema,
slash commands, and routing behavior are identical. Only internal storage
and cache mechanisms changed.

### New: `scripts/lib/atomic-io.js` (zero-dep primitive)

Replaces the manual spin-lock + PID-check in session-utils / detect-fallback
with **optimistic concurrency**:

* `atomicWriteJson(path, data)` — write-to-temp + rename. Atomic on POSIX
  and Windows. Readers never see partial files.
* `atomicMergeJson(path, mergeFn, default)` — read-modify-write with bounded
  retry. If another process wrote between read-and-write, retry up to 5
  times with exponential backoff (10ms -> 200ms, total wall clock <= 2s).
* `atomicAppendJsonLine(path, entry)` — convenience wrapper for JSONL logs.
* `safeReadJson(path)` — read-or-null, strips BOM, never throws.

**Race test passed:** 10 parallel hook invocations against the same session
state file produce correct `modelCounts: { haiku: 10 }` with no corruption,
no lost updates.

### session-utils.js rewrite

* Removed spin-lock (`acquireSessionLock` / `releaseSessionLock` kept as no-op
  stubs for backward compatibility with external callers).
* Removed PID-alive check (`process.kill(pid, 0)` is unreliable on Windows
  and was causing false-dead diagnoses).
* `saveSessionState` now delegates to `atomicIo.atomicMergeJson` with the
  counter-merge logic (Math.max per model) living inside the mergeFn callback.
* Wall-clock bounded: max 2 seconds under contention (was previously 3 seconds
  with potential stale-lock scenarios on top).

### Config hot-reload

`scripts/lib/config.js` caches are now **mtime-invalidated**:

* On every `loadConfig(cwd)`, the cache computes a signature of the 3 input
  files' mtimes + sizes. If any differs from the cached signature, reparse.
* `clearConfigCache()` exported for explicit invalidation (useful in tests
  and if the user manually tweaks config mid-session).
* Previously the config was cached for the entire process lifetime. Now
  edits to `task-routing.json`, `learned-keywords.json`, or
  `.claude/model-routing.json` take effect on the **next prompt** with no
  session restart required.

### Prompt history proactive cap

`scripts/lib/session.js:updatePromptHistory`: shift-before-push instead
of slice-after-push (same pattern as the v2.5.1 fix for recentAutoRoutes).
History window is now configurable via `config.promptHistory.window`
(default 3, min 1, max 20).

### New tests (+19 for v3.0.0; 79 total)

* `tests/atomic-io.test.js` — 13 tests covering write/read/merge/append,
  default-on-missing, mtime-based concurrency detection, BOM stripping,
  mergeFn error handling, counter-max semantics, parent-dir auto-creation.
* `tests/config-hot-reload.test.js` — 6 tests covering cache-reuse,
  mtime-based invalidation, explicit clearConfigCache, signature stability
  and difference detection.

### Backward compatibility

All previous callers of `session.loadSessionState` / `saveSessionState`
work unchanged — same signatures, same semantics, just more robust
internals. External scripts that called `acquireSessionLock` (none that we
know of) still get `true` returned.

### Removed legacy primitives

* `scripts/lib/sleep.js` — no longer imported by session-utils after atomic-io
  replaced the spin-lock. File retained (still used by detect-fallback's own
  logic) but the dependency graph is now cleaner.

Version sync 2.7.0 -> 3.0.0.

## v2.7.0 — Effort integration

Adds a second routing dimension alongside model selection: **Effort** level
(Low / Medium / High) represents the reasoning/thinking budget the model
should use. Orthogonal to model choice; emitted as a hint in the hook output
and consumed by the subagent workers + the user (Ctrl+E in Claude Code UI).

### New: `scoring.determineEffort()`

Pure function of sub-scores + confidence + matched category + config rules.

| Trigger | Result |
|---|---|
| `multiFile >= 4` | HIGH |
| category in `highCategories` (architecture/security/planning/performance_audit/large_refactoring/multi_file_work/algorithms/tech_debt/system_design) | HIGH |
| `confidence < 40` WITH keyword match | HIGH |
| `structure >= 6` (highly structured prompt) | HIGH |
| category in `lowCategories` (typo_fix/formatting/rename/comments/status/imports/search_list) WITH keyword match | LOW |
| `wordCount <= 2` AND confident keyword | LOW |
| everything else | MEDIUM (configurable) |

Per-category explicit override: `defaultEffort: "low"|"medium"|"high"` on any
`models.<model>.categories.<key>` block always wins over rule-based triggers.

### Hook output

```
[Model Router] Complexity: COMPLEX (score 9/10) -> Recommended: opus
Effort: high (category 'architecture' is in highCategories)
Confidence: 85% (3 signals, high agreement)
```

### Subagent integration

All three worker agents (`haiku-worker.md`, `sonnet-worker.md`,
`opus-worker.md`) updated with an "Effort level" guidance block. They
read the hint from the hook output and adapt their response style:
- LOW → concise, 1-3 line answers, no preamble
- MEDIUM → default balanced behavior
- HIGH → step-by-step reasoning, edge cases, trade-offs explicit

Additionally, when the hook emits an AUTO-ROUTING instruction, it appends
the effort hint directly: *"Automatically delegate to sonnet-worker.
Use MEDIUM effort: normal balance of thoroughness and brevity."*

### New config block

```json
"effort": {
  "enabled": true,
  "emitInOutput": true,
  "emitInSubagentHint": true,
  "defaultLevel": "medium",
  "rules": {
    "highCategories": [...],
    "lowCategories": [...],
    "lowConfidenceThreshold": 40,
    "multiFileThreshold": 4,
    "structuralHighThreshold": 6,
    "lowEffortConfidenceThreshold": 70
  }
}
```

### Other additions
* **`/effort`** slash command - show current config + last 20 decisions
* **16 new unit tests** in `tests/effort.test.js` covering all triggers,
  per-category overrides, priority order, and enabled/disabled modes
* **`/stats`** now reports effort distribution (low/medium/high %)
* Usage log (`logs/usage.jsonl`) captures `effort` field per entry

### What this enables
The plugin can now recommend *both* model and effort. A `fix typo` prompt
gets haiku+low. An `investigate race condition` prompt gets sonnet+high.
An `audit authentication architecture` prompt gets opus+high. The user
still controls the UI Effort selector (Ctrl+E), but the plugin now has
a principled recommendation for each prompt.

### Backward compatibility
`effort.enabled: false` disables all output/logging of effort; behavior
then identical to v2.6.0. Existing logs without `effort` field are
counted as "none" in `/stats` effort distribution.

Version sync 2.6.0 -> 2.7.0.

## v2.6.0

Distribution polish. No behavior changes; focuses on first-time user
experience, metadata completeness for marketplace discovery, and
copy-paste example configs.

### Plugin metadata
* `.claude-plugin/icon.svg` (NEW): 128x128 SVG icon for marketplace listing.
  Simple 3-tier representation (haiku/sonnet/opus stacked rectangles).
* `.claude-plugin/plugin.json`: added `homepage`, structured `repository`
  and `bugs` fields, `category: "development"`, `icon` reference, and
  `author.url`. Keywords expanded from 6 to 12.
* `.claude-plugin/marketplace.json`: bumped metadata version to 1.1.0,
  added `icon` field to plugin entry.

### README polish
* New **Compatibility Matrix** section (Claude Code / Node / OS).
* New **Getting Started (30 seconds)** section - 5 steps from install to
  first visible saving via `/stats`.
* New **Cost Model** section with concrete savings table and per-model
  pricing reference. Removes "what does this cost me?" ambiguity.
* New **FAQ** section with 8 questions covering: routing overrides,
  project-local config, team sharing, hook timeouts, external services,
  audit logs, reset, coexistence with other plugins, uninstall.
* Badges expanded: CI status + Latest Release added alongside existing
  license / Node / plugin-version.

### Example configs (docs/examples/)
* `security-critical.json`: opus-first for auth/payment/crypto keywords,
  disables auto-routing, safeMode=true, quality-first profile.
* `startup-lean.json`: cost-saver profile, expanded haiku auto range
  (1-4 instead of 1-2), tight daily budgets, aggressive rate-limiting.
* `ml-heavy.json`: ML-specific opus categories (ml_design, algorithm_choice),
  sonnet notebook_work category, LLM fallback + auto-apply enabled with
  lower threshold (3 instead of 5) for faster vocab growth.

### Version sync
2.5.1 -> 2.6.0 across plugin.json / package.json / marketplace.json /
dist/README.md / README badge.

## v2.5.1

Three post-audit code-review fixes. No behavior changes for normal inputs;
hardens edge cases found by chaos-engineer + code-reviewer skill reviews.

* **Fix 1 (CRITICAL)** — `scripts/lib/scoring.js:52`: replaced `Object.entries()`
  with `Object.keys() + hasOwnProperty` check to prevent prototype-pollution
  and Symbol-key surprises when iterating `config.models.<x>.categories`.
  Now also type-checks `catDef` is a plain object before use.
* **Fix 2 (WARNING)** — `scripts/analyze-complexity.js:541-543`: `recentAutoRoutes`
  cap is now proactive (shift-before-push) instead of reactive (slice after).
  The array can no longer transiently exceed 20 items during save contention.
* **Fix 3 (WARNING)** — `scripts/lib/error-log.js:logHookError()`: explicit
  Error-object serialization before `JSON.stringify` (Error.message/stack are
  non-enumerable, circular refs would previously break silent). Added nested
  fallback entry if stringify fails, plus stderr signal when error-logging
  itself self-fails (previously completely invisible).

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
