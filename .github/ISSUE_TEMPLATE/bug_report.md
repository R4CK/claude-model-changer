---
name: Bug report
about: Something is broken or behaves unexpectedly
title: "[BUG] "
labels: ["bug"]
assignees: ["R4CK"]
---

## What happened
<!-- Clear description of the problem. One paragraph. -->

## Expected behavior
<!-- What you thought should happen. -->

## Reproduction
<!-- Step-by-step. Anyone should be able to reproduce from this. -->
1.
2.
3.

## Example prompt (for routing bugs)
<!-- The exact prompt that misrouted, or a minimal one that reproduces. -->
```
<your prompt here>
```

## Actual routing decision
<!-- Output of the hook, or what /complexity says: -->
```
echo '{"prompt":"<your prompt>"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-complexity.js"
```

## Expected routing decision
<!-- Which model should it have picked, and why? -->

## Environment
- Plugin version: <!-- output of `cat ~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/.claude-plugin/plugin.json | grep version` -->
- Claude Code version: <!-- `claude --version` -->
- OS: <!-- macOS / Linux / Windows + version -->
- Node.js: <!-- `node --version` -->
- Install method: <!-- marketplace / dist/install.js / source ./install.sh / install-plugin.js -->

## Preflight output
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.js"
```
<!-- Paste the full output here. If preflight fails, that's almost always the bug. -->

## Logs (optional but helpful)
<!-- Last 20 lines from logs/hook-debug.log:
tail -20 ~/.claude/plugins/cache/<owner>/claude-model-changer/<version>/logs/hook-debug.log
-->

## Workaround
<!-- If you found one, share it. Helps others until the fix lands. -->
