---
description: Testing rules — mock boundary, what to test, file placement, naming
alwaysApply: true
---

# Testing Rules

Runner: **Jest** (`npm test`, `npm run test:watch`)

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
