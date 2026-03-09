---
name: model-router
description: Intelligent model routing for Claude Code. Automatically analyzes task complexity and recommends the right model (haiku for simple, sonnet for moderate, opus for complex). Use when the user asks about model routing, complexity scoring, task-to-model mappings, or wants to understand or configure the routing behavior.
---

# Model Router

Automatic complexity-based model routing for Claude Code.

## How It Works

1. Every user prompt is analyzed by a **UserPromptSubmit hook** before processing
2. The hook runs `scripts/analyze-complexity.js` which scores complexity 1-10
3. The score is matched against predefined **task categories** in `config/task-routing.json`
4. A routing suggestion is injected as context, asking the user to confirm

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

## Configuration

Edit `config/task-routing.json` to customize:

- **Move categories between models:** Change which task types map to which model
- **Add/remove keywords:** Tune what triggers each category
- **Create new categories:** Add your own task type classifications
- **Adjust scoring weights:** Change how much each factor influences the score
- **Change thresholds:** Modify the score ranges for each model

## Commands

- `/route <model> <task>` — Force a specific model for a task
- `/complexity <text>` — Check complexity score without routing

## Scoring Factors

| Factor              | Weight | Description                               |
|---------------------|--------|-------------------------------------------|
| Keyword matching    | 35%    | Task category keywords from config        |
| Multi-file signals  | 20%    | Indicators of cross-file work             |
| Structural items    | 20%    | Lists, file paths, bullet points          |
| Word count          | 15%    | Longer prompts suggest more complexity    |
| Code blocks         | 10%    | Number of code blocks in the prompt       |

Questions receive a 20% score reduction (configurable via `questionReduction`).
