# `exploration/phase0/` — Product Analyst

> Builds the `ProductBrief` that gives the exploration agents product
> understanding. Runs BEFORE Phase 1 Survey. Parent map:
> [../../CLAUDE.md](../../CLAUDE.md). Design:
> [phase0-product-analyst-plan.md](../../../../../docs/development/phase0-product-analyst-plan.md).

| File | Purpose |
| --- | --- |
| [product-brief.types.ts](product-brief.types.ts) | `ProductBrief` + `BriefField<T>` (source / confidence / basis). |
| [product-brief.util.ts](product-brief.util.ts) | `normalizeProductBrief` — the SINGLE validation boundary. |
| [evidence-collector.ts](evidence-collector.ts) | 8 cheap HTTP fetches (no browser); sitemap → path-segment histogram. |
| [product-analyst.ts](product-analyst.ts) · [product-analyst-prompts.ts](product-analyst-prompts.ts) | The agent + its prompt. |
| [brief-format.ts](brief-format.ts) | ONE renderer, four consumer slices. |
| [brief-questions.ts](brief-questions.ts) | Picks the ≤3 questions worth asking; folds answers back in. |

24. **Phase 0 is `full`-preset only and must NEVER fail a run.** Gate via
   `isQuickPreset` (single source — never an inline string compare); `quick` is 2 min
   TOTAL and is the onboarding path, where a phase spending 30s before Phase 1 is
   worse than no phase. Every failure is a NAMED skip (`quick_preset`, `no_evidence`,
   `ai_failed`, `unparseable`, `no_signal`) that is logged AND traced — a silent skip
   would recreate the audit's "degradation nobody can see" class. `preset` is
   carried explicitly from the controller (`ExplorationJobData` → `ExplorationConfig`)
   because it used to be resolved to a budget and discarded; **`undefined` means NOT
   quick**, since the chat producers pass no budget and get the full defaults.
25. **`normalizeProductBrief` is the ONLY validation boundary for the brief.** A
   WHITELIST that rebuilds key by key, so an extra key is dropped rather than
   filtered — the brief can never become a credential sink (same discipline as
   `normalizeMobileBriefing`). It enforces, in code and not in the prompt:
   fail-closed `paymentPolicy` (**`allowed_sandbox` is downgraded unless
   `source:'user'`** — an LLM deciding a hostname "looked like staging" would
   otherwise place real orders); `stopBeforeCommit` forced on any non-user critical
   flow; `confidence:'low'` for any observed/inferred claim with no `basis`; and an
   all-`unknown` brief instead of `undefined` on garbage, so downstream has ONE path.
   The prompt parser deliberately does NO field validation, so the two cannot drift.
26. **An `unknown` brief field prints NOTHING in a prompt.** Not "Roles: unknown",
   not an empty list — an LLM shown "unknown" invents, an LLM shown nothing does not
   reason about it. Low-confidence fields are LABELLED so the model can discount
   them; `mustNeverTouch` prints even when inferred (an over-broad ban costs one
   flow, a missed one emails real customers). All four slices live in
   `brief-format.ts` — do not hand-roll a fifth renderer.
27. **`checkSsrfHost` is the single resolve-then-check guard.** Extracted from
   `entry-preflight` when the evidence collector needed it too (~8 URLs derived from
   the target site). `isBlockedSsrfHostname` is a STRING check that does not resolve
   DNS, so `evil.example.com → 10.0.0.5` needs this. Both callers follow redirects
   MANUALLY and re-check every hop.
28. **Max 3 questions, asked only when the evidence structurally cannot answer.**
   Product decision, not a knob. `planBriefQuestions` ranks
   `blastRadius × (1 − confidence) × consumerCount`, truncates to
   `MAX_BRIEF_QUESTIONS`, and puts the environment/payment question in slot 1
   whenever an irreversible surface exists. A field the analyst already answered
   confidently, or that a user answered, is NEVER re-asked — showing it in the
   editable card is free, a question is not. **Zero questions is the target
   outcome.** `hasIrreversibleSurface` deliberately ignores `stopBeforeCommit` on
   USER-sourced flows: the normalizer sets that flag on every non-user flow as a
   precaution, so counting it would ask a blog whether it takes payments.
29. **A user answer becomes `source:'user'` + `confidence:'high'`** — the user IS
   the evidence, which is why the normalizer exempts user values from the
   basis-required downgrade. `allowed_sandbox` is reachable ONLY this way. Naming a
   critical flow is **not** permission to complete it: `applyBriefAnswers` keeps
   `stopBeforeCommit: true` on user-listed flows, since only the environment/payment
   answer grants that. A skipped question leaves the derived value untouched and is
   recorded in `askLog`, and asking STOPS after the first skip.
30. **Asking works without a chat session.** `requestClarificationViaRedis` takes
   `chatSessionId` OR `userId` (the emit already routed to both; only the signature
   required a chat session), because REST `/explorations/start` has none — the web
   client filters on `explorationId`. With neither, it returns null immediately
   rather than blocking for the full timeout on a question nobody was asked.
   Frontend: `product_brief` is in the modal's KNOWN list and maps onto the existing
   choice/text rendering — without that it fell through to the CAPTCHA layout and
   told the user to solve a captcha that does not exist.
