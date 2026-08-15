# `src/api/mobile/` — mobile REST surface (editor, sessions, CI/CD)

> Two auth worlds live here. Editor and session routes use a Supabase JWT;
> the CI routes use a per-project API key and are mounted **separately**.
> Getting that mount wrong is not a subtle bug — it makes a whole surface
> unreachable, silently. See § Two routers.

---

## Files

| File | Purpose |
| ---- | ------- |
| [mobile.route.ts](mobile.route.ts) | JWT-gated routes: app upload, variants, builds, permission policy, CI-**key** management. Mounted at `/api/v1/mobile` behind `requireAuth, requireApproved` |
| [ci.route.ts](ci.route.ts) | **CI-key-gated** routes, mounted separately at `/api/v1/mobile/ci`. Ends in a terminal 404 |
| [mobile.controller.ts](mobile.controller.ts) | Editor upload/finalize, app info, variants — thin, delegates to `services/mobile/mobile-app.service.ts` |
| [ci-app.controller.ts](ci-app.controller.ts) | CI build publish: `upload-url`, `finalize`, `whoami` |
| [ci.controller.ts](ci.controller.ts) | CI test runs: `POST /ci/run`, `GET /ci/run/:runId/status`. Its `appUrl` publish branch lives in `services/mobile/ci-url-publish.service.ts` |
| [ci-key.controller.ts](ci-key.controller.ts) | Generate / revoke / status for a project's CI API key (JWT-gated — a human creates the key) |
| [session.controller.ts](session.controller.ts) | Device session lifecycle: warmup, tap/swipe/type, apply, run-on-session, exploration |
| [companion.route.ts](companion.route.ts) · [companion.controller.ts](companion.controller.ts) | Companion relay — mixed auth, applied per route inside the router |
| [mobile-error-mapper.ts](mobile-error-mapper.ts) | `MobileAppError` tag → HTTP response; also the single funnel for runner errors (session-gone → 410, no-capacity → 503) |
| [mobile-request.helpers.ts](mobile-request.helpers.ts) | Body parsing shared by the controllers (`pickPlatform`, `parseVersionCode`, …) |

---

## Two routers, and why

`mobile.route.ts` is mounted behind `requireAuth, requireApproved`. A CI key
(`qai_ci_<hex>`) is not a Supabase JWT, so `verifyToken` rejects it **before**
any per-route middleware runs. CI routes therefore cannot live in that router —
they did once, and `POST /mobile/ci/run` had never worked for a single request.

```
index.ts:
  app.use('/api/v1/mobile/ci', ciRoutes)                               ← FIRST
  app.use('/api/v1/mobile', logWarmupOutcome, requireAuth, …, mobileRoutes)
```

Three consequences to keep in mind:

1. **Order is load-bearing.** Flip these two and every CI request 401s again.
   Guarded by `src/test/mobile-ci-route-mount.test.ts`, which asserts the
   ordering against `index.ts`'s source and drives a real Express app over HTTP.
2. **Express matches at segment boundaries**, so `/mobile/ci` does not capture
   `/mobile/projects/:id/ci-key` — CI *key management* stays JWT-gated, correctly.
3. `ciRoutes` ends in a **terminal 404**, so an unmatched `/mobile/ci/*` cannot
   fall through to the authed mount and answer `401 No token provided` — which
   reads as "your key is wrong" in a customer's CI log. The flip side: a future
   **authed** `/ci/...` route added to `mobile.route.ts` would silently 404.
   Add it to `ci.route.ts` instead.

---

## CI/CD build publish (a customer's pipeline uploads a build)

Three calls. The binary never transits the backend.

```
POST /ci/app/upload-url
  → requireCiApiKey  (indexed hash lookup → services/mobile/db/ci-auth.db.ts,
                      then owner not-deleted + approved)
  → isPaidUser → publish quota (MAX_CI_PUBLISHES_PER_HOUR, default 30/project/h)
  → NO mutex — minting a URL is cheap, and matrix lanes must not block
  → ci-app-publish.service.ts createCiUploadUrl
      (write-access check; lane = getProjectDefaultVariant, NOT literal 'default')
  → { uploadUrl, storagePath, requiredHeaders }

PUT <uploadUrl>   client → storage directly, carrying every requiredHeaders entry

POST /ci/app/finalize
  → per-storagePath mutex (reject: a resubmission is a duplicate, not a queue)
  → per-PROJECT mutex (wait up to 90s: parallel lanes queue, they do not fail)
  → finalizeMobileAppUpload({ source:'ci', enforceBuildContract:true })
  → parse (FORCED) → build-contract gate → recordBuild → settings merge
  → 201, then fire-and-forget pruneOldBuilds(resolved lane)

GET /ci/whoami → per-IP limiter → requireCiApiKey → { projectId } only
```

**Invariants:**

1. **`projectId` always comes from `req.ciProject`**, never the body or URL — the
   key *is* the project claim, so accepting a caller-supplied id is a straight IDOR.
