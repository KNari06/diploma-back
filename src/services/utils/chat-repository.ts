/**
 * ChatRepository — parameterized data-access layer for chat persistence.
 *
 * Every method takes a `ChatStore` as its first argument and routes reads/writes
 * to the corresponding tables. Business logic (auto-title, embedding triggers,
 * summarization triggers, intent routing) lives ONE LAYER ABOVE this — in the
 * concrete services (`ChatService`, `TestCaseChatService`). This file is the
 * single place where SQL-shape decisions for chat tables exist.
 *
 * Why this layer exists:
 *   1. Compile-time isolation: `ChatStore` is a required parameter on every
 *      method, so a global-chat call site can never accidentally read/write
 *      test-case tables (and vice versa).
 *   2. Behavioral parity: when fixing a bug in chat persistence, the fix lands
 *      once and applies to both backends. No copy/paste drift.
 *
 * Behavior is intentionally identical to the legacy ChatService — same query
 * timeouts, same sort tiebreakers, same graceful-degradation error policy.
 * Improvements should land here in a separate PR after the migration settles.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { redactCredentials } from '@/utils/security/redact-credentials';
import type { ChatStore } from './chat-store';

const QUERY_TIMEOUT_MS = 10_000;

export type ChatRole = 'user' | 'ai';

export interface ChatMessageInput {
  role: ChatRole;
  content: string;
  // `any` matches the legacy ChatService signature so handlers passing
  // testResult / testId / hasDraftSteps blobs don't need TS coercion.
  // Runtime safety comes from the per-record validation below.
  metadata?: any;
}

export interface SavedMessage {
  id: string;
  created_at: string;
}

export interface ChatMessageRow {
  id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  // See ChatMessageInput.metadata note — kept `any` for legacy parity.
  metadata?: any;
}

export interface ChatSessionRow {
  id: string;
  user_id: string;
  title: string;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Race a Supabase query against a hard timeout. Mirrors the original
 * pattern in ChatService.getRecentMessages so behavior is unchanged.
 */
