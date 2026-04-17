# Contributing to claude-model-changer

Thanks for considering a contribution. This guide covers what to expect and what's expected of you.

## TL;DR

1. Fork the repo
2. Branch off `main` (e.g., `feature/add-rust-keywords`)
3. Make changes
4. Run `node scripts/preflight.js` until it's green
5. Open a PR — fill out the template completely
6. Wait for CI and review

The `main` branch is protected: no direct pushes, every change goes through a PR with required CI + Code Owner approval.

---

## What kinds of contributions are welcome

### Yes, please
- **Bug fixes** — with a clear repro case in the PR description
- **New keywords for existing categories** — include `/tune` output or a real prompt example as rationale
- **New task categories** — must have at least 3 example keywords + a clear `label`
- **Cross-platform installer fixes** — especially for shells / package managers I haven't tested
- **Multi-language additions** — currently EN/HU/DE detected; adding more is welcome
- **Documentation improvements** — typos, clarifications, missing examples
- **Performance improvements** to scoring — must include a before/after benchmark

### Open an issue first to discuss
- Major architectural changes
- Removing or renaming existing categories (breaks user configs)
- Changing default scoring weights or thresholds
- New default hooks
- Anything that breaks backward compatibility

### Probably no
- New external dependencies (the plugin is intentionally zero-dep)
- ESM-only code in `scripts/` (must stay ES5-compatible for older Node)
- Telemetry, network calls, anything that ships data off the user's machine

---

## Local development

### Setup
```bash
git clone https://github.com/<your-fork>/claude-model-changer
cd claude-model-changer
node scripts/preflight.js          # must be green before you start
```

### Test the analyzer directly
```bash
echo '{"prompt":"refactor the auth module across all services"}' | node scripts/analyze-complexity.js
```

### Install your local version into Claude Code
```bash
./install.sh        # POSIX
.\install.ps1       # Windows PowerShell
```

After source changes, re-run the installer and restart Claude Code to pick up the changes.

### Rebuild the bundled installer
If you change anything in `scripts/`, `config/`, `hooks/`, `agents/`, `commands/`, `skills/`, or `.claude-plugin/`, rebuild the bundle:
```bash
node scripts/build-installer.js
cp install.js dist/install.js
```

The CI verifies that `dist/install.js` is in sync with what `build-installer.js` would produce. If you forget this step, CI fails.

---

## Testing requirements

Every PR MUST:

1. Pass `node scripts/preflight.js` locally
2. Pass GitHub Actions CI (preflight + behavioral tests for haiku/sonnet/opus routing)
3. Include a manual test command in the PR description showing the new behavior

For **routing changes** (the most common kind), also verify:
```bash
# Example: a typo task should route to haiku
echo '{"prompt":"fix typo in README"}' | node scripts/analyze-complexity.js | grep haiku

# Example: an architecture task should route to opus
echo '{"prompt":"redesign authentication across all services"}' | node scripts/analyze-complexity.js | grep opus

# Example: a config change should route to sonnet
echo '{"prompt":"add a new database migration"}' | node scripts/analyze-complexity.js | grep sonnet
```

---

## Code style

- **Plain ES5 JavaScript** in `scripts/` — runs on Node ≥16, must stay compatible with older Node too
- **2-space indentation**
- **Strict mode** at the top of every script: `"use strict";`
- **No external dependencies** — the plugin imports only built-in `fs`, `path`, `child_process`, `crypto`
- **Use `var`**, not `let`/`const`, in `scripts/` (compatibility)
- **Defensive coding** — every JSON parse wrapped in try/catch, every file read checked for existence
- **No console.log spam** — hook output is shown to the user; keep it tight

For docs/markdown:
- Prefer plain prose over emoji
- Code blocks have language tags (` ```bash `, ` ```json `, ` ```js `)
- Lines under ~100 chars where reasonable

---

## Commit messages

- **First line:** imperative summary, under 70 chars (`Fix typo in haiku scoring tiebreak`)
- **Body:** explain *why*, not *what* (the diff shows what)
- **Reference issues:** `Fixes #42` or `Refs #42`
- **One logical change per commit** — easier to revert and bisect

Example:
```
Fix off-by-one in question-type score reduction

The reduction was applied at score >= 3, but the threshold should be
> 3 to match the documented behavior in README.md. This caused
3-word questions to be unfairly demoted to haiku.

Fixes #17
```

---

## Pull request workflow

1. Push your branch to your fork
2. Open a PR against `R4CK/claude-model-changer:main`
3. **Fill out the template completely** — empty PRs get closed
4. CI runs automatically
5. R4CK is auto-requested as reviewer (via CODEOWNERS)
6. Address any review comments by pushing new commits (don't squash mid-review — easier to see what changed)
7. After approval, R4CK merges (squash by default, to keep `main` linear)

### What to expect
- First response within a few days
- Review comments are not personal — they're about the code
- Small focused PRs get reviewed faster than huge ones

---

## Branch protection (FYI)

The `main` branch enforces:
- No direct pushes (even from R4CK)
- All changes via PR
- Required status check: **Preflight** (the GitHub Actions workflow)
- Required Code Owner review
- Conversation resolution required
- Linear history (no merge commits on main)
- No force pushes, no deletions
- No bypass — even admins follow the rules

If CI fails on your PR, fix the failure and push again — don't try to bypass.

---

## Questions?

- Open a [Discussion](https://github.com/R4CK/claude-model-changer/discussions) for design questions
- Open an [Issue](https://github.com/R4CK/claude-model-changer/issues) for bugs and feature requests
- Mention `@R4CK` in your PR for review

Thank you!
