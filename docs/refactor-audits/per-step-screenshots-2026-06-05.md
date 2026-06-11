# Refactor & test audit — per-step screenshots (regression)

qai-backend · 2026-06-05 · audited 11 files (~7,070 lines, of which ~330 are net-new for this feature)

> Plan-only audit of the recently-added per-step screenshot feature (web + mobile regression replay capture a screenshot after every step → upload as URL → surface in the run report → prune via a nightly retention job). No code was changed. Five dimensions audited in parallel: architecture/layering, duplication, cohesion/size, dependency-direction, test-coverage.

## Scope

| File | Lines | Feature delta |
|---|---|---|
| src/config/features/screenshot-capture.ts | 46 | NEW |
| src/jobs/artifact-retention.job.ts | 193 | NEW |
| src/services/storage/test-artifacts-storage.service.ts | 1004 | +119 (encode/upload/path helpers) |
| src/agent/playwright/artifacts/artifacts-handler.ts | 344 | +43 (captureStepScreenshot) |
| src/agent/playwright/core/test-executor.ts | 2564 | +29 (replay-loop capture + 4 meta sites) |
| src/jobs/mobile-test-run.job.ts | 1655 | +66 (uploadStepScreenshots + append meta) |
| src/scheduler/index.ts | 84 | +12 (register job) |
| src/services/testing/regression/regression-report-assembler.service.ts | 649 | +20 (surface stepScreenshotUrl) |
| src/services/testing/results/test-executed-steps-redis.service.ts | 384 | +1 (reducer whitelist) |
| src/jobs/__tests__/artifact-retention.job.test.ts | 80 | NEW test |
| src/services/storage/__tests__/step-screenshot-encode.test.ts | 67 | NEW test |
| (types) testing.types.ts / preview.types.ts / websocket/types/types.ts | — | +stepScreenshotUrl field |

## Findings (ranked)

