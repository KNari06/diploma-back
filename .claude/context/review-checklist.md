# Review checklist — qai-backend

Used by `senior-reviewer` and for self-review before MR. Walk every section; skip a section only if no changed file touches it.

## Before starting

- [ ] Read `CLAUDE.md` (root) — hard invariants section.
- [ ] Read `.claude/rules/critical-patterns.md`, `code-quality.md`, `folder-structure.md`.
- [ ] Run `git diff <base>...HEAD --stat` then `git diff <base>...HEAD` — review ALL commits on the branch, not just the latest.

---

## Folder placement (`folder-structure.md`)

- [ ] No `.ts` files in the root of `src/`, `src/agent/`, `src/services/`, `src/websocket/`, `src/utils/`, `src/config/` (only `index.ts` barrel allowed).
- [ ] New LiteEngine piece → `src/agent/core/lite/<correct-subfolder>/`.
- [ ] New service → correct subfolder under `src/services/ai/`, `src/services/testing/`, etc. — not flat in `src/services/`.
- [ ] New REST route → `src/api/<domain>/` folder, wired into `src/index.ts`.
- [ ] New WS handler → `src/websocket/handlers/<name>.handler.ts`. Preview events stay in `preview.handler.ts`.
- [ ] New BullMQ job → `src/jobs/<name>.job.ts`, registered in `src/worker/index.ts`.
- [ ] New prompt → `src/ai/prompts/` flat layout.
- [ ] Import paths match the actual structure — no stale `@/services/ai/openai.service` style aliases.

---

## Hard invariants (`CLAUDE.md` + `critical-patterns.md`)

These are BLOCK-level issues.

- [ ] **OpenAI role mapping** — `convertRoleForOpenAI()` called before every OpenAI API call. Raw `msg.role` (`'ai'`) never passed directly.
- [ ] **CDP in preview** — no `context.newCDPSession(page)` piggybacking on the screencast session; no `Accessibility.enable` in preview context. Playwright built-ins (`page.accessibility.snapshot()`, `page.content()`) used instead. Etap 2 exception: own session + `finally { cdp.detach() }` only.
- [ ] **WebSocket handlers always emit** — no silent `return` from any `socket.on(...)` handler. Every code path emits a response.
- [ ] **CSS selectors** — `CSS.escape()` used when interpolating element IDs. No `@` in attribute selectors.
- [ ] **Playwright replay path** — `waitUntil: 'load'` everywhere (not `'domcontentloaded'`).
- [ ] **Concurrency guards** — `PreviewRunService.isRunning()` checked before any recording+apply conflict. Redis mutex in place for chat session. `AbortController` used for cancellable requests.
- [ ] **Element resolution** — 3-stage waterfall (compiled plan → LLM resolver → smart locator) intact. No stages skipped.
- [ ] **`resolvePlaceholders`** — all `{{key}}` interpolation goes through `resolvePlaceholders`. No inline `.replace(/\{\{…\}\}/g, …)` elsewhere.
- [ ] **Secret redaction** — any new sink that emits, logs, or persists interpolated step bodies runs through `redactSecrets` / `buildStepRedactor`. DB persistence stores original `{{...}}` placeholder, not resolved value.
- [ ] **Telemetry writes are best-effort** — new telemetry sinks wrapped in try/catch that `logger.warn`s and swallows. Never allowed to fail the test path.
- [ ] **Shared resource check** — before modifying code that touches a CDP session, WS room, page context, or Redis/in-memory map: verified all other users of that resource. `rg "resourceName" src/ --type ts` evidence exists.

---

## Code quality (`code-quality.md`)

- [ ] No N+1 queries — no per-item `supabase.from(...).single()` inside a loop. Batched with `.in()`.
- [ ] DB fields verified — every field in `.select()` exists in `supabase-migrations/supabase-schema.sql`.
- [ ] No duplicates — searched for existing functionality before creating a new file. `rg` evidence.
- [ ] Import consistency — after any export change, all import sites updated (`rg "import.*from.*changed-module" src/`).
- [ ] `npm run type-check` passes.
- [ ] `npm run lint` passes.

---

## CLAUDE.md maintenance (`structure.md`)

- [ ] New top-level service or class in a hot folder → row added to that folder's `CLAUDE.md` file table.
- [ ] New WS event or REST route → relevant flow section in CLAUDE.md updated.
- [ ] New project-wide invariant → added to root `CLAUDE.md` hard invariants, or the folder's Invariants section.
- [ ] Renamed/moved/deleted file referenced in any CLAUDE.md → reference updated or removed.
- [ ] `doc-map.js` updated if a new service file was added that should have an API doc.

---

## Security (`general.md`)

- [ ] No hardcoded keys, tokens, or secrets — `process.env` only.
- [ ] No sensitive data logged outside `debug` level.
- [ ] Input validated at system boundaries (user input, external API responses).

---

## Prompt changes (only when `src/ai/prompts/` or `src/services/ai/` touched — `prompt-optimization.md`)

- [ ] Context-first logic — intent understood from sentence structure, not keyword matching.
- [ ] Tested scenarios pass: `"Test this API https://..."` → `api_test`, `"Did you run API test?"` → `general_chat`.
- [ ] Token efficiency acceptable: no large prompt growth for marginal accuracy gain.

---

## Code cleanliness

- [ ] No commented-out code blocks.
- [ ] No `// removed X`, `// added for Y`, `// used by Z` comments.
- [ ] Comments only where WHY is non-obvious (workaround, hidden constraint, surprising invariant).
- [ ] No TODOs without a ticket reference.
- [ ] No unused imports or dead code.
