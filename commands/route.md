---
description: "Manually route a task to a specific model (haiku, sonnet, or opus), bypassing automatic complexity analysis"
argument-hint: "<model> <task description>"
---

The user wants to manually route a task to a specific model.

Parse the arguments: the first word should be the model name (haiku, sonnet, or opus),
and everything after it is the task description.

**If the first argument is a valid model name:**
Delegate the task (the remaining text) to the corresponding worker agent:
- `haiku` -> use the **haiku-worker** agent
- `sonnet` -> use the **sonnet-worker** agent
- `opus` -> use the **opus-worker** agent

**If no valid model name is provided**, show usage:

```
Usage: /route <model> <task>

Models:
  haiku  - Fast, simple tasks (typo fixes, renames, quick questions)
  sonnet - Balanced tasks (features, bugs, tests, refactoring)
  opus   - Complex tasks (architecture, system design, large refactoring)

Examples:
  /route haiku fix the typo on line 42
  /route sonnet add input validation to the signup form
  /route opus redesign the authentication architecture
```
