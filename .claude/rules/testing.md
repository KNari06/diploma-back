---
description: Testing rules — mock boundary, what to test, file placement, naming
alwaysApply: true
---

# Testing Rules

Runner: **Jest**, split into two lanes (`jest.config.js` → `projects`).

| Lane | What's in it | Command | In the merge gate? |
|---|---|---|---|
| `unit` | 531 files — everything self-contained | `npm test` | ✅ yes |
| `integration` | 13 files — every test needing real infrastructure (12 browser, 1 Redis) | `npm run test:integration` | ❌ no — run deliberately |

`npm run test:all` runs both. `npm test` is the unit lane only, so a green
`npm test` is the same thing CI checks.

A red MR names the failing test in GitLab's **Test summary** widget: the CI job
adds `--reporters=./scripts/jest-junit-reporter.js` (an in-repo reporter — jest
has no built-in one, and `jest-junit` is a dependency this repo will not add for
formatting) and uploads `junit.xml`. It is off in a local run; nothing to do.

## The `*.integration.test.ts` suffix means ONE thing: it needs real infrastructure

That suffix is the *only* thing that selects the lane — there is no path list to
maintain. So:

- **A new test that needs a browser, a real Redis, a real DB — anything the gate
  cannot provide — MUST be named `*.integration.test.ts`.**
  Otherwise it lands in the merge gate, where it is slow and, under CPU
  contention, fails as a *timeout* that looks exactly like a real hang. A parallel
  run once produced 37 backend failures, 15 of which were pure starvation and
  passed cleanly when run alone. That is what this split exists to prevent.
- **A test that needs nothing external must NOT carry the suffix**, even when
  it is "integration-ish" in the looser sense below. Two files were misnamed under
  this rule and renamed when the split landed (`allure-pipeline.test.ts`,
  `apply.service.db.test.ts`); both are fully in-process and deterministic, and
  belong in the gate.

⚠️ **Terminology collision, on purpose.** This repo already used "integration
test" for the `src/test/` files (real DB, supertest — see below). Those are NOT
in the browser lane: they are not named `*.integration.test.ts` and they run in
`unit`. When you read "integration" here, check which sense is meant — the
*filename suffix* always means browser.

Same shape as `qait-mobile-runner`, where the suffix means "needs a real device"
and CI skips it with `--exclude='*.integration*'`.

## Mock boundary

- **Unit tests** — mock at the service boundary. Services receive stubbed collaborators; never mock Supabase directly inside a service test.
- **Integration tests** — hit a real database. Never mock Supabase in `src/test/`.
- Mock WS/socket emissions freely — they're infrastructure, not business logic under test.

## What to test and where

| What | Where | How |
|---|---|---|
| Pure utilities / helpers | Colocated `__tests__/` | Unit, no mocks |
| Middleware | Colocated `__tests__/` | Unit, mock req/res |
| Service business logic | Colocated `__tests__/` | Unit, stub `db/` layer *(requires `db/` sublayer — see architecture.md)* |
| `db/` sublayer queries | `src/test/` | Integration, real DB |
| Route / controller flows | `src/test/` | Integration, supertest |
| AI prompt builders | Colocated `__tests__/` | Unit, snapshot or assertion on output string |

Routes and thin job handlers don't need their own tests — they're covered by integration tests.

## File placement

- Unit tests: `src/<same-path>/__tests__/<file>.test.ts` — matches existing middleware and handler pattern
- Integration tests: `src/test/<feature>.test.ts` — matches existing flat folder

## Naming

Describe behavior, not the function:
```
✓ "returns 401 when token is missing"
✗ "tests authenticate middleware"
```

## What not to test

- Implementation details (private methods, internal state)
- Thin wrappers that only delegate (route files, job handlers that immediately call a service)
- Config files
