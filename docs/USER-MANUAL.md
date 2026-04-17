# Claude Model Changer - User Manual

## Overview

Claude Model Changer automatically analyzes every prompt you send and routes it to the optimal Claude model:

- **Haiku** (score 1-2): Fast, cheap. Typo fixes, simple renames, quick questions.
- **Sonnet** (score 3-6): Balanced. Feature additions, bug fixes, test writing.
- **Opus** (score 7-10): Thorough. Architecture design, multi-file refactoring, complex algorithms.

## How It Works

1. You type a prompt
2. The `UserPromptSubmit` hook runs complexity analysis (score 1-10)
3. Based on score + confidence, it either auto-routes or asks you
4. A subagent worker handles the task
5. The `SubagentComplete` hook logs usage stats
6. Stats appear at the end of every response

## Session Stats Display

Every response ends with stats like:

```
📊 haiku 33%(1🤖) | sonnet 0% | opus 67% | 3 prompts (1🤖)
🔋 Context ██░░░░░░░░ 18% | Session ░░░░░░░░░░ 4% (48 left)
📈 Weekly: Haiku █░░░░░░░░░ 10% | Sonnet ░░░░░░░░░░ 1% | Opus █░░░░░░░░░ 6%
📊 Total: ██░░░░░░░░░░░░░░░░░░ 12% (23/200)
```

- **Line 1**: Session model distribution + subagent count (🤖)
- **Line 2**: Context window usage + session budget remaining
- **Line 3**: Weekly usage per model vs plan limits
- **Line 4**: Total weekly usage vs overall limit

## Manual Model Override

Force a specific model by prefixing your prompt:

```
@haiku fix the typo in README.md
@sonnet add input validation to the login form
@opus redesign the authentication architecture
```

## Commands Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `/stats` | Usage statistics: model distribution, top categories, auto-route rate |
| `/summary` | Current session: model percentages, skills used, prompt count |
| `/dashboard` | Open HTML dashboard with charts and graphs |
| `/complexity <prompt>` | Check complexity score without routing |
| `/health` | Full diagnostics: config, logs, agents, hooks, session |

### Configuration

| Command | Description |
|---------|-------------|
| `/configure` | Interactive wizard for all settings |
| `/export-config [path]` | Export config as shareable bundle |
| `/import-config <path>` | Import config bundle |

### Routing Control

| Command | Description |
|---------|-------------|
| `/route <model> <task>` | Manually route to specific model |
| `/benchmark <prompt>` | Compare all three models side-by-side |
| `/save-pattern "<pattern>" <model> [label]` | Save pattern for auto-routing |
| `/patterns [delete <index>]` | List or manage saved patterns |

### Quality & Tuning

| Command | Description |
|---------|-------------|
| `/rate <1-5> [comment]` | Rate last routing result |
| `/tune` | Get tuning suggestions from override patterns |

## Scoring System

### Sub-Scores (weighted)

| Factor | Weight | What It Measures |
|--------|--------|-----------------|
| Keywords | 35% | Matched task category keywords |
| Multi-file | 20% | Indicators of cross-file work |
| Structure | 20% | Lists, questions, file references |
| Word count | 15% | Prompt length |
| Code blocks | 10% | Embedded code snippets |
| Context boost | 10% | Project type + prompt history |

### Confidence & Auto-Routing

- **High confidence** (70%+): Auto-routes without asking
- **Medium confidence** (40-70%): Asks for confirmation
- **Low confidence** (<40%): Always asks, never auto-routes

### Borderline Handling

Scores near model boundaries (e.g., 3 = haiku/sonnet border) trigger:
1. Historical data lookup for the category
2. Quality ratings comparison
3. Auto-resolve if history strongly favors one model
4. Otherwise asks the user

## Task Categories (28)

### Haiku Categories
typo_fix, simple_rename, quick_question, single_line_change, formatting_fix, import_update, status_checks, simple_lookup, translation_request

### Sonnet Categories
feature_addition, bug_fix, test_writing, code_review, moderate_refactoring, component_creation, integration_work, configuration, documentation, data_processing, api_work, dependency_management

### Opus Categories
architecture_design, multi_file_refactoring, complex_algorithm, security_audit, performance_optimization, migration_planning, system_design

## Multi-Language Support

The plugin detects prompt language automatically:
- **English**: Default keyword matching
- **Hungarian**: Translated keywords (e.g., "javitsd" -> bug fix)
- **German**: Translated keywords (e.g., "Fehler beheben" -> bug fix)

## Adaptive Weights

The plugin learns from your quality ratings (`/rate`). If you consistently rate haiku poorly on certain categories, it auto-adjusts scoring weights to route those tasks to sonnet. Run `/tune` to see suggestions.

## Context Window Monitoring

| Usage | Action |
|-------|--------|
| 55%+ | Gentle suggestion to compact |
| 65%+ | Strong warning, recommend `/compact` |
| 75%+ | Auto-creates handoff file, forces compact |
| 90%+ | Forces model downgrade to haiku |

## Budget & Rate Limits

Configure in `config/task-routing.json`:

```json
{
  "planLimits": {
    "sessionLimit": 50,
    "weeklyHaiku": 100,
    "weeklySonnet": 50,
    "weeklyOpus": 30,
    "weeklyAllModels": 200
  }
}
```

When limits are approached, the plugin warns and may restrict auto-routing.

## Anomaly Detection

The plugin monitors for:
- **Opus spikes**: Too many opus calls in one day
- **Cost spikes**: Daily cost exceeding weekly average
- **Score drift**: Average complexity drifting over time

Anomalies are reported in the routing output.
