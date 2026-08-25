# QAIT Backend — Navigation Map

> ### Workspace rules — non-negotiable
>
> This repo is one of five in the QAIT workspace. **Duplicated here on purpose:** an
> agent that treats this repo's `.git` as the project root never reads the
> workspace-root file, so these would silently not apply. Canonical source +
> reasoning: [../CLAUDE.md](../CLAUDE.md), [../.claude/rules/](../.claude/rules/),
> [../.claude/decisions/](../.claude/decisions/). Keep in sync with the root file.
>
> - **Branch format** `<feature-name>/<kebab-description>-<YYYYMMDD>`, date = today.
> - **NEVER commit, push, or merge to `dev`/`main`.** Work only on the feature branch;
>   integrate via a pull request, opened by the user or on explicit request.
> - **NEVER push without an explicit request**, and only to the feature branch's own remote.
> - **NEVER `--amend`, rebase, or force-push a commit that is already pushed** — it
>   forces a divergence only a force-push can reconcile. Add a NEW commit instead.
>   Check with `git status -sb` before amending.
> - **Long installs/builds:** never relaunch `npm install` because one "looked killed" —
>   check `pgrep -fl "npm install"` first. See [../.claude/rules/operations.md](../.claude/rules/operations.md).
> - **Installs:** `.npmrc` sets `ignore-scripts=true` — dependency install hooks are the
>   execution vector for npm supply-chain worms. Nothing here needs a rebuild (prod has
>   always installed with `--ignore-scripts`); both Dockerfile stages pass the flag
>   explicitly, since `.npmrc` is not `COPY`ed into the image. Never remove it to make a
>   build pass. See [../.claude/rules/supply-chain.md](../.claude/rules/supply-chain.md).
> - **Tests:** unit tests mock at the data-access boundary; integration tests hit a real
>   database — never mock Supabase in an integration test.
> - **Live testing shares ONE machine.** Before `run-dev.sh` or starting the emulator,
>   acquire the shared lock `/Users/Darkhan/Developer/qaits/.dev-stack.lock` per
>   [../.claude/rules/dev-stack-lock.md](../.claude/rules/dev-stack-lock.md); release it
>   after `stop-dev.sh`. Only one clone's stack + emulator can run at a time — skipping
>   the lock collides with a parallel session mid-test.

> Read this first. Use it to find which directory to open, then read that directory's `CLAUDE.md`.
> Don't grep blindly across `src/` — go through the map.
>
> **This file is a router, not a reference.** Detail belongs in the folder's own
> `CLAUDE.md`. Keep it under 20 KB — see [.claude/rules/structure.md](.claude/rules/structure.md).

**Stack:** Express + TypeScript + Playwright + OpenAI/Gemini + Supabase + BullMQ (Redis) + Socket.IO
**Scale:** ~765 TS files. 3 processes (api, worker, scheduler). 11 BullMQ job types. 50+ REST routes. ~140 WS events.

---

## Three processes

| Process   | Entry                                            | Purpose |
| --------- | ------------------------------------------------ | ------- |
| API       | [src/index.ts](src/index.ts)                     | HTTP + Socket.IO server. Owns preview sessions (live browsers). |
| Worker    | [src/worker/index.ts](src/worker/index.ts)       | BullMQ consumer. All background jobs. **Must call `registerBuiltinResourceAdapters()`** — it is where replay applies `resource_bindings`; without it every bound test dies at SETUP with `No adapter registered for resource kind '…'`. |
| Scheduler | [src/scheduler/index.ts](src/scheduler/index.ts) | Cron + one-time triggers — enqueues regression runs. Local: own container. Prod: hosted in the worker behind a Redis leader lock (`SCHEDULER_IN_WORKER`). |

Run: `npm run dev` (API), `npm run worker`, `npm run scheduler`.

---

## Top-level map of `src/`

