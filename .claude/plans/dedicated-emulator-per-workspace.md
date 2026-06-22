# Plan: Dedicated emulator per workspace (fully dedicated, no sharing) — v2 (post-audit)

**Status:** APPROVED DESIGN — not yet implemented.
**Branches:** `mobile/dedicated-emulator-per-workspace` (backend + runner, one per repo).
**v2 changelog:** Adversarial re-audit found 3 plan-breaking gaps the v1 missed — all folded in below and marked 🆕:
- 🆕 **Concurrency:** runner mutex is per-`sessionId`, NOT per-serial → two runs of one workspace would drive the SAME container concurrently (v1 wrongly said they serialize). New Phase 5.
- 🆕 **Lifecycle:** worker `finally` destroys every non-pool session → a dedicated session calls `emulatorManager.stop(serial)` = kills/disrupts the dedicated container after each run. New Phase 6 (`sessionSource:'dedicated'` + end-without-destroy).
- 🆕 **Security:** `warmupSession`/`autoBootAndInstall` accept `projectId` from the request body with NO access check → deriving workspaceId from it is exploitable. New Phase 2.0 (project-access guard) — HARD BLOCKER.
- Plus: ownerId↔MOBILE_MULTI_USER_ISOLATION coupling, telemetry blindness, iOS limited to physical, extra docs. All addressed.

## Decisions (locked)
- **Model A**: one runner orchestrates many redroid containers (no per-customer runner yet).
- **Lock key**: `workspaceId` (billing/team unit; on the mobile job payload, server-derived).
- **Policy**: fully dedicated — a workspace's container is pinned to it; NO sharing, NO lease, NO pool fallback.
- **On dedicated failure**: typed error to the user; NEVER fall back to a shared device (that breaks isolation).
- **HW boundary**: dedicated *container* on a shared VM (docker isolation). Not dedicated hardware.
- **Platform**: 🆕 **android only** for v1. iOS dedicated is NOT realistic (no remote simulator farm; only physical iPhones, which are single-user). Table CHECK still allows 'ios' for future, but resolver returns null for ios in v1.
- **Map population**: MANUAL (containers created manually via `setup-emulator-vm.sh`). Auto-provision = future phase.
- **Frontend**: ZERO changes for routing — backend derives workspace from auth/projectId. Optional entitlement badge later.

## Mechanism (verified end-to-end)
`deviceSelector.serial` pinning works runner-side. Backend sends
`createSession(platform, { deviceSelector: { serial: "<host:port>" }, ownerId: workspaceId, userId })`
→ `resolveAndroidDevice` extracts port via `parsePortFromSerial` → `emulatorManager.start({port})`
→ `connectToHostDevice("<EMULATOR_HOST>:<port>")` binds to THAT container.
(Refs: session.routes.ts:122,183 · session-manager.ts:407-428 · emulator-manager.ts:145-165 · host-emulator-connector.ts:163-187.)

---

## Session-birth sites (audit-confirmed COMPLETE — exactly these)
| # | Surface | Callsite | workspaceId | Action |
|---|---------|----------|-------------|--------|
| 1 | Regression / chat-mobile / CI (worker) | `mobile-test-run.job.ts:409` → `acquireSession` (claim L103 / cold L148) | on payload (L108), NOT passed in | intercept inside acquire |
| 2 | Editor warmup pool→cold | `session.controller.ts:619,632` | derive from projectId | intercept |
| 3 | Editor warmup pinned | `session.controller.ts:612` | — | flows through 2 |
| 4 | Auto-boot on APK upload | `session.controller.ts:1653` | derive from projectId | intercept |
| — | mobile_agent / exploration / preview / test-resource / driver-probe / CI controller | reuse existing sessionId OR enqueue job | n/a | NO change (audit-verified: none create a session) |

All `runnerUrl` come from `env.MOBILE_RUNNER_URL` (5 enqueue sites verified) — no alternate-baseUrl bypass exists.

---

