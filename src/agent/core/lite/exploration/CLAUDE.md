# `exploration/` — Invariants

> Hard rules for autonomous site exploration. The file map and phase overview
> live in the parent map: [../CLAUDE.md](../CLAUDE.md#exploration--autonomous-site-exploration).
> Phase 0's own rules (24-30) are in [phase0/CLAUDE.md](phase0/CLAUDE.md).
>
> Numbering continues the parent's list (1-7 there cover collectors, pipeline
> and LiteEngine billing) so an invariant keeps one stable number repo-wide.

8. **"Never reached the entry URL" MUST be distinguishable from "site has no flows."**
   `SurveyAgent.survey()` throws [EntryUnreachableError](entry-unreachable.error.ts)
   instead of returning an empty tree. It used to `return this.tree`, which the engine
   turned into `status:'completed', reason:'no_entry_points'` — so a typo'd or dead URL
   reported success, told the user their site had no testable flows, and still charged
   `EXPLORATION_DISCOVERY_CREDITS`. Throwing routes into the job's existing catch
   (`failRun` + `status:'failed'` + rethrow BEFORE the deduction), so no billing code
   was needed. Do NOT wrap the `survey()` call in a catch that swallows — the whole
   point is that the failure reaches the job. (Targeted surveys use `surveyTargets()`,
   which is separate and intentionally non-fatal.)
9. **Exploration only bills when it produced a RUNNABLE test case.** `exploration-run.job.ts`
   gates `deductCreditsForTest` on `testCases.filter(tc => tc.steps?.length > 0).length`,
   **not** `result.testCases.length` — `TestCaseBuilder` appends one zero-step
   `not_explored` placeholder per UNEXPLORED entry point, so the naive length check
   billed a run that surveyed pages and then explored nothing (budget exhausted, every
   flow blocked), which is the exact case the gate exists to catch. The chat reply uses
   the SAME count, so "You were not charged" can never contradict the charge.
   **Consequence to keep in mind:** `requireCredits` is now a reservation, not a
   settlement — a run that yields nothing consumes browser + LLM work for free. Watch
   for abuse if `/start` ever gets a cheaper rate limit.
10. **The entry URL is validated + probed BEFORE the job is enqueued, at every producer.**
   [normalizeEntryUrl](../../../../utils/validation/entry-url.ts) (accepts a bare domain,
   enforces the http(s) allowlist + SSRF blocklist) then
   [preflightEntryUrl](../../../../services/testing/exploration/entry-preflight.service.ts)
   (DNS resolve-then-check + one GET; classifies dns_failure / connection_refused /
   tls_error / timeout / http_error / bot_challenge / auth_required / ssrf_blocked).
   All three producers normalize AND probe — REST `explorations.controller`, chat
   `ai_test/handler`, and the confirm path `exploration-confirmation`. The confirm path
   **re-probes rather than trusting the ask-time verdict**: its Redis payload lives for
   `PENDING_EXPLORATION_TTL_SEC`, so a site reachable when we asked can be down when the
   user confirms, and that is the last gate before a paid job is enqueued.
   **`sanitizeUrl` is NOT the right helper here** — the chat path never called it (that
   was an SSRF hole), and teaching `sanitizeUrl` to prepend a scheme would change
   preview/flows/step-apply behaviour, whose tests assert it throws on a scheme-less
   string. **Scheme selection is decided on the PARSED hostname, never a raw-string
   prefix** — `startsWith('localhost')` matched `localhost.attacker.com` and downgraded
   an attacker-chosen host to cleartext.
   **The probe follows redirects MANUALLY (`maxRedirects: 0`) and re-validates every
   hop.** axios's own redirect-following is an SSRF bypass: the DNS resolve-then-check
   covers only the FIRST hop, so a public host could 302 to `169.254.169.254` and the
   metadata body came back — verified live against loopback servers before the guard
   existed. `isBlockedSsrfHostname` alone is insufficient (it does not resolve DNS), so
   `assertHostAllowed` resolves and checks every returned address, for the entry host and
   each hop.