async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} query timed out`)), QUERY_TIMEOUT_MS),
  );
  return Promise.race([p, timeoutPromise]);
}

export class ChatRepository {
  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Insert a batch of messages. Increments timestamps by 1ms per record so
   * (user, ai) pairs preserve order even when written in the same tick.
   * Returns inserted rows in input order: [{id, created_at}, ...].
   *
   * Filters invalid rows silently (matches legacy behavior — chat must keep
   * working even if a malformed metadata object slips through).
   */
  static async saveMessages(
    store: ChatStore,
    sessionId: string,
    messages: ChatMessageInput[],
  ): Promise<SavedMessage[]> {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('Invalid sessionId');
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      logger.warn('[CHAT_REPO] No messages to save', { store: store.kind, sessionId });
      return [];
    }

    const validMessages = messages.filter(
      (msg) =>
        msg &&
        typeof msg === 'object' &&
        (msg.role === 'user' || msg.role === 'ai') &&
        msg.content &&
        typeof msg.content === 'string' &&
        msg.content.trim().length > 0,
    );

    if (validMessages.length === 0) {
      logger.warn('[CHAT_REPO] No valid messages to save', {
        store: store.kind,
        sessionId,
        totalMessages: messages.length,
      });
      return [];
    }
    if (validMessages.length < messages.length) {
      logger.warn('[CHAT_REPO] Filtered out invalid messages', {
        store: store.kind,
        sessionId,
        valid: validMessages.length,
        invalid: messages.length - validMessages.length,
      });
    }

    // 1ms increment per message preserves ordering within the same batch.
    // Redact bare-shape secrets (pasted bot tokens / webhook URLs) at this
    // single write choke point so every chat surface is covered.
    const baseTime = Date.now();
    const records = validMessages.map((msg, index) => ({
      session_id: sessionId,
      role: msg.role,
      content: redactCredentials(msg.content.trim()),
      metadata: msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {},
      created_at: new Date(baseTime + index).toISOString(),
    }));

    const { data, error } = await supabaseAdmin
      .from(store.messages)
      .insert(records)
      .select('id, created_at');

    if (error) {
      logger.error('[CHAT_REPO] Failed to save chat messages', {
        store: store.kind,
        sessionId,
        recordCount: records.length,
        error: error instanceof Error ? error.message : String(error),
        code: (error as any).code,
      });
      throw error;
    }

    logger.info('[CHAT_REPO] Saved messages', {
      store: store.kind,
      sessionId,
      messageCount: records.length,
    });

    return (data ?? []).map((row: any) => ({
      id: row.id,
      created_at: row.created_at,
    }));
  }

  /**
   * Load up to `limit` most recent messages, returned in chronological order
   * (oldest first). Graceful degradation: any error returns [] so chat keeps
   * working without history rather than 500-ing on the user.
   */
  static async getRecentMessages(
    store: ChatStore,
    sessionId: string,
    limit: number = 20,
  ): Promise<ChatMessageRow[]> {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      logger.warn('[CHAT_REPO] Invalid sessionId in getRecentMessages', {
        store: store.kind,
        sessionId: typeof sessionId,
      });
      return [];
    }

    const validLimit = Math.max(1, Math.min(100, Math.floor(limit || 20)));

    try {
      const queryPromise = supabaseAdmin
        .from(store.messages)
        .select('id, role, content, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }) // tiebreaker for same-ms timestamps
        .limit(validLimit);

      let data: any[] | null;
      let error: any;
      try {
        const result = (await withTimeout(
          queryPromise as unknown as Promise<{ data: any[] | null; error: any }>,
          'Chat messages',
        )) as { data: any[] | null; error: any };
        data = result.data;
        error = result.error;
      } catch {
        logger.error('[CHAT_REPO] Query timed out fetching recent messages', {
          store: store.kind,
          sessionId,
          timeoutMs: QUERY_TIMEOUT_MS,
        });
        return [];
      }

      if (error) {
        logger.error('[CHAT_REPO] Failed to get recent messages', {
          store: store.kind,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
        });
        return [];
      }

      const validData = Array.isArray(data) ? data : [];

      // Sort DESC by (created_at, id), then reverse to chronological ASC.
      const sortedData = validData.sort((a, b) => {
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        if (ta !== tb) return tb - ta;
        return b.id.localeCompare(a.id);
      });
      const messages = sortedData.reverse();

      const validMessages: ChatMessageRow[] = messages.filter(
        (msg) =>
          msg &&
          typeof msg === 'object' &&
          (msg.role === 'user' || msg.role === 'ai') &&
          msg.content &&
          typeof msg.content === 'string' &&
          msg.created_at,
      );

      if (validMessages.length < messages.length) {
        logger.warn('[CHAT_REPO] Filtered out invalid messages on read', {
          store: store.kind,
          sessionId,
          valid: validMessages.length,
          invalid: messages.length - validMessages.length,
        });
      }
      return validMessages;
    } catch (error) {
      logger.error('[CHAT_REPO] Error getting recent messages', {
        store: store.kind,
        sessionId,
        error,
      });
      return [];
    }
  }

  /**
   * Cursor-paginated message list for the frontend chat history view.
   * `before` is an ISO timestamp; rows older than it are returned, oldest first
   * within the page so the UI can append directly.
   */
  static async getMessagesPage(
    store: ChatStore,
    sessionId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<ChatMessageRow[]> {
    if (!sessionId) return [];
    const limit = Math.max(1, Math.min(100, Math.floor(opts.limit || 50)));

    let q = supabaseAdmin
      .from(store.messages)
      .select('id, role, content, created_at, metadata')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    if (opts.before) q = q.lt('created_at', opts.before);

    const { data, error } = await q;
    if (error) {
      logger.error('[CHAT_REPO] Failed to fetch messages page', {
        store: store.kind,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    return (data ?? [])
      .filter(
        (m: any) =>
          m && (m.role === 'user' || m.role === 'ai') && typeof m.content === 'string',
      )
      .reverse() as ChatMessageRow[];
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Atomic upsert: returns existing session for (user_id, test_case_id) or
   * creates one. The DB UNIQUE constraint guarantees idempotency under
   * concurrent first-message races (e.g. user double-clicks send).
   *
   * Used by the test-case service. The global service has its own get-or-create
   * keyed by (user_id, workspace_id) which lives in legacy code untouched.
   */
  static async getOrCreateSessionByTestCase(
    store: ChatStore,
    userId: string,
    testCaseId: string,
    seed: { title?: string; context?: Record<string, unknown> } = {},
  ): Promise<ChatSessionRow> {
    if (store.kind !== 'testcase') {
      throw new Error(
        `getOrCreateSessionByTestCase requires TESTCASE_STORE, got ${store.kind}`,
      );
    }
    if (!userId || !testCaseId) {
      throw new Error('userId and testCaseId are required');
    }

    // Atomic upsert keyed on the (user_id, test_case_id) UNIQUE constraint.
    // `ignoreDuplicates: true` makes the call a no-op when the row already
    // exists (vs overwriting title/context). The follow-up SELECT then reads
    // the canonical row regardless of which branch happened.
    //
    // Why two queries: Supabase JS returns no row from `.upsert(...).select()`
    // when ignoreDuplicates skips the write — we'd have to do the SELECT
    // anyway. Net cost: 1 round-trip on cold path, 1 round-trip on warm path
    // (Postgres handles the conflict in-engine, no extra network hop).
    const { error: upsertError } = await supabaseAdmin
      .from(store.sessions)
      .upsert(
        {
          user_id: userId,
          test_case_id: testCaseId,
          title: seed.title ?? 'New Chat',
          context: seed.context ?? {},
        },
        { onConflict: 'user_id,test_case_id', ignoreDuplicates: true },
      );

    if (upsertError) {
      logger.error('[CHAT_REPO] Failed to upsert test-case session', {
        userId: userId.substring(0, 8),
        testCaseId,
        code: (upsertError as any).code,
        error: upsertError instanceof Error ? upsertError.message : String(upsertError),
      });
      throw upsertError;
    }

    const { data, error } = await supabaseAdmin
      .from(store.sessions)
      .select('id, user_id, title, context, created_at, updated_at')
      .eq('user_id', userId)
      .eq('test_case_id', testCaseId)
      .maybeSingle();

    if (error || !data) {
      logger.error('[CHAT_REPO] Failed to read test-case session after upsert', {
        userId: userId.substring(0, 8),
        testCaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error ?? new Error('Session not found after upsert');
    }

    return data as ChatSessionRow;
  }

  /**
   * Read the test-case session if it exists. Returns null if not yet created
   * (lazy-create model — first POST /chat creates it; this never does).
   */
  static async findSessionByTestCase(
    store: ChatStore,
    userId: string,
    testCaseId: string,
  ): Promise<ChatSessionRow | null> {
    if (store.kind !== 'testcase') {
      throw new Error(`findSessionByTestCase requires TESTCASE_STORE, got ${store.kind}`);
    }

    const { data, error } = await supabaseAdmin
      .from(store.sessions)
      .select('id, user_id, title, context, created_at, updated_at')
      .eq('user_id', userId)
      .eq('test_case_id', testCaseId)
      .maybeSingle();

    if (error) {
      logger.error('[CHAT_REPO] findSessionByTestCase failed', {
        userId: userId.substring(0, 8),
        testCaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    return (data as ChatSessionRow) ?? null;
  }

  /**
   * Verify session belongs to user. Returns true on owner match.
   * Used by every mutating endpoint to enforce ownership at the data layer
   * even when middleware misses (defense in depth).
   */
  static async sessionBelongsToUser(
    store: ChatStore,
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from(store.sessions)
      .select('user_id')
      .eq('id', sessionId)
      .maybeSingle();
    return !!data && (data as any).user_id === userId;
  }

  /**
   * Update title, but only if it's still the default. This is a race guard for
   * `autoGenerateTitle`: if the user manually renamed the chat between the
   * first message and async title generation, we don't clobber their choice.
   */
  static async updateTitleIfDefault(
    store: ChatStore,
    sessionId: string,
    title: string,
  ): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from(store.sessions)
      .update({ title })
      .eq('id', sessionId)
      .eq('title', 'New Chat')
      .select('id');
    if (error) {
      logger.error('[CHAT_REPO] updateTitleIfDefault failed', {
        store: store.kind,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }

  /**
   * Force-update title (used by explicit PATCH endpoint where the user is
   * intentionally renaming the chat).
   */
  static async setTitle(
    store: ChatStore,
    sessionId: string,
    title: string,
  ): Promise<void> {
    const { error } = await supabaseAdmin
      .from(store.sessions)
      .update({ title })
      .eq('id', sessionId);
    if (error) throw error;
  }

  /** Hard delete; cascades to messages, embeddings, summaries, feedback. */
  static async deleteSession(store: ChatStore, sessionId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from(store.sessions)
      .delete()
      .eq('id', sessionId);
    if (error) throw error;
  }

  /**
   * Wipe messages but keep the session row (reuses the same `id` so the
   * frontend's open subscription stays valid).
   */
  static async clearMessages(store: ChatStore, sessionId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from(store.messages)
      .delete()
      .eq('session_id', sessionId);
    if (error) throw error;
  }

  /**
   * Read first user message — building block for auto-title generation.
   * Returns null if the user hasn't sent anything yet (unusual but possible
   * if title gen runs against a freshly-cleared session).
   */
  static async getFirstUserMessageContent(
    store: ChatStore,
    sessionId: string,
  ): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from(store.messages)
      .select('content')
      .eq('session_id', sessionId)
      .eq('role', 'user')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn('[CHAT_REPO] getFirstUserMessageContent error', {
        store: store.kind,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!data || typeof (data as any).content !== 'string') return null;
    return (data as any).content;
  }
}
