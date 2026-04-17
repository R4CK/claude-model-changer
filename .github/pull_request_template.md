<!--
Thanks for opening a PR!

Please fill out every section below. PRs that skip the testing checklist
or omit a clear "what/why" will be closed with a request to update.
-->

## What
<!-- One sentence: what does this PR change? -->

## Why
<!-- Why is this change needed? Link to an issue if applicable: "Fixes #42" -->

## How
<!-- Brief implementation notes. What files? What new behavior? -->

## Type
<!-- Check one or more -->
- [ ] Bug fix
- [ ] New feature
- [ ] Routing config change (added / moved keywords, new categories)
- [ ] Documentation
- [ ] Refactor / cleanup
- [ ] CI / tooling
- [ ] Breaking change (please open an issue first to discuss)

## Testing
<!-- Required. Show how you verified the change works. -->

- [ ] `node scripts/preflight.js` passes (all checks green)
- [ ] Tested locally on a real Claude Code session
- [ ] If you changed `config/task-routing.json`, tested with at least one example prompt per affected category:
  ```bash
  echo '{"prompt":"<your test prompt>"}' | node scripts/analyze-complexity.js
  ```
- [ ] If you changed any script in `scripts/`, rebuilt the bundle:
  ```bash
  node scripts/build-installer.js && cp install.js dist/install.js
  ```

## Checklist
- [ ] No `logs/` files committed (runtime data)
- [ ] No archives, no `.local.json` files, no `node_modules/`
- [ ] Backward compatible — existing user `task-routing.json` overrides still work
- [ ] Updated relevant docs (README, INSTALL, dist/README) if user-facing change
- [ ] Used `var` (not `let`/`const`) in `scripts/` for ES5 / older Node compatibility

## Screenshots / examples (optional)
<!-- Output of /stats, dashboard screenshots, before-and-after routing examples, etc. -->
