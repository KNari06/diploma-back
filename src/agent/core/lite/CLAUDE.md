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
| [command-executor.ts](pipeline/command-executor.ts) | Maps LLM commands → Playwright; `observePage` enriches output with progress / network / console / **PAGE HEALTH**; redacts creds before LLM/trace. | `CommandExecutor` |
| [planner-agent.ts](pipeline/planner-agent.ts) · [executor-agent.ts](pipeline/executor-agent.ts) · [reviewer-agent.ts](pipeline/reviewer-agent.ts) | The three agents. Reviewer runs a deterministic **health gate** before the done-claim. | — |
| [prompts.ts](pipeline/prompts.ts) | Planner / Executor / Reviewer prompt builders (read the blackboard). | `buildPlannerPrompt`, `buildReviewerPrompt`, … |
| [types.ts](pipeline/types.ts) | `PipelineConfig`, `TestBlackboardState`, `CommandResult`. | — |

---

## `exploration/` — autonomous site exploration

4-phase orchestrator ([exploration-engine.ts](exploration/exploration-engine.ts)):
Survey (BFS + Cartographer) → Strategy (Strategist) → Flow execution (FlowRunner →
TestPipeline per flow + Scout branch discovery) → Coverage eval (Sentinel).

| File | Purpose |
| --- | --- |
| [exploration-engine.ts](exploration/exploration-engine.ts) | The 4-phase orchestrator + checkpoint/resume. |
| [survey-agent.ts](exploration/survey-agent.ts) | Phase 1 BFS page discovery; calls Cartographer per page. |
| [flow-runner.ts](exploration/flow-runner.ts) | Phase 2 — runs each flow through `TestPipeline` (concurrency-bounded); builds `PipelineConfig` (incl. `flowIsAuth`, `pageInsightContext`); Scout after each flow. |
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
