/**
 * Test-case chat REST endpoints.
 *
 *   GET    /chat/test-cases/:testCaseId/session             — metadata or 404
 *   GET    /chat/test-cases/:testCaseId/messages            — paginated history
 *   PATCH  /chat/test-cases/:testCaseId/session             — rename
 *   DELETE /chat/test-cases/:testCaseId/session             — hard delete (cascades)
 *   POST   /chat/test-cases/:testCaseId/session/clear       — wipe messages, keep row
 *   POST   /chat/test-cases/:testCaseId/cancel              — abort in-flight LLM
 *   POST   /chat/test-cases/:testCaseId/feedback            — 👍/👎 a message
 *   GET    /chat/test-cases/:testCaseId/feedback/:messageId — read this user's feedback
 *   DELETE /chat/test-cases/:testCaseId/feedback/:feedbackId — remove feedback row
 *
 * Mounting (chat.route.ts):
 *   router.use('/test-cases/:testCaseId', testCaseChatRoutes);
 *
 * Auth chain (set at parent mount in src/index.ts):
 *   requireAuth → requireApproved → THIS ROUTER → requireTestCaseAccess
 *
 * Why a per-test-case router and not slots inside chat-sessions.controller:
 *   - Different ownership model. Global chat sessions belong to a user;
 *     test-case chats are workspace-scoped (any member of the workspace
 *     opens THEIR OWN dialog with the AI). The auth helper differs.
 *   - Different identity. Sessions are identified by their UUID (global)
 *     vs. by the (user, testCaseId) pair (test-case). Routes that take
 *     `testCaseId` keep the URL stable across visits — the client never
 *     needs to remember a session UUID.
 *   - Different feature ceiling. Test-case scope deliberately drops
 *     project association, welcome messages, embeddings, summaries
 *     (Phase 11). Mixing them with global session controllers would
 *     pollute that surface with `if (testCase) {}` everywhere.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '@/utils/core/error-handler';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import { TestCaseChatService } from '@/services/utils/test-case-chat.service';
import { TestCaseFeedbackService } from '@/services/feedback/test-case-feedback.service';
import { requireTestCaseAccess } from './shared/test-case-access';
import { cancel as registryCancel, keyOfTestCase } from './shared/request-key';
import type { CreateFeedbackRequest, FeedbackType } from '@/types';

// `mergeParams: true` so :testCaseId from the parent mount propagates
// into req.params on every handler in this router. Without it our
// middleware can't see the path segment because Express scopes params
// per-router by default.
const router = Router({ mergeParams: true });

/**
 * Feature-flag gate. Applied FIRST so disabled deployments never even
 * get to the workspace-membership check below — that check makes a
 * pair of DB round-trips, and we don't want to pay for them when the
 * feature is off.
 *
 * 501 Not Implemented (vs 404) is the deliberate choice: it tells the
 * frontend "the route is real but this deployment hasn't enabled it"
 * so the client can show a meaningful message rather than retry-on-404.
 */
router.use((_req: Request, res: Response, next: NextFunction): void => {
  if (!env.ENABLE_TEST_CASE_CHAT) {
    res.status(501).json({
      success: false,
      error: 'Per-test-case chat is not enabled in this deployment',
      code: 'FEATURE_DISABLED',
    });
    return;
  }
  next();
});

// Every route in this router needs a verified workspace-membership for
// the :testCaseId path segment. Apply once at the top; individual
// handlers then trust `req.testCaseAccess` to be populated.
router.use(requireTestCaseAccess('params'));

// ─────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────

/**
 * GET /session
 *
 * Lazy-create model: returns 404 when the user has not sent the first
 * message yet. The frontend treats 404 as "open empty chat" — exactly
 * the behavior we want when the user opens a test case for the first
 * time. Calling this endpoint NEVER creates a row.
 */
router.get('/session', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      res.status(404).json({ success: false, error: 'No chat yet for this test case' });
      return;
    }
    res.json({ success: true, session });
  } catch (err) {
    logger.error('[TC_CHAT_API] GET /session failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to load session' });
  }
}));

/**
 * PATCH /session — rename.
 *
 * Body: { title: string } where title is 1-200 chars after trim.
 * Refuses to operate if the session doesn't exist yet (no implicit
 * create on rename — user must send a message first; symmetric with
 * GET /session 404 behavior).
 */
router.patch('/session', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  const title = (req.body?.title ?? '').toString();
  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      res.status(404).json({ success: false, error: 'No chat yet for this test case' });
      return;
    }
    await TestCaseChatService.setTitle(session.id, title);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Invalid title') {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    logger.error('[TC_CHAT_API] PATCH /session failed', {
      testCaseId,
      error: msg,
    });
    res.status(500).json({ success: false, error: 'Failed to rename session' });
  }
}));