| # | Area | Sev | File:line | Issue | Rule | Proposal | Effort/Risk |
|---|------|-----|-----------|-------|------|----------|-------------|
| 1 | cohesion/arch | High | test-artifacts-storage.service.ts:281 | Feature pushed an already-large file to 1004 lines (~2.5× the ~400 guide) by adding 4 step-screenshot fns without splitting first | architecture.md "never add to oversized file — split first"; reviewer.md BLOCK "file grew past ~400 without extracting a named concern" | Extract `src/services/storage/step-screenshot.service.ts` (buildStepScreenshotPath, encodeStepScreenshot, processAndUploadStepScreenshot, uploadStepScreenshotToStorage). Seam: bulk filesystem-artifact upload (video/trace) stays; in-memory step-screenshot encode/upload moves | S / low |
| 2 | architecture | High | mobile-test-run.job.ts:1298 | `uploadStepScreenshots` is a private static on the job handler — base64 decode + concurrency loop + upload orchestration = domain logic on a job | reviewer.md BLOCK "job handler contains domain logic instead of delegating" | Move into the new step-screenshot.service.ts as `uploadMobileStepScreenshots(steps,testId,userId)`; job calls the service. Folds into #1 | S / low |
| 3 | architecture | High | artifact-retention.job.ts:19,109 | Job imports `supabaseAdmin` directly and inlines the storage walk (list/recurse/remove) | reviewer.md BLOCK "service imports supabaseAdmin directly" + "job handler contains domain logic" | Delegate storage I/O to a service/db helper (see #4). NOTE: pre-existing pattern — AccountDeletionPurgeJob does the same; team should decide if sweep jobs are an explicit exception | S / low |
| 4 | duplication | High | artifact-retention.job.ts:109 ↔ account-deletion.service.ts:646 | `pruneOldFiles`/`listFolders` BFS walk is structurally identical to the inline `purgePrefix` closure (paginate → file/folder split → recurse → bulk remove); differs only by a cutoff filter | invariant #8 DRY; critical-patterns §5 | Extract `src/utils/storage/storage-prefix-walker.ts` → `walkStoragePrefix(bucket, prefix, { maxDepth, pageSize, filter })`. Retention passes a cutoff filter; account-deletion passes none. Unblocks unit-testing both | M / low |
| 5 | test | High | regression-report-assembler.service.ts:391 | The core routing decision — stepScreenshotUrl → `screenshots[]` (NOT `bugScreenshots[]`), deduped — has zero tests. Wrong bucket = screenshots vanish or land in the wrong tab | testing.md "service business logic, stub db/ layer" | Add cases to the EXISTING `regression-report-assembler.test.ts` (harness verified present). ~10 lines, no new infra | S / low |
| 6 | test | High | artifacts-handler.ts:142 | `captureStepScreenshot` never-throws / dev-skip / null-page / fullPage-on-fail contracts untested | testing.md; invariant "must not fail the test path" | New `artifacts-handler.test.ts`: fake Page records screenshot opts, mock storage import + isDevelopment | M / low |
| 7 | duplication/correctness | Med | test-executor.ts:150,153 | **Bucket split-brain (verified):** `captureBugScreenshot` hardcodes bucket `'test-artifacts'`; step/video/trace use `env.SUPABASE_BUCKET_NAME` (default `qai-assets`). Retention job + assembler only know `qai-assets`, so bug screenshots are in an unpruned bucket | invariant #8 DRY; consistency (judgment call) | VERIFY both buckets exist in Supabase. If one is canonical, route captureBugScreenshot through the storage service (env-driven). Largely PRE-EXISTING — feature made the divergence more visible by adding a 3rd, differently-bucketed path. There is also a literal `'traces'` bucket in playwright.controller.ts:150 | S / med |
| 8 | dependency | Med | test-artifacts-storage.service.ts:2 | Storage primitive imports `ScreenshotCaptureFeature` to read format/quality — config decision baked into a data-access helper; forces a feature-flag mock to unit-test encoding | architecture.md layer principle (judgment); cycle CONFIRMED ABSENT | Make `encodeStepScreenshot(raw, sourceExt, { format, quality })` take explicit params; callers resolve from the feature. Removes the import; unblocks a mock-free encode test | S / low |
| 9 | duplication | Med | test-executor.ts:924 · mobile-test-run.job.ts:775 · scheduler/index.ts | `ScreenshotCaptureFeature.isEnabled()` gate is checked at 3 call sites, yet `captureStepScreenshot` already self-gates (dev). Decision logic leaked out of its boundary | invariant #8 DRY | Centralize the gate inside `captureStepScreenshot` and `ArtifactRetentionJob.start()`; call them unconditionally. Removes the feature import from test-executor + scheduler | S / low |
| 10 | duplication | Med | test-artifacts-storage.service.ts:211,277,348 | upload → error-check → getPublicUrl → return URL repeated ~4× (video/trace/screenshot/step) | critical-patterns §5; code-quality "No duplicates" | Private `uploadBufferToStorageBucket(bucket, path, buffer, contentType)`; all uploaders delegate. Do during #1 | S / low |
| 11 | duplication | Med | mobile-test-run.job.ts:1315 ↔ test-artifacts-storage.service.ts:224 | base64→Buffer decode (data-URI strip + jpeg/png detect) hand-rolled in the mobile job, duplicating `uploadScreenshotToStorage` | critical-patterns §5 | Extract `decodeBase64Screenshot(shot) → { raw, sourceExt }` next to the encode helpers; both call it. Do during #1 | S / low |
| 12 | cohesion | Med | regression-report-assembler.service.ts:284-399 | Pre-existing oversize (649) grown further by the feature; the step→RunReportStep + artifact-projection loop is a separable concern | reviewer.md BLOCK "file grew past ~400" | Extract `run-step-projector.service.ts` (`projectStepsAndArtifacts(completedSteps, phaseList, testResult)`). Do AFTER test #5 pins behavior | M / med |
| 13 | test | Med | test-executed-steps-redis.service.ts:91 | `reduceRuntimeMeta` whitelists+truncates stepScreenshotUrl but is a private, untested pure transform; a silent field-drop would break the whole pipeline with no failing test | testing.md "pure utilities, no mocks" | Export (or extract to `step-event-reducers.ts`) and unit-test field preservation + 2000-char truncation | S / low |
| 14 | test | Med | test-artifacts-storage.service.ts:348 | `uploadStepScreenshotToStorage` empty-buffer guard + upload-error rethrow untested | testing.md "service business logic" | Mock `@/db/supabase` at the storage boundary (this file IS the data-access layer — allowed); 2 branch cases | S / low |
| 15 | test | Med | mobile-test-run.job.ts:1298 | `uploadStepScreenshots` (base64→URL / already-URL skip / failure-drops-to-undefined) untestable while private static | testing.md "don't test private methods — extract first" | After #2 extraction, test `uploadMobileStepScreenshots` with an injectable uploader | M / low |
| 16 | test | Low | test-artifacts-storage.service.ts:281 | `buildStepScreenshotPath` pure fn untested (owns the `fail/` + prefix separation retention relies on) | testing.md "pure utilities" | Add path-shape cases to the existing encode test file; no mocks | S / low |
| 17 | duplication | Low | regression-report-assembler.service.ts:379,391 | bug-screenshot and step-screenshot aggregation loops are near-twins | minor (judgment) | Fold both into the #12 projector extraction | S / low |
| 18 | test/arch | Low | artifact-retention.job.test.ts:32 | Existing test mocks `@/db/supabase` directly — reviewer.md flags "unit test mocks Supabase directly" | reviewer.md Testing BLOCK (nuanced) | Tension, not a hard violation: for a storage job there's no db/ sublayer to mock. After #3/#4, mock the new storage util instead | S / low |

## Refactor plan (sequenced)

1. **Verify the bucket split-brain (#7)** — confirm whether `test-artifacts` and `qai-assets` both exist in Supabase. This is a correctness gate, not just cleanup: it decides whether `captureBugScreenshot` (and the new step path) should converge on one env-driven bucket, and whether the retention job is missing bug screenshots. Cheap, unblocks the decision in steps 2 & 5. *Depends on: nothing.*
2. **Extract `step-screenshot.service.ts` (#1, #2, #10, #11)** — move the four step-screenshot fns out of the 1004-line storage service; move mobile's `uploadStepScreenshots` here as `uploadMobileStepScreenshots`; fold in the shared `uploadBufferToStorageBucket` + `decodeBase64Screenshot` helpers. One S-move resolves the storage oversize *and* the mobile job's domain-logic BLOCK. *Depends on: nothing (do first among refactors).*
3. **Parameterize encoding (#8)** — change `encodeStepScreenshot` to take explicit `{ format, quality }`; callers read the feature flag and pass them. Removes the storage→config edge and unblocks a mock-free encode test. *Depends on: 2.*
4. **Centralize the feature gate (#9)** — gate inside `captureStepScreenshot` + `ArtifactRetentionJob.start()`; remove the scattered `isEnabled()` checks. *Depends on: nothing; low risk.*
5. **Extract `walkStoragePrefix` util + delegate retention (#4, #3)** — shared BFS walker; `ArtifactRetentionJob` and `account-deletion.service.ts` both use it; retention stops importing `supabaseAdmin` directly. *Depends on: nothing; refactors a second caller so coordinate with the account-deletion owner.*
6. **Extract `run-step-projector.service.ts` from the assembler (#12, #17)** — move the step→RunReportStep + artifact projection out of the 649-line assembler. *Depends on: test #5 landing first so behavior is pinned before the move.*

> Steps 2–5 are independent S-effort wins; step 1 should precede any decision to reroute bug screenshots; step 6 is the only M/med item and should follow its test.

## Test-coverage plan

- **Current coverage:** 2 tests added by the feature — `artifact-retention.job.test.ts` (prune boundary + in-flight guard) and `step-screenshot-encode.test.ts` (webp/jpeg/fallback). Both pass. Everything else net-new is uncovered.
- **Make-testable-first (extractions that unblock tests):**
  - Export/extract `reduceRuntimeMeta` (#13) — currently private.
  - Extract `uploadMobileStepScreenshots` with an injectable uploader (#15, via refactor step 2).
  - Parameterize `encodeStepScreenshot` (#8) so its test needs no feature-flag mock.
- **Proposed tests (behavior-named), in priority order:**
  1. **Assembler routing** (#5) — *highest value, lowest cost.* In the existing `regression-report-assembler.test.ts`: "adds stepScreenshotUrl to screenshots[] and aggregate", "does NOT add it to bugScreenshots", "dedupes against the final screenshot", "skips a `data:` base64 value", "works when test_results has no screenshot". Mock boundary: the existing db/ sublayer mock (already wired).
  2. **captureStepScreenshot** (#6) — `artifacts-handler.test.ts` (new): null page → undefined; dev → undefined, no upload; passing step → `fullPage:false`; failure → `fullPage:true`; screenshot throws → undefined; upload throws → undefined. Mock: fake Page + mocked storage import + `isDevelopment`.
  3. **reduceRuntimeMeta** (#13) — `step-event-reducers.test.ts` (new, after export): preserves stepScreenshotUrl ≤2000 chars; truncates >2000; tolerates undefined/non-object; keeps bugScreenshotUrl alongside. No mocks (pure).
  4. **uploadStepScreenshotToStorage** (#14) — empty buffer throws without I/O; Supabase error rethrows; success returns URL. Mock `@/db/supabase` storage at the data-access boundary.
  5. **uploadMobileStepScreenshots** (#15, after extraction) — already-URL left as-is; base64 (data-URI / raw `/9j/` / png) → URL replacement; uploader throws → `step.screenshot` becomes undefined (never base64, never throws).
  6. **buildStepScreenshotPath** (#16) — pass path under `step-screenshots/<testId>/`; failure under `…/fail/`; honors ext + ts; never uses the `screenshots/` prefix. No mocks.
- **Do NOT test:** `processAndUploadStepScreenshot` (thin composition of two tested helpers); `MobileTestRunJobHandler.process()` (thin job handler — integration-covered); the giant legacy replay loop in test-executor.ts; `screenshot-capture.ts` config getters.

## Out of scope / deferred

- **Pre-existing `supabaseAdmin` direct usage** not introduced by this feature: `test-executor.ts` (Postgres `resolveWorkspaceFromProject` + `captureBugScreenshot` storage), `mobile-test-run.job.ts:1555` (`intelligent_test_sessions` UPDATE), and other sweep jobs (`AccountDeletionPurgeJob`). Real layering debt, but a separate workstream — flagged for awareness only.
- **Broad decomposition** of the 1655-line mobile job and the 2564-line test-executor beyond the step-screenshot extractions — explicitly out of scope.
- **Frontend** rendering of the new `screenshots[]` / `step.screenshot` — not part of this backend feature surface (web `ArtifactTabs` / `StepsTimeline` already consume them).

## Open questions

1. **Does the `test-artifacts` bucket exist** alongside `qai-assets`, and is having bug screenshots in a bucket the retention job never prunes intentional? (Blocks finding #7.)
2. **Are sweep jobs an accepted exception** to "no direct `supabaseAdmin` in jobs"? Multiple existing sweep jobs do it; the answer decides whether #3 is a fix or a documented carve-out.
3. **Should the retention policy treat failure-step screenshots differently** (longer retention)? The `fail/` subfolder was added for exactly this, but the current sweep prunes the whole `step-screenshots/` subtree uniformly.