| Folder | What's in there | Own CLAUDE.md |
| ------ | --------------- | ------------- |
| [src/services/testing/ui/preview/](src/services/testing/ui/preview/) | **Editor / Preview / Recording / Replay.** The hot zone. | ✅ |
| [src/jobs/](src/jobs/) | BullMQ handlers (11 types), background replay, scheduler sweeps. | ✅ |
| [src/api/chat/](src/api/chat/) | Intent-driven chat router — global + per-test-case (editor) chat. | ✅ |
| [src/services/core/](src/services/core/) | Accounts, plans, credits, referrals, transactional email. | ✅ |
| [src/agent/core/lite/](src/agent/core/lite/) | LiteEngine + 5 multi-agents + Pipeline v2 + Exploration v2. | ✅ (starter) |
| [src/services/test-resource/](src/services/test-resource/) | Polymorphic test resources — `auth`, `environment`, `secret` adapters; `data_fixture` queued. | ✅ |
| [src/services/ai/](src/services/ai/) | LLM clients (OpenAI/Gemini), intent parser, cost tracking, embeddings, memory. | ⏳ TODO |
| [src/ai/prompts/](src/ai/prompts/) | All prompt builders. Intent, chat, test plan, API flow, intelligent testing. | ⏳ TODO |
| [src/api/](src/api/) | 50+ REST controllers, grouped by domain. | ⏳ TODO |
| [src/api/mobile/](src/api/mobile/) | Mobile REST surface — editor + sessions (JWT) and CI/CD (project API key, separate mount). | ✅ |
| [src/websocket/](src/websocket/) | Socket.IO server + handlers. Most events live in `handlers/preview.handler.ts`. | ⏳ TODO |
| [src/services/testing/](src/services/testing/) | Non-preview testing (regression, plans, results, executions, fixtures, exploration). | — |
| [src/services/integrations/](src/services/integrations/) | Jira, Stripe, Telegram, Allure, Git webhooks. | ✅ |
| src/services/chat/ | Chat-side context + tracing: `editor-context.service.ts`, `chat-test-trace.service.ts`. | — |
| [src/services/kb/](src/services/kb/) | Knowledge base (skills, patterns) for auto-learn. | — |
| [src/services/skills/](src/services/skills/) | Skill registry — composable test capabilities. | — |
| src/services/mobile/ | Mobile runner integration (scrcpy, redroid, a11y agent). | — |
| src/services/telegram-tasks/ | **QAIT Tasker** — Telegram group task tracker. Gated `TELEGRAM_TASKS_ENABLED` (default off). | — |
| [src/config/](src/config/) | AI model config, queues, env, features, testing knobs. | — |
| [src/db/](src/db/) | Supabase client + helpers. Schema in `supabase-migrations/`. | — |
| [src/middleware/](src/middleware/) | Auth, rate limiting, request logging, error handler. | — |
| src/utils/ | Helpers — only truly reusable cross-domain code. | — |
| src/types/ | Shared types not bound to a single feature. | — |

**Rule of thumb:** if a folder has a `CLAUDE.md`, read it before working in that folder. If it doesn't and there are >8 files, ask whether to create one.

---

## Where things live (cheat sheet)

| When you need to… | Open |
| ----------------- | ---- |
| …understand preview/replay/recording/auto-healing | [preview/CLAUDE.md](src/services/testing/ui/preview/CLAUDE.md) |
| …work on background replay, scheduling, or sweeps | [jobs/CLAUDE.md](src/jobs/CLAUDE.md) |
| …work on chat, intents, confirms, or the editor agent | [api/chat/CLAUDE.md](src/api/chat/CLAUDE.md) |
| …change plans, credits, referrals, or email | [services/core/CLAUDE.md](src/services/core/CLAUDE.md) |
| …work on Jira / Stripe / Telegram / Allure | [services/integrations/CLAUDE.md](src/services/integrations/CLAUDE.md) |
| …add a new resource kind (env/secret/fixture/…) | [test-resource/CLAUDE.md](src/services/test-resource/CLAUDE.md) |
| …change LLM behaviour for element resolution | `preview/element-resolver.service.ts`, `preview/intent-step-lint.service.ts` |
| …change a prompt | `src/ai/prompts/*.ts` |
| …change request-understanding (ANALYZE/ENRICH/IMPROVE) | `src/ai/prompts/request-understanding-prompts.ts` |
| …add/change a chat intent | [api/chat/CLAUDE.md](src/api/chat/CLAUDE.md) § Intents |
| …resolve a descriptor ("payment tests","smoke") → test IDs | `src/services/testing/resolver/test-query-resolver.service.ts`; consumed via `chat/shared/intent-target-resolution.ts` |
| …add/change a yes-no / cancel / approval keyword (ru/en/kk) | `src/config/testing/intent-keywords.ts` (single source — NEVER inline). See Invariant #17 |
| …add/modify a BullMQ job | `src/jobs/<name>.job.ts`, register in `src/worker/index.ts` — see [jobs/CLAUDE.md](src/jobs/CLAUDE.md) |
| …add a REST route | `src/api/<domain>/` (route + controller + service), wire in `src/index.ts`. **Mount order matters** — a router with its own auth mounts BEFORE any broader `requireAuth` prefix (`/mobile/ci` before `/mobile`, `/chat/public` before `/chat`) |
| …add or change a CI/CD endpoint (project API key, no JWT) | [api/mobile/CLAUDE.md](src/api/mobile/CLAUDE.md) — `ci.route.ts`, NOT `mobile.route.ts` |
| …add a WS event | `src/websocket/handlers/<handler>.ts`. Preview events go in `preview.handler.ts` |
| …invalidate the test-suites editor's caches on a CRUD mutation | Emit `project:{testcase,flow,module}:mutated` to the `project:<id>` room via [project-mutation-emit.ts](src/websocket/helpers/project-mutation-emit.ts). Client joins via `subscribe:project` (fail-closed: owner OR active workspace member) |
| …run something on a schedule | `src/scheduler/` — see [jobs/CLAUDE.md](src/jobs/CLAUDE.md) § Scheduled cron |
| …run AI agent (LiteEngine) | `src/agent/core/lite/lite-engine.ts` → `MultiAgentOrchestrator` in `agents/` |
| …run autonomous site exploration | `src/agent/core/lite/exploration/exploration-engine.ts` |
| …trace AI cost / token usage | `src/services/ai/cost/`, `src/services/ai/tracking/` |
| …measure / eval the chat authoring agent | [src/scripts/chat-eval/](src/scripts/chat-eval/) — **read its README first**. See [api/chat/CLAUDE.md](src/api/chat/CLAUDE.md) § Evaluating |
| …author a LOGIN test bound to a stored credential | [api/chat/CLAUDE.md](src/api/chat/CLAUDE.md) § Authoring a LOGIN test |
| …check DB schema | `supabase-migrations/supabase-schema.sql` — **bootstrap only, not current**; see [critical-patterns.md §10](.claude/rules/critical-patterns.md) |
| …add/change a **prod** env var (not just `env.ts`) | See "Env vars: local vs prod" below — prod env lives in `qait-infra/azure/terraform/.env`, NOT here |
| …read a runtime trace / log | `test_logs/<feature>/<YYYY-MM-DD_HH-MM-SS>_<testId>.jsonl` — `editor/`, `chat_test/`. Auto-pruned after `EDITOR_LOG_RETENTION_DAYS` (default 3) |

