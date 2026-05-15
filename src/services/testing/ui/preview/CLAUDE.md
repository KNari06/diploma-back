# Editor / Preview / Replay / Recording

> Hot zone of the project. Live browser sessions, step recording, replay execution, element resolution, auto-healing.
> Most production bugs land here. Read this whole file before changing anything in this folder.

**Parent map:** [project root CLAUDE.md](../../../../../CLAUDE.md)

---

## What this folder owns

Three connected products on top of one Playwright session:

1. **Preview session** — long-lived browser owned by the API process. User sees a live video and can click/type into the page through WS.
2. **Recording** — every interaction (mouse, keyboard, navigation) is captured and persisted as `IntentStep` rows.
3. **Apply / Run / Replay** — execute one step (`apply`) or all steps (`run`) on the live preview, OR run them headlessly in a fresh browser (background replay / regression — that lives in [src/jobs/manual-test-run.job.ts](../../../../jobs/manual-test-run.job.ts) and uses services here).

Element resolution and auto-healing serve all three.

---

## File map

> Detailed per-method API references live in [`api/`](api/). Each row in the core table links to its API doc.

### Core services (ordered by importance)

| File | API doc | Purpose |
|---|---|---|
| [preview-session.service.ts](preview-session.service.ts) | [api/preview-session.md](api/preview-session.md) | Browser/page/session lifecycle. Owns Playwright `BrowserContext` per user. Snapshot throttling (500 ms), TTL (30 min), cleanup. |
| [preview-step-apply.service.ts](preview-step-apply.service.ts) | [api/preview-step-apply.md](api/preview-step-apply.md) | Execute a single step. Plan building, readiness wait, action, post-verify, fake-success guard. |
| [preview-run.service.ts](preview-run.service.ts) | [api/preview-run.md](api/preview-run.md) | Apply All / Run from start. Sequential loop, cancel, force-cancel on session stop, LLM diagnosis on fail. |
| [recording-capture.service.ts](recording-capture.service.ts) | [api/recording-capture.md](api/recording-capture.md) | Browser events → `IntentStep`. `PROBE_AT_POINT_FN`, field sessions, scroll merge, drag-drop. |
| [element-resolver.service.ts](element-resolver.service.ts) | [api/element-resolver.md](api/element-resolver.md) | LLM element selection + vision rescue. 5-stage waterfall. Apply rules 1–18. |
| [intent-step-lint.service.ts](intent-step-lint.service.ts) | [api/intent-step-lint.md](api/intent-step-lint.md) | Wraps resolver. Candidate scoring, ambiguity detection, clarification flow, degraded-mode fallback. |
| [locator-plan-builder.service.ts](locator-plan-builder.service.ts) | [api/locator-plan-builder.md](api/locator-plan-builder.md) | Compiled fallback chain (role → testId → label → placeholder → text → css). `ref` excluded for replay. |
| [step-readiness.service.ts](step-readiness.service.ts) | [api/step-readiness.md](api/step-readiness.md) | 7-layer pre-action readiness — challenge, nav race, loaders, API idle, animation, overlay, element state. |
| [dom-analysis-extractor.service.ts](dom-analysis-extractor.service.ts) | [api/dom-analysis-extractor.md](api/dom-analysis-extractor.md) | Page → `InteractiveNode[]`. Symmetry partner of `PROBE_AT_POINT_FN`. |
| [../../../../websocket/handlers/preview.handler.ts](../../../../websocket/handlers/preview.handler.ts) | [api/preview-handler.md](api/preview-handler.md) | All `preview:*` WS events — recording, mouse/keyboard, navigation, apply, devtools, video. |
| [intent-test-case.service.ts](intent-test-case.service.ts) | — | CRUD for intent test cases (steps + metadata). Import/export. |
| [intent-step-converter.service.ts](intent-step-converter.service.ts) | — | `IntentStep` ↔ Playwright commands (used by background replay). |
| [snapshot-router.service.ts](snapshot-router.service.ts) | [api/snapshot-router.md](api/snapshot-router.md) | (Etap 2) Routes snapshot collection between legacy `evaluate` and CDP path. `useCdpForPreviewPoll` flag added; dense-gate removed. |
| [cdp-snapshot.service.ts](cdp-snapshot.service.ts) | [api/snapshot-router.md](api/snapshot-router.md) | (Etap 2 / WIP) CDP-based snapshot pipeline — skeleton, most phases TODO. |
| [snapshot-diff.util.ts](snapshot-diff.util.ts) | [api/snapshot-router.md](api/snapshot-router.md) | Shadow-mode validator: field-level diff between evaluate and CDP snapshots. Boolean-falsy normalization added. |
| [candidate-pruner-llm.service.ts](candidate-pruner-llm.service.ts) | [api/candidate-pruner-llm.md](api/candidate-pruner-llm.md) | LLM pre-filter: narrows ~60 candidates to ~15 before resolver. Fail-open, identity-rescue, cross-script matching. |
| [step-readiness-v2.service.ts](step-readiness-v2.service.ts) | [api/step-readiness-v2.md](api/step-readiness-v2.md) | Smart waiter V2: 3-level readiness (existence→actionability→identity) with soft-escape at 70% budget. Shadow mode via `runV1WithShadow`. |