/**
 * DELETE /session — hard delete.
 *
 * Cascades to messages, embeddings, summaries, feedback. Idempotent:
 * 200 with `{deleted: false}` if there was nothing to delete (still
 * a successful state from the client's perspective, vs 404 which would
 * surface in error logs and confuse retries).
 */
router.delete('/session', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      res.json({ success: true, deleted: false });
      return;
    }
    await TestCaseChatService.deleteSession(session.id);
    res.json({ success: true, deleted: true, sessionId: session.id });
  } catch (err) {
    logger.error('[TC_CHAT_API] DELETE /session failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to delete session' });
  }
}));

/**
 * POST /session/clear — wipe messages but keep the session row.
 *
 * Used when the user wants a fresh conversation in the same test case
 * without losing their place in the URL or the WS subscription. The
 * session id stays the same, so any open chat panel does not need to
 * resubscribe.
 */
router.post('/session/clear', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      res.json({ success: true, cleared: false });
      return;
    }
    await TestCaseChatService.clearMessages(session.id);
    // Reset title back to default so the next first message can re-trigger
    // auto-title via `updateTitleIfDefault`. Otherwise `WHERE title='New
    // Chat'` would never match again and the chat would keep its old name.
    await TestCaseChatService.setTitle(session.id, 'New Chat');
    res.json({ success: true, cleared: true, sessionId: session.id });
  } catch (err) {
    logger.error('[TC_CHAT_API] POST /session/clear failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to clear session' });
  }
}));

// ─────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────

/**
 * GET /messages?limit=50&before=<iso>
 *
 * Paginated history, oldest-first within each page. Returns [] (200
 * not 404) when the session does not exist — empty list is a normal
 * state for a brand-new test case, not an error.
 *
 * Pagination contract:
 *   - `limit` clamped to [1, 100] in the repository
 *   - `before` is an ISO timestamp; messages with `created_at < before`
 *     are returned. To page backwards: pass the oldest message's
 *     `created_at` as the next `before`.
 */
router.get('/messages', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  const limit = Number(req.query.limit ?? 50);
  const before = req.query.before ? String(req.query.before) : undefined;

  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      // Distinct shape for "no session yet" so the frontend can branch
      // on `hasSession` without dealing with `sessionId: string | null`
      // typing gymnastics. Empty-list 200 — not 404 — because "no
      // history" is a normal first-visit state, not an error.
      res.json({ success: true, hasSession: false, messages: [] });
      return;
    }
    const messages = await TestCaseChatService.getMessagesPage(session.id, {
      limit,
      before,
    });
    res.json({ success: true, hasSession: true, sessionId: session.id, messages });
  } catch (err) {
    logger.error('[TC_CHAT_API] GET /messages failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to load messages' });
  }
}));

// ─────────────────────────────────────────────────────────────────────
// Cancel
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /cancel — abort the in-flight LLM call for this test-case chat.
 *
 * Scope: only aborts the AbortController stored in the namespaced
 * registry. Does NOT cancel running BullMQ jobs / preview replays /
 * mobile sessions launched from this chat — that's Phase 10 (full
 * cancel cascade). Today this matches the legacy global behavior.
 *
 * Returns `{cancelled: true}` if an active request was aborted,
 * `{cancelled: false}` if there was nothing to cancel (already
 * finished, never started, or already aborted by another request).
 * Never 404 — frontend should treat both as terminal "you can send
 * the next message now".
 */
router.post('/cancel', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      res.json({ success: true, cancelled: false, reason: 'no_session' });
      return;
    }
    const result = await registryCancel(keyOfTestCase(session.id), userId);
    res.json({
      success: true,
      cancelled: result.cancelled,
      message: result.message,
      sessionId: session.id,
    });
  } catch (err) {
    logger.error('[TC_CHAT_API] POST /cancel failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to cancel' });
  }
}));

// ─────────────────────────────────────────────────────────────────────
// Feedback
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /feedback — 👍 / 👎 on a specific AI message.
 *
 * Body: { message_id, feedback_type, intent_type?, context? }
 * Idempotent: re-submitting flips the type; no duplicate rows.
 * `session_id` is resolved server-side from `message_id` to prevent
 * client-side mismatch.
 */
