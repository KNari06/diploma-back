# Lite Engine + Exploration — Navigation Map

> Starter map (not exhaustive). This folder is large (~13 subdirs); only the
> hot paths and shared building blocks are mapped here. Add a row when you
> touch a file that isn't listed and future-you would want it findable.

**Two independent entry engines share the same building blocks (collectors,
pipeline, analysis):**

| Engine | Entry | Purpose |
| --- | --- | --- |
| **LiteEngine** | [lite-engine.ts](lite-engine.ts) → `MultiAgentOrchestrator` ([agents/](agents/)) | Single-goal AI test authoring/run (chat editor). |
| **Exploration v2** | [exploration/exploration-engine.ts](exploration/exploration-engine.ts) | Autonomous multi-agent site exploration → discovered test cases. |

---

## Top-level

| File | Purpose |
| --- | --- |
| [lite-engine.ts](lite-engine.ts) | LiteEngine — orchestrates a single goal via the cognitive agents. |
| [lite-types.ts](lite-types.ts) | `LiteSnapshot` / `LiteElement` — the snapshot shape every layer consumes. |
| [lite-state.ts](lite-state.ts) | Run-state container for LiteEngine. |

---

## `collectors/` — page observation (shared)

| File | Purpose | Key exports |
| --- | --- | --- |
| [snapshot-collector.ts](collectors/snapshot-collector.ts) | DOM → `LiteSnapshot`; `format()` renders the element list (incl. `[DISABLED] [REQUIRED] [INVALID] [READONLY] [SHADOW]` flags) for the LLM. | `SnapshotCollector` |
| [network-tracker.ts](collectors/network-tracker.ts) | Tracks requests/responses; document + fetch/xhr 4xx/5xx land in `networkErrors`. | `getErrorsSince`, `getNetworkActivityState` |
| [console-collector.ts](collectors/console-collector.ts) | Page console errors/warnings. | `getErrorsSince`, `getFormattedErrors`, `getErrorCount` |
| [page-health.ts](collectors/page-health.ts) | **Pure** technical-health classifier (server-error / session-lost / console count) from collector signals. No I/O, never throws. | `classifyPageHealth`, `formatPageHealth`, `pageHealthHasSignal` |
| [visual-stability.ts](collectors/visual-stability.ts) | Wait-for-stable / loading-indicator detection (1.5s hard cap). | `VisualStability` |
| [screenshot-collector.ts](collectors/screenshot-collector.ts) · [error-collector.ts](collectors/error-collector.ts) | Screenshots; post-hoc error-page detection. | — |

---

## `pipeline/` — per-flow Planner → Executor → Reviewer (used by Exploration Phase 2)

| File | Purpose | Key exports |
| --- | --- | --- |
| [test-pipeline.ts](pipeline/test-pipeline.ts) | The round loop: Planner → Executor → Reviewer until done/blocked/timeout. Owns the `TestBlackboard`. | `TestPipeline` |
| [blackboard.ts](pipeline/blackboard.ts) | Per-flow shared state (plan, rounds, insights, progress, `pageHealth`, `roundInfo`). | `TestBlackboard` |
| [command-executor.ts](pipeline/command-executor.ts) | Maps LLM commands → Playwright; `observePage` enriches output with progress / network / console / **PAGE HEALTH**; redacts creds before LLM/trace. `assertText` is a grounded read-only assertion (see below). | `CommandExecutor` |
| [commands.ts](pipeline/commands.ts) | Executor tool schemas. `PLAYWRIGHT_COMMANDS` (always offered) + `ASSERT_TEXT_COMMAND` (offered ONLY when assert authoring is on). | `PLAYWRIGHT_COMMANDS`, `ASSERT_TEXT_COMMAND` |
| [planner-agent.ts](pipeline/planner-agent.ts) · [executor-agent.ts](pipeline/executor-agent.ts) · [reviewer-agent.ts](pipeline/reviewer-agent.ts) | The three agents. Reviewer runs a deterministic **health gate** before the done-claim. | — |
| [prompts.ts](pipeline/prompts.ts) | Planner / Executor / Reviewer prompt builders (read the blackboard). | `buildPlannerPrompt`, `buildReviewerPrompt`, … |
| [types.ts](pipeline/types.ts) | `PipelineConfig`, `TestBlackboardState`, `CommandResult`. | — |

