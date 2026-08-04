# Phase 0 — Entry Preflight + Product Analyst

Status: **PROPOSED — not built.** No code written. Plan only.
Audited 2026-08-01 against clean `dev`. Every claim below carries a `file:line`
and was read in code (CONFIRMED) unless marked SUSPECTED.

Root problem this solves: the exploration agents jump straight to "enumerate
clickable things per page". Nothing in the web path knows what the product is
*for*, so everything defaults to `priority:'medium'`, test names come out
mechanical, Sentinel scores coverage against *discovered entry points* rather
than business need, and no assertion checks a business outcome.

Second problem, found while scoping: **every entry failure collapses into
"completed, 0 results, 10 credits charged."** Unreachable, bot-blocked,
login-walled, redirected off-domain and genuinely-empty are indistinguishable.

---

## 0. Ground truth — verified current behavior

### Entry failure modes

| Case | Today | File:line |
|---|---|---|
| No URL (REST) | 400, honest, no charge | `explorations.controller.ts:357-366` |
| No URL (chat) | Blocked by a generic `!hasUrl \|\| !hasScope` gate — not exploration-specific; also blocks a valid URL when scope is missing | `ai_test/handler.ts:372-396` |
| Stale fallback URL | Chat falls back to `sessionProject.settings.main_url`; the explicit-exploration path skips confirmation, so it can silently explore a stale URL | `ai_test/handler.ts:375`, `:649` |
| Bare domain `app.acme.com` | **REST rejects** (`new URL()` throws → "Invalid URL format"). Chat **accepts** (prepends `https://`). Asymmetric | `validation.ts:157,178` vs `chat/shared/utils.ts:19-41` |
| DNS / refused / TLS / 30s timeout | `return this.tree` (empty). **No throw.** No progress event, no trace warning | `survey-agent.ts:248-254` |
| 404 / 500 | `page.goto` resolves on any status → snapshotted and classified as a normal page | Playwright semantics |
| Empty tree → result | `status:'completed'`, `reason:'no_entry_points'` **only in the trace file** | `exploration-engine.ts:256-268` |
| Charge | Fires on that success path → **10 credits for a dead URL** | `exploration-run.job.ts:185-192` |
| Chat reply | "**Exploration Complete** — Explored **https://gogle** autonomously… Pages surveyed: 0" | `exploration-run.job.ts:204-215` |
| Retry | **Zero** retries for DNS/TCP/TLS. 429 gets 1 retry and **discards the computed `backoffMs`** | `survey-agent.ts:228-254`, `rate-limiter.ts:140` |
| Preflight probe | **None anywhere** (grepped `preflight|reachab|dns.lookup|isReachable`) | — |

### Confirmed bugs found while scoping (not part of the original audit)

- **SECURITY — chat path has no SSRF guard.** The chat exploration path never
  calls `sanitizeUrl` (grep over `src/api/chat/` returns nothing). It uses
  `normalizeUrl`, whose own comment says private IPs get `https://` and are
  "validated/blocked at a higher level if needed" — **for exploration there is no
  such higher level.** So no http/https allowlist and no
  `isBlockedSsrfHostname`. `chat/shared/utils.ts:32-33`, `ai_test/handler.ts:664`.
  Also note `isBlockedSsrfHostname` does **not** resolve DNS (`validation.ts:186-188`),
  so a hostname resolving to `10.x` passes even on the REST path.
- **Redirect kills BFS silently.** `isSameOrigin` compares against
  `config.entryUrl` (`survey-agent.ts:1061-1069`) while `checkDomainBoundary`
  deliberately accepts **either** origin (`domain-boundary.ts:97-99`). The two
  policies disagree. `acme.com → acme.io` means BFS seeds from the post-redirect
  URL but then rejects *every* link as off-origin → 1 page, 0 flows, charged.
- **`pageHealth` is dead code.** A DOM probe reads `[role="alert"], .error,
  .alert-danger, [class*="error-message"]` + `readyState` into a local
  (`survey-agent.ts:536-563`) and is **never passed** to
  `classifyWithCartographer` (the call at `:566-574` takes 7 args, none health).
  A free honest-status signal already on the floor.
- **Asymmetric visibility.** The *targeted* survey path surfaces failure as a
  `targeted_survey_failed` trace warning + `agent_warning` event
  (`exploration-engine.ts:358-368`). The **entry** URL has no equivalent.

