# `src/api/chat/` — intent-driven chat router

> Two surfaces share this router: **global chat** and **per-test-case chat** (the
> editor). They share one socket, so routing discipline is load-bearing — see
> Invariants below.

---

## Flow

```
POST /api/chat/message → handleChat()   (chat.controller.ts)
→ pending-state interceptors  (run BEFORE parsing)
→ deterministic editor save   (tc-chat, AFTER parsing)
→ parseUserIntent()           (one LLM call, returns an `analysis` block)
→ post-parse enrichment       (descriptor → concrete IDs)
→ confirm-or-explore guard    (global chat only)
→ compound splitter           (if isCompound)
→ routeToHandler()            → handler from INTENT_HANDLERS
```

### Interceptors (before parsing)

**Global chat only** — exploration-confirm → manage-confirm
([regression/shared/manage-confirmation.ts](regression/shared/manage-confirmation.ts))
→ run-existing-confirm ([shared/run-existing-confirmation.ts](shared/run-existing-confirmation.ts))
→ compound-continuation ([shared/compound-queue.ts](shared/compound-queue.ts)).

**Test-case chat only** — editor-confirm ([shared/editor-confirmation.ts](shared/editor-confirmation.ts)),
the editor half of the same two-phase confirm (Invariant #13).

### Deterministic editor save

[shared/editor-save.ts](shared/editor-save.ts): "save" in an open test case issues
`qa_update_test_case_steps` server-side instead of hoping the model calls it.
Triggered by EITHER the `save_test` classification OR the `SAVE_REQUEST` anchor list
— the classifier is unstable on this exact word (the same bare "save" landed on
`save_test` one day and `general_chat` the next). No draft cached → falls through to
`general_chat`.

### Parse + enrich

`parseUserIntent()` ([../../services/ai/intent/intent-parser.service.ts](../../services/ai/intent/intent-parser.service.ts))
— one LLM call now ALSO returns an `analysis` block (ANALYZE + IMPROVE folded in, see
[../../ai/prompts/request-understanding-prompts.ts](../../ai/prompts/request-understanding-prompts.ts)):
`targetSelector{type,value}` (descriptor), `executionModifiers{browser,…}`,
`isCompound/subRequests`, `manage{…}`, `lookbackDays`.

Post-parse enrichment ([shared/intent-target-resolution.ts](shared/intent-target-resolution.ts)):
`TestQueryResolver` resolves a descriptor → concrete IDs
([../../services/testing/resolver/test-query-resolver.service.ts](../../services/testing/resolver/test-query-resolver.service.ts));
on ambiguity, a conditional 2nd LLM call (ENRICH) narrows candidates.

### Confirm-or-explore guard

Global chat, `platform_test`, non-exploration, non-compound
([chat.controller.ts](chat.controller.ts) STEP 5.5): `TestCaseResolverService.resolve({…, ownerOnly:true})`
→ if any saved test case clears the partial floor (≥0.50), store the candidates
(`storePendingRunExisting`) and ASK the user to confirm (single→yes/no, multi→pick N)
instead of Lite-running; the next turn's run-existing-confirm interceptor runs the
chosen case via `RegressionRunService.runSavedTestCase` (auto web/mobile, threads
`chatSessionId` so the run streams progress/result into the chat panel like a Lite run).

If nothing matches, reply suggesting the **Explore** section
(`TestCaseResolverService.userHasAnyTests` tailors the copy). `ownerOnly`/`userHasAnyTests`
are owner-scoped to match the owner-scoped runner (`getSavedTestCase`) — surfacing a
workspace-mate's test would dead-end on confirm. NEVER silently Lite-runs a typed
"test X". Replaced the old auto-redirect-to-run_regression + prefilled-steps Smart Resolver.

Compound splitter (if `isCompound`): run step 1, queue the rest; advance-after-success
per turn.

---

## Intents (23)

Registered in [shared/handler-registry.ts](shared/handler-registry.ts):

`platform_test`, `api_test`, `api_flow_test`, `general_chat`, `needs_clarification`,
`save_test`, `run_regression`, `run_plan`, `run_module`, `run_by_tag`, `create_plan`,
`add_to_plan`, `analyze_failure`, `test_recommendations`, `coverage_analysis`,
`editor_action`, `mobile_test`, `mobile_action`, `mobile_agent`, **`flaky_report`,
`manage_schedule`, `manage_module`, `manage_plan`** (the last 4 added in the management
phase; they call existing `qa_manage_*` tools through `executeTool`, not the
SubAgentPipeline).

**Adding an intent:** `<intent>/handler.ts` + register in
[shared/handler-registry.ts](shared/handler-registry.ts) (map + descriptions) + routing
message in [shared/routing.ts](shared/routing.ts).

**Adding a management op** (schedule/module/plan): new `manage_*` intent calling
`qa_manage_*` through `executeTool` — see
[regression/shared/manage-tool.helper.ts](regression/shared/manage-tool.helper.ts).

---

## Invariants (long form)

Root CLAUDE.md states these as one-liners; the reasoning lives here.

### #13 — Write/management ops go through `executeTool`

Never the raw skill, never a hand-rolled confirm. The `manage_*` handlers call
`qa_manage_*` via `executeTool` ([../../services/skills/tool-executor.ts](../../services/skills/tool-executor.ts))
so the centralized confirm-preview guard (in `SkillRegistry`, keyed `sessionId:toolName`),
loop-detection, retry, and timeout all apply.

Two-phase confirm is deterministic: turn 1 → `confirm:false` (preview, op cached in
Redis via [regression/shared/manage-confirmation.ts](regression/shared/manage-confirmation.ts)),
turn 2 "yes" → re-run the SAME cached args with `confirm:true`. Never write on the
first turn; never echo the tool's LLM-targeted "WRITE operation requires confirmation"
message to the user (surface a human preview instead).

**Every chat surface that can reach a `confirm`-bearing tool needs its own interceptor**
— without one the model is the only thing carrying approval across turns, and it
re-plans instead: the per-test-case editor lacked one and silently dropped four saves
in a row while telling the user they had succeeded. A gate refusal is identified by
`SkillResult.needsConfirmation`, never by matching the message text.

The editor's variant ([shared/editor-confirmation.ts](shared/editor-confirmation.ts))
keeps a 30-min TTL (matched to `DraftStepsCache`, since a cached save often persists
the server-held draft) and therefore re-arms the registry's 5-min in-memory preview via
`SkillRegistry.recordConfirmationPreview` before replaying — the ONLY sanctioned caller
of that method.

### #14 — Pending state is Redis-keyed by `chatSessionId` ONLY

No userId fallback — it would leak a pending flow across the user's other sessions.
MUST be cleared on cancel + error: `/chat/cancel` and the controller's error path both
call `clearPendingCompound` + `clearPendingEditorConfirmation`.

The compound splitter advances **after** a step succeeds — never before (a
clarification/confirm answer must retry the same step, not drive the next one).

### #16 — Per-test-case chat is the editor surface: three rules hold together

**(a) Exclusive WS routing.** `emitChatMessage` / `emitChatProcessingStep` /
`emitChatTestUpdate` with a `testCaseId` route ONLY to `chat:tc:<testCaseId>`, never
also to `chat:<sessionId>` ([../../websocket/core/websocket.service.ts](../../websocket/core/websocket.service.ts));
`subscribe:chat:testcase` joins ONLY that room. Both global and editor `Chat` share ONE
socket, so emitting an editor event to `chat:<sid>` would surface it in the global chat.
The frontend filter is the second guard: a global chat accepts a `chat:*` event only
when `event.sessionId` matches its live ref OR the pending `localStorage` id
(first-message window) — an event with another sessionId is dropped
(`homeSocketBindings.ts` in qai-frontend).

**(b) mode is forced to `'editor'`** in the controller for tc-scope so the executor's
editor flow (generate steps → confirm → run on preview → save) activates; the lite/pro
toggle is a global-chat concept and must never reach a tc-chat.

**(c) Scope-awareness.** `testCaseId`/`testCaseName` are threaded into
`buildExecutorPrompt` + a system-prompt TEST-CASE SCOPE block so "save/update" edits
THIS test case (`qa_update_test_case_steps`), not a duplicate (`qa_create_test_case`)
— **and the prompt is backed by a server-side gate**, because the model ignored it live
and answered "save" with two `qa_create_test_case` calls under invented names: in
tc-scope that tool refuses and redirects unless the model sets `new_separate_test:true`.

The gate reads `SkillContext.storeKind`, which the **sub-agent pipeline** must thread
onto every `skillContext` it builds (`PipelineContext.storeKind` → `executor-agent` /
`sub-executor`) — it long set it only on the monolithic fallback loop, so every
scope-gated skill silently read `undefined` on the path that actually runs.

Trace for analysis: `ChatTestTraceService` → `test_logs/chat_test/` (best-effort,
scrubs `{{secrets.*}}` / inline creds, TTL-evicted).

### #17 — Control-word lists live ONLY in `intent-keywords.ts`

[../../config/testing/intent-keywords.ts](../../config/testing/intent-keywords.ts) —
never inline. They were duplicated across four call sites (intent-fast-path,
confirmation-classifier, compound-queue, manage-tool.helper) and Kazakh kept getting
forgotten. The `MultiLangList` type makes `{en,ru,kk}` REQUIRED (build fails if a
language is dropped); a contract test asserts anchors + unicode-boundary behavior.

These lists are an **optimization + regex fallback, NOT the classifier** — the LLM
(`parseUserIntent` GPT pass / Gemini→OpenAI in confirmation-classifier) is the
language-agnostic source of truth and covers the long tail. Keep buckets to
high-frequency anchor forms; do not chase completeness. Build regexes via
`toBoundaryRegex` (unicode `(?![\p{L}\p{N}])`, never ASCII `\b` — see root Invariant #15).

Note: this is the chat-intent control-word registry; DOM/element-text keyword lists
(submit/close/destructive matched in `page.evaluate`) stay local to their services by
design.

---

## Evaluating the authoring agent

**Add + edit** — [../../scripts/chat-eval/](../../scripts/chat-eval/): headless replay of
the Planner→Executor→Reviewer pipeline + deterministic (Tier-2a) scorer over a biased
bootstrap corpus (`npm run chat-eval`). Authored steps are captured via the `writeSteps`
trace (tc-scope, `executeTools` in
[general/sub-agents/agents/executor-agent.ts](general/sub-agents/agents/executor-agent.ts))
and `result.draftSteps`. **Read its README FIRST** — findings + the add-path capture
gap: `qa_author_test_iteratively`'s steps aren't captured headless, so a run that picks
it is detected (`hasUninstrumentedAuthoring`) and scored **uncapturable** (excluded from
the pass-rate, not false-failed).

**Run on a fixture** (Tier-2b: first-run-pass + false-green) — `npm run chat-eval:fixture`
replays authored web tests against a controlled Express fixture (`fixture/`, :4400,
flag-toggle broken-state). Stage 1 = hand-seeded golden steps (deterministic, no LLM);
Stage 2 (`--author`) = agent authors on a live headless preview (`startSession` →
`EditorIterativeAuthorService.authorTest`), then replays via `executePlaywrightTest`.
Run-caught finding: the `isPaymentContext` guard blocks checkout authoring.

---

## Authoring a LOGIN test bound to a stored credential

The production path. Gated by `CREDENTIAL_AUTHORING_ENABLED` (**default ON** —
[../../config/features/credential-authoring.ts](../../config/features/credential-authoring.ts);
set `false` to disable without a deploy. The tool schema, both prompts and the handler
all read it and must stay in agreement).

The user names a saved `secret`; the chat tool `qa_author_test_iteratively` takes
`credential_secret_name` and
[../../services/testing/ui/preview/named-credential-secret.ts](../../services/testing/ui/preview/named-credential-secret.ts)
resolves it **server-side** (owner + session's project — the model never sees or
supplies a `resource_id`).

Values are injected for the live authoring run; each credential fill is frozen as
`{{secrets.<key>}}` and a `secret` **resource binding** rides with the draft through
[draft-steps-cache.ts](../../services/testing/ui/preview/draft-steps-cache.ts) →
`IntentTestCaseService.create` → `intent_test_cases.resource_bindings`, so the SAVED
test resolves the credential at replay. **Without that binding the authored draft works
and the saved test 401s** — the trap this path exists to close.

A credential the app RENDERS BACK ("Welcome back, …") is templated out of the persisted
step by [credential-step-templater.ts](../../services/testing/ui/preview/credential-step-templater.ts).
Run-proof: `npm run chat-eval:credential-proof`.
