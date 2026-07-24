# Chat authoring eval — findings & harness guide

Measuring and iterating on the **chat test-authoring agent** (the
Planner→Executor→Reviewer pipeline in `src/api/chat/general/sub-agents/`).

Companion to the plan: [`claude-plans/qait-agents-to-be-state-20260718.md`](../../../../claude-plans/qait-agents-to-be-state-20260718.md).
This file records what we *learned* building the observability + eval loop —
the gotchas that cost time and the numbers that are easy to get wrong.

---

## The harness in one minute

| Command | What it does | Cost |
|---|---|---|
| `npm run chat-eval` | Replays every bootstrap scenario N times through the real pipeline (headless), scores authored steps deterministically, prints a pass-rate baseline. | ~$0.33 (8×1) |
| `npm run chat-eval -- --runs=3 --scope=edit` | Filter by run count / scope (`add`\|`edit`) / `--only=<substr>`. | — |
| `npm run chat-eval:instrument [scenarioId]` | One replay with a per-call token breakdown + the verbatim request / authored steps / reply. | ~$0.04 |
| `npm run chat-eval:fixture` | **Tier-2b** — replays hand-seeded golden web tests against a controlled fixture app; scores first-run-pass-rate + false-green-rate. DETERMINISTIC, no LLM. | ~$0 |
| `npm run chat-eval:fixture -- --author` | Tier-2b Stage 2 — the agent AUTHORS the test against the live fixture, then it's replayed. | ~$0.05–0.15/scenario |
| `npm run chat-eval:fixture:serve` | Boot the web fixture standalone on :4400 (manual poking). | ~$0 |

Files: `replay.ts` (headless pipeline driver), `scoring.ts` (pure deterministic
scorer), `scenarios.ts` (bootstrap corpus), `run-eval.ts` (CLI), `instrument-run.ts`
(token profiler), `__tests__/scoring.test.ts` (18 pure unit tests). **Tier-2b:**
`fixture/` (Express web app + flag-toggle broken-state), `fixture-runner.ts` (run
primitive), `author-on-fixture.ts` (Stage-2 live authoring), `fixture-scoring.ts`
(+ 14 unit tests), `fixture-scenarios.ts`, `run-fixture-eval.ts` (CLI).

---

## How authoring actually works (verified)

- Two surfaces, one brain: **global chat** (add a new test) and **per-test-case
  chat** (edit a bound case). Both run the same sub-agent pipeline.
- Writes go through confirm-gated QA tools: `qa_run_draft_steps` (draft, no
  save), `qa_create_test_case` (save new), `qa_update_test_case_steps` (edit in
  place). The editor prompt saves only on an explicit "save".
