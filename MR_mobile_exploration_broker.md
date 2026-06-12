# MR: Mobile exploration broker + exploration-surface intent bias (backend)

**Branch:** `feat/mobile-exploration-broker` → `dev`
**Repo:** qai-backend
**Pairs with frontend MR:** `feat/exploration-chat-pr1` → `dev` (qai-frontend) — review/merge together.

---

## What this delivers

Moves mobile exploration from *browser→runner (API key in the browser)* to *browser→backend→runner*. The runner API key stays server-side; mobile runs flow through the **same** `exploration:*` events, history table, and live view as web. Also adds a soft intent bias so the Explore UI defaults ambiguous URL requests to exploration.

---

## Commits

- `5992144` soft exploration bias for the Exploration UI surface (`context.surfaceContext='exploration'`)
- `ddff589` broker runner exploration API server-side (Slice 1 — `MobileRunnerClient` explorer methods + readiness proxy route)
- `7267840` relay runner exploration socket → backend (Slice 2 — `MobileExplorationRelay`, adds `socket.io-client`)
- `25ee0dd` queue + worker + job + persistence (Slice 3)
- `dc313e2` close audit blockers: reconnect_failed, fast-run race, test-case persistence, SSRF, jobId (Slice 3.5)
- `53a05bd` REST endpoint to start a brokered mobile exploration (Slice 4)
- `b54bc21` forward chatSessionId to the job (Slice-5 audit pairing)

## Key files

- `services/mobile/mobile-runner-client.ts` — explorer methods (start/status/result/answer/cancel/readiness), key injected via existing `request()`.
- `services/mobile/mobile-exploration-relay.ts` (new) — connects to the runner socket with the server-held key, forwards `exploration:progress`/`completed` to the backend's emitters (stamped with chatSessionId+userId), `waitUntilDone()` for the job to await, idempotent teardown + reconnect/finished/timeout handling.
- `jobs/mobile-exploration-run.job.ts` (new) — records run, starts runner, holds relay, on completion fetches result + persists test cases.
- `services/testing/exploration/exploration-storage.service.ts` — `completeMobileRun` + `saveMobileTestCasesFromSnapshot` (direct insert from `flows[].mobile.cases[].intentSteps`).
- `config/infrastructure/queues.ts` — `mobile-exploration` queue + `addMobileExplorationJob` + job-data type.
- `worker/index.ts` — worker registration + shutdown.
- `api/mobile/session.controller.ts` + `mobile.route.ts` — `GET /exploration/readiness`, `POST /projects/:id/exploration/start`.
- `ai/prompts/intent-and-chat-prompts.ts` + `api/chat/shared/intent-parsing.ts` — `surfaceContext` + `applyExplorationSurfaceBias`.

## New dependency

`socket.io-client@^4.8` (matches `socket.io` server major) — for the relay to act as a socket client of the runner.

---

## Security (the B2C point)

- `MOBILE_RUNNER_API_KEY` is read **only** server-side (relay handshake + client headers) and is in no response body the browser consumes for exploration.
- The start endpoint trusts the **server-derived** runner socket URL (no client-supplied URL → no SSRF widening).
- `explorationId` uses `randomUUID` (it's the BullMQ jobId — `Date.now()` risked same-ms dedup collisions).

## Tests

`npx jest <files>` → **35 passing** across 5 suites: `mobile-runner-client.exploration`, `mobile-exploration-relay`, `mobile-exploration-run.job`, `start-mobile-exploration`, `intent-parsing`. `tsc --noEmit` clean on all touched files.

---

## Reviewer checklist

- [ ] Runner key never in a browser-bound payload; relay reads it from env only.
- [ ] Relay lifecycle: resolves `waitUntilDone()` on completed / reconnect_failed / timeout / stop; no leaked sockets (always torn down in the job's `finally`).
- [ ] Fast-run race: replayed `explorer:event` kind=finished synthesises completion (guarded against double-complete).
- [ ] Architecture: services don't import DB clients except the storage data-access layer; controller→queue is route→service.
- [ ] `attempts:1` (no retry) is intentional for long crawls (a re-run starts a fresh runner session).

## Known gaps / follow-ups

- **Persistence path is config-JSON, not columns** (decision): platform/appId/runnerSessionId ride in `exploration_runs.config` — no migration. Promote to columns later if SQL filtering by platform is needed.
- **No live end-to-end run verified** — the runner + a warmed emulator weren't available; coverage is unit-level. Recommend an integration smoke test against a real runner.
- **Live device-preview** still uses its own runner path on the frontend (out of scope; the exploration control path is fully brokered).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