---

## Hot flows (entry → exit)

### Recording (user records actions in live editor)

WS `preview:keyboard:type` / `preview:mouse:click`
→ [preview.handler.ts](src/websocket/handlers/preview.handler.ts)
→ `RecordingCaptureService.captureStep()`
→ emit `preview:recording:step:capture`
→ DB persist (batched).

### Apply single step in live preview

WS `preview:step:apply`
→ `PreviewStepApplyService.applyStep()`
→ `LocatorPlanBuilder` → `waitForStepReadiness()` → Playwright action
→ `ElementResolver` (LLM fallback) if compiled plan missed
→ emit `preview:step:apply:result`.

### Apply All / Run from start (live preview)

WS `preview:run:start`
→ `PreviewRunService.runSavedSteps()`
→ stops recording → loop `applyStep()` → emits progress
→ `preview:run:complete`.

### Background replay (web and mobile) · Scheduled cron

→ **[src/jobs/CLAUDE.md](src/jobs/CLAUDE.md)** — full entry→exit for both platforms,
the five ways mobile diverges, the forked `mobile_test_results` table, telemetry,
dedicated emulators, the leader lock, and the 24h sweeps.

### Chat → test creation / management

→ **[src/api/chat/CLAUDE.md](src/api/chat/CLAUDE.md)** — interceptor order, parse +
enrich, the confirm-or-explore guard, the compound splitter, and all 23 intents.

### Self-serve "magic first test" · Transactional email

→ **[src/services/core/CLAUDE.md](src/services/core/CLAUDE.md)** — PLG provisioning
flow, plan/credit funnels, referrals, and every email sender with its trigger.

---

## Hard invariants (do not violate)