## Phase 0 — STATUS: DONE (impl notes vs plan)
Implemented on branch `mobile/dedicated-emulator-per-workspace`. Adjustments found during impl:
- **integration-token sites were NOT a real bug.** `getIntegrationSummary`/`listConnectedIntegrations` already branch on `if (workspaceId)` and treat falsy as "global tokens only"; `''` is falsy so it worked by luck. Fixed callers to drop `|| ''` (pass value / `?? undefined`) — cosmetic correctness, not the query bug the audit claimed.
- **6th `|| ''` site found:** `chat.service.ts:477` — a generic chat-session row mapper, NOT a mobile-job path. Left untouched (out of scope).
- **Real fixes (mobile job birth points):** `mobile-test-dispatcher.service.ts` and `preview.controller.ts` now THROW on null workspace instead of persisting `''`.
- **db/supabase.ts legacy branch (0.3):** left as-is — only fires when the workspaces table is ABSENT (42P01), impossible once NOT NULL is applied. Adding code there = dead code for an unreachable state.
- **Stale test mocks (0.5):** left as-is — they mock at the service boundary, never hit the DB constraint; the regression-plan-access "orphan project" test validates REAL defensive code. All pass.
- Migrations split into backfill + notnull (two deploys).
- Verified: `tsc --noEmit` clean; dispatcher 17/17 (added throw-on-null test); negative-generation + regression-plan-access 22/22.

## Phase 0 — Data integrity (foundation)
`projects.workspace_id` is nullable (NOT NULL commented out, workspaces.sql:291); backfill ran unconditionally (workspaces.sql:81-136) so live nulls are unlikely but possible.

