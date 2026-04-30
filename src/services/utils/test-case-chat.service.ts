/**
 * TestCaseChatService — high-level façade for per-test-case chat persistence.
 *
 * One row per (user_id, test_case_id) in `test_case_chat_sessions`. Created
 * lazily on the first user message — never on read. Mirrors the public surface
 * of the legacy `ChatService` (saveChatMessages / getRecentMessages /
 * autoGenerateTitle / etc.) so handlers can swap the service reference and
 * keep the same call patterns.
 *
 * Scope decisions (intentional, can revisit):
 *   - No embeddings here. The TESTCASE_STORE.embeddings table exists, but the
 *     write path lives in chat-embeddings.service.ts which is GLOBAL_STORE-only
 *     today. Wiring it up is a separate phase — not blocking this release.
 *   - No summarization here. Same reason: chat-summarization.service.ts is
 *     GLOBAL_STORE-only today. The TESTCASE_STORE.summaries table is ready;
 *     the service-level integration ships when long-tail test-case dialogs
 *     warrant it.
 *   - No welcome-message insertion. Test-case chats start truly empty until
 *     the user types — that's the product spec.
 *
 * All persistence flows through ChatRepository, which is the only file that
 * speaks SQL for chat tables. That guarantees behavioral parity with the
 * global chat path on every shared code path.
 */

import { logger } from '@/utils/core/logger';
import { ChatRepository } from './chat-repository';
import type { ChatMessageRow, ChatSessionRow, ChatMessageInput, SavedMessage } from './chat-repository';
import { TESTCASE_STORE } from './chat-store';

// Re-export the row/input types so handlers can `import { ChatMessageRow }
// from '.../test-case-chat.service'` without reaching into the repository.
// Keeps the service the single import surface for the test-case path.
export type { ChatMessageRow, ChatSessionRow, ChatMessageInput, SavedMessage };

export class TestCaseChatService {
  /**
   * Lazy get-or-create for the (user, test case) chat session. Idempotent
   * under concurrent first-message races — backed by the DB UNIQUE constraint.
   *
   * IMPORTANT: callers must have already verified the user can access the
   * test case (see requireTestCaseAccess middleware in Phase 3). This method
   * does NOT re-check workspace membership — it trusts its input.
   */
  static async getOrCreateSession(
    userId: string,
    testCaseId: string,
  ): Promise<ChatSessionRow> {
    return ChatRepository.getOrCreateSessionByTestCase(TESTCASE_STORE, userId, testCaseId);
  }

  /**
   * Read-only session lookup. Returns null when the session has not been
   * created yet — that's the normal first-visit state, not an error.
   */
  static async findSession(
    userId: string,
    testCaseId: string,
  ): Promise<ChatSessionRow | null> {
    return ChatRepository.findSessionByTestCase(TESTCASE_STORE, userId, testCaseId);
  }

  /**
   * Save a batch of messages. Mirrors ChatService.saveChatMessages contract
   * (returns inserted rows in input order with id + created_at).
   *
   * Triggers async auto-title generation if this looks like the first user
   * message in the session — best-effort, errors swallowed so they can't
   * cascade into a failed POST /chat response.
   */
  static async saveMessages(
    sessionId: string,
    messages: ChatMessageInput[],
  ): Promise<SavedMessage[]> {
    const saved = await ChatRepository.saveMessages(TESTCASE_STORE, sessionId, messages);

    // Fire-and-forget auto-title; safe to skip if it fails.
    // Guard inside updateTitleIfDefault prevents clobbering manual renames.
    if (messages.some((m) => m.role === 'user')) {
      void TestCaseChatService.autoGenerateTitle(sessionId).catch((err) => {
        logger.warn('[TC_CHAT] autoGenerateTitle failed (non-fatal)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return saved;
  }

  /** Last `limit` messages, chronological. Same shape as ChatService.getRecentMessages. */
  static async getRecentMessages(
    sessionId: string,
    limit: number = 20,
  ): Promise<ChatMessageRow[]> {
    return ChatRepository.getRecentMessages(TESTCASE_STORE, sessionId, limit);
  }

  /** Cursor-paginated history for the frontend chat panel. */
  static async getMessagesPage(
    sessionId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<ChatMessageRow[]> {
    return ChatRepository.getMessagesPage(TESTCASE_STORE, sessionId, opts);
  }

  /** Defense-in-depth ownership check (middleware does the workspace join separately). */
  static async sessionBelongsToUser(sessionId: string, userId: string): Promise<boolean> {
    return ChatRepository.sessionBelongsToUser(TESTCASE_STORE, sessionId, userId);
  }

  /**
   * Generate a title from the first user message. Idempotent and safe to
   * call multiple times: the WHERE-default guard in the repo means we never
   * overwrite a user-renamed title.
   *
   * Returns the generated title, or null on any failure (validation, no first
   * message, race lost to a manual rename).
   */
  static async autoGenerateTitle(sessionId: string): Promise<string | null> {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return null;
    }
    try {
      const content = await ChatRepository.getFirstUserMessageContent(
        TESTCASE_STORE,
        sessionId,
      );
      if (!content) return null;

      // Trim noise, cap length. Keep aligned with ChatService.autoGenerateTitle.
      let title = content.trim();
      title = title.replace(/[#*`[\]]/g, '');
      title = title.replace(/https?:\/\/[^\s]+/g, '');
      title = title.trim();
      if (title.length > 50) title = title.substring(0, 50).trim() + '...';
      if (title.length < 5) title = 'New Chat';

      // Default-only update: race-safe vs explicit rename.
      const updated = await ChatRepository.updateTitleIfDefault(
        TESTCASE_STORE,
        sessionId,
        title,
      );
      if (!updated) return null; // user already renamed, leave it alone
      logger.info('[TC_CHAT] Auto-generated title', { sessionId, title });
      return title;
    } catch (error) {
      logger.error('[TC_CHAT] Error auto-generating title', { sessionId, error });
      return null;
    }
  }

  /** Explicit rename via PATCH endpoint. */
  static async setTitle(sessionId: string, title: string): Promise<void> {
    const trimmed = (title ?? '').trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new Error('Invalid title');
    }
    await ChatRepository.setTitle(TESTCASE_STORE, sessionId, trimmed);
  }

  /** Hard delete the whole session (cascades to messages/embeddings/summaries/feedback). */
  static async deleteSession(sessionId: string): Promise<void> {
    await ChatRepository.deleteSession(TESTCASE_STORE, sessionId);
  }

  /** Wipe messages but keep the session — preserves the open WS subscription. */
  static async clearMessages(sessionId: string): Promise<void> {
    await ChatRepository.clearMessages(TESTCASE_STORE, sessionId);
  }
}