### Reuse surface (do not rebuild)

| Need | Existing | Constraint |
|---|---|---|
| Ask the user a question | `ClarificationService.requestClarificationViaRedis` + web modal + skip sentinel | Type union is narrowed to `captcha_solve\|2fa_code\|test_data` (`clarification.service.ts:273`) — must widen for `'url'`/`'product_question'` |
| Same, in-process | `requestClarification` | **In-memory `Map`** (`:38`) — exploration runs in the **worker**, so unusable |
| Route the question | `emitExplorationClarification` already routes by `chatSessionId` **OR `userId`** (`websocket.service.ts:1081-1095`) | `requestClarificationViaRedis` never passes `userId` (`:92` only in the non-Redis variant) |
| REST path addressing | — | `chatSessionId` appears **zero times** in `explorations.controller.ts`; job payload at `:410-419` omits it. Frontend already filters on `explorationId` (`useExplorationSocket.js:316`), so routing by `userId` is the fix |
| Typed ask with choices | `type:'url'` + `options[]` + `required` + `timeout` precedent | `lite-engine.ts:3765-3773` |
| Brief storage | `exploration_runs.config` jsonb already selected (`explorations.controller.ts:267`) | No migration needed for v1 |
| Honest status precedent | `status` CHECK already allows `timed_out`/`cancelled` | `20260618_exploration_runs_terminal_status.sql` |
| Safe-by-construction brief shape | `normalizeMobileBriefing` — drops credential-ish fields, caps every field | `mobile-briefing.util.ts` |

---

## 1. Piece 1 — Entry Preflight (small, no LLM, ship first)

Fixes billing + honesty + a security hole. Piece 2 depends on its normalization
and reachability, so this lands first regardless.

**P1.1 — Normalize before validating.** Prepend scheme when absent so
`app.acme.com` works on REST as it already does in chat. Keep `sanitizeUrl`'s
protocol allowlist + SSRF guard. Single shared helper so the two paths stop
disagreeing.

**P1.2 — Close the chat SSRF hole.** Route the chat exploration path through the
same normalize→sanitize helper. Security fix; do not defer.

**P1.3 — Reachability probe before the credit gate.** Cheap HEAD/GET with a short
timeout, then classify:
`reachable | dns_failure | connection_refused | tls_error | timeout | http_error | bot_challenge | auth_required`.
Detect bot challenge from 403/503 + body markers (`rate-limiter.ts:157-161`
matches 429 only, so a Cloudflare interstitial is invisible today).
On a non-reachable classification: **return the error to the user and never
enqueue** → no charge, no false "completed".

**P1.4 — Make entry-nav failure throw.** In `SurveyAgent.survey()`, replace the
`return this.tree` early-returns (`survey-agent.ts:214-254`) with a typed
`EntryUnreachableError`. This is the **cheapest high-value change in the whole
plan**: the job's existing catch (`exploration-run.job.ts:249-273`) then does the
right thing for free — `failRun` with a real `error_message`, `status:'failed'`
on the WS, and because the rethrow precedes line 185, **no credit charge**.

**P1.5 — Retry transient failures.** Small bounded backoff for DNS/TCP/TLS/timeout
(cold-start apps on Render/Heroku exceed 30s). Also honor the `backoffMs` the
429 path already computes and currently throws away.

**P1.6 — Honest terminal statuses.** Add `unreachable` / `blocked_by_bot` /
`auth_required` / `no_content` to the status CHECK (migration follows the
`20260618` precedent) and surface `reason` in `result.summary` — today it exists
only in the trace. Fix the chat completion copy so 0 test cases never reads
"Explored … autonomously".

**P1.7 — Use `pageHealth`.** Pass the already-collected probe into Cartographer
and into the run summary. Free signal, currently discarded.

**P1.8 — Fix the redirect policy.** Make `isSameOrigin` accept the post-redirect
origin (align with `checkDomainBoundary`), and when the entry URL redirects
off-domain, surface it — ask for confirmation when the channel is available,
otherwise record it in the summary.

**Acceptance:** a typo'd URL, a dead host, a Cloudflare-blocked site and a
login-walled site each produce a **distinct** status, a **useful message**, and
**zero credits charged**. Exercised by unit tests per classification.

---