- **0.1** 🆕 Pre-flight audit query (run manually first): `SELECT count(*) FROM projects WHERE workspace_id IS NULL;` Must be 0 before 0.4.
- **0.2** 🆕 Fix EVERY `workspaceId || ''` fallback (audit found 5, not 1) — and the integration-token NULL-query bug:
  - `mobile-test-dispatcher.service.ts:245` — throw on null (mobile must have a real workspace).
  - `preview.controller.ts:748` — same.
  - `jira-qa-orchestrator.service.ts:240`, `failure-analysis.service.ts:94` — these feed `integration-token.service.ts:370` `.or('workspace_id.eq.${ws},workspace_id.is.null')`; `ws=''` makes the query match nothing. Fix to branch: if workspaceId → `.eq` + `.is null`; else `.is null` only. (This is a latent bug independent of our feature — fix it correctly, don't just stop passing '').
  - `regression-report-assembler.service.ts:735` tolerates null (returns `[ownerId]`) — leave, but note.
- **0.3** 🆕 Harden project-creation paths that omit workspace_id so NOT NULL can't break them:
  - `db/supabase.ts:570` legacy branch deletes workspace_id — change to assign `system_workspace_id` instead of dropping it.
  - Audit-confirmed SAFE (always set): self-serve-provisioning, project-context.service, ProjectService.createProject.
- **0.4** 🆕 SPLIT into two migrations across two deploys (avoid backfill/constraint race):
  - `features/workspace-projects-workspace-id-backfill.sql` (idempotent backfill) — deploy with 0.2/0.3 code.
  - `features/workspace-projects-workspace-id-notnull.sql` (`ALTER … SET NOT NULL`) — NEXT deploy, after 0.1 confirms 0 nulls.
- **0.5** 🆕 Update stale test mocks asserting null workspace_id: `regression-plan-access.test.ts:158`, `negative-generation.service.test.ts:54`, `test-case-chat.test.ts`. (They become unrealistic post-NOT-NULL.)

**Test:** dispatcher throws on null; integration-token query matches global tokens when workspaceId is absent (not ''); NOT-NULL migration fails loudly if a null remains.

---

## Phase 1 — STATUS: DONE (impl notes vs plan)
- Migration `features/workspace-dedicated-device.sql` — mirrors workspace_credits; **owner-only** RLS (read+write) since runner_serial is internal infra. Registered in INDEX.md.
- db/: `src/services/mobile/db/dedicated-device.db.ts` — `getActiveDedicatedDevice` via supabaseAdmin, never throws (DB error → null → shared-pool fallback).
- Service: `src/services/mobile/dedicated-device.service.ts` — `resolveDedicatedDevice(workspaceId, platform)` with 60s TTL cache (incl. negative caching). **flutter → android device row** (flutter runs on android containers); **ios → null in v1**.
- Flag: `DEDICATED_MOBILE_EMULATOR_ENABLED` (env.ts, default false) + `DedicatedDeviceFeature.isEnabled()`.
- Types kept LOCAL to db/service (not in mobile-runner.types.ts) — self-contained concern, not runner wire protocol.
- Tests: 9/9 (flag off, ios, no-row, missing-ws, platform-mismatch, flutter-maps-android, caching ±). tsc clean.

## Phase 1 — Table + resolver + flag

### 1.1 Migration `features/workspace-dedicated-device.sql` (mirror `workspace_credits`)
Lean mapping — NO lease/status/current_user columns (sharing rejected):
```sql
CREATE TABLE IF NOT EXISTS workspace_dedicated_device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('android','ios')),  -- ios reserved; v1 resolver returns null for ios
  runner_serial TEXT NOT NULL,            -- e.g. '10.0.0.5:5606'
  runner_url    TEXT,                     -- nullable; reserved for Model B (per-workspace runner)
  is_active     BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspace_dedicated_device_workspace_id ON workspace_dedicated_device(workspace_id);
ALTER TABLE workspace_dedicated_device ENABLE ROW LEVEL SECURITY;
-- 🆕 runner_serial is internal infra (IP:port) — do NOT expose to members. Owner-only read.
CREATE POLICY "Owners can view workspace dedicated device" ON workspace_dedicated_device
  FOR SELECT USING (public.check_workspace_membership(workspace_id, ARRAY['owner']));
CREATE POLICY "Owners can manage workspace dedicated device" ON workspace_dedicated_device
  FOR ALL USING (public.check_workspace_membership(workspace_id, ARRAY['owner']));
-- updated_at trigger: copy the pg_proc-guarded block from workspace_credits.
```
Backend reads via `supabaseAdmin` (bypasses RLS). RLS via existing `check_workspace_membership` SECURITY DEFINER helper (matches workspace_credits; avoids the past cross-tenant RLS bug). 🆕 Owner-only SELECT — `runner_serial` must not leak to non-owner members or client JWTs via PostgREST.

### 1.2 db/ sublayer + service
- `src/services/mobile/db/dedicated-device.db.ts` — `getActiveDedicatedDevice(workspaceId)` via `supabaseAdmin` (where `is_active`).
- `src/services/mobile/dedicated-device.service.ts` — `resolveDedicatedDevice(workspaceId, platform): { serial, runnerUrl? } | null`:
  - null if no row / inactive / platform mismatch / 🆕 `platform === 'ios'` (v1).
  - TTL in-memory cache (60s) keyed by workspaceId.
- Type in `mobile-runner.types.ts`.

### 1.3 Feature flag
- `env.ts`: `DEDICATED_MOBILE_EMULATOR_ENABLED` (z transform → bool, default `'false'`; mirror `MOBILE_MULTI_USER_ISOLATION`).
- `src/config/features/dedicated-device.ts`: `DedicatedDeviceFeature.isEnabled()` (mirror `OrgMembersFeature`).

**Test:** db read null on missing/inactive/platform-mismatch/ios; cache; flag off ⇒ resolver null (zero behavior change).

---

## Phase 2 — STATUS: DONE (impl notes vs plan)
- **2.0 IDOR guard (blocker):** `warmupSession` now calls `ProjectService.getProject(projectId, userId)` right after projectId validation → 404 on no-access (getProject returns null for non-members, no info leak). `autoBootAndInstall` already loaded the project but didn't block — added explicit early-return when getProject returns null. (Upload route is requireAuth only, NOT project-scoped — confirmed; this is the real guard.)
- **2.1/2.2 acquire intercept:** `acquireSession` takes `workspaceId`; runs `resolveDedicatedDevice` as **tier-0** before pool/warmup/cold. On hit → `createSession({deviceSelector:{serial}, ownerId:workspaceId})`, returns `sessionSource:'dedicated'`, NO shared fallback on failure. Added `'dedicated'` to the sessionSource union here + in mobile-test-run.job.
- **2.3 warmup + auto-boot:** both resolve dedicated and, on hit, force `deviceSelector={serial}` + `ownerId=workspaceId`. warmup reuses its pinned-create path (a serial auto-selects skipPool); auto-boot spreads deviceSelector into createSession.
- **2.5 ownerId coupling:** dedicated forces `ownerId=workspaceId` regardless of MOBILE_MULTI_USER_ISOLATION (isolation comes from the container; ownerId is defense-in-depth, no-op if runner multi-user off).
- workspaceId is ALWAYS server-derived: job payload (dispatcher) or access-checked `project.workspace_id` (warmup/auto-boot) — never the request body.
- Tests: session-acquisition.dedicated 3/3 (pin+skip-ladder, no-fallback-on-failure, fall-through). Full mobile suite 186/186. tsc clean.
- NOTE: Phase 6 (don't destroy the dedicated container in the job finally) NOT yet done — the worker still routes `sessionSource!=='pool'` → destroySession. MUST land before enabling the flag.

## Phase 2 — Backend routing + security

### 2.0 🆕 SECURITY PREREQUISITE (HARD BLOCKER — must land before/with 2.x)
Audit: `warmupSession` (session.controller.ts:164) and `autoBootAndInstall` (:1577) take `projectId` from the request body with **no access check** (the only check is a non-fatal swallowed call inside `applyProjectPolicyToSession`). Deriving workspaceId from an unchecked projectId lets user A pass victim B's projectId → B's dedicated serial.
- Add an explicit guard at the top of BOTH: `const project = await ProjectService.getProject(projectId, userId); if (!project) return 403/404;` BEFORE any project-derived work.
- This is a real latent IDOR independent of our feature; dedicated routing makes it tenancy-critical. Fix regardless.

### 2.1 Thread workspaceId into acquireSession (site 1)
- Add `workspaceId: string | undefined` to `acquireSession` params (session-acquisition.service.ts:35).
- `mobile-test-run.job.ts:409` — pass `workspaceId` (already destructured L108). Job payload workspaceId is server-set by the dispatcher from `intentCase.project_id` — trusted at enqueue.

### 2.2 Dedicated intercept (single chokepoint, runs FIRST — before pool/warmup/cold)
```
if (DedicatedDeviceFeature.isEnabled() && workspaceId) {
  const dd = await resolveDedicatedDevice(workspaceId, platform);   // null for ios in v1
  if (dd) {
    const s = await client.createSession(platform, {
      deviceSelector: { serial: dd.serial },
      ownerId: workspaceId,           // 🆕 ALWAYS for dedicated — see 2.5 (decoupled from MOBILE_MULTI_USER_ISOLATION)
      userId,
    });
    return { sessionId: s.sessionId, sessionSource: 'dedicated', sessionClaimMs, coldStartUsed: false }; // 🆕 new source
  }
}
// else: existing pool → warmup → cold ladder unchanged.
```
- 🆕 Running FIRST is what PREEMPTS tier-2 warmup reuse — a dedicated workspace must never claim a shared warmed session.
- On dedicated `createSession` failure: throw typed error; NO shared fallback.

### 2.3 Warmup + auto-boot (sites 2 & 4)
- After the 2.0 access guard, both derive `workspaceId = await getProjectWorkspaceId(projectId)` and, if dedicated resolves, force `deviceSelector = { serial }`, `ownerId = workspaceId`, skip pool.
- DRY: helper `resolveDedicatedSelectorForProject(projectId, platform)` (warmup + auto-boot) + the workspace variant for acquire.

### 2.4 Security invariant + test
- workspaceId ALWAYS server-derived from authenticated projectId/job payload; NEVER from a user body field.
- Test: a request for project A (workspace A) can never resolve workspace B's serial; 2.0 guard returns 403 for a non-member projectId.

### 2.5 🆕 ownerId ↔ MOBILE_MULTI_USER_ISOLATION coupling (resolve the contradiction)
Today shared path only passes ownerId when `MOBILE_MULTI_USER_ISOLATION=true`; AND the runner's `applyOwnerToSession` no-ops unless `config.multiUser.enabled` (runner-side). So passing `ownerId=workspaceId` from the backend does NOTHING unless the RUNNER has multi-user enabled.
- **Decision:** for a fully-dedicated container, cross-workspace data bleed isn't possible (one workspace per container), so multi-user isolation is NOT required for correctness — it's defense-in-depth. v1: pass `ownerId=workspaceId` (harmless if runner multi-user off; gives per-workspace Android user if on). Do NOT make dedicated depend on MOBILE_MULTI_USER_ISOLATION.
- Document this explicitly so the "isolation" claim isn't overread: isolation comes from the dedicated *container*, not the Android multi-user.

**Tests:** acquire takes dedicated path only when flag on + mapping exists; reports `sessionSource:'dedicated'`; never falls back to shared on failure; warmup + auto-boot pin the same serial; A≠B isolation; 2.0 IDOR guard.

---

## Phase 3 — Runner: pool/dedicated port-collision
Risk (verified): dedicated serial on a port the pool warms (`POOL_ANDROID_BASE_PORT + i*2`) → pool grabs it.
- **3.1** `config/index.ts` pool: add `androidExcludedPorts` from `POOL_ANDROID_EXCLUDED_PORTS` (CSV).
- **3.2** `session-pool.ts` `init()` (L96): skip excluded ports.
- **3.3** 🆕 `recoverBroken()` also boots a slot and picks ports — ensure it ALSO honors the exclude list (audit flagged it re-collides otherwise). Verify port selection path in recoverBroken/findFreePort.
- **3.4** Ops contract: dedicated ports MUST be outside pool range AND in `POOL_ANDROID_EXCLUDED_PORTS`. Document in runner CLAUDE.md.

**Test:** pool init + recoverBroken with `POOL_ANDROID_EXCLUDED_PORTS=5606` never boot on 5606.

---

## Phase 5 — 🆕 Runner: serial-level concurrency lock (CRITICAL — the v1 miss)
Confirmed: mutex is per-`sessionId` (`mobile-runner.ts:283` `sessionMutexes.get(sessionId)`). Two `createSession` calls to the same dedicated serial → two sessionIds → two independent mutexes → **both run concurrently on the SAME container**, interleaving commands and corrupting test runs. Fully-dedicated MUST serialize per device.
- **5.1** Add a per-**serial** lock layer in the runner. Options (pick at impl):
  - (a) On `createSession`, if a live session already exists for the same resolved serial, REJECT with a typed `DEVICE_BUSY` (backend surfaces "your dedicated emulator is busy with another run — retrying"); OR
  - (b) a serial-keyed async mutex that `executeCommand`/run acquires in addition to the session mutex.
  - **Recommended: (a)** for v1 — simpler, matches "one run at a time per dedicated device", lets the backend queue/retry. (b) is heavier and risks deadlock with the existing RwLock.
- **5.2** Backend: on `DEVICE_BUSY` from a dedicated create, short bounded retry/backoff, then a clear "dedicated emulator busy" message — NEVER fall back to shared.
- **5.3** Note: this also covers the editor-warmup vs worker-run overlap for the same workspace (both pin the same serial).

**Test:** two concurrent createSession to one serial → second gets DEVICE_BUSY (option a); single-run path unaffected.

---

## Phase 6 — STATUS: BACKEND DONE (runner half pending)
- **6.1 (backend, done):** job `finally` cleanup now branches `pool → releaseSession`, `dedicated → endDedicatedSession`, else `destroySession`. A dedicated session is NEVER destroyed (destroySession → emulatorManager.stop → adb emu kill would tear down the container).
- **Client method (done):** `MobileRunnerClient.endDedicatedSession(sessionId)` → `POST /api/sessions/:id/end-dedicated` (noRetry, 15s). Until the runner ships the endpoint it 404s → caught by the existing try/catch → logged; the container is NOT destroyed either way (the safety property). Test pins method+path (POST, never DELETE).
- **6.2 (runner, PENDING — separate repo/branch):** implement `POST /api/sessions/:id/end-dedicated` = the app-reset half of `resetSession` (force-stop + clear data + end session + drop run manager + end trace) WITHOUT `releaseAndroidDevice`/`emulatorManager.stop`.
- **6.3 (runner, PENDING):** exclude dedicated sessions from TTL device-teardown (TTL may end the session but must NEVER stop the host container) — mark via an isDedicated flag or the markPooled exclusion mechanism.
- Tests: client 2/2; tsc clean. (Job-finally branch itself is thin handler logic — not separately unit-tested per testing rules.)

## Phase 6 — 🆕 Lifecycle: don't destroy the dedicated container (CRITICAL — the v1 miss)
Confirmed: worker `finally` (mobile-test-run.job.ts:1299) routes every non-`pool` session → `client.destroySession`, and `destroySession` → `releaseAndroidDevice(serial)` → `emulatorManager.stop(serial)` → `adb -s <serial> emu kill` against the REMOTE redroid container (session-manager.ts:479-484, 1846/1856). So a dedicated session would disrupt/kill the dedicated container every run.
- **6.1** Backend: track `sessionSource` through to the finally. For `'dedicated'`, do NOT call `destroySession`. Instead call a reset-without-destroy that ends the session + resets app state but leaves the container alive.
- **6.2** Runner: add `POST /api/sessions/:id/end-dedicated` (or extend release) = the app-reset half of `resetSession` (force-stop app, clear data, drop run managers, end trace) WITHOUT `releaseAndroidDevice`/`emulatorManager.stop`. Effectively `resetSession` minus device teardown; the session object can be dropped from the map but the container persists.
- **6.3** TTL: a dedicated session created via createSession is subject to the 25-min TTL cleanup, which calls `destroySession` → kills the container. Exclude dedicated sessions from TTL teardown of the *device* (mark the session so TTL ends the session but never stops the host container). Reuse the `markPooled`/exclude mechanism or an `isDedicated` flag on the session.
- **6.4** Confirm `releaseAndroidDevice` on a `cloud`/host serial: it calls `emulatorManager.stop` (NOT the physical branch). Must be bypassed for dedicated. (If a future check makes host emulators no-op on stop, still gate explicitly — don't rely on it.)

**Test:** ending a dedicated session does NOT call emulatorManager.stop for its serial; container/session-from-pool semantics unaffected; TTL on a dedicated session ends session without stopping the container.

---

## Phase 7 — 🆕 Observability — DEEP-DIVE FINDINGS (pre-impl)
Deep-dive result: there is **no `session_source` column**. `test_executions` persists only `cold_start_used` (bool) + `session_claim_ms`; the aggregation funnel (`recomputeRunStatus`) reads only `cold_start_used`. A dedicated run records `coldStartUsed:false` (same as pool/warmup) → indistinguishable. So making dedicated observable is NOT a 1-liner — it needs a new column.
- `sessionSource` union ALREADY widened to include 'dedicated' in the only two typed spots (session-acquisition.service.ts:47/94, mobile-test-run.job.ts:288) — no other narrowing exists; nothing broken.
- **7.1 (if we persist):** migration `ALTER TABLE test_executions ADD COLUMN session_source TEXT NULL;` → thread `tlm.sessionSource` → `ExecutionService.persistTelemetryByTestId` (add `session_source?: string|null`). Both writes already wrapped in try/catch (invariant #11 safe — mirror exactly).
- **7.2 (cheap, no schema):** acquire already logs `[MOBILE-TEST] Dedicated session created {workspaceId}`. Add a counterpart "dedicated workspace fell through to <source>" warn when a flag-on workspace with a row resolves null — that single log line is enough for an ops alert WITHOUT a column.
- **Decision pending user:** persist `session_source` (queryable adoption/breakage metrics, +1 migration +3 edits) vs log-only 7.2 (zero schema, covers the "silent breakage" alarm). Recommend **log-only 7.2 now**, defer the column until adoption metrics are actually needed.
- Aggregation: do NOT add a write to `regression_runs.total_*` outside `recomputeRunStatus` (invariant #11 single funnel).

## RUNNER — STATUS: DONE (qait-mobile-runner branch `mobile/dedicated-emulator-per-workspace`, commit e375bbf)
- **Phase 6 (done):** `dedicated` flag on createSessionSchema → createSession opts → POST /sessions marks the session dedicated. `markDedicated/unmarkDedicated/isDedicated` (+ `dedicatedSessionIds` Set) excluded from BOTH the TTL loop AND `evictOldestIdleSession` (the v1 terrain map missed the eviction path — re-verified). New `POST /sessions/:id/end-dedicated` → `resetSession` (app-reset, no device teardown), 404 on gone session.
- **Phase 5 (done):** `createAndroidSession` rejects `DEVICE_BUSY` when a dedicated create targets a serial that already has a live session (mirrors the physical-device guard). Backend retries.
- **Phase 3 (done):** `config.pool.androidExcludedPorts` (POOL_ANDROID_EXCLUDED_PORTS); pool `init` steps over reserved ports.
- Tests: session-manager 30/30, session-pool 18/18, routes 45/45. tsc clean. (2 pre-existing foreground-test failures unrelated.)
- DEFERRED: `recoverBroken` port-pick was flagged in v1 as a second collision site — in current code recoverBroken lets EmulatorManager assign (no fixed port), so it does NOT re-collide with a dedicated port. No change needed; noted here so it isn't re-investigated.

## RUNNER terrain map (Phase 5/6/3 — for the runner-repo branch)
- **6 endpoint:** `POST /api/sessions/:id/end-dedicated` = wrap `requireSessionOwnership(runner)` → call **`runner.resetSession(id)`** (NOT destroy). resetSession already = app-reset MINUS device teardown; `destroySession` = resetSession + `releaseAndroidDevice`→`emulatorManager.stop` (the container kill). Insert after the `/release` route (~session.routes.ts:400).
- **6.3 TTL:** mirror the existing `pooledSessionIds`/`markPooled` pattern with `dedicatedSessionIds` + `if (this.dedicatedSessionIds.has(id)) continue;` in the TTL loop (session-manager.ts:228). Add `isDedicated?: boolean` to AndroidSession/IosSession (session-types.ts).
- **5 per-serial lock:** mirror the existing physical-device `DEVICE_BUSY` guard in `createAndroidSession` (session-manager.ts:627-640) — a `serialMutexes` map keyed by serial, acquired after the emulator is resolved (~617), released in destroySession finally (~1874). Recommended v1: reject with `DEVICE_BUSY` if a live session already exists for that serial (backend retries) — simpler than a queuing mutex, no deadlock risk vs the existing RwLock.
- **3 excluded-ports:** `config.pool.dedicatedPorts` (CSV) → skip in `resolveAndroidDevice` (~427) AND `recoverBroken` port pick.

## Phase 7 — STATUS: DONE (log-only, per user decision)
- Chose **log-only** (no `session_source` column) — covers the silent-breakage alarm without a migration; adoption metrics deferred until needed.
- acquire emits a warn `[MOBILE-TEST] Dedicated feature on but no device resolved — falling back to shared pool {workspaceId, platform}` ONLY when flag is ON + workspaceId present + platform≠ios (ios fall-through is expected in v1, not a misconfig). Dedicated-hit info log already exists (Phase 2).
- Ops alert: watch that warn line. No schema change; sessionSource union already widened (Phase 2).
- Tests: 6/6 (warn on flag-on miss; no-warn on flag-off; no-warn on ios). Full mobile suite 191/191.

## Phase 7 — 🆕 Observability (original spec)

---

## Phase 4 — STATUS: DONE
- qait-infra `azure/scripts/setup-emulator-vm.sh`: ops runbook comment block — how to add a dedicated container (new port outside pool range → table row → POOL_ANDROID_EXCLUDED_PORTS → MOBILE_RUNNER_ALLOWED_HOSTS + flag). All four must move together; no auto-provision.
- qai-backend CLAUDE.md: mobile-regression flow now documents the tier-0 dedicated intercept + endDedicatedSession cleanup + server-derived workspaceId.
- qait-mobile-runner CLAUDE.md: session-lifecycle dedicated paragraph + `POST /:id/end-dedicated` route + `POOL_ANDROID_EXCLUDED_PORTS` env.
- FEATURE COMPLETE across all 3 repos. Remaining to GO LIVE: provision a container + table row + the 4 env/flag settings (ops), then flip DEDICATED_MOBILE_EMULATOR_ENABLED.

## Phase 4 — Infra + docs (original spec)
- **4.1** `qait-infra/azure/scripts/setup-emulator-vm.sh` + README: "add a dedicated container" = new redroid container on a port OUTSIDE pool range + row in `workspace_dedicated_device` + add port to `POOL_ANDROID_EXCLUDED_PORTS` + host in `MOBILE_RUNNER_ALLOWED_HOSTS`. No automation v1.
- **4.2** 🆕 Config-sync checklist (must move together): backend `DEDICATED_MOBILE_EMULATOR_ENABLED` + `MOBILE_RUNNER_ALLOWED_HOSTS` (incl. dedicated host) ↔ runner `POOL_ANDROID_EXCLUDED_PORTS`. A row in the table is useless if the host isn't allowlisted (SSRF guard rejects) or the port isn't excluded (pool steals it).
- **4.3** CLAUDE.md (same change):
  - `qai-backend/CLAUDE.md`: dedicated intercept (tier-0) before the 3-tier ladder; new table + db/; env flag; `sessionSource:'dedicated'`; lifecycle (end-without-destroy); security invariant.
  - `qait-mobile-runner/CLAUDE.md`: excluded-ports knob; serial-level lock; `end-dedicated` endpoint; dedicated-container ops contract.
  - 🆕 New `src/services/mobile/CLAUDE.md` (>8 files, hot): acquire tiers + ownerId coupling + dedicated routing.

---

## Edge cases / failure modes (all covered)
1. No mapping ⇒ resolver null ⇒ shared pool (unchanged). ✓
2. Inactive / platform-mismatch / ios-v1 ⇒ null ⇒ shared pool. ✓
3. Flag off ⇒ resolver null ⇒ zero behavior change. ✓
4. Dedicated container down ⇒ typed error, NO shared fallback. ✓
5. Legacy null workspace_id ⇒ Phase 0 backfill+NOT NULL; dispatcher throws if it slips. ✓
6. Pool/dedicated port collision ⇒ Phase 3 (init + recoverBroken). ✓
7. Tenant spoofing via projectId ⇒ 🆕 Phase 2.0 access guard + 2.4 server-derived workspaceId + test. ✓
8. 🆕 Two concurrent runs, same workspace, one device ⇒ Phase 5 serial-lock → DEVICE_BUSY + backend retry (v1 was WRONG that they serialize). ✓
9. Multi-user cap on dedicated redroid ⇒ ownerId=workspaceId reuses one Android user/workspace; OwnerUserMap handles cap/LRU. ✓
10. 🆕 Dedicated container destroyed each run ⇒ Phase 6 end-without-destroy + TTL exclusion. ✓
11. 🆕 ownerId no-op when runner multi-user off ⇒ Phase 2.5: isolation comes from the container, not the Android user; ownerId is defense-in-depth. ✓
12. 🆕 Editor warmup reuse vs dedicated ⇒ dedicated intercept runs first (2.2), preempts warmup. ✓
13. 🆕 Silent routing breakage ⇒ Phase 7 `sessionSource:'dedicated'` + ops alert. ✓
14. 🆕 iOS ⇒ resolver returns null for ios in v1 (no remote sim farm); falls to shared. ✓

## Out of scope (explicit)
- Lease / TTL-sharing / reserved-floor (rejected).
- Per-workspace dedicated runner (Model B) — `runner_url` column reserved; routing NOT built; if ever built, per-workspace runner_url MUST pass `validateRunnerUrl()` (SSRF) before use.
- Auto-provisioning containers.
- Frontend entitlement UI (optional, later — MobileSettings badge / pricing matrix).
- Dedicated iOS (physical-only; deferred).

## Build order
0 (data, 2 deploys) → 1 (table/resolver/flag) → 2.0 (security blocker) → 2.x (routing) → 5 (serial lock) + 6 (lifecycle) [runner-critical, land WITH backend routing] → 3 (port exclusion) → 7 (telemetry) → 4 (infra/docs).
Backend (0,1,2,7) and runner (3,5,6) in parallel branches but **5+6 must ship before enabling the flag in any env** — without them dedicated corrupts runs and kills containers.