router.post('/feedback', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  const body = (req.body ?? {}) as CreateFeedbackRequest;

  if (!body.message_id || !isValidUUID(body.message_id)) {
    res.status(400).json({ success: false, error: 'Invalid message_id' });
    return;
  }
  const validTypes: FeedbackType[] = ['like', 'dislike'];
  if (!body.feedback_type || !validTypes.includes(body.feedback_type)) {
    res.status(400).json({ success: false, error: 'Invalid feedback_type' });
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Route-level message-ownership check.
  //
  // Audit finding (Phase 6): without this check, user A in workspace W
  // who legitimately owns BOTH test-case-X and test-case-Y could POST
  // feedback for a message from test-case-Y via the URL of test-case-X.
  // The service layer would still accept it (user owns the message)
  // but feedback rows would be attributed to the wrong test case →
  // analytics drift, frontend confusion ("why is this 👎 here?").
  //
  // We resolve the message's session here and confirm it belongs to
  // the test-case session bound to the URL `:testCaseId`. This is the
  // narrow check the feedback service can't easily do because it
  // doesn't know which test case the request claims to be for.
  // RLS + service-level ownership remain as second/third lines of
  // defense — this is just the integrity guard.
  // ─────────────────────────────────────────────────────────────────
  try {
    const session = await TestCaseChatService.findSession(userId, testCaseId);
    if (!session) {
      res.status(404).json({ success: false, error: 'No chat session for this test case yet' });
      return;
    }
    // Confirm message lives in THIS session. Cheaper than re-fetching
    // the message in the service: we already know the session id.
    const { supabaseAdmin } = await import('@/db/supabase');
    const { data: msg, error: msgErr } = await supabaseAdmin
      .from('test_case_chat_messages')
      .select('id, session_id')
      .eq('id', body.message_id)
      .maybeSingle();
    if (msgErr) {
      logger.error('[TC_CHAT_API] feedback: failed to resolve message', {
        testCaseId,
        messageId: body.message_id,
        error: msgErr instanceof Error ? msgErr.message : String(msgErr),
      });
      res.status(500).json({ success: false, error: 'Failed to validate message' });
      return;
    }
    if (!msg) {
      res.status(404).json({ success: false, error: 'Message not found' });
      return;
    }
    if ((msg as any).session_id !== session.id) {
      // Message exists but belongs to another test-case session.
      // Same 404 we'd return for a non-existent message — don't leak
      // existence of messages from other test cases.
      logger.warn('[TC_CHAT_API] feedback: cross-test-case attempt blocked', {
        userId: userId.substring(0, 8) + '...',
        urlTestCaseId: testCaseId,
        urlSessionId: session.id,
        messageId: body.message_id,
      });
      res.status(404).json({ success: false, error: 'Message not found' });
      return;
    }

    const feedback = await TestCaseFeedbackService.createOrUpdate(userId, body);
    res.json({ success: true, feedback });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Message not found') {
      res.status(404).json({ success: false, error: msg });
      return;
    }
    if (msg.startsWith('Unauthorized')) {
      res.status(403).json({ success: false, error: msg });
      return;
    }
    logger.error('[TC_CHAT_API] POST /feedback failed', {
      testCaseId,
      error: msg,
    });
    res.status(500).json({ success: false, error: 'Failed to save feedback' });
  }
}));

/**
 * GET /feedback/:messageId — read this user's feedback for a message.
 * Returns 404 when the message has no feedback from this user.
 */
router.get('/feedback/:messageId', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  const messageId = req.params.messageId;
  if (!isValidUUID(messageId)) {
    res.status(400).json({ success: false, error: 'Invalid message id' });
    return;
  }
  try {
    const fb = await TestCaseFeedbackService.getForMessage(messageId, userId);
    if (!fb) {
      res.status(404).json({ success: false, error: 'No feedback' });
      return;
    }
    res.json({ success: true, feedback: fb });
  } catch (err) {
    logger.error('[TC_CHAT_API] GET /feedback/:messageId failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to load feedback' });
  }
}));

/**
 * DELETE /feedback/:feedbackId — remove a feedback row.
 *
 * 404 when nothing matched (own row, valid UUID, but already gone) so
 * retries from a flaky client can distinguish "needed to retry" from
 * "successfully deleted".
 */
router.delete('/feedback/:feedbackId', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { testCaseId } = req.testCaseAccess!;
  const feedbackId = req.params.feedbackId;
  if (!isValidUUID(feedbackId)) {
    res.status(400).json({ success: false, error: 'Invalid feedback id' });
    return;
  }
  try {
    const ok = await TestCaseFeedbackService.delete(feedbackId, userId);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Feedback not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('[TC_CHAT_API] DELETE /feedback/:feedbackId failed', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to delete feedback' });
  }
}));

export default router;
