# Claude Model Changer

A Claude Code plugin that automatically routes tasks to the appropriate model (haiku/sonnet/opus) based on complexity analysis.

## Features

- **Automatic complexity scoring** on every prompt (1-10 scale)
- **Predefined task categories** mapped to models (28 categories across 3 models)
- **Fully configurable** via `config/task-routing.json`
- **Auto mode** for high-confidence scores (1-2 and 9-10) - delegates without asking
- **Borderline detection** warns when score is near model boundaries (3-4 or 7-8)
- **Cost estimation** shows relative cost info for each recommended model
- **Usage statistics** tracks routing history with `/stats` command
- **Project-specific overrides** via `.claude/model-routing.json` per project
- **Manual override** with `@haiku`/`@sonnet`/`@opus` markers or `/route` command
- **Score checking** with `/complexity` command

## Installation

Install as a Claude Code plugin:

```bash
claude plugin add "/path/to/claude-model-changer"
```

Or copy to your Claude Code plugins directory.

## Usage

### Automatic Routing
Just type your prompt normally. The plugin will:
1. Analyze complexity
2. Show the recommended model, matched category, and cost estimate
3. **Auto-route** for clear cases (score 1-2 or 9-10) without asking
4. **Ask for confirmation** for moderate scores (3-7)
5. **Flag borderline** scores (3-4 or 7-8) with both model options

### Manual Override
```
@opus redesign the authentication system
```
or
```
/route sonnet add input validation to the form
```

### Check Score
```
/complexity implement a caching layer across all services
```

### View Statistics
```
/stats
```

## Configuration

Edit `config/task-routing.json` to customize task-to-model mappings.

### Default Mappings

**Haiku** (score 1-3): Typo fixes, renames, formatting, comments, imports, quick questions, search/list, single-line edits, status checks

**Sonnet** (score 4-7): Feature addition, bug fixing, testing, code review, small refactoring, component creation, integration, configuration, error handling, documentation

**Opus** (score 8-10): Architecture, large refactoring, multi-file work, algorithms, security, performance, planning, system design, tech debt

### Auto Mode Configuration

```json
"autoMode": {
  "enabled": true,
  "autoThresholds": {
    "haiku": [1, 2],
    "opus": [9, 10]
  },
  "borderlineZones": [3, 4, 7, 8]
}
```

- **autoThresholds**: Score ranges that auto-delegate without asking
- **borderlineZones**: Scores that trigger a borderline warning
- Set `"enabled": false` to always ask (disable auto mode)

### Cost Estimates

```json
"costEstimates": {
  "haiku": { "inputPer1M": 0.25, "outputPer1M": 1.25, "label": "~10x cheaper than opus" },
  "sonnet": { "inputPer1M": 3.00, "outputPer1M": 15.00, "label": "balanced cost/performance" },
  "opus": { "inputPer1M": 15.00, "outputPer1M": 75.00, "label": "most capable, highest cost" }
}
```

### Project-Specific Overrides

Create `.claude/model-routing.json` in your project root to override settings per project.
See `config/project-override-example.json` for examples.

```json
{
  "models": {
    "opus": {
      "categories": {
        "critical_path": {
          "label": "Critical path code",
          "keywords": ["auth module", "payment", "billing"]
        }
      }
    }
  },
  "autoMode": { "enabled": false }
}
```

The project config is **deep-merged** with the base config, so you only need to specify the fields you want to change.

### Customization Examples

Move "debug" from sonnet to haiku:
```json
// In haiku.categories, add:
"debug": {
  "label": "Quick debugging",
  "keywords": ["debug", "console.log"]
}
// Remove from sonnet.categories.bug_fixing.keywords
```

Add a new category:
```json
// In sonnet.categories, add:
"database": {
  "label": "Database work",
  "keywords": ["sql", "query", "migration", "schema", "database"]
}
```

## Scoring System

| Factor | Weight | Description |
|--------|--------|-------------|
| Keyword matching | 35% | Matches against configured task categories |
| Multi-file indicators | 20% | Phrases like "across all files", "project-wide" |
| Structural complexity | 20% | Numbered lists, file paths, bullet points |
| Word count | 15% | Longer prompts = higher complexity |
| Code blocks | 10% | Number of code fences in the prompt |

Questions receive a 20% reduction factor.

## Commands

| Command | Description |
|---------|-------------|
| `/route <model> <task>` | Force a specific model (haiku/sonnet/opus) |
| `/complexity <text>` | Check complexity score without routing |
| `/stats` | Show usage statistics |

## File Structure

```
claude-model-changer/
├── .claude-plugin/plugin.json              # Plugin manifest
├── config/
│   ├── task-routing.json                   # Editable task-to-model mappings
│   └── project-override-example.json       # Example project override
├── scripts/analyze-complexity.js           # Complexity scoring engine
├── hooks/hooks.json                        # UserPromptSubmit hook config
├── logs/usage.jsonl                        # Usage log (auto-generated)
├── agents/
│   ├── haiku-worker.md                     # Fast model agent
│   ├── sonnet-worker.md                    # Balanced model agent
│   └── opus-worker.md                      # Complex model agent
├── commands/
│   ├── route.md                            # /route command
│   ├── complexity.md                       # /complexity command
│   └── stats.md                            # /stats command
└── skills/model-router/SKILL.md            # Skill documentation
```

## Requirements

- Node.js (for the complexity analyzer script)
- Claude Code with plugin support