Long form for the chat ones (#13, #14, #16, #17) lives in
[api/chat/CLAUDE.md](src/api/chat/CLAUDE.md) § Invariants.
See also [.claude/rules/critical-patterns.md](.claude/rules/critical-patterns.md).

1. **Never reuse the screencast CDP session in preview** — piggybacking on the `video-stream` session causes 100% video freeze. `CdpSnapshotService` opens its own session and detaches in `finally`; in background/regression contexts `context.newCDPSession(page)` is always fine. [critical-patterns.md §2](.claude/rules/critical-patterns.md)
2. **WebSocket handlers must always emit a response** — a silent `return` leaves the frontend stuck on "Loading…" forever, including on error paths.
3. **Recording and step apply are mutually exclusive in a preview session** — recording auto-stops when a run starts (`PreviewRunService.isRunning()` guard).
4. **Replay path uses `waitUntil: 'load'`, never `'domcontentloaded'`** — different timing semantics, don't mix.
5. **OpenAI role mapping** — DB stores `'ai'`, OpenAI requires `'assistant'`; always pass through `convertRoleForOpenAI()` from `utils/helpers/chat-helpers` or you get a 400.
6. **CSS selector escaping** — use `CSS.escape()` when interpolating IDs, because React 18 `useId()` produces colons that break selectors.
7. **Element resolution is a 3-stage waterfall** — compiled plan → LLM resolver → smart locator, never skip a stage. **One sanctioned exception:** `options.useScreenshotOnly` forces vision-only resolution (short-circuits at the top, hard-fails if vision misses); the evidence/compiled fast-paths are all gated off the same flag. Per-step, opt-in only. **On MOBILE the flag has to be forwarded, not just read** — every mobile resolution (editor Find, Apply, and the editor's Run loop) funnels through `MobileRunnerClient.lintElement`, so all three call sites must pass `useScreenshotOnly`: [lintSession](src/api/mobile/session.controller.ts), the lint fast path in [mobile-step-apply.service.ts](src/services/mobile/mobile-step-apply.service.ts), and the duplicated loop in `runTestCaseOnSession`. Miss one and the toggle is silently inert there (it resolves by text and can confidently tap the wrong icon). The dispatched command also carries `_useScreenshotOnly`, because vision coords are demoted below the trust threshold and the runner's re-validation would otherwise fall back to text. **A forced step must also stay plan-less**: all three call sites skip the lint whenever the step has a `compiled` plan, so persisting one silently moves that step onto `runSteps` — a zod-validated route where the flag has to be listed in the runner's `intentStepOptionsSchema` or it is stripped. Every forced-vision path therefore withholds the compiled plan rather than storing it.
8. **DRY before writing new logic** — `rg "<thing>" src/ --type ts` first; there's a high chance it already exists.
9. **`{{key}}` interpolation goes through `resolvePlaceholders`** ([resolve-placeholders.ts](src/utils/interpolation/resolve-placeholders.ts)) — three call sites once diverged with their own regexes. Add a new variable source by passing one more `VariableSource`, never another regex. Selectors / `elementDescription` are intentionally NOT interpolated.
10. **Anything that EMITS, LOGS, or PERSISTS a step body after interpolation must redact `secrets.*`** — pair `resolvePlaceholders` with `redactSecrets` / `buildStepRedactor` ([redact-step.ts](src/utils/interpolation/redact-step.ts)) or `executor.redactString` / `redactRuntimeMeta`. **DB persistence is the special case:** store the original `{{...}}` placeholder, not the resolved value (`preserveOriginalStep`), or re-runs see a stale literal forever. **On the agent side the same rule covers runtime credentials, not just `secrets.*`:** every LLM-facing or trace-bound string leaving the Lite pipeline goes through `redactCredentialValues` ([redact-secrets.ts](src/utils/interpolation/redact-secrets.ts)) — vision insight, console errors, `assert_text` actual, and the formatted page snapshot, which is redacted once at the `setCurrentSnapshot` choke point so every prompt and the round history inherit it.
11. **Telemetry writes are best-effort — NEVER fail the test path** — every write is wrapped in try/catch that `logger.warn`s and swallows; a missing analytics column is a degraded audit trail, not a failed test. Single funnel for per-run aggregation: `TestCompletionHandlerService.recomputeRunStatus()` — no other path may write `regression_runs.total_*_ms`.
12. **Step persistence (`tests.executed_steps`) is owned by the PRODUCER, in-process** — whoever runs the test appends via `TestExecutedStepsRedisService.appendStepCompleted` in its own process; the worker drains to Postgres in the job's `finally`. `webSocketService.emitTestStepCompleted` is **broadcast-only** — re-adding an append there would fire only on the main process AND double-count. [jobs/CLAUDE.md](src/jobs/CLAUDE.md)
13. **Chat write/management ops go through `executeTool`, never the raw skill or a hand-rolled confirm** — so the centralized confirm-preview guard, loop-detection, retry and timeout all apply. Two-phase confirm is deterministic; every surface reaching a `confirm`-bearing tool needs its own interceptor. [Long form →](src/api/chat/CLAUDE.md)
14. **Chat pending-state is Redis-keyed by `chatSessionId` ONLY** (no userId fallback — it leaks across the user's other sessions) **and MUST be cleared on cancel + error.** The compound splitter advances only *after* a step succeeds. [Long form →](src/api/chat/CLAUDE.md)
15. **Unicode word boundaries: use `(?![\p{L}\p{N}])`, never `\b`** — JS `\b` is ASCII-only, so `\bда\b` / `\bхватит\b` never match Cyrillic. This bit the confirmation classifier and the compound cancel-phrase regex.
16. **Per-test-case chat (`testCaseId` present) is the editor surface — three rules hold together:** (a) exclusive WS routing to `chat:tc:<testCaseId>`, never also `chat:<sessionId>`; (b) `mode` forced to `'editor'`; (c) scope-awareness backed by a **server-side gate**, not just the prompt — the model ignored the prompt live and created duplicates under invented names. [Long form →](src/api/chat/CLAUDE.md)
17. **Chat control-word lists live ONLY in [intent-keywords.ts](src/config/testing/intent-keywords.ts)** — never inline. Duplicated across four call sites once, and Kazakh kept getting forgotten; `MultiLangList` now makes `{en,ru,kk}` required. They are an optimization + regex fallback, NOT the classifier. [Long form →](src/api/chat/CLAUDE.md)
18. **A failed runner batch command returns an HTTP 200 body, never a rejection** — `executeBatchCommands` RESOLVES on failure (`executeBatch` turns a thrown handler into `{success:false}`), so awaiting it without reading `results[]` cannot tell a working command from a broken one — a failed `install_app` + wipe once let a run start on stale logged-in state and still pass. Check via [findRunnerBatchFailure](src/services/mobile/runner-batch-result.ts); in `MobileAppPrepService` all mutating batches go through its `batch()` wrapper, `isPackageOnDevice` the one sanctioned exception.

---

## Architecture, testing, and doc upkeep

- [.claude/rules/architecture.md](.claude/rules/architecture.md) — layer breakdown, `db/` sublayer contract, dependency direction, file size rules.
- [.claude/rules/testing.md](.claude/rules/testing.md) — mock boundary, what to test and where, file placement, naming.
- [.claude/rules/structure.md](.claude/rules/structure.md) — **when to update a CLAUDE.md, the size budget, and the memory-vs-CLAUDE.md split.** Update the relevant map in the same PR as the code change.

---

## Env vars: local vs prod (how to actually change a prod value)

Adding a var to [env.ts](src/config/environment/env.ts) makes it exist in code — it
does **NOT** set it in prod. Local and prod are two separate places:

- **Local:** `qai-backend/.env` (dotenv). Only affects your machine.
- **Prod:** the backend runs on **Azure Container Apps**, and its env is managed in
  **`qait-infra/azure/terraform/`**, NOT here and NOT in the deploy pipeline (the
  GitLab `deploy:api` job only swaps the image). A dev edits **one** file —
  `qait-infra/azure/terraform/.env` — and the terraform CI ([azure/terraform/.gitlab-ci.yml](../qait-infra/azure/terraform/.gitlab-ci.yml))
  buckets every line into three:
  1. **`SECRET_KEYS`** (in that `.gitlab-ci.yml`) → a top-level tfvar feeding a
     `secret {}` block. A secret ALSO needs a `variable` + `secret {}` +
     `env { secret_name }` in [container-apps.tf](../qait-infra/azure/terraform/container-apps.tf)
     (see how `jwt-secret` is wired).
  2. **`INFRA_KEYS`** → skipped (terraform-controlled OR already a hardcoded `env {}`
     block in `container-apps.tf`; a name that's hardcoded there MUST be in
     `INFRA_KEYS` or you get a duplicate-env error).
  3. **everything else** → an `app_env` map → a `dynamic "env"` block on BOTH
     containers. **So a plain flag = just add `NAME=value` to that `.env`, nothing
     else.** (`MOBILE_RUNNER_ENABLED` / `COMPANION_ENABLED` are the examples.)

  Merge to the branch the infra pipeline watches → it runs `terraform plan` →
  `apply` → the Container App rolls a new revision with the value. No image rebuild.

**The trap (see [ship the switch, not just the code](../.claude/lessons/20260615-ship-the-switch-not-just-the-code.md)):** a feature gated by a
default-off flag is **dark in prod until the flag is set in that shared `.env`** —
having it `true` in your local `.env` proves nothing about prod. "Done" isn't done
until the prod value is wired there. This is exactly how the companion relay shipped
to prod but returned 503 until `COMPANION_ENABLED=true` was added to the infra `.env`.

## Pre-commit checks

```bash
npm run type-check
npm run lint
```

Don't deploy without explicit approval. See [.claude/rules/general.md](.claude/rules/general.md).