### Supporting services

| File | Purpose |
|---|---|
| [html-context.service.ts](html-context.service.ts) | Builds compact page-structure context (scene summary) for LLM prompts. |
| [preview-video-stream.service.ts](preview-video-stream.service.ts) | CDP screencast for live video. Owns the **screencast** CDP session — do NOT piggyback `CdpSnapshotService` on it (100% freeze measured). |
| [preview-devtools-collector.service.ts](preview-devtools-collector.service.ts) | Console / Network / HTML / Accessibility tabs in the editor. |
| [editor-trace.service.ts](editor-trace.service.ts) | JSONL traces for every step capture/apply. Used for postmortem debugging. |
| [editor-trace-upload.ts](editor-trace-upload.ts) | Upload trace bundles to storage when user reports a problem. |
| [auth-detector.ts](auth-detector.ts) | Detects login walls / auth-required state. Emits `preview:auth:required`. |
| [step-blocker-diagnosis.service.ts](step-blocker-diagnosis.service.ts) | LLM-driven "what's blocking this step?" used as a retry hint. |
| [step-telemetry-collector.service.ts](step-telemetry-collector.service.ts) | Per-step metrics aggregation. |
| [ai-check.service.ts](ai-check.service.ts) | AI-driven assertion (`check:*` step types). |
| [draft-steps-cache.ts](draft-steps-cache.ts) | In-memory cache for unsaved draft steps. |
| [external-nav-trap.ts](external-nav-trap.ts) | Catches navigations to unrelated origins (treats as fake-success signal). |
| [evidence-shortcut.utils.ts](evidence-shortcut.utils.ts) | Cached "this evidence already worked" shortcut to skip resolver. |
| [auto-wait-for.utils.ts](auto-wait-for.utils.ts) | Inject `wait:*` synthetic steps before slow actions. |
| [page-interactive.utils.ts](page-interactive.utils.ts) | "Is page interactive yet" heuristic. |
| [text-normalizer.util.ts](text-normalizer.util.ts) | Unicode/whitespace normalization for label matching. |
| [implicit-role.util.ts](implicit-role.util.ts) | Maps `<button>`, `<a href>` etc. to ARIA roles. |
| [dynamic-id.util.ts](dynamic-id.util.ts) | Detects framework-generated IDs (`el-id-`, `radix-`, `:rN:`, `mui-`, UUID, …) — skipped in fingerprints. |
| [intent-resolve-audit.ts](intent-resolve-audit.ts) | Audit log for resolver decisions: `logIntentResolveApply`, `logIntentResolveLint`, `buildChosenSnapshot`. Fire-and-forget JSONL to `logs/intent_resolve.log`. |
| [failure-collector.service.ts](failure-collector.service.ts) | Builds `StepFailureEvidence` bundle when apply exhausts all strategies. Called only from `_buildFailureResult()` in preview-step-apply. |
| [recorded-description-llm.service.ts](recorded-description-llm.service.ts) | Generates natural-language element descriptions at record time via LLM (`generateRecordedDescription`). Cached; fail-open (returns undefined). Used as a soft hint by the resolver. |
| [preview.types.ts](preview.types.ts) | All shared types: `IntentStep`, `ProbedElement`, `BindingHints`, `LocatorPlan`, WS payloads, trace events. |
| [index.ts](index.ts) | Barrel export. |

### Sibling — `wait-phases/` (used by `step-readiness.service.ts`)

| File | Phase |
|---|---|
| [../wait-phases/navigation.ts](../wait-phases/navigation.ts) | Wait for navigation race / `load` event. |
| [../wait-phases/dom-settle.ts](../wait-phases/dom-settle.ts) | MutationObserver — animation-aware DOM idle. |
| [../wait-phases/element-state.ts](../wait-phases/element-state.ts) | Element visible/enabled/in-viewport. |
| [../wait-phases/hover-effect-settle.ts](../wait-phases/hover-effect-settle.ts) | Wait for hover-induced reflow. |
| [../wait-phases/overlay-modal.ts](../wait-phases/overlay-modal.ts) | Detect blocking overlays. |
| [../wait-phases/post-action-verify.ts](../wait-phases/post-action-verify.ts) | Click-effect verification (URL change, focus, new node, …). |
| [../wait-phases/action-specific.ts](../wait-phases/action-specific.ts) | Per-action calibration (type vs click vs hover). |