- **But global "create a test" often routes to `qa_author_test_iteratively`** —
  a goal-based agentic tool that builds steps by executing them live on the
  preview. It takes a `goal`, not a `steps` array, so the harness does NOT
  capture it (see gotcha #6). The 8×1 baseline (2026-07-23) showed the executor
  picking it for **every** add scenario — tool choice between it and
  `qa_run_draft_steps` is stochastic, and only the latter is capturable headless.
- Create-vs-edit is decided in the executor **prompt** (the TEST-CASE SCOPE
  block, `prompts/executor-prompt.ts`), not by structural state — the source of
  the duplicate-creation bug this work guards against (Hard invariant #16c).

---

## Gotchas that cost time (read before extending)

1. **A standalone script gets an EMPTY skill registry → 0 tools → the pipeline
   silently short-circuits to `fallback` and authors nothing.** The registry is
   populated at server boot; `replay.ts` calls `registerAllSkills()` once per
   process before `getAvailableTools()`. Symptom in logs: `Tools filtered from:
   0 to: 0` then `No tools available after filtering — falling back`. Unit tests
   were green while the integration was empty — classic "green is not done."
2. **Headless replay has no live DOM, so authored steps are ungrounded.** With
   no preview page (`Start URL: about:blank`), the agent writes plausible-but-
   generic steps ("the Log in button") instead of DOM-specific ones. The
   deterministic scorer (Tier-2a) **cannot catch this** — the steps are
   structurally fine. Only a run-on-fixture (Tier-2b) would, when they fail
   against a real app. This is the concrete case for building Tier-2b.
3. **A single-shot replay is side-effect-light for free.** The confirm-gate
   downgrades every write tool's `confirm=true→false` (no prior preview turn),
   so `qa_create/update` return a preview WITHOUT persisting and
   `qa_run_draft_steps` only caches an in-memory draft. So deterministic scoring
   needs only an LLM key — **no sandbox DB project, no DB writes**. (A sandbox +
   scoped auto-confirm is only needed for Tier-2b, which actually runs steps.)
4. **`writeSteps` capture is tc-scope only.** The chat trace
   (`ChatTestTraceService` → `test_logs/chat_test/`) is written only when
   `store.kind === 'testcase'`. So the harness captures the **edit** path from
   the trace (`source` = tool choice) and the **add** path from
   `result.draftSteps`. There is no live trace for global-chat authoring —
   extending it there is a deliberate follow-up (touches invariant #16).
   **Corollary: grounding detection is add-path-only.** The trace deliberately
   drops step `value`s (secret-safety), so edit-path captures never populate
   `valueShape` and the fabrication check can't fire there. Fine while all
   `grounding:'credentials'` scenarios are add-scope; solve before adding a
   credential-bearing edit scenario, or it will silently false-green.
5. **`lite:analyze` now descends into `test_logs/` subdirs** (`chat_test/`,
   `editor/`, `replay/`, `regressions/`). It previously did a flat readdir of
   the root and missed every sharded trace.
6. **The add path can't capture `qa_author_test_iteratively` headless — it's now
   EXCLUDED as "uncapturable", not false-failed.** That tool's very first check is
   `if (!confirm) return {success:false}`, so under the confirm-gate downgrade it
   bails in ~1ms with no steps (its steps are produced by actually running the
   agentic loop on a live preview, which headless replay has none of). It's also
   absent from `STEP_TRACE_SOURCE` in `executor-agent.ts` and never populates
   `result.draftSteps` — so neither capture path sees its steps. **The fix (option
   b):** the harness detects the tool from `result.metrics.toolsExecuted`
   (`hasUninstrumentedAuthoring` in `scoring.ts`) and sets
   `CapturedRun.uninstrumentedAuthoring`. When an **add-authoring** run (`scope==='add'
   && expectsSteps`) authored via it but produced nothing capturable and didn't
   clarify, the scorer returns `ScenarioScore.uncapturable=true` (`passed=false`,
   neutral sub-checks) and
   `aggregate` **drops it from the pass-rate denominator** — so a valid tool choice
   no longer reads as a false-red (it's `○` in the scorecard, `n/a` if every run of
   a scenario is uncapturable). This distinguishes "authored via an uninstrumented
   tool" from "authored nothing". The 8×1 baseline (2026-07-23) hit the *old*
   false-fail on all 3 real add scenarios; those now show as uncapturable instead
   of 0%. The edit path is unaffected (`qa_update_test_case_steps` writes steps to
   the trace from its args before the gate short-circuits).
   **Still deferred:** actually *scoring* the add path — capturing this tool's steps
   needs a live/stub preview (Tier-2b run-on-fixture); option (a) hard-requires it
   because the tool won't produce steps without one. Forcing `qa_run_draft_steps`
   in eval scope was rejected (it changes the agent, same objection as trimming
   tools). So: trust the **edit**-path number; the **add**-path pass-rate is valid
   only over its *capturable* runs (uncapturable ones are excluded, not counted).

---

## Cost — measured, not estimated

`gpt-5.4-mini` @ $0.002/1K in, $0.008/1K out; **cached input $0.0002/1K (90% off)** ([ai-cost-manager.service.ts](../../services/ai/cost/ai-cost-manager.service.ts)).

**Pre-caching baseline** (add-login-happy, 1 run, 2026-07-21) — before cached tokens were surfaced/billed:

| agent | calls | in | out | cost | share |
|---|--:|--:|--:|--:|--:|
| executor | 2 | 14,013 | 273 | $0.030 | **74%** |
| router | 1 | 2,518 | 73 | $0.006 | 14% |
| responder | 1 | 1,776 | 203 | $0.005 | 13% |
| reviewer | 0 (fast-approve, no LLM) | — | — | — | — |
| **total** | **4** | **18.3k** | **549** | **$0.041** | |

**With prompt caching wired** (same scenario, warm, 2026-07-23) — `cached_tokens` now surfaced by the client and billed at the cachedInput rate:

| agent | calls | in | cached | out | cost |
|---|--:|--:|--:|--:|--:|
| executor | 2 | 14,621 | 13,568 | 275 | $0.0070 |
| responder | 1 | 1,770 | 1,280 | 207 | $0.0029 |
| router | 1 | 2,518 | 2,304 | 70 | $0.0014 |
| **total** | **4** | **18.9k** | **17.7k (92%)** | **552** | **$0.0112** |

- **One warm run ≈ $0.011 (was $0.043) — a 74% cut.** Full 8×1 ≈ $0.09, 8×3 ≈ $0.27.
  Verify with `npm run chat-eval:instrument` — it prints per-call `cached` tokens
  and the no-cache-vs-actual delta.
- **Cost = the executor's input tokens.** It's called twice with a near-identical
  ~7k-token prefix (tool schemas + system prompt); OpenAI automatically caches
  that identical ≥1024-token prefix, so ~90%+ of the executor's input is a cache
  hit on any warm turn.
- **How it's wired (not a request param — OpenAI auto-caches):** the client reads
  `usage.prompt_tokens_details.cached_tokens`, exposes it as
  `OpenAIResponse.usage.cachedInputTokens`, and `calculateOpenAICost` bills the
  cached subset at each model's `cachedInput` rate (full input rate for models
  without one, so billing never over-discounts). Purely surfacing + pricing an
  already-latent discount — a **production** win on every real authoring turn.
  A cold first-ever call shows `cached=0`; steady-state traffic keeps the prefix warm.
- **Cache warmth affects the number.** A back-to-back re-run shows higher hit
  rates than a cold one; the table above is a warm run (representative of a busy
  authoring surface). Do **not** cheapen the eval by trimming tools or swapping to
  a cheaper model — that measures a different agent than users get.
- Efficiency already present: the executor gets a **router-filtered** tool subset
  (`getToolsForCategories`), and the reviewer fast-approves without an LLM call.

---

## Scoring model

**Tier-2a (deterministic, built)** — pure, no app run, no judge:
`producedSteps` · `toolChoiceCorrect` (edit→update, add→create/draft, never the
wrong one) · `noDuplicate` (edit never creates) · `stepsWellFormed` (known type
+ non-empty description). Aggregated to per-scenario + overall **pass-rate over
N**, with agent-flakiness flagged (passed some runs, not all).

**Tier-2b (run-on-fixture, BUILT — web)** — the real **first-run-pass-rate** /
**false-green-rate**: actually RUN authored web tests against a controlled fixture
app (`fixture/`, :4400 — login/search/checkout with keyed elements + a flag-toggle
broken-state ported from qait-testbed's design; `shop.sf2-discount` silently omits
the 10% discount). Chain (all existing tested fns): `authorTest(goal)` (or golden
steps) → `toIntentSteps` → `convertIntentStepsToCommands` → `executePlaywrightTest`
(own fresh headless browser) → `success`. Two stages:
- **Stage 1** (`chat-eval:fixture`, no LLM): hand-seeded golden steps (pinned
  `options.cssSelector` → deterministic via the executor's pinned-CSS
  short-circuit). Proves the rig: 100% first-run-pass on the clean app, and the
  checkout golden test goes RED on `sf2-discount` (false-green correctly caught).
  A false-green here is a rig REGRESSION → non-zero exit.
- **Stage 2** (`--author`, LLM): the agent authors against the live headless
  preview (`startSession` → `EditorIterativeAuthorService.authorTest`, no DB/Redis/
  WS gate; confirm-gate bypassed by calling the service directly). Measures the
  REAL agent under production conditions — the only valid way (running the
  headless-`about:blank`-authored steps would measure resolver-rescue, not
  authoring; see gotcha #2).

**Metric semantics (so the numbers aren't misread):** first-run-pass = green on
clean; false-green = green on broken, and only over scenarios with a
`breaksUnderFlag` pairing that ALSO passed clean (a red-on-clean test isn't
false-green-measurable). N=1, biased corpus → directional, not a baseline.

**Two run-only findings from the live Stage-2 runs (2026-07-24) — the "caught by
running" payoff:**
1. **Payment-action guard blocks unattended checkout authoring.** The agent's
   production `isPaymentContext` guard ([clarification-gates.ts](../../agent/core/lite/analysis/clarification-gates.ts),
   gated in pipeline [command-executor.ts](../../agent/core/lite/pipeline/command-executor.ts)) fires on
   "Proceed to checkout"/"Place order" → `report_blocked`, authors nothing. So an
   autonomous eval can't author a checkout/payment test — a substrate gap.
2. **Authored login tests aren't self-contained → not reproducible.** The agent
   logs in fine during authoring (creds surfaced to the Planner) but the credential
   values are NOT frozen into the steps (empty/placeholder, secret-safety) → a fresh
   replay types nothing → login 401s → the authored test first-run-FAILS. This
   *run-proves* the credential-store gap (rung-1). The eval labels this honestly
   (credential-store gap, not an authoring defect); opt-in credential injection is
   a deferred follow-up.

**Rung-3 update (2026-07-24) — the agent now authors a DETERMINISTIC assertion.**
The above caveat is **superseded** for the editor path. The lite Executor gained a
config-scoped `assert_text` command ([commands.ts](../../agent/core/lite/pipeline/commands.ts) `ASSERT_TEXT_COMMAND`,
gated by `PipelineConfig.enableAssertAuthoring`, set only by
`EditorIterativeAuthorService`) so it can emit a `type:'assert'` step
(text-contains, deterministic on every replay) when the goal implies a checkable
value. It's **grounded** — the handler reads the element's live text and only
succeeds if the value is present now, mirroring replay's `compareValues('contains')`
so a grounded assert can't false-RED on a clean replay. Stage-2 now reports the
`assertKind` per scenario (`deterministic` | `ai_check` | `none`). Live-verified on
the search flow: the agent authored `assert_text(result-count, "1 result")` → first-run
PASS on clean, RED on `shop.sf-search-count` (`Text assertion failed: expected "1 result",
got "2 results"`) → false-green 0. The `ai_check` terminal self-judge still exists as a
fallback; exploration authoring is unchanged (flag off).

---

## Corpus honesty

`scenarios.ts` is a **biased, hand-written bootstrap set** — what we *think*
breaks, not what real usage shows. `test_logs/chat_test/` is empty until real
traces accrue. Treat any baseline off these as directional, not ground truth;
swap for a mined, representative corpus before trusting the number.
