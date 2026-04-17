---
description: "Benchmark a prompt across all three models (haiku, sonnet, opus) to compare their responses side-by-side"
argument-hint: "<prompt to benchmark>"
---

The user wants to benchmark a prompt by sending it to all three model workers and comparing results.

**Steps:**

1. Take the user's prompt argument as the benchmark task
2. If no argument provided, ask: "What prompt would you like to benchmark across all three models?"
3. Run the complexity analyzer to get the score:
   ```bash
   echo '{"prompt":"--dry-run <user_prompt>"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
   ```
4. Send the SAME prompt to all three workers in parallel using the Agent tool:
   - Launch **haiku-worker** with the prompt
   - Launch **sonnet-worker** with the prompt
   - Launch **opus-worker** with the prompt
5. Collect all three responses

**Display format:**

```
Benchmark Results
=================
Prompt: "<user_prompt>"
Complexity Score: X/10 (recommended: <model>)

┌─────────┬──────────────┬──────────────┬──────────────┐
│         │ Haiku        │ Sonnet       │ Opus         │
├─────────┼──────────────┼──────────────┼──────────────┤
│ Length   │ ~XXX words   │ ~XXX words   │ ~XXX words   │
│ Approach │ <summary>    │ <summary>    │ <summary>    │
│ Quality  │ ★★★☆☆       │ ★★★★☆       │ ★★★★★       │
└─────────┴──────────────┴──────────────┴──────────────┘

Recommendation: <model> provides the best value for this task.
```

6. Log the benchmark to `logs/benchmarks.jsonl`:
   ```json
   {"timestamp":"...","prompt":"...","score":X,"results":{"haiku":{"wordCount":N},"sonnet":{"wordCount":N},"opus":{"wordCount":N}}}
   ```

7. After showing results, ask: "Rate each response quality (1-5) to help improve routing, or skip."