### API surface

| File | Routes |
|---|---|
| [../../../../api/preview/preview.route.ts](../../../../api/preview/preview.route.ts) | Mounts everything under `/api/v1/preview`. |
| [../../../../api/preview/preview.controller.ts](../../../../api/preview/preview.controller.ts) | Session CRUD, step list/save, run trigger. |
| [../../../../api/preview/draft.controller.ts](../../../../api/preview/draft.controller.ts) | Save draft run as test case. |
| [../../../../api/preview/upload.controller.ts](../../../../api/preview/upload.controller.ts) | Trace / screenshot uploads. |
| [../../../../api/preview/quick-action-endpoints.ts](../../../../api/preview/quick-action-endpoints.ts) | One-shot quick actions. |

### WebSocket

| File | Purpose |
|---|---|
| [../../../../websocket/handlers/preview.handler.ts](../../../../websocket/handlers/preview.handler.ts) | All `preview:*` events — recording, mouse/keyboard, navigation, apply, devtools, video. |
| [../../../../websocket/handlers/preview-input-helpers.ts](../../../../websocket/handlers/preview-input-helpers.ts) | Mouse/keyboard event normalization. |

---

## WebSocket events (canonical list)

### Client → Server
| Event | Trigger |
|---|---|
| `preview:recording:start` / `:stop` | User toggles recording |
| `preview:keyboard:type` | Buffered, debounced 1500ms |
| `preview:mouse:click` / `:down` / `:up` | Pointer interaction |
| `preview:mouse:wheel` | Debounced 500ms, merge window 3000ms |
| `preview:step:lint` | Live lint a step against current page |
| `preview:step:clarify:select` | User picks from candidate elements |
| `preview:step:apply` | Run one step on the live preview |
| `preview:run:start` / `:cancel` | Run all steps |
| `preview:page:navigate` / `:refresh` / `:back` / `:forward` | Page nav |
| `preview:tab:switch` / `:close` | Tab control |
| `preview:html:request` / `:accessibility:request` / `:network:list:request` / `:network:detail:request` | DevTools tabs |
| `preview:apply-resource` / `:save-login` | Test resources (auth fixture apply) |

### Server → Client
| Event | Meaning |
|---|---|
| `preview:recording:step:capture` | New step recorded |
| `preview:recording:step:update` | Existing step edited (typing continues, scroll merged) |
| `preview:recording:step:remove` | Step removed (e.g. typing field session ended with no change) |
| `preview:recording:state` | `{ recording: boolean, reason? }` |
| `preview:page` | DOM snapshot update (throttled 500ms, only on change) |
| `preview:video:stream` | CDP screencast frame |
| `preview:lint:result` | Resolved candidates + confidence |
| `preview:step:apply:result` | Apply success/fail + evidence |
| `preview:run:progress` / `:complete` | Run loop status |
| `preview:auth:required` | Login wall detected |

---

## Hot flows in detail

### Recording — typing field session
```
preview:keyboard:type (first key on a focused input)
  → openFieldSession() — store input ref, capture initial value
  → buffer additional keys in memory (no events emitted)
  → blur OR click elsewhere OR navigation
  → closeFieldSession()
      reads live input.value (canonical, not buffered string)
      emits ONE Type step
  → if value unchanged: emit preview:recording:step:remove instead
```
The buffered-keys path is legacy fallback for inputs without focus/blur events.

### Recording — mouse click
```
preview:mouse:click (clientX, clientY)
  → page.evaluate(PROBE_AT_POINT_FN, x, y)
      walks elementsFromPoint cursor:pointer chain
      resolves wrapper → icon child if click landed on wrapper border
      returns ProbedElement: tag, id, testIdAttr, role, text, ariaLabel,
                              fingerprint (stable hints), bindingHints
  → captureStep('click', probed, contextSnapshot)
  → emit preview:recording:step:capture
  → write to editor trace
```

