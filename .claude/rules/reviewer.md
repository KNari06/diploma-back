---
description: Code review checklist — BLOCK criteria and section references for MR review
alwaysApply: true
---

# Review checklist — qai-backend

## BLOCK criteria
Any of these → REQUEST_CHANGES before anything else.

**Architecture** (`architecture.md`)
- Route/controller contains business logic
- Service imports `supabaseAdmin` directly instead of going through `./db/`
- `db/` file contains logic or calls a service
- Job handler contains domain logic instead of delegating to a service

**File size** (`architecture.md`)
- File grew past ~400 lines without extracting a named concern

**Hard invariants** (`CLAUDE.md` §Hard invariants · `critical-patterns.md`)
- OpenAI role mapping skipped — raw `msg.role` passed instead of `convertRoleForOpenAI()`
- CDP session reused/piggybacked in preview context
- WebSocket handler has a silent `return` with no emit
- `{{key}}` interpolation done inline instead of through `resolvePlaceholders`
- New sink emits/logs/persists interpolated step body without running through `redactSecrets`
- Telemetry write can fail the test path
- Per-test-case chat emit routes to `chat:<sessionId>` instead of EXCLUSIVELY `chat:tc:<testCaseId>` (CLAUDE.md §Hard invariant #16 — global/editor chat leak)

**Testing** (`testing.md`)
- Unit test mocks Supabase directly instead of the `db/` sublayer

---

## Walk these sections
- **Folder placement** → `folder-structure.md`
- **Hard invariants detail** → `CLAUDE.md` §Hard invariants + `critical-patterns.md`
- **Code quality** → `code-quality.md` (N+1, schema field verification, no duplicates, import consistency, type-check, lint)
- **Testing** → `testing.md`
- **CLAUDE.md maintenance** → `structure.md`
- **Security** → `general.md`
- **Prompts** (only if `src/ai/` touched) → `prompt-optimization.md`
- **Code cleanliness** — no commented-out code, no `// added for Y` comments, no bare TODOs
