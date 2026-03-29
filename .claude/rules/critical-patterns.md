---
description: Hard-won patterns from past bugs — CDP, WebSocket, CSS, concurrency, Playwright
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

## 2. NEVER create raw CDP sessions

Video screencast uses its own CDP session. Creating new CDP sessions (`context.newCDPSession(page)`) or calling `Accessibility.enable` WILL conflict and freeze video.

```typescript
// WRONG — conflicts with video screencast
const cdp = await context.newCDPSession(page);
await cdp.send('Accessibility.enable');

// CORRECT — use Playwright built-in APIs
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
