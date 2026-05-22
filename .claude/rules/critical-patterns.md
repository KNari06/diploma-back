---
description: Hard-won patterns from past bugs — CDP, WebSocket, CSS, concurrency, Playwright, OpenAI role mapping, Supabase
alwaysApply: true
---

# Critical Patterns (from past incidents)

## 1. Check shared resource usage BEFORE changing code

Before modifying any code, check what ELSE uses the same resource:
- CDP session → video screencast may use it
- WebSocket room → multiple handlers may listen
- Page context → collectors, recorders, preview all share it
- Shared state (Redis, in-memory maps) → concurrent operations may conflict

```bash
# Find all usages of a resource before changing it
rg "resourceName" src/ --type ts
```

## 2. CDP sessions in preview — measured trade-off (Etap 2, May 2026)

**Background/regression contexts:** `context.newCDPSession(page)` is fine — no screencast, no conflict.

**Preview contexts (live editor with screencast):** empirically tested in `cdp-screencast-collision.integration.test.ts`:
- **Separate CDP session** (what Etap 2 opens): sparse pages → no impact; dense pages (~90ms snapshot) → brief FPS drop to ~11 during snapshot, recovers immediately to 60 FPS. Acceptable trade-off vs 16s evaluate freeze.
- **Piggyback on screencast session** (reuse `video-stream`'s session): **100% video freeze — WORSE than separate session.** Do NOT do this.
- Calling `Accessibility.enable` on a separate session: still freezes video (old pattern, still banned).

**Rule for Etap 2 code:** `CdpSnapshotService` opens its own session and detaches in `finally`. Never reuse `preview-video-stream.service.ts`'s session. For DevTools/a11y outside Etap 2, use Playwright built-in APIs:

```typescript
// WRONG — piggyback or accessibility.enable on any session in preview
const cdp = videoStreamSession; // 100% freeze
await cdp.send('Accessibility.enable'); // also wrong — freezes video

// CORRECT — Etap 2: own session, own lifecycle
const cdp = await context.newCDPSession(page);
try { /* snapshot */ } finally { await cdp.detach(); }

// CORRECT — DevTools outside Etap 2
const snapshot = await page.accessibility.snapshot();
const html = await page.content();
```

## 3. WebSocket handlers MUST always respond

NEVER silently `return` from a WebSocket handler without emitting a response. Frontend hangs on "Loading..." if no response arrives.

```typescript
// WRONG — frontend hangs forever
socket.on('preview:data:request', async () => {
  if (!session) return; // silent return = frontend stuck
});

// CORRECT — always emit response
socket.on('preview:data:request', async () => {
  if (!session) {
    socket.emit('preview:data:response', { error: 'No session' });
    return;
  }
  // ... process and emit response
});
```

## 4. CSS selector validation

Invalid selectors crash the ENTIRE `querySelectorAll` call, not just that one selector.

```typescript
// WRONG — @ is invalid in CSS attribute selectors
const selectors = ['button', '[@click]', 'a']; // crashes ALL

// CORRECT
const selectors = ['button', '[x-on\\:click]', 'a'];
```

Always use `CSS.escape()` when interpolating element IDs into selectors (React 18+ `useId()` generates IDs with `:` characters):

```typescript
// WRONG — breaks if id contains ':'
document.querySelector(`#${id}`);

// CORRECT
document.querySelector(`#${CSS.escape(id)}`);
```

## 5. DRY — always reuse existing code

Before writing new logic, search for existing implementations. Import and reuse rather than copy-paste. If existing code needs modification, refactor it to be reusable (extract to shared util) rather than creating a second copy.

```bash
# Search before implementing
rg "functionNameOrPattern" src/ --type ts
```

## 6. Playwright wait strategy (replay path)

- Use `waitUntil: 'load'` everywhere in replay path (NOT `domcontentloaded`)
- Auto-injected waitFor steps: `continueOnError: true`, 5s timeout
- New tab detection: after click, check `context.pages()` if URL didn't change — switch page if new tab opened

## 7. Concurrency guards

- Preview recording and step apply: reject during active run (`PreviewRunService.isRunning()`)
- In-memory mutex: per-testCase promise-chaining wraps DB writes
- Redis-based concurrent request prevention per chat session
- AbortController for request cancellation

## 8. Element resolution fallback chain

3-stage waterfall: compiled plan → LLM resolver → smart locator. Never skip stages — each catches cases the previous misses.

Upload fallback chain: `setInputFiles` → nearby hidden input + shadow DOM → `fileChooser` (3s) → synthetic drag-drop.

## 9. OpenAI role mapping

DB stores `'ai'`, OpenAI API requires `'assistant'`. Passing raw `msg.role` causes a 400 error.

```typescript
import { convertRoleForOpenAI } from "@/utils/helpers/chat-helpers";

// CORRECT
const messages = chatHistory.map((msg) => ({
  role: convertRoleForOpenAI(msg.role), // 'ai' → 'assistant'
  content: msg.content,
}));

// WRONG — 400 from OpenAI
const messages = chatHistory.map((msg) => ({
  role: msg.role,
  content: msg.content,
}));
```

- DB/TypeScript types: `'user' | 'ai' | 'system'`
- OpenAI accepts: `'user' | 'assistant' | 'system' | 'function' | 'tool' | 'developer'`
- Use `convertRoleForOpenAI()` before **every** OpenAI API call.

## 10. Supabase field verification

Before using a field in `.select()`, verify it exists in `supabase-migrations/supabase-schema.sql`. Querying a non-existent field returns no error — it silently returns `null`.

```typescript
// CORRECT — verified fields
.select("id, url, status, created_at")

// WRONG — fields don't exist, silent null
.select("test_id, created_date")
```

## 11. Supabase N+1 queries

Never call `.single()` inside a loop. Batch with `.in()`.

```typescript
// BAD — N+1
for (const r of results) {
  const test = await supabase.from("tests").select("*").eq("id", r.test_id).single();
}

// GOOD — one query
const testIds = results.map((r) => r.test_id);
const { data: tests } = await supabase.from("tests").select("*").in("id", testIds);
```