11. **`isSameOrigin` accepts the POST-REDIRECT origin — but only after an SSRF check.**
   `acme.com` 301-ing to `acme.io` seeds the BFS from the redirect target, so comparing
   only against the configured URL rejected every link on the site we actually landed on
   — one page surveyed, zero flows, still billed. The landed origin is recorded once, on
   successful entry navigation, and **`recordLandedOrigin` refuses to promote an origin
   that fails `isBlockedSsrfHostname`**: promotion makes it BFS-crawlable, and the
   worker's browser never runs the preflight, so a redirect to `http://10.0.0.5/` would
   otherwise get a private origin crawled past every other guard. When promotion is
   refused the run degrades to the configured origin rather than dying.
   Note the entry-nav retry is **budget-aware** for the same class of reason: 3 × 30s +
   backoff is 94.5s, 79% of the `quick` preset's 120s total, so each attempt is clamped
   to `budget.remainingTimeMs()` and retries stop below
   `ENTRY_NAV_MIN_BUDGET_FOR_RETRY_MS`.
12. **`bb.pageInsights` MUST be written by the survey — three agents read it.**
   `SurveyAgent.setPageInsightSink()` is wired by the engine at ALL THREE
   construction sites (entry survey + both targeted surveys); the survey publishes
   inside the `if (nodeId)` guard so a deduped page (`addNode` → null) never
   stores an insight under a missing key. Before this, the map had three readers
   (Strategist, Sentinel, and the Planner via FlowRunner's `pageInsightContext`)
   and ZERO writers on a fresh run — the only assignment was the checkpoint-resume
   path — so Cartographer computed `forms`/`dataEntities`/`interactiveAreas` per
   page and the result was discarded. **Key alignment matters:** the map is keyed
   by the TREE's `page-N` id because `FlowRunner.findPageInsight` resolves
   url → `node.id` → key, but Cartographer stamps its own
   `page-${Date.now()}`; `publishPageInsight` re-stamps `insight.pageId` with the
   node id so the key and the field can't drift. The sink is best-effort — a
   throwing sink must never fail a survey.
13. **The Planner's form hint carries field LABELS, not a count.** `summarizeForms`
   renders `[Email*, Password*] → "Sign in"` (`*` = required); `forms: 2` was not
   actionable, defeating the point of Cartographer's prompt calling `forms`
   mandatory. `insight.forms` comes straight from an LLM (`parseCartographerResponse`
   only Array-checks it), so stay defensive about missing/non-object fields.
   `PAGE_INSIGHT_MAX_CHARS` 300 → 600: truncating mid-list is worse than a longer
   hint, because a Planner seeing half a list submits an incomplete form.
14. **A discovered case with no steps is NEVER persisted.** `saveTestCases` filters
   `steps.length > 0` before insert. `TestCaseBuilder` emits one zero-step
   `not_explored` placeholder per UNEXPLORED entry point, and persisting those wrote
   real `intent_test_cases` rows with `steps_json: []` — unrunnable and
   indistinguishable from a genuine draft. The mobile snapshot path in the same
   service already guarded this (`if (steps.length === 0) continue`); the web path
   did not. Those placeholders are also excluded from the billing count (invariant #9).
15. **The exploration OUTCOME rides a tag, not `status`.** `intent_test_cases.status`
   is a LIFECYCLE column constrained to `draft|published|archived`
   ([20260201_001](../../../../../supabase-migrations/20260201_001_intent_test_cases_unify.sql)),
   so `passed`/`failed`/`blocked` cannot go there — a discovered case is legitimately
   a `draft` however it ran. `taskToTestCase` pushes `explored-<status>`; without it a
   flow that PASSED and one that FAILED produced byte-identical rows. Do NOT "fix"
   this by writing an outcome into `status` — it violates the CHECK and fails the insert.
16. **The Sentinel fallback score is capped when discovery was thin.** Its denominator
   is what we DISCOVERED, so the ratio inverts exactly when discovery failed worst: a
   Cartographer parse failure yielding 2 entry points instead of 40 scored 2/2 = **100**,
   displaying a near-total failure as perfect coverage. Below
   `FALLBACK_MIN_ENTRY_POINTS_FOR_FULL_SCORE` the score is capped and the summary says
   so. Why it was invisible: **Cartographer and Scout swallowed failures with no
   progress event** (Strategist/Sentinel both emit `agent_warning`); the survey now
   emits one when Cartographer returns nothing and falls back to DOM heuristics.
17. **A retry that succeeds must update every derived field, not just `status`.**
   `runSingleFlow` tracks `effectiveGoalAchieved` / `effectiveProgressScore` /
   `effectiveRoundsUsed` / `effectiveBlockedReason` alongside `status`. The recovery
   retry set `status='completed'` but the return still read `pipelineResult.success`,
   so a genuinely recovered flow was saved `goalAchieved:false` → TestCaseBuilder
   marked it `'failed'` while `status` said `'completed'`, and the summary counted it
   as both. `roundsUsed` now SUMS both attempts.
18. **`VALID_BLOCKER_TYPES` must stay in sync with the `BlockerType` union.**
   `needs_data` was in the union (with a docblock calling it user-resolvable) but
   missing from the list, so an Executor reporting `BLOCKED [needs_data]` had it
   downgraded to `'other'` — which is NOT in the clarification allow-list, so the user
   was never asked for the value and the flow stayed permanently dead.
19. **A RESUME must not re-charge and must not re-save.** `deductCreditsForTest` is not
   idempotent on `testId`, and `resumeFromCheckpoint` merges `previousTasks` into the
   result (correct — the summary should reflect the whole run), so the job used to
   re-save the pre-crash flows as DUPLICATE `intent_test_cases` rows and re-charge 10cr,
   up to the 3-resume cap = 40cr + 4× duplicates for one logical run. The job now skips
   the charge entirely when `isResume` (safe: `clearCheckpoint` happens INSIDE
   `engine.run()` before the charge, so a crash between them leaves no checkpoint and
   the retry is a fresh, chargeable run) and saves only cases whose entry-point id is
   absent from `checkpoint.flowRunner.completedTasks`.
20. **A resumed run must SAY coverage was not assessed.** `resumeFromCheckpoint` skips
   Phase 1.5 + 2.5 by design — no Strategist, no Sentinel, static `fromEntryPoints`
   queue — but wrote `status:'completed'` with an EMPTY coverage section, which reads as
   "assessed, scored 0". `markResumedRunSummary` fills `qualitySummary` / `gaps` /
   `recommendations` with the truth and leaves `coverageScore` **undefined** (a 0 would
   itself be a lie). Applied at all three resume result-build sites.
21. **Network assertions are the ONLY exploration assertion that is verified — and a
   failure is fatal ONLY on 5xx-where-2xx-was-expected.** Discovery already derives
   them for free from `NetworkTracker`; they are now persisted whole
   (`intent_test_cases.network_assertions`, migration `20260801_…`) instead of being
   flattened into a write-only `assert:` tag, threaded via `TestJobData.networkAssertions`
   (`getSavedTestCase` selects `*`, so no query change), and verified after the step
   loop in [test-executor.ts](../../../playwright/core/test-executor.ts).
   **Why the narrow fatal rule:** these assertions are authored autonomously and nobody
   reviews them before they land in a user's project, so a spurious RED turns a whole
   discovered suite into triage noise — worse than missing a regression. A 5xx where
   discovery saw 2xx is the only mismatch that cannot be a matter of opinion. A missing
   call, a 4xx, or family drift are all legitimately explainable (different data, changed
   validation, another branch) and are logged + traced, never fatal. `matchNetworkAssertion`
   owns that judgement via `serverError`; the executor must not re-derive it from strings.
   Matching is lenient elsewhere: status **family** (200→204 safe) and
   `normalizeUrlWithPattern` on BOTH sides (per-run ids + query strings safe) — the same
   function used at authoring time, so authoring and verification stay symmetric. Runs
   only when all steps passed (a missing call is expected after stopping early); the
   recorder attaches ONLY when assertions exist (zero cost otherwise); a throwing check
   is swallowed — a broken check is a missing check, not a red test.
22. **DO NOT reuse `NetworkTracker` in replay, and DON'T put a network assert in
   `case 'assert'`.** `NetworkTracker`'s constructor auto-starts request interception with
   **body capture** — right for an AI agent, wrong per-request on every scheduled test;
   use [NetworkCallRecorder](../../../playwright/execution/network-call-recorder.ts) (one
   `response` listener, method/url/status only, ring-buffered, idempotent, defensive).
   And `case 'assert'` requires a selector + resolves a locator BEFORE its
   `visible|hidden|text|url` switch, so a selector-free check cannot live there —
   `assertUrl` is the precedent, hence test-case-level verification after the loop.

23. **Cross-flow memory is written when a flow ENDS, not after Phase 2.**
   `recordFlowOutcome` ([agents/blackboard.ts](agents/blackboard.ts)) is called from both
   terminal paths in `FlowRunner.executeFlow` — the normal one and the infra-error
   `catch` (AFTER its blocker classification, so the memory keeps the classified reason,
   not a raw stack). `bb.completedFlows` is only filled once `runAll` RETURNS, so
   everything reading it mid-Phase-2 saw an empty list: `recordAccomplishment` had zero
   callers and the blockers section of `priorLearnings` never rendered — every flow
   re-discovered what the previous one already paid for. Blockers therefore live in
   `workingMemory.blockersByCategory`, not derived from `completedFlows`.
   **Record the TASK, never a hand-rolled status check:** `FlowExplorationTask.status`
   ('completed') and `FlowExecutionResult.status` ('passed') are DIFFERENT unions, so
   `recordFlowOutcome` maps through the existing `taskToFlowResult` — comparing
   `=== 'completed'` against a mapped result never matches and files every win as a
   failure. `skipped` is excluded (it never ran). The caller redacts `blockedReason` on a
   SHALLOW COPY, since the reason is page-derived text (hard invariant #10) and mutating
   the task in place would change what is then emitted and traced.
   Rendering is [prior-learnings.ts](prior-learnings.ts) — pure, so the cap rule is
   testable without FlowRunner's Playwright+OpenAI import graph. It drops whole trailing
   SECTIONS (ordered blockers → strategy → tried) instead of tail-slicing the joined
   string, which truncated mid-sentence and ate the most valuable section first.
   Redaction runs AFTER capping: the mask (3 chars) never exceeds what it replaces
   (min 4), so it can only shrink the block.
24. **Exploration authors deterministic asserts — but the VALUE is screened, not just
   the prompt.** `enableAssertAuthoring` is no longer editor-only: FlowRunner sets it
   from `categoryAllowsAssertAuthoring(entryPoint.category)` at BOTH `PipelineConfig`
   sites (primary + recovery retry — they drifted before on `flowIsAuth`). The whole
   mechanism already existed (the `assert_text` command, `type:'assert'` steps,
   `commandToStep`'s frozen structural selector, and 7 assertion kinds in the replay
   `case 'assert'`); only exploration had it switched off, so a discovered case rested
   entirely on the terminal `ai_check` self-judge.
   **Why a code guard was required to turn it on:** the only protection against
   freezing a volatile value was one line of prompt text. That is fine in the editor,
   where a human reviews the authored step, and NOT fine here — nobody reviews an
   exploration assertion before it lands in the user's project, and one frozen
   timestamp makes a permanently RED test, which is worse than no assertion at all
   (same reasoning as invariant #21's narrow fatal rule).
   [assert-volatility.ts](../pipeline/assert-volatility.ts) rejects clock times, dates
   (ISO / numeric / written), relative times, labelled ids, UUIDs, high-entropy tokens,
   precise money and progress values, BEFORE the value is grounded against the page —
   a timestamp grounds perfectly right now and is red forever after. The rejection is
   returned to the model as a tool error explaining what to assert instead, so the
   round is not lost. Deliberately STRICT: a missed assertion costs one check, a
   false-RED costs the credibility of every test around it.
   **Keep the accept-list tests as seriously as the reject-list tests.** The id rule
   requires an explicit marker AND a digit-bearing token precisely so that
   `Order confirmed` — the most valuable e-commerce assertion there is — is not banned;
   an earlier draft rejected it. Same for the category gate: `authentication` is
   excluded for a STRUCTURAL reason (its replay cannot reproduce its own login), not
   out of caution, and widening that list would silently gut `e_commerce`/`crud`.

25. **Every user-facing exploration COUNT derives from `summary.flows` — but
   `flows` is NOT everything that persists (see #27).** `TestCaseBuilder.buildSummary` builds `flows` with ONE
   filter — `tc.explored && tc.steps.length > 0`, the exact rule `saveTestCases`
   uses — and then derives `flowsPassed/Failed/Blocked` (`flows.filter(status)`),
   `flowsExplored` (`flows.length`) and `runnableTestCases` (`flows.length`) from
   that single array. Do NOT re-derive an outcome count from raw `flowTasks`: the
   two collections diverge (a `timeout` maps to a `failed`/`not_explored` test case,
   and the `explored` predicate + step-count gate differ from task status), which is
   exactly what made the results-panel header ("3 failed") disagree with its tabs and
   the history card's total ("34 tests") exceed the panel's "All (22)". A flow that
   ran but recorded zero steps is NOT persisted, so it is excluded from `flows` and
   counted in `flowsNotExplored` (positive cases with `!(explored && steps>0)`) — its
   own honest bucket, never folded into `flowsFailed`. Consumers must use
   `summary.runnableTestCases`, NOT `result.testCases.length` (which still counts one
   zero-step `not_explored` placeholder per unexplored entry point): the chat "Test
   cases generated" line, `exploration_runs.test_cases_count` (history card), the WS
   `emitExplorationCompleted.testCasesCount`, and the chat metadata all read the
   runnable count so no surface can contradict another. `savedTestCaseIds` remains the
   authoritative persisted set (shorter still on a resume — invariant #19).

26. **The PAGES list/counter reflects every VISITED page, not only surveyed nodes.**
   `buildSummary.pages` starts from `tree.getAllNodes()` (survey BFS — carries
   title/pageType/depth/entry-point counts) THEN appends any `step.pageUrl` seen in a
   flow that is absent from the tree, tagged `pageType:'visited'`. The BFS survey often
   nodifies only the entry page while flows navigate on to `/signup`, `/verify-email`,
   a workspace route — those were genuinely explored but the counter (`pages.length`)
   read "1 page". Page identity is `canonicalPageKey` (origin+path, query/hash/trailing
   slash stripped) so `/login?next=x` and `/login#form` don't inflate the count; it is
   deliberately COARSER than `url-pattern.ts` (which also collapses path ids —
   `/user/1` vs `/user/2` are different pages here) and finer than origin-only. Keep
   `pagesSurveyed` (`tree.getNodeCount()`) as the survey-only metric behind the chat
   "Pages surveyed" line — it is a DIFFERENT, honest number and must not be conflated
   with the visited count. Live (`page_discovered` events) still shows the survey count
   and jumps to the visited count on history load — correct direction, same live-vs-final
   pattern as the flow counts; do not try to stream flow-visited pages live.
27. **"What we EXPLORED" and "what we WROTE" are two different numbers — pick the
   one that answers the question.** Generated negative cases are `explored:false`
   (nothing ever ran them) so they are correctly absent from `summary.flows` and from
   every outcome count — but they carry 3 steps, and `saveTestCases` persists anything
   step-bearing, so they DO become `intent_test_cases` rows. Reporting `flows.length`
   as the test-case total therefore under-counted by one row per form flow: the history
   card said 3 while the project gained 5 and `/explorations/:id/test-cases` (which
   returns every row for the run) listed 5. Not an edge case — `FORM_CATEGORIES` is
   `authentication` / `form_submission` / `user_management` / `e_commerce`.
   `buildSummary` now emits three numbers: `runnableTestCases` (= `flows.length`,
   explored flows — the panel's flow list), `negativeTestCases`, and
   `persistedTestCases` (their sum = exactly what `saveTestCases` writes).
   **Route each consumer by its question:** "what did my project receive" →
   `persistedTestCases` (`exploration_runs.test_cases_count`, the chat "Test cases
   generated" line + metadata, the WS completion event, `coverage_evaluated`); "what
   did we actually explore" → `runnableTestCases`. **BILLING stays on
   `runnableTestCases`** — a negative is a template derived from a flow already being
   charged for, so billing on it would charge 10cr for a run where every real flow
   failed, exactly the contradiction #9 exists to prevent. Negatives get their own
   chat line rather than being folded into the explored total: a saved-but-unverified
   case must never be presented as one we ran.
28. **Exploration reads authorize on PROJECT ACCESS, not on who started the run.**
   `/explorations/start` admits any workspace member (`projectBelongsToWorkspace` has
   no owner requirement) while every read filtered `exploration_runs.user_id = caller`
   — so a teammate could start a run against a shared project and then 404 on its own
   results, with `run-discovered` silently dropping every case. All reads + cancel now
   go through `resolveAccessibleExploration` → `hasProjectAccess` (owner OR active
   member), and the row queries scope by `project_id` + `exploration_id` instead of
   `user_id` (the rows are owned by whoever started the run). **The project bound is
   load-bearing:** it is what stops a caller passing an id from another project once
   the ownership filter is gone. **`listExplorations`' `workspaceId` comes from the
   QUERY STRING** — it was safe only because of the `user_id` filter, so it now
   verifies membership (`WorkspaceAccessService.isMember`) BEFORE widening; dropping
   that filter without the check would have turned it into an IDOR.
29. **Cancellation is cooperative, cross-process, and keeps the partial result.**
   `POST /explorations/:id/cancel` flips `exploration_runs.status` — the flip IS the
   signal, because the endpoint runs on the API process and the engine runs in the
   worker, so no in-memory flag could reach it. The worker polls `isRunCancelled` via
   `ExplorationConfig.onCancelCheck` at the engine's phase boundaries AND once per
   `FlowRunner.runAll` iteration (after each flow completes). **Both are needed:** the
   engine's two checks alone would make a cancel issued during Phase 2 wait out the
   whole flow phase, because that phase is one `await`. The stop folds into
   `BudgetTracker.cancel()` so `isExhausted()` stays the SINGLE stop condition for the
   survey BFS, the flow queue and the Sentinel extra round (`canSurveyMorePages` gates
   on it too — it checks time, not `isExhausted`, so it needed its own guard).
   A cancelled run **still builds, saves and traces its partial output** (the browser
   and LLM spend is already sunk; discarding real test cases would punish stopping),
   keeps `status:'cancelled'` via `recordCancelledRunOutput` rather than being
   relabelled `completed`, and is **never charged** — that asymmetry is deliberate, so
   nobody lets a bad run burn its full budget to avoid an ambiguous charge. Like a
   resume, it refuses to fabricate a coverage score: the Sentinel never ran, so
   `coverageScore` stays undefined instead of reporting 0.
30. **The UNPLANNED tail is capped against the flow budget, and the entry-point
   count is reported in its two halves.** Measured on a real prod run
   (automationexercise.com, `scopeHint:"registration"`): 181 entry points discovered
   against `maxFlows: 30`, and the run produced brand-browsing tests instead of
   registration ones — 44% of its saved cases had ≤1 real action
   (`navigate → click → ai_check`, i.e. "the page loaded").
   **Cause:** `fromStrategyOutput` enqueued planned flows first and then EVERY
   unplanned entry point, so on a site discovering far more candidates than it can
   run, the tail consumed the slots the Strategist chose. `scopeHint` could not save
   it — the hint reaches four PROMPTS but no code path filters the queue, so it is
   advisory only.
   **Fix:** `opts.maxFlows` caps the unplanned tail at `UNPLANNED_BUDGET_SHARE`
   (0.3) of the budget. A cap, NOT a hard drop: the plan is an LLM output, and
   trusting it exclusively means one bad plan yields a near-empty suite. Applied at
   all three `fromStrategyOutput` sites (Phase 1.5, its targeted-survey rebuild, and
   the Sentinel's focused extra round — the focused round needs it for the same
   reason). **Skipped when the plan is EMPTY** (Strategist failed / returned
   nothing): every entry point is then "unplanned", and capping would discard the
   whole run rather than a tail. `queue.unplannedDropped` records the trim and the
   engine emits an `agent_warning` — a silently narrowed field is the exact
   invisible-degradation class this audit keeps finding.
   **Reporting:** `entryPointsDiscovered` stays (back-compat) but is now
   accompanied by `surveyEntryPoints` + `branchEntryPoints`. The sum was unreadable
   next to `pagesSurveyed` — "181 entry points / 2 pages" implies 90 per page, when
   the survey found 28 across those 2 and Scout contributed ~153 branch points
   DURING flows (`branchPointCount` is uncapped). Same total, but breadth-of-survey
   is now distinguishable from depth-of-exploration.
