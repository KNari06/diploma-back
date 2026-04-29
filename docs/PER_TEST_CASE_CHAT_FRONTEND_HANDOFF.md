# Per-Test-Case Chat — Frontend Integration Handoff

**Backend status:** Phase 1–9 shipped. All endpoints, WS events, persistence and feature flag are ready. Migration `supabase-migrations/20260429_test_case_chat.sql` waits to be applied.

**Frontend status:** zero integration done. Both `apps/web` (React/Vite) and `apps/desktop` (Electron/React/TS) need the same set of changes.

**Audience:** Frontend team integrating per-test-case chat in the AI Editor (TestSuitesWeb / TestSuitesMobile / desktop equivalents).

---

## 1. The product change in one sentence

When the user opens a test case in the AI Editor, the AI chat next to it must hold a private, persistent conversation **scoped to that test case**, not to the workspace. Today the chat is workspace-scoped — same dialog wherever you go.

---

## 2. What the backend gives you

### 2.1 New persistence (transparent to the client)

Five new tables (mirrors of the workspace chat tables):

| Workspace chat | Per-test-case chat |
|---|---|
| `chat_sessions` | `test_case_chat_sessions` |
| `chat_messages` | `test_case_chat_messages` |
| `chat_message_embeddings` | `test_case_chat_message_embeddings` (deferred — empty for now) |
| `chat_summaries` | `test_case_chat_summaries` (deferred — empty for now) |
| `message_feedback` | `test_case_message_feedback` |

Identity of a per-test-case chat is `(user_id, test_case_id)` — UNIQUE. **The session row does not exist until the user sends the first message.** GET endpoints return 404 / `hasSession: false` for an unsent test case.

### 2.2 New feature flag

`ENABLE_TEST_CASE_CHAT` (default `false`).

When OFF:
- `POST /api/v1/chat` with `testCaseId` → **501 Not Implemented** + `code: 'FEATURE_DISABLED'`
- `/api/v1/chat/test-cases/*` REST routes → **501** on every method
- `socket.emit('subscribe:chat:testcase')` → ack `{ ok: false, error: 'Per-test-case chat is not enabled in this deployment' }`

When ON: everything below works. Frontend should NOT silently fall back to legacy chat on 501 — show a feature-disabled state if needed (during staged rollout).

### 2.3 Authorization (no change in primitives)

- HTTP: same `Authorization: Bearer <jwt>` chain as `/api/v1/chat/*` (`requireAuth → requireApproved`). Plus new `requireTestCaseAccess` middleware verifies the caller is an active member of the workspace that owns `intent_test_cases.project_id → projects.workspace_id`. 404 / 403 returned with `code: 'TEST_CASE_NOT_FOUND' | 'ACCESS_DENIED'`.
- WebSocket: same JWT-in-`auth` handshake. The `subscribe:chat:testcase` handler runs the SAME workspace-membership check.

### 2.4 Intents that get blocked in test-case scope

Sending a message in a test-case chat with one of these intents will be **silently rewritten to `general_chat`** server-side (with a warning logged):

`platform_test`, `api_test`, `api_flow_test`, `mobile_test`, `mobile_action`, `mobile_agent`, `run_regression`, `run_plan`, `run_module`, `run_by_tag`, `create_plan`, `add_to_plan`, `save_test`.

Allowed: `general_chat`, `editor_action`, `needs_clarification`, `analyze_failure`, `coverage_analysis`, `test_recommendations`. Frontend doesn't need to detect or block these — backend handles it. Just don't be surprised when "create a regression plan" gives a chat reply instead of running anything.

---

## 3. REST endpoints

