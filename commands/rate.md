---
description: "Rate the quality of the last model routing result (1-5 stars) to help improve routing accuracy"
argument-hint: "<1-5> [optional comment]"
---

The user wants to rate the quality of the last routed task.

**Parse the argument:**
- First token: rating (1-5 integer). 1=poor, 2=below average, 3=average, 4=good, 5=excellent
- Remaining tokens (optional): comment about the result

**Steps:**
1. Read the last entry from `${CLAUDE_PLUGIN_ROOT}/logs/usage.jsonl` to get the model and category of the last routed task
2. Create a quality log entry and append it to `${CLAUDE_PLUGIN_ROOT}/logs/quality.jsonl`:
```json
{"timestamp": "ISO-8601", "rating": 4, "model": "sonnet", "category": "bug_fixing", "comment": "good fix"}
```
3. Confirm to the user: "Rated last task (model: sonnet, category: bug_fixing) as 4/5. Thank you!"

**If no argument provided**, ask the user for a rating 1-5.

**If rating is out of range** (not 1-5), tell the user to provide a number between 1 and 5.

**Quality stats**: To see aggregate quality data, use `/stats` which includes quality ratings breakdown.
