# `.claude/` — Claude Code config for qai-backend

## Folder layout

| Folder / file        | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `commands/`          | Slash commands — explicit `/name` invocation        |
| `agents/`            | Sub-agents called by commands to do heavy work      |
| `context/`           | Reference docs read by agents (not auto-loaded)     |
| `rules/`             | Always-on rules loaded into every session           |
| `hooks/`             | Shell/Node scripts triggered by harness events      |
| `temporary/reviews/` | Saved review outputs — gitignored, one file per run |
| `settings.json`      | Shared permissions + hook registration              |

---

## Code review

### Before sending an MR

```
/review-mr
```

Spawns `senior-reviewer` and returns a verdict with `file:line` citations.

**Base branch — manual override:**

```
/review-mr dev
/review-mr some-other-branch
```

**Base branch — auto-detected (no argument):**

1. Tracked upstream of the current branch (`git rev-parse --abbrev-ref @{u}`)
2. Fallback: `dev`

### What gets checked

The reviewer walks `.claude/context/review-checklist.md` in order:

1. **Folder placement** — new files in the right `src/` subfolder
2. **Hard invariants** — OpenAI role mapping, CDP session in preview, WebSocket always-respond, CSS escaping, Playwright wait strategy, concurrency guards, secret redaction
3. **Code quality** — N+1 queries, DB field existence, no duplicates, type-check + lint pass
4. **CLAUDE.md maintenance** — docs updated when hot-folder files changed
5. **Security** — no hardcoded secrets, no sensitive logs, validated inputs
6. **Prompt changes** — only checked when `src/ai/prompts/` or `src/services/ai/` are in the diff

### Verdict levels

| Verdict             | Meaning                                  |
| ------------------- | ---------------------------------------- |
| `APPROVE`           | Ready to send                            |
| `APPROVE_WITH_NITS` | Send as-is or fix the small things first |
| `REQUEST_CHANGES`   | Blocking issues — fix before MR          |
| `BLOCK`             | Hard invariant violated — must fix       |

### Review history

Each `/review-mr` run saves its verdict to `temporary/reviews/<branch>-<YYYY-MM-DD>.md`. The folder is gitignored — pure local audit trail. Useful for comparing verdicts across fix iterations on the same branch.

### Re-running after fixes

After fixing blocking issues, run `/review-mr` again. The reviewer re-reads the full diff from scratch and writes a new file.

---

## Hooks (automatic, no action needed)

| Event                 | Hook                        | What it does                                                    |
| --------------------- | --------------------------- | --------------------------------------------------------------- |
| Before any Edit/Write | `pre-edit-doc-hint.js`      | Reminds which API doc to read before editing a hot service      |
| After every turn      | `check-claudemd-updated.js` | Warns if a hot-folder file was edited but its CLAUDE.md was not |
| After every turn      | `validate-doc-maps.js`      | Checks that all entries in `doc-map.js` resolve to real files   |
