---
description: "Run the canonical 10-prompt routing benchmark and report drift against the previous run. Designed for weekly cron / /loop runs."
argument-hint: "[--quiet|--json]"
---

The user wants to run the routing benchmark suite.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/auto-benchmark.js" $ARGUMENTS
```

Output (default human-readable):

```
=== Auto-Benchmark Report ===
Pass: 10/10 (100%)

Per-prompt:
  ✓ h1 score=1 model=haiku (expected: haiku 1-2) cat=Typo fixes
  ✓ h2 score=1 model=haiku (expected: haiku 1-2) cat=Renames
  ...
  ✓ o1 score=8 model=opus (expected: opus 7-10) cat=System design

⚠ Drift since last benchmark: 0 case(s)
```

If drift is detected, the report shows before/after model + score for each case.
Exit code 0 = all pass; 1 = one or more cases failed expectations.

For periodic runs:

```
/loop 7d node "${CLAUDE_PLUGIN_ROOT}/scripts/auto-benchmark.js" --quiet
```

History stored in `logs/benchmarks.jsonl` (capped at 50 runs).
