/**
 * TestCaseFeedbackService — CRUD for per-test-case message feedback.
 *
 * Mirrors the public surface of `FeedbackService` but writes to
 * `test_case_message_feedback` (FK → test_case_chat_messages) instead of
 * the global `message_feedback` table. We need a separate service —
 * not a parameterized FeedbackService — because:
 *
 *   1. `FeedbackService.createFeedback` joins through `chat_messages`
 *      → `chat_sessions` → `workspace_members` for ownership. Test-case
 *      messages live in different tables and own different join paths.
 *
 *   2. Re-using the same class with a runtime branch would force every
 *      feedback callsite to know which surface it's on; cleaner to keep
 *      the call-time choice at the controller and have two services
 *      that share NO mutable state.
 *
 *   3. The aggregation/analytics methods on FeedbackService (top
 *      messages, time-series, insights) intentionally are NOT mirrored
 *      here — those are TODO for Phase 12 (feedback analytics include
 *      test-case data). For now test-case feedback is write-mostly and
 *      the existing dashboards keep showing the global pool.
 *
 * Authorization model
 * ───────────────────
 * Test-case message ownership is verified through:
 *   message_id → test_case_chat_messages.session_id
 *              → test_case_chat_sessions.user_id
 * The HTTP middleware (`requireTestCaseAccess`) has already verified
 * the caller is in the test case's workspace, so we only need to
 * ensure the message actually lives in this user's session — defense
 * in depth (RLS enforces it too).
 *
 * Idempotency
 * ───────────
 * `(message_id, user_id)` is UNIQUE in the migration. createOrUpdate
 * uses `.upsert(...).select(...)` so a re-submitted feedback flips
 * 👍↔👎 instead of duplicating rows.
 */

import { supabaseAdmin } from '@/db/supabase';
import type { CreateFeedbackRequest, MessageFeedback } from '@/types';
import { logger } from '@/utils/core/logger';

const FEEDBACK_TABLE = 'test_case_message_feedback';
const MESSAGES_TABLE = 'test_case_chat_messages';

export class TestCaseFeedbackService {
  /**
   * Create or update feedback. Returns the canonical row so the API
   * response carries the assigned id even on the first submit.
   *
   * Resolves session_id from the message_id rather than trusting a
   * client-supplied value — prevents a malicious client from
   * mismatching message and session to confuse analytics later.
   */
  static async createOrUpdate(
    userId: string,
    request: CreateFeedbackRequest,
  ): Promise<MessageFeedback> {
    // 1. Look up the message → resolve real session_id.
    const { data: message, error: messageError } = await supabaseAdmin
      .from(MESSAGES_TABLE)
      .select('id, session_id')
      .eq('id', request.message_id)
      .maybeSingle();

    if (messageError) {
      logger.error('[TC_FEEDBACK] Failed to resolve message', {
        messageId: request.message_id,
        error: messageError instanceof Error ? messageError.message : String(messageError),
      });
      throw messageError;
    }
    if (!message) {
      throw new Error('Message not found');
    }

    const sessionId = (message as any).session_id as string;

    // 2. Defense-in-depth: confirm the session belongs to this user.
    // RLS already gates this, but the controller-level access check is
    // for the test_case_id; if a client somehow swapped message_ids
    // across two test cases of theirs, we still want session integrity.
    const { data: session } = await supabaseAdmin
      .from('test_case_chat_sessions')
      .select('id, user_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (!session || (session as any).user_id !== userId) {
      throw new Error('Unauthorized: feedback target does not belong to caller');
    }

    // 3. Upsert on (message_id, user_id) UNIQUE — re-submitting flips
    // the type instead of accumulating rows. Returns canonical row.
    const { data, error } = await supabaseAdmin
      .from(FEEDBACK_TABLE)
      .upsert(
        {
          message_id: request.message_id,
          user_id: userId,
          session_id: sessionId,
          feedback_type: request.feedback_type,
          intent_type: request.intent_type ?? null,
          context: request.context ?? {},
        },
        { onConflict: 'message_id,user_id' },
      )
      .select()
      .single();

    if (error || !data) {
      logger.error('[TC_FEEDBACK] Failed to upsert feedback', {
        messageId: request.message_id,
        userIdShort: userId.substring(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error ?? new Error('Failed to save feedback');
    }

    logger.info('[TC_FEEDBACK] Feedback saved', {
      feedbackId: (data as any).id,
      type: request.feedback_type,
    });
    return data as MessageFeedback;
  }

  /** Read this user's feedback for a given message; null if none. */
  static async getForMessage(
    messageId: string,
    userId: string,
  ): Promise<MessageFeedback | null> {
    const { data, error } = await supabaseAdmin
      .from(FEEDBACK_TABLE)
      .select('*')
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      logger.warn('[TC_FEEDBACK] getForMessage failed', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    return (data as MessageFeedback) ?? null;
  }

  /**
   * Hard delete. Caller must own the row — RLS enforces the same
   * predicate, so a stray delete request from another user just
   * affects zero rows. We additionally reject if no row matched, so
   * the API can return a sensible 404 instead of a misleading 200.
   */
  static async delete(feedbackId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from(FEEDBACK_TABLE)
      .delete()
      .eq('id', feedbackId)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      logger.error('[TC_FEEDBACK] Delete failed', {
        feedbackId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return Array.isArray(data) && data.length > 0;
  }

  /** List all feedback rows attached to a session (for the chat UI badge). */
  static async listForSession(
    sessionId: string,
    userId: string,
  ): Promise<MessageFeedback[]> {
    const { data, error } = await supabaseAdmin
      .from(FEEDBACK_TABLE)
      .select('*')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) {
      logger.warn('[TC_FEEDBACK] listForSession failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    return (data ?? []) as MessageFeedback[];
  }
}