2. **`requiredHeaders` is declared by the provider that minted the URL**
   ([blob-store.ts](../../services/storage/blob/blob-store.ts)), never inferred from
   the URL's hostname. Azure answers `400 MissingRequiredHeader` on a block-blob PUT
   without `x-ms-blob-type`. Note APK/IPA **writes are Azure-only by policy**
   (`getBlobStoreForWrite` throws otherwise), so a non-Azure environment fails loudly.
3. **`autoBootAndInstall` is NOT fired** on the CI path — there is no emulator at
   publish time. `pruneOldBuilds` IS, with the *resolved* lane, or it prunes a lane
   the upload never wrote to.
4. **A failed finalize deletes its orphaned object** — `pruneOldBuilds` only
   reclaims storage for rows it prunes, and paths are unique per call.
   **Except** when the path is outside the project's own tree: that case fires
   precisely when a caller supplies someone else's path, so deleting would make
   finalize a cross-tenant delete primitive. The backstop for everything this
   misses — a pipeline that dies between the PUT and the finalize, so no code
   path ever runs — is `MobileOrphanSweepJob`
   ([../../jobs/mobile-orphan-sweep.job.ts](../../jobs/mobile-orphan-sweep.job.ts)),
   which compares the container against the database directly.
5. **`whoami` returns `projectId` only.** Its output lands in CI logs, which are
   public for open-source repositories.
6. **Two publishes for one project must never overlap** — hold the per-project
   mutex (`ci_publish_lock:<projectId>`) around anything that finalizes a build.
   `finalizeMobileAppUpload` reads `project.settings`, spends 13-26s parsing,
   then writes a patch rebuilt from that snapshot, and `updateProject` merges
   settings SHALLOWLY — so overlapping publishes silently drop one lane's entry
   from `mobileAppVariants`, and the affected lane then resolves to the wrong
   binary with nothing in the logs. The old 1-per-5-minutes upload gate was the
   only thing preventing the overlap; the mutex replaces it. Any future path
   that finalizes a build needs the same lock. Rate limiting is NOT a
   substitute — it bounds frequency, not overlap.
7. **Redis mutexes here release by compare-and-delete**
   ([redis-mutex.ts](../../utils/core/redis-mutex.ts)), never a bare `del`: a
   holder that outlives its TTL would otherwise delete the NEXT holder's lock.

**The build contract** ([flutter-build-contract.ts](../../services/mobile/flutter-build-contract.ts)
+ [flutter-driver-static-detect.ts](../../services/mobile/flutter-driver-static-detect.ts))
hard-rejects a build QAIT cannot drive, with a remediation snippet in the body.
**CI-only** — the editor upload keeps its advisory banner, because a native
Android test needs no driver extension and a user may legitimately upload a
release build to inspect it. Enforcing it also **forces the binary parse**, which
the CI path would otherwise skip whenever the pipeline supplied full version
identity. See the ADR: [CI auth via a separate router + upload-time build contract](../../../.claude/decisions/20260727-ci-auth-via-separate-router-and-upload-time-build-contract.md).

---

## Gotchas

- **A host lane can only be written if the project has a build for it.**
  `PUT /projects/:id/app/flutter-host` answers **409 `HOST_BUILD_MISSING`** for
  `host: 'ios'` when no iOS build exists (base slot, legacy slot, or any named
  variant — the predicate is `hasProjectMobileBuild`). Same gate on the per-flow
  host (`flows.controller.ts`, 409) and the per-case `host_platform`
  (`IntentTestCaseService`, 400). Single source:
  [flutter-host-guard.service.ts](../../services/mobile/flutter-host-guard.service.ts) —
  **route every new host-writing path through it**, or the unrunnable pair comes
  back and fails 2 minutes later as an opaque WebDriverAgent timeout that blames
  the runner. Android is deliberately NOT gated (it is the implicit fallback
  lane; gating it would strand a project already on iOS). See the
  [ADR](../../../.claude/decisions/20260802-ios-host-lane-hard-blocked-without-an-ios-build.md).
- **`finalize` is slow and synchronous** — it downloads the whole build, parses
  it, and inflates a ~46 MB kernel blob. 13–26 s for a 146 MB APK. Any ingress
  timeout below the mutex TTL means a client 504s while the server works on.
- **The editor and CI upload paths share `mobile-app.service.ts`.** A change
  there hits both; only `enforceBuildContract` and `source` differ.
- **The publish limiter fails CLOSED (503), the `whoami` limiter fails OPEN.**
  The first mints signed storage-WRITE URLs whose orphans nothing collects; the
  second is read-only. Both go through
  [redis-rate-limit.middleware.ts](../../middleware/redis-rate-limit.middleware.ts) —
  note it checks `QueueManager.isRedisAvailable()` BEFORE issuing a command,
  because ioredis buffers commands while disconnected and a bare try/catch
  would stall the request instead of failing fast.
- Manual testing steps, including how to clear the publish counter and the
  per-project mutex between runs, are in [TESTING.md](../../../TESTING.md) § 7.
