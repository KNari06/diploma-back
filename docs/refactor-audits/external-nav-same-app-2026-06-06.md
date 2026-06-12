# Refactor & test audit — Preview external-navigation / same-app detection

qai-backend · 2026-06-06 · audited 3 files (~4,886 lines; ~720 in scope)

> **Plan only.** Nothing applied. Grounded in `qai-backend/CLAUDE.md`, `.claude/rules/*`, and `src/services/testing/ui/preview/CLAUDE.md`. Dimension `dependency-direction` was **skipped** (feature lives in one folder; placement is covered under architecture). Findings not backed by a written rule are labelled *judgment call*.

## Scope

| File | Lines | In-scope surface |
|---|---:|---|
| `src/services/testing/ui/preview/external-nav-trap.ts` | 425 | full — post-nav revert state machine + `isSameApp` **copy #1** + host helpers + `TEMP_DISABLE_EXTERNAL_NAV_TRAP` (temporary flag just added) |
| `src/services/testing/ui/preview/new-tab-opener.ts` | 295 | full — anchor→new-tab promotion + `isSameApp` **copy #2** (has test `__tests__/new-tab-opener.test.ts`) |
| `src/services/testing/ui/preview/preview-session.service.ts` | 4166 | **partial** — `probeExternalAnchorAt` (~100–223, `isSameApp` **copy #3** inside `page.evaluate`) + call site (~2036) + 3× `attachExternalNavTrap` (~837/1110/3526). Rest of file out of scope. |

Referenced but out of scope: `auth-detector.ts` (`hostnameOf` copy), `src/utils/security/url-safety.ts` (`extractEtldPlusOne` — 4th copy of last-2-label, with IPv4/IPv6 guards the preview copies lack).

## Findings (ranked)

| # | Area | Sev | File:line | Issue | Rule | Proposal | Effort/Risk |
|---|---|---|---|---|---|---|---|
| 1 | duplication / cohesion / test | **High** | `external-nav-trap.ts:~125` · `new-tab-opener.ts:~75` · `preview-session.ts:~189` | **`isSameApp` heuristic triplicated.** All three comments say they "must mirror" each other; none enforces it. This is the exact divergence that produced the documentolog cross-ccTLD loop (`documentolog.com` vs `documentolog.kz` → last-2-label mismatch) and forced `TEMP_DISABLE_EXTERNAL_NAV_TRAP`. | CLAUDE.md #8 DRY; code-quality "No duplicates"; preview/CLAUDE.md #5 ("pre-click and post-nav paths agree on cross-origin") | Extract `src/services/testing/ui/preview/same-app.util.ts` → `isSameApp`, `hostnameOf`, `originOf`. Import in copies #1 & #2. Copy #3 stays inline (runs in `page.evaluate`) but gets a `// must stay in sync with same-app.util.ts` comment. **Make-testable-first unblock + prerequisite to remove TEMP_DISABLE.** | S / low |
| 2 | duplication | Med | `url-safety.ts:135` (+ preview copies) | A **4th** last-2-label impl (`extractEtldPlusOne`) exists with IPv4/IPv6 guards the preview copies omit → silent gap: an IPv4 preview URL `1.2.3.4` makes `isSameApp` match any IP sharing the last two octets. | CLAUDE.md #8 DRY | Fold `extractEtldPlusOne`'s guards into `same-app.util.ts` (or import it) so the preview path is IP-safe. | S / low |
| 3 | duplication | Med | `external-nav-trap.ts:~107` · `auth-detector.ts:188` | `hostnameOf` duplicated with divergent contracts (`''` vs `undefined` on failure; auth-detector lowercases). | CLAUDE.md #8 DRY | Single `hostnameOf` in `same-app.util.ts`; update `auth-detector.ts` to import it (canonicalize to `string`, `''` on failure). | S / low |
| 4 | architecture / cohesion | **High** | `preview-session.ts:100` | `probeExternalAnchorAt` (~120 lines) — a self-contained pre-click same-app/anchor classifier — is buried in the 4166-line session service, while its siblings (trap, new-tab-opener) have dedicated files. The trap's own module doc (line ~11) already names it as part of this feature. | folder-structure (feature util next to feature); architecture (mixed concerns — session lifecycle vs anchor classification) | Extract to `anchor-probe.util.ts` (or into `external-nav-trap.ts`). Import back at the call site (~2036). Node-side host compare uses `same-app.util.ts`. | S / low |
| 5 | architecture | Med | `preview-session.ts:~1977` | `executeMouseAction` writes a **second inline `page.evaluate` anchor probe** (`elementFromPoint → closest('a[href]')`) duplicating `new-tab-opener.probeAnchorAtLocator` (same `{tag,href,target}` shape). Partially bypasses the "single path" invariant #16. | CLAUDE.md #8 DRY; preview/CLAUDE.md #16 | Export `probeAnchorAtPoint(page,x,y): AnchorClickProbe \| null` from `new-tab-opener.ts`; replace the inline probe with it, then feed existing `shouldOpenAsNewTab`. | S / low |
| 6 | architecture | Med | `preview-session.ts:837/1110/3526` | 3× `attachExternalNavTrap` each pass a **different** baseline-URL source (`safeStartUrl` / `startUrl` / `newUrl`) with no documented rationale; a wrong baseline silently mis-calibrates the trap. `markIntentionalGoto` pairing is also hand-done at each site. | CLAUDE.md #8 (deliberate, documented variation); *judgment call* | Add an `attachTrapForPage(page, sessionId, baselineUrl, reason)` factory in `external-nav-trap.ts` that documents the canonical source per context and centralizes the `markIntentionalGoto` pairing. | S / low |
| 7 | test-coverage | **High** | `external-nav-trap.ts:~184` | `onFrameNavigated` state machine (intent-window / run-suppression / same-app / cross-origin revert / notice-dedup / reverting-guard) has **zero tests**. `attachExternalNavTrap` is exported → testable now with a fake Page. | testing.md (service logic, stub collaborators) | `__tests__/external-nav-trap.test.ts`; mock `page.goBack/goto` + `webSocketService.emitToRoom` + a `Frame` stub. `.skip` the revert-branch cases with a `RESTORE` marker (TEMP_DISABLE makes that branch dead today). | M / low |
| 8 | test-coverage | **High** | `external-nav-trap.ts:~125` (post-extract `same-app.util.ts`) | The pure `isSameApp` — source of the production incident — is **untested**. Trivially unit-testable (string→string→bool). | testing.md (pure util, no mocks) | `__tests__/same-app.util.test.ts` — incl. the documentolog ccTLD regression case + multi-label ccTLD over-match edge. Depends on #1. | S / low |
| 9 | test-coverage | Med | `__tests__/new-tab-opener.test.ts:~78` | Existing test covers `www/api` subdomains but **NOT** the ccTLD regression (`documentolog.kz` vs `.com`) that `shouldOpenAsNewTab` relies on. | testing.md (behavior-named cases) | Add `'treats different ccTLD same brand as cross-origin anchor (documentolog regression)'` + `co.uk` edge. No code change; documents current behavior, turns red when the heuristic is upgraded. | S / low |
| 10 | architecture / test | Low | `external-nav-trap.ts:47` | Top-level import of the `webSocketService` singleton couples the trap to WS infra and blocks unit testing (other infra, e.g. `EditorTraceService`, is lazy-imported at line ~214). | architecture (dependency direction — services shouldn't bind infra singletons); *judgment call* | Inject a `notifyBlocked(sessionId,payload)` callback into `attachExternalNavTrap`, OR lazy-`import()` the WS service in the emit block like the trace service. | M / low |
| 11 | cohesion / size | Low | `external-nav-trap.ts` (425) | Over the 400-line signal, but **big-but-cohesive** — ~200 runnable lines; the rest is JSDoc. The 5 registry maps all serve the one trap lifecycle; no second responsibility is nameable beyond `isSameApp` (#1). | CLAUDE.md File size ("name two responsibilities or it's just big") | **No split** beyond extracting `isSameApp` (#1). | — |
| 12 | test-coverage | Low | `new-tab-opener.ts` (`openHrefInNewTab`) | Fail-open error path (newPage throws → returns null) untested. | testing.md | Add mock-`context.newPage`-throws test to `new-tab-opener.test.ts`. | S / low |

## Refactor plan (sequenced)

Low-risk, high-unblock first. Dependencies called out.

1. **Extract `same-app.util.ts`** — `isSameApp` + `hostnameOf` + `originOf`, folding in `extractEtldPlusOne`'s IPv4/IPv6 guards. Wire copies #1 (`external-nav-trap`), #2 (`new-tab-opener`), and `auth-detector.hostnameOf`. Add the sync-comment to copy #3's `page.evaluate` body. *Fixes #1, #2, #3; unblocks all tests; prerequisite for removing TEMP_DISABLE.* (depends-on: none)
2. **Unit-test `same-app.util`** (#8) — full case matrix incl. the documentolog ccTLD regression + `co.uk` edge. (depends-on: 1)
3. **Test `onFrameNavigated`** (#7) — `external-nav-trap.test.ts` with a fake Page; `.skip`+`RESTORE` the revert-branch cases. (depends-on: none; pairs with 1)
4. **Brand-aware `isSameApp` + remove `TEMP_DISABLE_EXTERNAL_NAV_TRAP`** — the real fix for the documentolog loop, made in the ONE shared util. Gated by the suites from 2 & 3 (flip the `.skip`). (depends-on: 1, 2, 3) — *the only med-risk step; touches safety behavior.*
5. **Extract `probeExternalAnchorAt`** out of `preview-session.service.ts` → `anchor-probe.util.ts` (#4); Node-side host compare via `same-app.util`. (depends-on: 1)
6. **Extract `probeAnchorAtPoint`** + replace the inline `executeMouseAction` probe (#5) — closes the invariant-#16 gap. (depends-on: none)
7. **`attachTrapForPage` factory** (#6) — document baseline-URL choice + centralize `markIntentionalGoto`. (depends-on: none)
8. **WS notifier injection** (#10) + `openHrefInNewTab` error-path test (#12) + new-tab ccTLD regression cases (#9). (depends-on: 3 for the notifier-enabled trap tests)

## Test-coverage plan

**Current coverage**
- `new-tab-opener.test.ts` — covers `shouldOpenAsNewTab` for `www/api` subdomains, target/modifier cases. **Missing:** the ccTLD regression; `openHrefInNewTab` error path; `probeAnchorAtLocator` (Playwright-bound, integration-only).
- **Zero tests:** `external-nav-trap.ts` (`isSameApp`, `onFrameNavigated`, notice dedup, suppression, idempotent attach), `probeExternalAnchorAt`.

**Make-testable-first**
- Extract `same-app.util.ts` (step 1) → `isSameApp`/`hostnameOf` become importable & unit-testable.
- `onFrameNavigated` is already reachable via the exported `attachExternalNavTrap` (inject a fake Page) — no extraction needed; only a fake `Frame` + mocked `goBack/goto/emit`.

**Proposed tests** (behavior-named; colocated `__tests__/`; mock only Playwright Page/WS):
- `same-app.util.test.ts`: identical host; `www/m/staging`/sibling subdomain → true; unrelated host / same-TLD different brand → false; **`business.documentolog.com` vs `account.documentolog.kz` → false (documentolog regression)**; `foo.co.uk` vs `bar.co.uk` over-match edge (documents current, turns red after PSL); unparseable/`about:blank` → false; IPv4 same-last-2-octets → false (after guard fold).
- `external-nav-trap.test.ts`: intent-window allow; intent beats suppression; run-suppression allow; same-app allow (refreshes `lastSafeUrl`, not baseline); **cross-origin revert calls `goBack` then `goto` fallback** (`.skip` until TEMP_DISABLE off); notice dedup within/after `NOTICE_DEDUP_MS`; skips `about:blank`/non-http; idempotent attach (WeakSet); `clearExternalNavTrapSession` stops emits. `afterEach` → `clearExternalNavTrapSession` (module-level maps leak otherwise).
- `new-tab-opener.test.ts` additions: ccTLD regression + `co.uk` edge; `openHrefInNewTab` newPage-throws → returns null.
- `probeExternalAnchorAt`: unit — `page.evaluate` throws → returns null (fail-open). The rest is integration-only (driven by a real click).

**Not worth testing** (per testing.md): the `setTimeout` reverting-flag cleanup (implementation detail); `probeAnchorAtLocator` (thin Playwright wrapper); the in-`evaluate` DOM traversal (integration-only).

## Out of scope / deferred

- The 4166-line `preview-session.service.ts` as a whole — only `probeExternalAnchorAt` + the trap call sites are in scope. Its size is a separate audit.
- `src/utils/security/url-safety.ts` (`extractEtldPlusOne`) — referenced for the IPv4/IPv6 guard fold (step 1), not deep-audited.
- `TEMP_DISABLE_EXTERNAL_NAV_TRAP` is a deliberate temporary workaround; step 4 is its proper resolution, not a finding against it.
- No `supabaseAdmin`/`db/` imports in any in-scope file — that invariant is clean.

## Open questions

- **Util home:** `src/services/testing/ui/preview/same-app.util.ts` (collocated, all current callers in this folder) vs `src/utils/` (cross-domain, given the `url-safety.ts` overlap). Auditors lean preview-folder; confirm.
- **Brand-aware approach for step 4:** cheap SLD-label-across-TLD match with a length guard (matches the existing crude heuristic's risk profile) vs a real public-suffix list (correct for `co.uk`/`com.au` but heavier dependency). Which?
- **Removing `TEMP_DISABLE`** changes external-nav safety semantics globally (all preview sessions) — needs product sign-off on "same brand across ccTLD = in-app", plus the green test suite as the gate.
