---
description: Run senior-reviewer on the current branch diff before sending an MR
argument-hint: [base-branch — optional, auto-detected otherwise]
---

Invoke the `senior-reviewer` subagent to review the current branch.

Arguments: $ARGUMENTS

## Step 1 — Determine base branch

- If `$ARGUMENTS` is a branch name — use it.
- Otherwise: `git rev-parse --abbrev-ref @{u} 2>/dev/null` (strip `origin/`).
- Fallback: `dev`.

Tell the user: "Reviewing diff against `<base>`. Proceeding."

## Step 2 — Review

Spawn `senior-reviewer` via the Agent tool. Pass:
- the base branch name
- instruction to run `git diff <base>...HEAD` for the full branch diff

Show the full verdict.

## Step 3 — Save the review

Write the verdict to `temporary/reviews/<branch>-<YYYY-MM-DD>.md` where `<branch>` is the current branch name (slashes replaced with `-`). Create the folder if it doesn't exist (`mkdir -p temporary/reviews`).

File format:
```
# Review: <branch> vs <base> — <YYYY-MM-DD>

<full verdict output>
```

Tell the user: "Review saved to `temporary/reviews/<filename>`."

## Step 4 — After the review

- **APPROVE** — "Ready for MR. Want me to draft the description?"
- **APPROVE_WITH_NITS** — list the nits, ask: "Fix before sending or send as is?"
- **REQUEST_CHANGES / BLOCK** — list the blockers. Ask: "Fix now?" — if yes, apply fixes and re-run `/review-mr` when done.

Do NOT run `git push` or create an MR without explicit permission.
