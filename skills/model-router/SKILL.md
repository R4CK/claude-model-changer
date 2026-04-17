---
name: model-router
description: Intelligent model routing for Claude Code. Automatically analyzes task complexity and recommends the right model (haiku for simple, sonnet for moderate, opus for complex). Use when the user asks about model routing, complexity scoring, task-to-model mappings, or wants to understand or configure the routing behavior.
---

# Model Router v5.0

Automatic complexity-based model routing for Claude Code with safety features, learning, multi-language support, and anomaly detection.

## How It Works

1. Every user prompt is analyzed by a **UserPromptSubmit hook** before processing
2. The hook runs `scripts/analyze-complexity.js` which scores complexity 1-10 with confidence %
3. Detects prompt language (English, Hungarian, German) and uses translated keywords
4. Priority chain: manual override (@model) > saved patterns > keyword scoring (with adaptive weights)
5. Checks budget limits, rate limits, API limits, context window usage, anomalies, and quality history
6. A routing suggestion is injected as context, asking the user to confirm (or auto-routing for high-confidence scores)

## Complexity Levels

| Score | Level    | Model  | Use Cases                                           |
|-------|----------|--------|-----------------------------------------------------|
| 1-3   | SIMPLE   | haiku  | Typo fixes, renames, quick questions, single edits  |
| 4-7   | MEDIUM   | sonnet | Features, bugs, tests, refactoring, components      |
| 8-10  | COMPLEX  | opus   | Architecture, system design, multi-file refactoring |

## Manual Override

- **Inline markers:** Add `@haiku`, `@sonnet`, or `@opus` anywhere in your prompt
- **Natural language:** Say "use haiku for this" or "use opus"
- **Command:** Use `/route <model> <task>` to bypass analysis entirely

## Multi-Language Support (v5)

Prompts in Hungarian and German are automatically detected and matched against translated keywords:
- Hungarian: "javítsd az elírást" -> Typo fixes -> haiku
- German: "Tippfehler beheben" -> Typo fixes -> haiku
- Full category translations for all 28 task categories in both languages

## Safety Features

- **Config validation (A1):** Validates config on load, warns about errors, continues with defaults
- **Score confidence (A2):** 0-100% confidence metric. Low confidence (<40%) disables auto-routing
- **Fallback chain (A3):** haiku->sonnet->opus escalation when agent can't handle task
- **Token budgets (A4):** Daily/weekly limits per model. Warns at 80%, blocks auto-route at 100%
- **Rate limiting (A5):** Max auto-routes per minute to prevent runaway costs
- **Safe mode (A6):** `"safeMode": true` disables all auto-routing. `--dry-run` for testing
- **API rate limit monitor (F4):** Tracks RPM/TPM, downgrades model at 80%, forces haiku at 95%
- **Anomaly detection (F1):** Alerts on opus spikes, cost spikes, and score drift vs 7-day average

## Intelligence Features

- **Context-aware routing:** Detects project type and adjusts scoring (Rust tasks get complexity boost)
- **Session stickiness:** Same-topic prompts stay on the same model (Jaccard similarity)
- **Override learning:** Logs overrides, `/tune` analyzes patterns and suggests config changes
- **Prompt patterns:** Save patterns for instant routing (`/save-pattern`)
- **Quality feedback:** Rate results 1-5, get upgrade suggestions for low-quality combos
- **Context window monitor:** Tracks token usage, downgrades model at 75%+, forces haiku at 90%+
- **Adaptive weights (D1):** Auto-adjusts scoring weights based on quality rating correlations (needs 10+ ratings)
- **Multi-language detection (D2):** Hungarian/German prompt recognition with translated keyword matching

## Commands

| Command | Description |
|---------|-------------|
| `/route <model> <task>` | Force a specific model for a task |
| `/complexity <text>` | Check complexity score without routing |
| `/stats` | Show usage statistics, savings, quality ratings |
| `/tune` | Analyze override patterns for tuning suggestions |
| `/rate <1-5> [comment]` | Rate last task quality for learning |
| `/dashboard` | Generate HTML stats dashboard |
| `/save-pattern "<text>" <model>` | Save prompt pattern for auto-routing |
| `/patterns` | List or delete saved patterns |
| `/configure` | Interactive configuration wizard |
| `/benchmark <prompt>` | Compare same prompt across all 3 models |
| `/export-config` | Export config as shareable bundle |
| `/import-config <path>` | Import config bundle |

## Scoring Factors

| Factor              | Weight | Description                               |
|---------------------|--------|-------------------------------------------|
| Keyword matching    | 35%    | Task category keywords from config        |
| Multi-file signals  | 20%    | Indicators of cross-file work             |
| Structural items    | 20%    | Lists, file paths, bullet points          |
| Word count          | 15%    | Longer prompts suggest more complexity    |
| Code blocks         | 10%    | Number of code blocks in the prompt       |
| Context boost       | 10%    | Project type awareness                    |
| Question reduction  | -20%   | Questions scored lower (configurable)     |

Weights auto-adjust via adaptive learning after 10+ quality ratings.

## Configuration

Edit `config/task-routing.json` to customize:

- **Move categories between models:** Change which task types map to which model
- **Add/remove keywords:** Tune what triggers each category
- **Create new categories:** Add your own task type classifications
- **Adjust scoring weights:** Change how much each factor influences the score
- **Set budgets:** Control spending per model per day/week
- **Configure context monitor:** Set thresholds for context window management
- **Add language translations:** Extend keyword matching to other languages
- **Tune anomaly detection:** Adjust spike thresholds
- **Set API limits:** Configure RPM/TPM limits
- **Enable/disable features:** Safe mode, prompt hints, rate limiting, adaptive weights, etc.