**Deterministic-assert authoring (editor-only, config-scoped).** When
`PipelineConfig.enableAssertAuthoring` is set (ONLY by
`EditorIterativeAuthorService`; exploration leaves it off), the Executor is
offered `assert_text(ref, expected)` + prompt guidance so it can author a
`type:'assert'` step — a deterministic text-contains check the test re-verifies
on every replay (vs the terminal `mark_done`→`ai_check` LLM self-judge). The
handler is **grounded** (reads the element's live text, succeeds only if it
contains `expected`) and its comparison **mirrors replay's**
`compareValues('contains')` exactly (case-insensitive raw substring, no
whitespace collapse) so a grounded assert can't false-RED on a clean replay.
`commandToStep` freezes a structural `data-testid`/`id` selector (via
`options.cssSelector`) so replay's primary locator is text-independent — a
named heading's `role=heading[name="…"]` primary would otherwise locator-miss
on a changed value. Flag threads config → `TestBlackboard.setAssertAuthoring` →
`ExecutorAgent` tool list + the prompt builders.

**Credential freezing (editor-only, caller-scoped).** A credential fill is
persisted as `{{secrets.<key>}}` bound to a stored `secret` resource, so an
authored login test can actually re-run. `EditorIterativeAuthorService` supplies
a `SecretKeyForKind` mapper to `extractDiscoveredSteps`; exploration passes none
and is unchanged. The mapper is keyed on
`CommandResult.injectedCredentialKind` — the kind `overrideCredentialFillValue`
**actually injected** — so the frozen placeholder and the injected value agree by
construction, and the authoring service surfaces the matching
`resourceBindings` for the caller to persist.

---

## `exploration/` — autonomous site exploration

4-phase orchestrator ([exploration-engine.ts](exploration/exploration-engine.ts)):
Survey (BFS + Cartographer) → Strategy (Strategist) → Flow execution (FlowRunner →
TestPipeline per flow + Scout branch discovery) → Coverage eval (Sentinel).

| File | Purpose |
| --- | --- |
| [exploration-engine.ts](exploration/exploration-engine.ts) | The 4-phase orchestrator + checkpoint/resume. |
| [survey-agent.ts](exploration/survey-agent.ts) | Phase 1 BFS page discovery; calls Cartographer per page. **`survey()` THROWS `EntryUnreachableError` when the entry URL never loads** — see invariant #8. |
| [entry-unreachable.error.ts](exploration/entry-unreachable.error.ts) | Typed error for "never reached the entry URL", so it can't be confused with "site has no flows". |
| [flow-runner.ts](exploration/flow-runner.ts) | Phase 2 — runs each flow through `TestPipeline` (concurrency-bounded); builds `PipelineConfig` (incl. `flowIsAuth`, `pageInsightContext`); Scout after each flow. |
| [prior-learnings.ts](exploration/prior-learnings.ts) | Pure renderer for the cross-flow learnings block (blockers → strategy → tried), incl. the priority-aware char cap. |
| [flow-queue.ts](exploration/flow-queue.ts) · [per-page-budget.ts](exploration/per-page-budget.ts) | Priority queue + per-page fairness cap. |
| [budget-tracker.ts](exploration/budget-tracker.ts) · [rate-limiter.ts](exploration/rate-limiter.ts) | Time/flow/round budget; AI + navigation throttling. |
| [auth-url-patterns.ts](exploration/auth-url-patterns.ts) | **Single source** for login/auth URL heuristics (`isLoginUrl`). Consumed by survey-agent + page-health. English-only by design (LLM covers the tail). |
| [domain-boundary.ts](exploration/domain-boundary.ts) · [overlay-dismisser.ts](exploration/overlay-dismisser.ts) · [intra-flow-overlay-gate.ts](exploration/intra-flow-overlay-gate.ts) | Off-domain guard; popup/cookie/modal dismissal. |
| [test-case-builder.ts](exploration/test-case-builder.ts) | flowTasks → `ExplorationResult` (discovered cases). |
| [agents/](exploration/agents/) | Cartographer / Strategist / Scout / Sentinel + their prompts; `ExplorationBlackboard` (cross-phase shared state). |

---

## Page-health flow (perception signals → pipeline agents)

`observe_page` (every round) collects, via [page-health.ts](collectors/page-health.ts):

```
NetworkTracker.getErrorsSince + ConsoleCollector.getErrorsSince + URL transition
  → classifyPageHealth() → blackboard.setPageHealth(hasSignal ? verdict : undefined)
  → Reviewer prompt PAGE HEALTH section + Reviewer deterministic health gate
```

