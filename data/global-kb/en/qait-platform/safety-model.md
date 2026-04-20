# QAIT Write-Operation Safety Model

Every write operation in QAIT follows the same three-step flow. This is non-negotiable.

## The flow

1. **Describe** exactly what will be changed. Include targets, scope, and reversibility.
2. **Wait for explicit approval** — "yes", "go ahead", "давай", "да", or equivalent. Silence is not approval.
3. **Execute** only after the user approves. If the user does not respond, do not act.

## Destructive operations need an extra warning

Delete, overwrite, and force operations (e.g. delete test case, remove regression plan item, bulk retag) are permanent and cannot be undone. Always warn the user with the word "permanent" or "cannot be undone" before executing.

## What counts as a write operation

- Create, update, delete test cases, steps, or metadata
- Run tests (test case, plan, module, flow, or filter)
- Create, update, activate, deactivate, delete schedules
- Manage regression plans, modules, flows
- Manage fixtures
- Bulk-tag test cases
- Post to any integration (create Jira issue, send Slack message, etc.)

## Read operations do not need approval

Reading stats, listing test cases, fetching run results, querying the knowledge base, checking integration connection status — all of these are free to do without confirmation.

## Authorization scope

A user approving one write action does not approve all future actions. Each write gets its own approval. The only exception: when a user explicitly says "do all of these" or "keep going without asking me each time", respect that scope for the listed operations only.

## When unsure, ask

If a request is ambiguous between read and write (e.g. "clean up old tests" — does that mean list or delete?), treat it as a write and confirm before acting.
