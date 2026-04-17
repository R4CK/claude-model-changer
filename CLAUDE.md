# Claude Model Changer Plugin

## MANDATORY: Session statistics display

At the END of EVERY response, you MUST append the session stats lines from the hook context.
Look for ALL lines starting with `📊` or `🔋` or `📈` in the hook output injected before your response.
Copy those lines verbatim as the very last lines of your response. Do NOT skip this. Do NOT modify them.

If no `📊` line is present in the hook context, skip this rule.

Example format:
📊 haiku 67% ██████░░░░ | sonnet 33% ███░░░░░░░ | 3 prompts
🔋 Context ░░░░░░░░░░ 5% | Session ░░░░░░░░░░ 6% (47 left)
📈 Weekly: Haiku ████░░░░░░ 37% | Sonnet █░░░░░░░░░ 13% | Opus █░░░░░░░░░ 8%
📊 Total: ████████░░░░░░░░░░░░ 37% (74/200)

## MANDATORY: Context window auto-compact

The hook monitors context usage and issues warnings at 3 levels:

- **55%** (💡): Gentle suggestion — relay to user
- **65%** (⚠️): Strong warning — relay to user, recommend `/compact`
- **75%** (🚨): **AUTO-COMPACT REQUIRED** — the hook auto-creates `logs/session-handoff.md`. You MUST:
  1. Read the handoff file
  2. Fill in all sections (Task context, Completed steps, Modified files, Next steps, Key decisions)
  3. Run `/compact` with the filled-in summary
  4. Do NOT continue with the user's request until compact is done

This is critical to prevent hallucination at high context usage.