### Apply single step
```
preview:step:apply(stepId)
  → PreviewStepApplyService.applyStep()
    1. validate ownership + step shape
    2. if no compiled plan → LocatorPlanBuilder.buildCompiledPlan()
    3. waitForStepReadiness(prevAction, currentUrl) — 7 layers
    4. resolveElement():
         a. identity fast-path: id / testId / name match + uniqueness gate
         b. evidence shortcut: cached "this hint worked before"
         c. compiled plan: try each strategy in order
         d. LLM resolver (Gemini Flash + page snapshot + scene summary)
         e. vision rescue (screenshot + LLM)
         → returns Locator + resolverPath label
    5. Playwright action (click/fill/select/hover/...)
    6. post-action verify — click-effect signals (URL, focus, new node, newtab, ...)
       fake-success guard: weak signal + fingerprint mismatch + ground truth → FAIL
    7. update step.evidence: lastSuccessRef, bindingHints
  → emit preview:step:apply:result
```

### Apply All (Run from start, live preview)
```
preview:run:start
  → PreviewRunService.runSavedSteps()
    - guard: only one run at a time per session
    - stop active recording (reason='run-start')
    - injectAutoWaitForSteps() prepends wait:* before slow actions
    - loop steps:
        waitForStepReadiness → applyStep → emit progress
        on fail: stepBlockerDiagnosis (LLM) → suggested wait → retry once
        on timeout: break, emit complete with partial result
    - persist final state (batch compile plans for steps that gained one)
  → emit preview:run:complete
```
Timeout: `min(15min, 60s + 15s × steps)`.

### Background replay (regression / scheduled)
```
BullMQ enqueue (manual-test-run.job.ts)
  → fresh BrowserContext (NOT the live preview session)
  → IntentStepConverter → Playwright commands
  → executePlaywrightTestWithRetry (waitUntil: 'load' everywhere)
  → on auth wall: apply login resource (if bound)
  → post-run: ai-analysis.job.ts for bug detection
```

---

## Element resolution (3-stage waterfall + auto-heal)

```
buildAllowedSets(snapshot, intent)
  → HardAllowed: visible, role/tag matches action type
  → SoftAllowed: rest, with penalty hints

(0) Identity fast-path
    if recordedFingerprint has id/testId/name AND it's unique on page → use it.
    → resolverPath = 'identity_id' | 'identity_testid'

(1) Evidence shortcut
    if step has lastSuccessRef and that node is still findable → use it.
    → resolverPath = 'evidence_shortcut'

(2) Compiled plan
    iterate role → testId → label → placeholder → text → css.
    → resolverPath = 'compiled'

(3) LLM resolver (Gemini Flash)
    input: intent text, action type, candidates (top-K), scene summary.
    rules 1–18 in apply prompt: no loudest-CTA fallback, slug intents,
    adjacency≠function, etc.
    → resolverPath = 'llm'

(4) Vision rescue
    take screenshot, send to vision LLM with click target hints.
    → resolverPath = 'vision'

If apply fails after action: auto-heal path
    rebuild locator chain with current candidates.
    if upgraded (more diverse strategies) → use it.
    else → fall back to fingerprint hints + LLM vision.
```

**See also:** [.claude/rules/wrong-element-debugging.md](../../../../../.claude/rules/wrong-element-debugging.md) — the diagnostic order for "wrong element clicked" bugs. Walk through it before blaming the LLM.

---

## Invariants (must hold)

