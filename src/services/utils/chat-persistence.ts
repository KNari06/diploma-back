/**
 * ChatPersistence — single switching point between the two chat backends.
 *
 * Why this façade exists
 * ──────────────────────
 * Intent handlers (general_chat, editor_action, …) need to save messages,
 * read recent history and trigger title generation. They used to call
 * `ChatService.*` directly — which always wrote to the global chat tables.
 *
 * Per-test-case chat introduces a parallel set of tables. We don't want
 * every handler to grow `if (chatStore.kind === 'testcase') ... else ...`
 * branches — that's how silent cross-writes happen (the legacy `else`
 * branch is the default and silently wins on missing-store bugs).
 *
 * Instead, handlers receive a `chatStore: ChatStore` in their params and
 * call `ChatPersistence.saveMessages(store, sid, msgs)`. The façade picks
 * the correct backend. There is no default — `store` is required at every
 * call site, and the compiler enforces it.
 *
 * Scope today
 * ───────────
 * Only the methods actually used by handler code are exposed:
 *   - saveMessages
 *   - getRecentMessages
 *   - autoGenerateTitle  (kicked off async after first user message)
 *
 * Embeddings and summarization are NOT routed through here yet — they
 * remain global-only on the test-case path. We'll lift them in a later
 * phase when long-tail test-case dialogs warrant it.
 *
 * Not exposed: anything that mutates session metadata (rename, delete,
 * project association, workspace context) — those go through the type-
 * specific service directly because the call sites already know which
 * surface they're on (REST endpoints under /chat/sessions/* vs.
 * /chat/test-cases/:id/session).
 */

import { ChatService } from './chat.service';
import { TestCaseChatService } from './test-case-chat.service';
import type { ChatMessageInput, ChatMessageRow, SavedMessage } from './chat-repository';
import type { ChatStore } from './chat-store';

export class ChatPersistence {
  /**
   * Persist a batch of messages. Returns inserted rows in input order
   * `{ id, created_at }` — same shape regardless of backend, so handler
   * code that destructures the result keeps working unchanged.
   *
   * Triggers async auto-title for test-case backend on first user message
   * (handled inside TestCaseChatService.saveMessages). Global backend
   * keeps its existing behavior — title generation is invoked explicitly
   * by callers, not on every save.
   */
  static async saveMessages(
    store: ChatStore,
    sessionId: string,
    messages: ChatMessageInput[],
  ): Promise<SavedMessage[]> {
    if (store.kind === 'testcase') {
      return TestCaseChatService.saveMessages(sessionId, messages);
    }
    return ChatService.saveChatMessages(sessionId, messages);
  }

  /**
   * Load up to `limit` most recent messages, oldest-first. Same shape on
   * both backends so handlers can map straight into OpenAI conversation
   * history without branching.
   *
   * Note on signature drift: legacy ChatService.getRecentMessages takes
   * an optional `userId` for ownership double-check. We don't pass it on
   * the test-case path because middleware (requireTestCaseAccess) has
   * already vetted ownership upstream — re-checking here would just
   * cost a round-trip without changing the security posture. Global path
   * keeps the legacy behavior (userId enforced) for backward compat.
   */
  static async getRecentMessages(
    store: ChatStore,
    sessionId: string,
    userId: string | undefined,
    limit: number = 20,
  ): Promise<ChatMessageRow[]> {
    if (store.kind === 'testcase') {
      return TestCaseChatService.getRecentMessages(sessionId, limit);
    }
    // Legacy contract — return type narrows; cast is safe because both
    // services produce the same shape modulo the `id` field which legacy
    // already includes per the SELECT in chat.service.ts:175.
    return ChatService.getRecentMessages(sessionId, userId, limit) as Promise<ChatMessageRow[]>;
  }

  /**
   * Generate a title from the first user message — best effort, errors
   * swallowed. Idempotent: both backends short-circuit if a title was
   * already generated (test-case backend uses a `WHERE title='New Chat'`
   * race guard; global backend overwrites — see ChatService.autoGenerateTitle).
   *
   * Callers should `void`-call this and not await — title generation
   * must never block the user-visible response.
   */
  static async autoGenerateTitle(
    store: ChatStore,
    sessionId: string,
  ): Promise<string | null> {
    if (store.kind === 'testcase') {
      return TestCaseChatService.autoGenerateTitle(sessionId);
    }
    return ChatService.autoGenerateTitle(sessionId);
  }
}