This closes four causal links the per-flow agents were previously blind to:
HTTP 5xx ⇒ "server error not PASS" · redirect→login ⇒ "session lost" ·
console errors ⇒ visible JS break · progress%+rounds ⇒ "stuck, change strategy".

---

## Invariants (this folder)

1. **Page-health verdict is overwritten every `observe_page`, not appended.**
   `collectPageHealth` calls `setPageHealth(pageHealthHasSignal(h) ? h : undefined)` —
   a clean window MUST clear an earlier round's verdict, else the Reviewer health
   gate would block a recovered page forever ([command-executor.ts](pipeline/command-executor.ts)).
2. **The Reviewer health gate hard-blocks only on `serverErrorStatus` (5xx) and
   `sessionLost`.** A bare 4xx is left to the AI reviewer — 4xx is common/benign
   (validation), so deterministic blocking on it would cause false failures
   ([reviewer-agent.ts](pipeline/reviewer-agent.ts), runs BEFORE the done-claim so it
   catches the no-auditor / cooldown fast-paths).
3. **Any page-derived string sent to an LLM or trace is credential-redacted.**
   Console errors and `pageInsightContext` both pass through
   `redactCredentialValues` ([redact-secrets.ts](../../../utils/interpolation/redact-secrets.ts)) —
   the page may echo a credential into its DOM/console (CLAUDE.md hard invariant #10).
4. **`page-health.ts` is pure and `collectPageHealth` is best-effort.** No I/O,
   never throws; the caller's try/catch returns `''` on failure — health collection
   must never fail the flow (CLAUDE.md hard invariant #11).
5. **Login/auth URL detection lives only in [auth-url-patterns.ts](exploration/auth-url-patterns.ts).**
   Never inline a second login-URL regex — import `isLoginUrl`.
6. **A credential fill is frozen from `result.injectedCredentialKind`, never from `cmd.args.value`.**
   The executor prompt tells the model to emit a *throwaway* placeholder and
   `overrideCredentialFillValue` injects the real credential into a NEW command
   without touching `args` — so `args.value` is the model's fake string by
   design. The injected kind also OUTRANKS the model's `is_sensitive` flag
   (injection is decided by the classifier, not the flag), but only at **high**
   confidence: a medium match is a guess from a label (`username` patterns
   include the token `name`, so "Full name" would otherwise bind the account
   email to a name field). A credential field never keeps `args.value` —
   without a binding it loses its value rather than persisting a literal.
7. **LiteEngine bills 1 credit per successful executed step; Exploration does NOT.**
   Lite chat runs are UI tests (product decision 2026-07-17: 1cr/executed step, same
   as replay; NO refund on failure). **Billing ACCRUES then SETTLES once — it is NOT
   eager.** `chargeStepCredit(action)` (legacy loop: prefilled-replay, credential
   auto-fill, main AI action, recovery-retry) and `chargeForPipelineRound`
   (hybrid/pipeline-v2 via TestPipeline's `onRoundComplete`) only INCREMENT
   `billableStepCount`; the actual per-step deductions happen once in
   `settleStepCharges()`, called from `buildResult()`. **Bill-the-winner:** the paths
   fall through on failure (hybrid → pipeline v2 → legacy loop), so each fall-through
   boundary calls `resetPathCharges()` to discard the abandoned path's tally — only the
   path that reaches `buildResult` is billed (a run that ran 5 hybrid steps then finished
   in 8 pipeline steps bills 8, not 13). Eager charging double-billed those retries.
   Charge lives in LiteEngine, NOT in the shared [ActionExecutor](execution/action-executor.ts)
   or [pipeline/command-executor.ts](pipeline/command-executor.ts) — Exploration reuses
   both and bills flat 10cr, so a charge there would double-bill exploration. When you
   add a NEW `executor.execute` site in LiteEngine, call `chargeStepCredit` on its
   success path; when you add a NEW fall-through boundary, call `resetPathCharges()`
   before the next path runs. `settleStepCharges` latches `creditsExhausted` (surfaced on
   `LiteTestResult`) and never throws — mirrors the replay path.
8-23. **Exploration invariants moved** → **[exploration/CLAUDE.md](exploration/CLAUDE.md)**
   (entry-URL validation + SSRF, billing gates, resume, network assertions,
   cross-flow memory). Numbering is continuous across the two files.
---

## `exploration/phase0/` — Product Analyst

Pre-Phase-1 product discovery → `ProductBrief`, read by all four agents.
See **[phase0/CLAUDE.md](exploration/phase0/CLAUDE.md)** (invariants 24-30).