1. **Recording ↔ Run mutual exclusion.** `PreviewRunService.isRunning()` blocks new captures. Starting a run stops recording.
2. **WS handler must always respond.** Even on validation failure, emit a `:result` with `{ error }`. No silent returns.
3. **CDP sessions — measured trade-off (Etap 2, May 2026).** `preview-video-stream.service.ts` owns the screencast session — never piggyback on it (`existingCdpSession` != screencast session; piggyback causes 100% video freeze, empirically measured). `CdpSnapshotService` opens its **own** session and detaches in `finally` — this is allowed and causes only brief FPS drop (~11 FPS during dense snapshot, recovers immediately). For DevTools/a11y outside Etap 2 still use `page.accessibility.snapshot()` / `page.content()`. Calling `Accessibility.enable` on any session in preview still freezes video. See [critical-patterns.md](../../../../../.claude/rules/critical-patterns.md) §2.
4. **`waitUntil: 'load'` everywhere in apply/run/replay.** Don't introduce `domcontentloaded`.
5. **Recorder probe and snapshot collector must use the same criteria.** If the recorder captures an element, the resolver must be able to see it. Symmetry break = wrong-element bug. Both sides use the same dynamic-id regex (`dynamic-id.util.ts`) and the same Tier-1/Tier-2 selection rules.
6. **`node.id` and `node.testIdAttr` must be populated by the collector** (not just declared on the type). They drive the identity fast-path.
7. **Field sessions are single-shot.** One focus→blur cycle = one Type step, with `input.value` as canonical content.
8. **Lookahead before action, not after.** `waitForStepReadiness` runs before the click, not after. Otherwise we click the stale node and wait for the new one to appear.
9. **`CSS.escape()` when interpolating IDs.** React 18 `useId()` produces colons.
10. **Fake-success guard:** post-click `weak signal (focus/none/newtab) + fingerprint mismatch + has ground truth` → mark as FAIL, don't claim success. Layer at `preview-step-apply.ts`.
11. **`{{key}}` interpolation uses the unified helper** [`src/utils/interpolation/resolve-placeholders.ts`](../../../../utils/interpolation/resolve-placeholders.ts). Three callers (`preview-step-apply`, `preview-run`, background `test-executor`) read from the same `[scratchpad → runVariables]` source order. `runVariables` is plumbed via `PreviewSession.contextRunVariables` (populated by `preview:apply-resource` for environment/secret/fixture kinds). Adding another variable namespace = one more `VariableSource`, never another regex. Selectors / `elementDescription` are NOT interpolated — keep it that way.
12. **`secrets.*` values must never leak after interpolation.** Sinks already wired: `command-executor` log, replay-trace JSONL (`ReplayTraceWriter.setRedactValues`), editor-trace JSONL (provider in `EditorTraceService.getOrCreate`), `intent-resolve-audit` (`secretValues` param), WS `preview:step:apply:result` and three `preview:run:step` emits, `runtimeMeta` in `emitTestStepCompleted`. `preview-run` rewinds the persisted `appliedStep` back to its placeholder shape via `preserveOriginalStep` so DB rows store `{{secrets.X}}`, not the resolved value. `session.contextRunVariables` is cleared on `resetSession`. When you add a new emit / log / persist site carrying step bodies, plumb a redactor — see redact-step.md or use `executor.redactString` / `buildStepRedactor`. Snapshot semantics: redaction lists are captured ONCE per run; mid-run resource reapply needs an explicit refresh.

---

## Common pitfalls

- **`nodemon` cache.** New diagnostic logs / new trace fields not appearing? Restart: `lsof -ti:3000 | xargs kill -9; rm -rf node_modules/.cache; npm run dev`.
- **Adding a new field to `InteractiveNode` type but not populating it in the collector** = silent no-op repo-wide. Always check both type and `elements.push({...})` site.
- **Collector filter too narrow.** SVG/icon/role-less custom components can fail Tier-1 selectors and need Tier-2 cursor:pointer detection. Don't make Tier-2 require text — icons have none.
- **Tweaking the LLM prompt without checking if the target is in the candidate set.** The prompt cannot pick what it doesn't see. Diagnostic order: `step_start.recordedId` → `step_result.resolverPath` → `[ELEMENT_RESOLVER] identity fast-path diag.idMatch`. See the wrong-element-debugging rule.
- **`clickEffectSignal: 'newtab'` ≠ success.** Popup to an unrelated domain is the canonical fake-success symptom — let the guard fail it.

---

## Tests

`__tests__/` next door:
- `element-resolver.test.ts` — resolver path coverage
- `intent-step-lint.service.test.ts` — candidate scoring
- `preview-run.service.test.ts` — run loop, cancel
- `preview-step-apply.helpers.test.ts` — small helpers
- `preview-session-recording-state.test.ts` — recording lifecycle
- `recording-capture.service.test.ts` — probe, field sessions
- `step-readiness.service.test.ts` — 7-layer wait
- `html-context.service.test.ts` — scene summary
- `auto-wait-for.utils.test.ts` — wait:* injection
- `hover-highlight.test.ts` — hover overlay
- `ai-check.service.test.ts` — AI assertion
- `v22-pkg-smoke.test.ts` — V22 field-session smoke

Run a single one:
```bash
npx jest --testPathPattern="element-resolver" --no-coverage
```

---

## Recent baselines (versioned milestones)

- **V22 Pkg8** — Field Sessions for typing
- **V14** — 7-layer Step Readiness
- **V8** — Element Resolver with vision rescue + identity fast-path
- **April 2026 Editor Audit** — auto-healing 20s timeout, evidence shortcut, scroll retry, smart waits (third-party API filtering, MutationObserver animation filter), container scroll detection, compiled-shortcut skip after first failure / URL mismatch
- **April 28 2026 wrong-element fix** — snapshot collector Tier-2 widened to accept icon-only nodes, `node.id` / `node.testIdAttr` populated, identity fast-path landed, fake-success guard, LLM rules 16–18 across all 4 resolvers

If you find a behavior that contradicts what's written here, the milestone may have shifted — check `git log -p` on the relevant file before trusting this doc.
