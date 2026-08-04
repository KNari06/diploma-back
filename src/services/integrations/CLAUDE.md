# `src/services/integrations/` — Jira, Stripe, Telegram, Allure, Git webhooks

> Third-party surfaces. Each is feature-gated; check the flag before assuming a
> path is live in prod (see root CLAUDE.md § Env vars — a default-off flag is dark
> in prod until it's set in the shared infra `.env`).

---

## Jira — QA readiness

Before auto-running a ticket, `runFromJiraViaChat`
([../../api/jira/jira.controller.ts](../../api/jira/jira.controller.ts)) calls
`JiraQaOrchestratorService.assessReadiness`:

```
fetch issue + related tickets/subtasks/comments   (getJiraIssueWithContext)
→ enrich (KB + similar cases + past bugs + memory + scoped CoverageAnalysisService gaps)
→ ONE merged LLM call   (../../ai/prompts/jira-readiness-prompts.ts)
→ triage + a `readiness` block (score + forgotten-case gaps via TaskReadinessService)
```

Gated `JIRA_READINESS_ASSESSMENT_ENABLED` (default off). Single ADF→text extractor
`adfToPlainText`.

### Phase 2 — honest statuses and the handoff gate

Honest statuses (`honest-status.util.ts`: ready / empty / blocked / skipped) feed a
structured **handoff artifact** (`HandoffService` + `db/handoff.db.ts`, table
`qa_handoffs`) which is persisted and emitted to chat.

- **HARD GATE** keys off handoff status — `blocked` → ask, skip the run.
- **Hybrid autonomy** — `settings.integrations.jira.requireApprovalBeforeRun`;
  ready + flag → post branch options, don't auto-run.

### Developer fix-prompt

`DeveloperFixPromptService` +
[../../ai/prompts/fix-prompt.prompts.ts](../../ai/prompts/fix-prompt.prompts.ts),
gated `DEVELOPER_FIX_PROMPT_ENABLED`. Runs post-run in
[../../jobs/ai-analysis.job.ts](../../jobs/ai-analysis.job.ts): black-box markdown →
`ai_summary.fixPrompt`, from which it reaches **four** surfaces — the frontend
"Copy fix-prompt", a Jira feedback comment on the *source* ticket
(`jira-feedback.service.ts`), and both paths that FILE a new issue from a run
(`JiraReportService`, as its own comment).

Filing paths pass it via `JiraIssueRequest.fixPrompt`: the job has the summary in
memory; the manual endpoint (`POST /reports/:testId/jira`) resolves it from the
persisted summary through
[resolve-fix-prompt.util.ts](../testing/analysis/resolve-fix-prompt.util.ts)
(fail-open, reads `test_results` then the forked `mobile_test_results`).

## Filing a Jira issue from a test report

| file | purpose |
| ---- | ------- |
| `jira-report.service.ts` | Orchestration: create issue → attachments → comments → save link. Only the create step throws; everything after it is best-effort. |
| `jira-report-formatter.ts` | Pure ADF builders (description, code comment, fix-prompt comment). Each comment builder returns `null` when it has nothing to say — ADF rejects an empty text node, which would 400 the comment. |
| `jira-report-attachments.ts` | Video / trace / screenshot upload. Never throws. |
| `db/jira-report.db.ts` | `test_jira_issues` link insert. |

Rich comments go through `addJiraComment`, which takes `string | AdfDoc` — pass a
**doc**, not text, or `plainTextToADF` flattens the code block into paragraphs.

---

## Stripe

Webhook handling lives in [../../api/stripe/stripe.controller.ts](../../api/stripe/stripe.controller.ts).
Everything it writes — plans, credits, referral rewards, purchase/failure/cancel
emails — funnels through [../core/CLAUDE.md](../core/CLAUDE.md). Read that before
adding a write site; the funnels exist to keep `users` and `user_credits` in sync.

---

## Telegram — QAIT Tasker

> Lives in the sibling folder `src/services/telegram-tasks/`, documented here so the
> integrations surface is in one place.

Telegram group task tracker:

```
webhook ingest        (../../api/telegram-tasks/)
→ AI reconcile        (telegram-task-ai.service.ts, gpt-5.4-mini tool-use)
→ Supabase            (db/, tables telegram_tasks / telegram_messages)
```

Daily 10:00 Almaty batch ([../../jobs/telegram-task-sweep.job.ts](../../jobs/telegram-task-sweep.job.ts)),
registered in all three scheduler paths — see [../../jobs/CLAUDE.md](../../jobs/CLAUDE.md)
§ 24h sweeps. Feature-gated `TELEGRAM_TASKS_ENABLED` (default off).
