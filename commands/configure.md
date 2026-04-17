---
description: "Interactive configurator wizard for model routing settings - toggle features, adjust thresholds, manage weights, configure model classification"
argument-hint: "[section]"
---

The user wants to interactively configure their model routing settings.

Read the config from `config/task-routing.json` to populate current values. If the user provided an argument (e.g., `/configure models` or `/configure presets`), jump directly to that section.

Show the main menu:

```
Model Router Configuration
==========================

Model Classification:
 1. Preference profile     [current: balanced/cost-saver/quality-first]
 2. Score ranges            haiku: 1-3 | sonnet: 4-7 | opus: 8-10
 3. Keyword categories      View/add/remove/edit category keywords
 4. Auto-routing thresholds Auto: haiku 1-2, opus 9-10 | Borderline: 3,4,7,8

Features:
 5. Safe mode              [ON/OFF]
 6. Auto-routing           [ON/OFF]
 7. Budget limits          [ON/OFF]
 8. Prompt hints           [ON/OFF]
 9. Context monitor        [ON/OFF] (warn: 65%, force: 75%)
10. Anomaly detection      [ON/OFF]
11. API rate limits        [ON/OFF]
12. Adaptive weights       [ON/OFF]

Scoring:
13. View/edit scoring weights
14. View adaptive weight status
15. Reset weights to defaults

Actions:
16. Export current config
```

---

## Section details:

### 1. Preference profile
Read `config/task-routing.json` field `preferenceProfile` (default: "balanced"). Show:

```
Preference Profile
==================
Current: balanced

Available profiles:
 a) cost-saver     — Maximize haiku usage (score ranges: haiku 1-5, sonnet 6-8, opus 9-10)
                     Auto-route haiku for scores 1-4. Best for budget-conscious usage.
 b) balanced       — Default balanced routing (haiku 1-3, sonnet 4-7, opus 8-10)
                     Auto-route haiku 1-2, opus 9-10. Good for most workflows.
 c) quality-first  — Maximize quality (haiku 1-2, sonnet 3-6, opus 7-10)
                     Auto-route opus for scores 8-10. Best when quality matters most.
 d) custom         — Keep current custom settings unchanged.

Choose [a/b/c/d]:
```

When the user picks a profile, apply ALL of these changes at once to `config/task-routing.json`:
- **cost-saver**: `models.haiku.scoreRange=[1,5]`, `models.sonnet.scoreRange=[6,8]`, `models.opus.scoreRange=[9,10]`, `autoMode.autoThresholds.haiku=[1,4]`, `autoMode.autoThresholds.opus=[10,10]`, `autoMode.borderlineZones=[5,6,8,9]`
- **balanced**: `models.haiku.scoreRange=[1,3]`, `models.sonnet.scoreRange=[4,7]`, `models.opus.scoreRange=[8,10]`, `autoMode.autoThresholds.haiku=[1,2]`, `autoMode.autoThresholds.opus=[9,10]`, `autoMode.borderlineZones=[3,4,7,8]`
- **quality-first**: `models.haiku.scoreRange=[1,2]`, `models.sonnet.scoreRange=[3,6]`, `models.opus.scoreRange=[7,10]`, `autoMode.autoThresholds.haiku=[1,1]`, `autoMode.autoThresholds.opus=[8,10]`, `autoMode.borderlineZones=[2,3,6,7]`

Also set `preferenceProfile` to the chosen value. After applying, show the updated score ranges and confirm.

### 2. Score ranges
Read the current score ranges from `config/task-routing.json` and display them:

```
Score Ranges (1-10 scale) — read from config
=============================================
haiku:  [<min> — <max>]
sonnet: [<min> — <max>]
opus:   [<min> — <max>]

Which model to adjust? [haiku/sonnet/opus/back]
```

When adjusting, validate that ranges don't overlap and cover 1-10 completely. Update the model's `scoreRange` array.

### 3. Keyword categories
Show all categories grouped by model:

```
Keyword Categories
==================

HAIKU (simple tasks):
 1. Typo fixes      [8 keywords] — fix typo, spelling, misspelling...
 2. Renames          [5 keywords] — rename, change name...
 3. Formatting       [7 keywords] — formatting, indent, whitespace...
 ...

SONNET (moderate tasks):
 4. Feature addition [7 keywords] — add feature, implement...
 5. Bug fixing       [12 keywords] — fix bug, debug, broken...
 ...

OPUS (complex tasks):
 6. Architecture     [6 keywords] — architect, system design...
 ...

Actions:
 a) View keywords for a category (enter number)
 b) Add new category
 c) Add keyword to existing category
 d) Remove keyword from category
 e) Move category to different model
 f) Remove entire category
 g) Back to main menu
```

For **add new category**: Ask for model (haiku/sonnet/opus), category key, label, and keywords (comma-separated).
For **move category**: Remove from current model's categories and add to target model's categories.
For all changes, edit `config/task-routing.json` directly.

### 4. Auto-routing thresholds
```
Auto-Routing Configuration
===========================
Auto-route (no confirmation needed):
  haiku: scores [1-2]   — simple, unambiguous tasks
  opus:  scores [9-10]  — clearly complex tasks

Borderline zones (ask user to choose):
  scores [3, 4]  — haiku/sonnet boundary
  scores [7, 8]  — sonnet/opus boundary

Middle range (suggest + confirm):
  scores [5, 6]  — clearly sonnet territory

Adjust:
 a) Haiku auto-route range
 b) Opus auto-route range
 c) Borderline zones
 d) Back
```

### 5-12. Feature toggles (existing behavior)
Same as current — toggle ON/OFF, offer threshold adjustment for features that have thresholds.
- **5**: Safe mode toggle
- **6**: Auto-routing toggle (also show autoThresholds when enabled)
- **7**: Budget limits — show period/limits/warnAt/blockAutoRouteAt
- **8**: Prompt hints — show/edit per-model hints
- **9**: Context monitor — show/edit compactSuggest/compactWarn/compactForce/forceCheaper thresholds
- **10**: Anomaly detection — show/edit opusSpike/costSpike/scoreDrift thresholds
- **11**: API rate limits — show/edit RPM/TPM limits and warn/force percentages
- **12**: Adaptive weights — show/edit minRatings/minWeight/maxWeight

### 13. View/edit scoring weights
Display current weights and let user adjust:
```
Scoring Weights
===============
keyword:    0.35  ███████░░░
multiFile:  0.20  ████░░░░░░
structure:  0.20  ████░░░░░░
wordCount:  0.15  ███░░░░░░░
codeBlocks: 0.10  ██░░░░░░░░
             ----
Total:      1.00

Which weight to adjust? Enter name and new value (e.g., "keyword 0.40"):
```
After adjustment, normalize all weights to sum to 1.0 if needed.

### 14. Adaptive weight status
Run `echo '{"prompt":"--adaptive-stats"}' | node scripts/analyze-complexity.js` and display results.

### 15. Reset weights to defaults
Reset scoring weights to: keyword: 0.35, multiFile: 0.20, structure: 0.20, wordCount: 0.15, codeBlocks: 0.10

### 16. Export config
Suggest using `/export-config`.

---

After any change, edit the `config/task-routing.json` file directly to apply the setting. Confirm the change to the user and show the updated value. Then re-display the relevant section menu or offer to return to the main menu.

Keep the interaction conversational — show one menu at a time, apply changes immediately.