All under `/api/v1/chat/test-cases/:testCaseId/...`. Auth chain: `requireAuth → requireApproved → feature-flag gate → requireTestCaseAccess(params)`.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `GET` | `/session` | — | `{success, session: {id, title, context, created_at, updated_at}}` or **404** if no chat yet |
| `PATCH` | `/session` | `{title: string}` (1–200 chars) | `{success}` or 404 / 400 (invalid title) |
| `DELETE` | `/session` | — | `{success, deleted: boolean, sessionId?: string}`. Idempotent — 200 even if nothing existed. Cascades to messages/embeddings/summaries/feedback. |
| `POST` | `/session/clear` | — | `{success, cleared: boolean, sessionId?: string}`. Wipes messages, keeps the session row, resets title to `"New Chat"`. |
| `GET` | `/messages` | `?limit=50&before=<iso>` (limit clamped 1–100) | `{success, hasSession: false, messages: []}` if no session yet, otherwise `{success, hasSession: true, sessionId, messages: ChatMessageRow[]}`. Oldest-first within page. To page back: pass oldest message's `created_at` as next `before`. |
| `POST` | `/cancel` | — | `{success, cancelled: boolean, message?, sessionId?, reason?}`. Cancels in-flight LLM only — does NOT cancel running tests/preview/mobile (that's deferred Phase 10). |
| `POST` | `/feedback` | `{message_id, feedback_type: 'like'\|'dislike', intent_type?, context?}` | `{success, feedback}`. Idempotent — re-submitting flips the type via UPSERT. |
| `GET` | `/feedback/:messageId` | — | `{success, feedback}` or 404 (no feedback from this user) |
| `DELETE` | `/feedback/:feedbackId` | — | `{success}` or 404 |

### Message row shape

```ts
type ChatMessageRow = {
  id: string;
  role: 'user' | 'ai';        // backend stores 'ai'; OpenAI side maps to 'assistant'
  content: string;
  created_at: string;          // ISO 8601
  metadata?: any;              // free-form: {testId?, testType?, mode?, hasDraftSteps?, ...}
};
```

### Error response shape (uniform)

```json
{
  "success": false,
  "error": "<human message>",
  "code": "FEATURE_DISABLED" | "TEST_CASE_NOT_FOUND" | "ACCESS_DENIED" | "VALIDATION_ERROR" | ...,
  "timestamp": "ISO 8601"
}
```

---

## 4. POST /api/v1/chat — what changes

The existing endpoint stays. **One new optional body field:** `testCaseId?: string` (UUID).

When `testCaseId` is **present**:
- `sessionId` field in the body is **ignored** (the backend resolves session from `(user, testCaseId)` itself; lazy-creates if missing)
- `mode: 'editor'` continues to work alongside it
- `previewSessionId`, `pageContext` continue to work alongside it
- Persistence → `test_case_chat_messages`
- WS events emit to BOTH `chat:<sessionId>` AND `chat:tc:<testCaseId>` rooms (so subscribers on either side receive)

When `testCaseId` is **absent**: exactly today's behavior. Zero regression.

### Response

Same shape as today. `response.sessionId` will be the per-test-case session UUID (different namespace from workspace chat sessions). Save it locally if you need it for `/cancel` / `/feedback` shortcuts (see §5 caveat).

---

## 5. WebSocket protocol

Backend kept it minimal: **two new client→server events** + **same outbound events you already handle**.

### 5.1 New client → server events

```ts
// Subscribe
socket.emit(
  'subscribe:chat:testcase',
  { testCaseId: string },
  (response: { ok: boolean; error?: string; sessionId?: string }) => { ... }
);

// Unsubscribe
socket.emit('unsubscribe:chat:testcase', { testCaseId: string });
```

**Subscribe semantics:**
- Backend verifies workspace access (same `assertCanAccessTestCase` as REST).
- Joins your socket to room `chat:tc:<testCaseId>` immediately.
- If the per-test-case session row already exists for this user, ALSO joins `chat:<sessionId>` (covers history-driven emits from a returning user). Returns the resolved `sessionId` in the ack.
- If the session row does NOT exist yet (first visit), ack returns no `sessionId`. Subsequent first POST /chat creates the row server-side; backend dual-emits to both rooms automatically — your socket already in `chat:tc:<testCaseId>` receives it.

**Idempotent.** Re-subscribing is a no-op. Keep the same `subscribeToTestCaseChat(testCaseId)` Promise-wrapper pattern you already have for `subscribeToChat(sessionId)`.

**Ack timeout strategy:** mirror the existing 5-second ack timeout / retry-once logic from `subscribeToChat` (see `apps/web/src/services/websocketService.js:1283-1318`).

**Reconnect:** add the testCaseId to your `pendingSubscriptions` set so `restoreSubscriptions` can re-issue `subscribe:chat:testcase` after reconnection (parallel to how `chat:` keys are handled today).

### 5.2 Outbound events — UNCHANGED names

All existing chat events flow into the test-case room too:

- `chat:message`
- `chat:processing:step`
- `chat:test:update`

Frontend handlers don't need rewiring — they already listen by event name, room-agnostic. The same `setMessages([...prev, evt])` code works.

The only difference: when in test-case scope, your socket is subscribed to `chat:tc:<testCaseId>`, so events arrive there. When in workspace scope, they arrive in `chat:<sessionId>` as today.

### 5.3 Caveat: dual emit

If a socket happens to be in BOTH rooms (e.g. returning user with existing session, subscribed by `subscribe:chat:testcase` which joins both), the same `chat:message` event arrives **twice** — once per room. Frontend already de-dupes by `messageId` in the existing reducer, so this is safe, but be aware. (Server-side dedup would require a per-socket→tc map; not worth the cost.)

---

## 6. Identity & state — frontend implications

### 6.1 What you already have (good)

`apps/web/src/components/Home/TestSuitesWeb.jsx` already maintains an in-memory map `aiAgentSessionIdByKey[intentTestCaseId]` of session ids per test case (`TestSuitesWeb.jsx:2641`, `:5458`). It already parses `intentTestCaseId` from the URL `?intentTestCaseId=<UUID>` (`:2389-2415`). The Chat component is already passed a per-test-case `sessionId` prop in the editor (`TestSuitesWeb.jsx:12110-12124`).

**This is the right shape.** What's missing is wiring it through to the backend by passing `testCaseId` rather than (or alongside) `sessionId`.

### 6.2 Concrete glue you need to add

**In `<Chat />` component — the editor instance** (web: `apps/web/src/components/Home/Chat.jsx`, desktop: `apps/desktop/src/renderer/app/home/Chat.tsx`):

1. New prop `testCaseId?: string`. Pass it from TestSuitesWeb / TestSuitesMobile / desktop equivalents (where `intentTestCaseId` already lives in state).
2. In the message-send flow:
   - If `testCaseId` is present → call `wsService.subscribeToTestCaseChat(testCaseId)` (instead of `subscribeToChat(sessionId)`) BEFORE the POST.
   - Add `testCaseId` to the POST body.
   - **Drop** `sessionId` from the body when `testCaseId` is set — server ignores it, but cleaner.
3. On mount: call `chatService.getTestCaseSession(testCaseId)` and `chatService.getTestCaseMessages(testCaseId)` to load history. Treat 404 / `hasSession: false` as "open empty chat".
4. On unmount: `wsService.unsubscribeFromTestCaseChat(testCaseId)`. (See §6.4 — add this for both legacy and new paths if you can; tightens current leak.)

**No changes** in the workspace-chat usage of `<Chat />` (FloatingChatPanel etc.). Pass `testCaseId={undefined}` and the component falls back to today's behavior.

### 6.3 localStorage namespace — important

Today: `qai_chat_session_{user.id}_{workspace_id}` stores the workspace-chat sessionId (`Chat.jsx:626-629`).

Don't reuse this key for test-case sessions. They will collide and the user will see test-case messages "leak" into the workspace chat (or vice versa) on reload.

Recommended: `qai_chat_testcase_session_{user.id}_{testCaseId}` for the per-test-case sessionId cache. Also fine: don't cache it at all — the backend resolves `(user, testCaseId)` → sessionId on every `subscribe:chat:testcase` ack, so localStorage is just a latency optimization.

### 6.4 Cleanup on unmount — known existing bug worth fixing now

The current Chat component does NOT call `unsubscribeFromChat` when it unmounts (`Chat.jsx` ends without a useEffect cleanup for WS subs). For the workspace chat this leaks subscriptions across page navigations — annoying but not user-visible.

For test-case chat the user navigates between test cases far more frequently. Without a cleanup the user accumulates 5-10 active subs in 30 seconds. The server's per-socket subscription cap (configured high but finite) will eventually deny new subs.

**Add a cleanup `useEffect`** in Chat that calls the appropriate `unsubscribeFromXxx(...)` based on which mode it's in. Apply this fix to the legacy path too — it's the same one-liner.

---

## 7. The two send-flows side by side

**Workspace chat (today, unchanged):**

```
1. ensureSessionId()                          ← from localStorage / createNewSession
2. await wsService.subscribeToChat(sid)       ← ack within 5s
3. await chatService.sendMessage({sessionId: sid, message, ...})
4. response.reply  →  append to UI
5. wait for chat:message WS event             ← in case of streaming / sub-agents
```

**Test-case chat (new):**

```
1. await wsService.subscribeToTestCaseChat(testCaseId)
                                              ← ack returns {ok, sessionId?}
                                              ← stash sessionId if present (for /cancel)
2. await chatService.sendMessage({testCaseId, message, ...})
                                              ← NO sessionId in body
                                              ← response.sessionId is the (user, testCaseId) row
3. response.reply  →  append to UI
4. wait for chat:message WS event in chat:tc:<testCaseId> room
```

The two flows are **structurally identical** — only the subscribe call and the body field change.

---

## 8. Frontend file changes — checklist

### Web (`apps/web/src/`)

| File | Change |
|---|---|
| `services/websocketService.js` | Add `subscribeToTestCaseChat(testCaseId)` and `unsubscribeFromTestCaseChat(testCaseId)`. Mirror the in-flight dedup, ack timeout/retry, and `pendingSubscriptions` patterns used by `subscribeToChat` (lines 1205–1351). Use subscription key prefix `chat:tc:<testCaseId>` so it cohabits with existing `chat:<sid>` keys cleanly. |
| `services/chatService.js` | Add: `getTestCaseSession(testCaseId)`, `getTestCaseMessages(testCaseId, {limit, before})`, `updateTestCaseSessionTitle(testCaseId, title)`, `clearTestCaseSession(testCaseId)`, `deleteTestCaseSession(testCaseId)`, `cancelTestCaseChat(testCaseId)`, `sendTestCaseFeedback(testCaseId, payload)`, `getTestCaseFeedback(testCaseId, messageId)`, `deleteTestCaseFeedback(testCaseId, feedbackId)`. Each is a thin wrapper around the matching REST endpoint in §3. |
| `config/api.js` | Add `CHAT.TEST_CASE_BASE: '/api/v1/chat/test-cases'` constant; concatenate `:testCaseId` in service calls. |
| `components/Home/Chat.jsx` | (1) Accept `testCaseId` prop. (2) Branch the subscribe + POST flow by `testCaseId`. (3) Use a separate localStorage namespace if caching. (4) Add cleanup `useEffect` calling `unsubscribeFromTestCaseChat` (and `unsubscribeFromChat` for the legacy path). (5) On 501 responses with `code: FEATURE_DISABLED` → render an "AI assistant is rolling out" empty state instead of erroring. |
| `components/Home/TestSuitesWeb.jsx` | Pass `testCaseId={intentTestCaseId}` into `<Chat />` at line 12110. The variable already exists at `:2408`. |
| `components/Home/TestSuitesMobile.jsx` | Same — pass `testCaseId` into `<Chat />` at line 12597. |
| `i18n/locales/{en,ru,kk}.js` | Add strings: empty-state for new test-case chat, 501 feature-off message, "Per test case" UI label if any. |

### Desktop (`apps/desktop/src/renderer/app/`)

| File | Change |
|---|---|
| `realtime/socketClient.ts` | Add `subscribeToTestCaseChat(testCaseId: string): Promise<{sessionId?: string}>` and `unsubscribeFromTestCaseChat(testCaseId: string): void`. Same patterns as `subscribeToChat` (line 518). |
| `services/chatService.ts` | Mirror the web service additions. Extend `SendMessagePayload` interface (line 52) with `testCaseId?: string`. |
| `home/Chat.tsx` | Mirror Chat.jsx changes — props, branch logic, cleanup, 501 handling. |
| Equivalent of TestSuitesWeb in desktop | Pass `testCaseId` into `<Chat />`. |
| `i18n/...` | Same strings. |

---

## 9. Smoke-test checklist (manual on staging)

Backend will be flipped ON via env (`ENABLE_TEST_CASE_CHAT=true`). Frontend smoke tests:

1. **Feature off path** — set `ENABLE_TEST_CASE_CHAT=false`. Open a test case. Send a message → expect 501 + UI handles gracefully.
2. **Empty first visit** — `ENABLE_TEST_CASE_CHAT=true`. Open a test case never used before → empty chat, no errors.
3. **First message** — type, send → user message saves, AI reply arrives via WS.
4. **Reload** — reload the page → history loads from `GET /messages`, conversation continues.
5. **Switch test cases** — open test case A, send 2 msgs. Open test case B → empty. Open A again → 2 msgs back. **Critical: messages must NOT bleed between test cases.**
6. **Two tabs** — open same test case in two tabs. Send from tab 1 → both tabs see the message in real time.
7. **Cancel** — start a long message, hit cancel → aborts within ~1s.
8. **Like/dislike** — 👍 a message, reload, the 👍 persists.
9. **Workspace chat unaffected** — open the floating chat panel (workspace), send a message → still works exactly as before.
10. **Delete test case** — delete a test case from the test list → its chat session should be gone (verify via DB or by re-creating a test case with the same name and confirming empty chat).

---

## 10. Open questions for product / frontend team

These need a frontend product call — backend doesn't dictate:

1. **UI for "empty test case chat"** — what does the empty state look like? Welcome card with suggested actions? Just a placeholder? Different from the workspace-chat empty state?
2. **Same component or new component** — keep using `<Chat />` polymorphic, or fork a `<TestCaseChat />`? My read of the code suggests polymorphic is fine — the component already accepts `previewSessionId`, `mobileSessionId`, `embedded`, etc. so adding `testCaseId` is one more switch. But it's your call if you'd prefer narrowing the surface.
3. **Title / rename UI** — backend supports PATCH `/session` to rename. Do you want a UI for it on the per-test-case chat? (Workspace chat already has rename UI via `/sessions/:sessionId` PATCH — same shape.)
4. **localStorage caching policy** — cache per-test-case sessionId locally for fewer round-trips, or keep the source of truth on the server and resolve every subscribe? Either is fine; pick one and document.
5. **Quick-actions in editor mode** — the editor chat surfaces a "Save as test case" quick action via `metadata.quickActions` in `chat:message`. For a test-case chat this is moot (you ARE the test case). Backend doesn't emit it for `editor_action` intent in test-case scope, but if the legacy quick-action endpoint `POST /preview/draft/save-as-test-case` is invoked from there, it currently doesn't accept `testCaseId` (deferred Phase 14). Decide if you want to render or hide these actions.
6. **Handling 13 blocked intents** — the user typing "run regression on this test" will get an AI text reply that doesn't actually run anything. Do you want a UI hint ("Try this from the test list", etc.) or accept the silent rewrite? Backend gives no signal — would need a new `parsedIntent.blockedFromTestCaseScope: true` flag if you want the hint. (Easy to add — open an issue if you want it.)

---

## 11. Reference — backend files (read-only, do not modify from FE)

If anyone needs to confirm contracts:

- `src/api/chat/test-case-chat.route.ts` — REST routes
- `src/api/chat/chat.controller.ts:175` — POST /chat branching by `testCaseId`
- `src/api/chat/shared/test-case-access.ts` — auth helper
- `src/services/utils/test-case-chat.service.ts` — service surface
- `src/websocket/handlers/subscription.handler.ts:732` — `subscribe:chat:testcase` handler
- `src/websocket/types/types.ts` — WS event type definitions (canonical client contract)
- `supabase-migrations/20260429_test_case_chat.sql` — schema
- `src/test/test-case-chat.test.ts` — invariants (read-only — defines what we promised won't break)

---

## 12. Rollout sequence

1. Apply migration on dev (`psql $DEV_DB -f supabase-migrations/20260429_test_case_chat.sql`).
2. Deploy backend (flag still OFF). Verify no regression on workspace chat.
3. Frontend ships changes behind a frontend-side feature toggle (or no toggle — backend's 501 is enough).
4. Flip `ENABLE_TEST_CASE_CHAT=true` on dev. Run smoke tests §9.
5. Staging → prod, with 24h soak between each step.
6. Rollback: `ENABLE_TEST_CASE_CHAT=false` + restart. No data loss; existing test-case chat rows just become inaccessible until re-enabled.

---

## 13. Contacts

Backend questions: open issue with label `per-test-case-chat`. Reference this doc and quote the exact endpoint / event you're stuck on. Backend invariants are pinned by `src/test/test-case-chat.test.ts` — if a backend change would break that file, it shouldn't ship without a paired frontend update.