## 2. Piece 2 — Product Analyst (the actual feature)

New agent, runs **before** Phase 1 Survey. Recon → structured brief → shown
editable → consumed by Cartographer, Strategist, per-flow Planner, Sentinel.

**P2.1 — Recon pass.** Visit the entry URL plus a small fixed set of
high-signal targets (`/`, `/pricing`, `/about`, `/docs`, `sitemap.xml`,
`robots.txt`, footer links) and harvest structured evidence: OG tags, JSON-LD
schema.org, meta description, headings, nav, pricing/CTA copy, i18n/locale hints.
This is what today's `collectProductContext` (`survey-agent.ts:139-195`) should
have been — that one is regex-only, no LLM, Cartographer-only, and recomputed
per page.

**P2.2 — Detect product type first, then branch.** e-commerce / SaaS dashboard /
marketplace / fintech / content / booking / internal admin. The question
checklist and the risk profile differ per type; detecting first keeps the
checklist short.

**P2.3 — Answer a fixed question checklist (38 questions, 10 groups).** Identity &
purpose · users & roles · business-critical paths · money/conversion · data model ·
language/locale/vocabulary · risk & "must never break" · constraints/scope ·
test data · success criteria. Roughly **22 are inferable from evidence, 11 are
partial, 5–7 must be asked** — that asymmetry is the design: most of the brief is
*derived*, and the ask budget is spent only on what genuinely can't be.

Highest-value single field: **`criticalFlows`**. It replaces the hardcoded English
e-commerce heuristic at `strategist-prompts.ts:45` ("critical business flows
(login, checkout, registration)") with product-specific priorities. That one
substitution is most of the value of the whole phase.

Each field carries **source + confidence + basis** (`BriefField<T>`), and
`unknown` is representable — so downstream agents never treat a guess as fact.

**P2.4 — Ask only what it cannot infer, hard cap 4 questions, batched.**
Prioritize by `blastRadius × (1 − confidence) × consumerCount`, then: safety
pre-empts slot 1; max one question per group; never ask to double-check
something inferable (show it editable instead). **Zero questions is the target
outcome on the happy path.**

The canonical 4: (1) environment + payment policy as one multiple-choice —
uses the existing `options?: string[]` affordance (`clarification.service.ts:52`);
(2) critical-paths confirm-or-correct, pre-filled so "yes" is cheapest;
(3) which role the test account holds; (4) never-touch, pre-filled with inferred
candidates.

**Batch as ONE modal with one submit** — serializing 4 Redis clarification calls
is 4× the 2s poll latency plus 4 timeout chances (`MAX_RETRIES = 1`, 120s default
at `:156-158`, `:278`). Requires one new `ClarificationType: 'product_brief'`
carrying a ≤4-question payload. Skip is first-class via the existing
`CLARIFICATION_SKIP_SENTINEL` (`:22`) — a skipped question keeps its inferred
value or becomes `unknown`, and never blocks the brief.

**Ask budget is per-product-lifetime, not per-run:** persist per `projectId` +
origin, so a second exploration of the same product asks **zero** questions and
just shows "brief from {date} — still accurate?".

**P2.3b — Detect product type first, then branch.** Deterministic scorer with
LLM tiebreak, requiring **2+ independent signals** to claim a type (1 signal →
`'other'` with the guess recorded low-confidence). `marketplace` outranks
`ecommerce` when the dual-persona signal is present. Internal-admin is detected
largely by *absence* (blanket `Disallow: /`, no pricing, entry URL *is* a login)
— which is why `robots.txt` is fetch step 1.

Type doesn't change the questions much; it changes **the correct default per
question** and **which 4 to ask**. Examples: fintech → `paymentPolicy:'never'`,
assume production, all transfers in `mustNeverTouch`; marketplace → roles become
a *mandatory* ask (two-sided app is 2–3× what an anonymous crawl sees);
content/media → cap survey pages hard and treat article pages as one template;
internal admin → `mustNeverTouch` defaults to all deletes and bulk actions
(highest risk — real operational data).

**P2.3c — Evidence collection: 8 fixed cheap fetches, parallel, 30s total cap.**
`robots.txt` → `sitemap.xml` (the single highest-signal artifact — it *is* the
entity list) → rendered `/` with response headers + script/iframe hosts + JSON-LD
→ `/pricing` → `/about` → `/docs` → `/login` + `/signup` (render, never submit) →
`hreflang`/`og:locale`. 404s are signals, not errors (no `/pricing` + only "Book a
demo" ⇒ sales-led SaaS). Every collected string passes `redactCredentialValues`
before reaching the LLM — `/docs` pages frequently print demo credentials
verbatim (lite CLAUDE.md invariant #3). Sitemap URLs get path-segment
histogrammed, not pasted; raw evidence capped ~40k chars.

**P2.4b — Fail-closed safety, always.** `paymentPolicy`, `mustNeverTouch` and
`stopBeforeCommit` never derive an unsafe default: absent a `source:'user'`
grant, `paymentPolicy = 'never'` and every detected irreversible flow gets
`stopBeforeCommit: true`. **Low confidence must make the agent more
conservative, not more creative.** An over-broad prohibition costs a flow; a
missed one causes an incident (a run that emails 400 real customers).

**P2.4c — Uncertainty representation.** `source: 'unknown'` prints **nothing** in
the prompt rather than "Roles: unknown" — an LLM shown "unknown" invents; an LLM
shown nothing doesn't. Non-unknown fields print `[source, confidence — basis]`
inline, with explicit low-confidence and unknown sections. The normalizer
**downgrades any field claiming `observed`/`inferred` with no `basis` to
`confidence:'low'`** — evidence-or-it-didn't-happen, enforced in code, not in the
prompt. On unparseable LLM JSON, return an **all-`unknown` brief, not `null`**
(mirrors `parseCartographerResponse`'s catch at `cartographer-prompts.ts:318-337`):
one downstream path, and the review card still renders.

**P2.4d — Observation always wins over the brief.** If the brief says "no login"
and Cartographer finds one, the finding wins; log the divergence into
`openQuestions`. A stale brief must never suppress a live finding — the repo's
"trust the code" rule applied to product facts. Staleness detected via
`generatedAt` + an evidence fingerprint (hash of sitemap path-segment histogram +
nav labels); drift → re-infer the A-class fields, keep `source:'user'` fields,
re-ask nothing.

**P2.5 — Persist + show editable before Phase 1.** Store in
`exploration_runs.config` (no migration). **Non-negotiable:** a brief the user
never sees is a new silent-failure surface — a misread brief would poison every
downstream agent invisibly, which is exactly bug #2 from the audit. Persist
before Phase 1 so a resume never re-asks.

**P2.6 — Thread into the four consumers.** Cartographer (entry-point relevance),
Strategist (real priority instead of `medium`), per-flow Planner (**the one that
writes the steps — it currently receives no product context at all**), Sentinel
(score against business need, not entry-point count).

**P2.7 — Budget.** Phase 0 costs LLM calls. It must fit inside the existing
budget, and the `quick` preset's 2-minute wall clock cannot be consumed before
Phase 1 starts. Options: give Phase 0 its own small allowance, or run it only on
`full`. **Needs a decision.**

**Depends on:** the `pageInsights` wiring fix (audit bug #1) — the Planner has no
live context channel until `SurveyAgent` can write to the blackboard, so a brief
would have nowhere to land for the step-writing agent.

### Brief schema + consumer wiring

`ProductBrief` (v1, `schemaVersion: 1`). Safe by construction, modeled on
`normalizeMobileBriefing` (`mobile-briefing.util.ts:13-36`): the normalizer is a
**whitelist** that builds the object key-by-key, so extra keys on untrusted input
are dropped and the blob can **never become a credential sink** — by construction,
not by filtering. Every string trimmed+capped, every array capped with per-item
caps. Enums fall back safe (`productType→'other'`, `environmentKind→'unknown'`,
`paymentPolicy→'never'`). Plus a belt-and-braces `redactCredentialValues` pass over
`purpose`, `dataHints`, `glossary` and `basis` strings.

**Credentials never live here.** Test accounts ride `ExplorationConfig.credentials`
/ `authFixture` (`exploration/types.ts:66-82`) and the clarification answer seam;
on-page demo creds ride Cartographer's `authDetection.testCredentials`
(`cartographer-prompts.ts:281-288`). `paymentPolicy` carries the *policy* only —
never a card number.

Every field maps to a consumer through an **existing** seam — only one new
`ExplorationConfig.productBrief?` field is required:

| Consumer | Existing seam | Brief fields |
|---|---|---|
| Cartographer | `CartographerInput.productContext` (`agent-types.ts:173`), printed at `cartographer-prompts.ts:83-85` | `purpose`, `productType`, `entities`, `uiLanguages`, `region`, `glossary`, `mustNeverTouch`, `roles`, `errorSurfacePattern`. **Replaces** `collectProductContext()`, which demotes to one *evidence input* |
| Strategist | new `StrategistInput.brief` beside `scopeHint` (`strategist-prompts.ts:76-78`) | `criticalFlows` (ordering), `roles`+`testAccountRole` (auth plan), `outOfScopePaths`+`mustNeverTouch` (skips), `knownBlockers`, `testedSurface`, `paymentPolicy` |
| **Planner** | `PipelineConfig.pageInsightContext` → `setContextualHints` (`test-pipeline.ts:183-185`), built at `flow-runner.ts:662` | `dataHints`, matching `criticalFlows[].successSignal`, `stopBeforeCommit`, `mustNeverTouch`, `errorSurfacePattern`, `region`. Prepend a `BRIEF:` block — one-line change in `formatPageInsightContext` |
| Sentinel | new `SentinelInput.brief` near `scopeHint` (`sentinel-prompts.ts:68-70`) | `criticalFlows` (score against *these*, fixing the structural-only formula at `sentinel-prompts.ts:41-45`), `roles`, `riskProfile`, `openQuestions` (a gap from an unknown brief field is **not** a product gap) |

`openQuestions` is the contract with both the UI ("fix these first") and Sentinel
(report *"couldn't test seller flows — no seller account provided"* rather than a
product defect), and it seeds the next run's ask-4 — so a second exploration asks
about what actually hurt.

### Files to create (none exist yet)

`src/agent/core/lite/exploration/phase0/`: `product-brief.types.ts` ·
`product-brief.util.ts` (`normalizeProductBrief`) · `evidence-collector.ts` (the 8
fetches) · `product-analyst.ts` + `product-analyst-prompts.ts` ·
`brief-format.ts` (`formatBriefForPrompt`).

**Phase 0 must never fail the run** — on any failure return `undefined` and
proceed exactly as today (same posture as CLAUDE.md hard invariant #11 and
`collectProductContext`'s catch at `survey-agent.ts:189-194`).

---

## 3. Order

1. **Piece 1** (P1.1–P1.8) — billing + honesty + SSRF. Independently shippable.
2. **`pageInsights` wiring** (audit bug #1) — prerequisite for P2.6.
3. **Piece 2** (P2.1–P2.7).
4. **Deterministic assertions** (audit bug #11) — a brief tells you *what*
   matters; assertions are what actually verify it. Most valuable together.

## 4. DECIDED (2026-08-01, by the user)

- **Question cap = 3, asked ONLY when genuinely needed.** Not 4, and not
  infer-only: the agent *may* ask, but must earn each question. Ranking stays
  `blastRadius × (1 − confidence) × consumerCount` with the safety pre-empt, just
  truncated to 3 — and **zero questions remains the target outcome** whenever the
  evidence is strong enough. An A-class (inferable) field must never consume a slot;
  show it editable instead.
- **Phase 0 runs on the `full` preset ONLY.** `quick` is 2 min *total* and is the
  self-serve onboarding path, where time-to-first-test beats product understanding —
  Phase 0 would eat the budget before Phase 1 starts. So no separate allowance and no
  degrade mode is needed: on `quick`, Phase 0 is skipped entirely and exploration
  behaves exactly as it does today. This also bounds the blast radius of the whole
  feature to one preset.

## 5. Still open

- **Brief scope:** project-scoped and reused across runs (a web `AppSkeleton`
  equivalent, which is what makes the ask budget per-lifetime) vs per-run?
  Mobile's `AppSkeletonService` is hard-scoped to `mobile_android|ios|flutter`
  (`db/app-skeleton.db.ts:9`). Reuse is what delivers "second run asks nothing".
- **Where the review card lives** — chat surface, the exploration start screen, or
  both. Determines whether REST-initiated runs can show it at all.

## 6. Out of scope

Mobile exploration (user: "web first, mobile later"). The audit's other 19 bugs
are tracked separately in memory `web-exploration-audit.md`.
