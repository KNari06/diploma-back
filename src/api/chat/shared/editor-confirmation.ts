/**
 * Editor Confirmation (two-phase confirm for the per-test-case editor chat)
 *
 * Problem this solves: in a test-case editor chat the user says "save", the
 * executor calls a write tool with confirm=false, the tool returns its preview
 * refusal, the agent tells the user to reply "yes" — and then the "yes" turn
 * re-plans from scratch. The write tool is never called again. Observed live
 * (2026-07-26, chat session a6ef79e7…): four qa_create_test_case /
 * qa_update_test_case_steps calls across a session, every one confirm=false,
 * zero writes, and a closing "Done — I saved the login test case." that was
 * pure fabrication.
 *
 * Global chat solved this long ago — see `regression/shared/manage-confirmation.ts`
 * (Hard invariant #13/#14). The editor path never got the same interceptor, so
 * "yes" was ordinary free text there. This is that pattern ported to editor
 * scope: turn 1 caches the refused (toolName, args); turn 2's affirmative
 * re-issues the SAME args with confirm:true, deterministically, before the
 * executor gets a chance to re-plan.
 *
 * Two deliberate differences from the global version:
 *   1. Longer TTL (30 min, not 5) — matched to DraftStepsCache, because the
 *      cached args often lean on the server-held draft and because the real
 *      user in the trace above took 22 minutes to answer.
 *   2. The interceptor re-arms SkillRegistry's in-memory preview before
 *      re-issuing (see `recordConfirmationPreview`). Without it the longer TTL
 *      would be useless: the registry's own 5-minute window would have expired
 *      and the confirm=true would be downgraded straight back to a preview.
 */

import { Response } from 'express';
import { randomUUID } from 'crypto';
import { redisConnection } from '@/config/infrastructure/queues';
import { executeTool } from '@/services/skills/tool-executor';
import { SkillRegistry } from '@/services/skills/skill-registry';
import type { SkillContext } from '@/services/skills/types';
import { ChatPersistence } from '@/services/utils/chat-persistence';
import { TESTCASE_STORE } from '@/services/utils/chat-store';
import { logger } from '@/utils/core/logger';
import { classifyConfirmation } from './confirmation-classifier';
import { emitProcessingStep } from './utils';

const PENDING_EDITOR_PREFIX = 'pending_editor_confirm:';

/**
 * 30 minutes — deliberately longer than the global flow's 5. It is matched to
 * `DraftStepsCache`'s TTL, because a cached save often persists the server-held
 * draft rather than args-carried steps: a pending op that outlived the draft it
 * needs would resolve to a confusing "no cached draft" failure. Expiring
 * together means the pair is either both live or both gone.
 */
const PENDING_TTL_SECONDS = 30 * 60;

/**
 * Write tools whose refused call is worth replaying on "yes".
 *
 * Deliberately NOT `qa_author_test_iteratively`: authoring already handles its
 * own confirmation correctly (the trace shows a confirm=true honoured on the
 * turn after "yes"), it runs 20-60s live against the preview, and its reply is
 * assembled by the pipeline into something far better than a raw tool message.
 * Replaying it here would trade a working path for a worse one. This list is
 * about the persistence half of the flow, which is the half that was broken.
 */
const REPLAYABLE_TOOLS: ReadonlySet<string> = new Set([
  'qa_create_test_case',
  'qa_update_test_case_steps',
  'qa_update_test_case',
  'qa_delete_test_case',
]);

interface PendingEditorOp {
  toolName: string;
  /** Args WITHOUT confirm — confirm is set true only when the op is executed. */
  args: Record<string, any>;
  skillContext: SkillContext;
}

/** Keyed by chatSessionId ONLY — a userId fallback would leak the pending op
 *  into this user's other editor chats (Hard invariant #14). */
function keyFor(chatSessionId: string): string {
  return `${PENDING_EDITOR_PREFIX}${chatSessionId}`;
}

/** True when this tool's refused call should be cached for replay. */
export function isReplayableConfirmTool(toolName: string): boolean {
  return REPLAYABLE_TOOLS.has(toolName);
}

/**
 * Record a write tool's preview refusal so the next affirmative can replay it.
 * Called from the executor agent when a tool comes back `needsConfirmation`.
 * Best-effort: a Redis failure must never break the turn in progress.
 */
export async function storePendingEditorConfirmation(
  chatSessionId: string,
  op: PendingEditorOp,
): Promise<void> {
  if (!chatSessionId || !isReplayableConfirmTool(op.toolName)) return;
  // `confirm` is stripped rather than stored false: the stored args are the
  // shape the op is replayed with, and confirm is supplied by the replay.
  const { confirm: _confirm, ...args } = op.args ?? {};
  try {
    await redisConnection.set(
      keyFor(chatSessionId),
      JSON.stringify({ ...op, args }),
      'EX',
      PENDING_TTL_SECONDS,
    );
    logger.info('[EDITOR_CONFIRM] Cached pending write', {
      toolName: op.toolName,
      chatSessionId,
    });
  } catch (err) {
    logger.warn('[EDITOR_CONFIRM] Failed to store pending op', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Drop any pending editor confirmation for this session. */
export async function clearPendingEditorConfirmation(
  chatSessionId: string | undefined,
): Promise<void> {
  if (!chatSessionId) return;
  await redisConnection.del(keyFor(chatSessionId)).catch(() => {});
}

/**
 * Persist the turn into the per-test-case chat tables so a page reload shows
 * the same exchange the user just had. The global manage-confirm interceptor
 * skips this and its confirmed turns vanish from history on reload; the editor
 * chat IS the test case's record, so it saves. Best-effort — a persistence
 * failure must not swallow a write that already succeeded.
 */
async function persistTurn(
  chatSessionId: string,
  userMessage: string,
  aiReply: string,
): Promise<void> {
  try {
    await ChatPersistence.saveMessages(TESTCASE_STORE, chatSessionId, [
      { role: 'user', content: userMessage, metadata: { mode: 'editor' } },
      { role: 'ai', content: aiReply, metadata: { source: 'editor_confirmation' } },
    ]);
  } catch (err) {
    logger.warn('[EDITOR_CONFIRM] Failed to persist confirmation turn', {
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reply in the shape the editor chat reads. `reply` is what the frontend
 * prefers; `message` is kept as the fallback field it also accepts.
 */
function sendReply(
  res: Response,
  chatSessionId: string,
  success: boolean,
  text: string,
): void {
  res.json({
    success,
    reply: text,
    message: text,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}

/**
 * Intercept a reply to a pending editor confirmation. Returns true if the
 * message was handled (response already sent), false to let the normal
 * parse+route path proceed. Called from the controller BEFORE intent parsing,
 * mirroring `handlePendingManageConfirmation` on the global path.
 */
export async function handlePendingEditorConfirmation(
  res: Response,
  message: string,
  chatSessionId: string,
  userId: string,
): Promise<boolean> {
  const key = keyFor(chatSessionId);

  let pendingRaw: string | null;
  try {
    pendingRaw = await redisConnection.get(key);
  } catch {
    return false;
  }
  if (!pendingRaw) return false;

  const intent = await classifyConfirmation(message, 'save the changes just described');

  // Ambiguous reply → drop the pending op and let the normal flow handle it
  // (the user moved on to something else). Same behavior as the global flows:
  // a stale pending op must never hijack an unrelated message.
  if (intent === 'other') {
    await redisConnection.del(key).catch(() => {});
    return false;
  }

  await redisConnection.del(key).catch(() => {});

  let pending: PendingEditorOp;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    return false;
  }

  if (intent === 'decline') {
    const text = 'Okay — nothing was saved. What would you like to change?';
    await persistTurn(chatSessionId, message, text);
    sendReply(res, chatSessionId, true, text);
    return true;
  }

  // intent === 'confirm' → execute the stored op with confirm:true.
  //
  // Ownership re-check: the pending op carries the skillContext captured when
  // it was cached. Refuse to replay it for anyone else — the key is session-
  // scoped, but a stale op must never execute under a different identity.
  if (pending.skillContext?.userId !== userId) {
    logger.warn('[EDITOR_CONFIRM] Pending op user mismatch — dropped', {
      chatSessionId,
      toolName: pending.toolName,
    });
    return false;
  }

  try {
    // The controller's opening "Analyzing your request..." row would otherwise
    // sit frozen for the length of the write.
    //
    // Emitted ONLY when the cached op carries a testCaseId: without one,
    // `emitProcessingStep` falls back to the `chat:<sessionId>` room, and both
    // chats share a socket — an editor progress row would surface in the
    // user's global chat (Hard invariant #16a). An op cached before this field
    // existed, or by a caller that omitted it, silently loses the progress row.
    // That is the correct trade: a missing spinner beats a cross-surface leak.
    const emitTestCaseId = pending.skillContext?.testCaseId;
    if (emitTestCaseId) {
      emitProcessingStep(
        chatSessionId,
        'agent_executing_tool',
        'Applying the change you approved...',
        90,
        { toolName: pending.toolName },
        emitTestCaseId,
      );
    }

    // Re-arm the registry's preview so this confirm=true is honoured. Both
    // halves of the handshake are proven at this point: the refusal that
    // cached the op, and the affirmative just classified.
    SkillRegistry.recordConfirmationPreview(chatSessionId, pending.toolName);

    const callResult = await executeTool({
      toolName: pending.toolName,
      toolCallId: `editor_confirm_${randomUUID()}`,
      args: { ...pending.args, confirm: true },
      skillContext: pending.skillContext,
    });
    const result = callResult.toolResult;

    // Refused again. The gate's prose is written for the model, so it is never
    // echoed to the user (Hard invariant #13). Re-cache and ask once more —
    // self-healing, and bounded: the refusal itself re-registers a preview, so
    // the next affirmative goes through.
    if (result.needsConfirmation) {
      logger.warn('[EDITOR_CONFIRM] Replay was refused again', {
        toolName: pending.toolName,
        chatSessionId,
      });
      await storePendingEditorConfirmation(chatSessionId, pending);
      const text =
        'I could not complete that save on the first try. Reply "yes" once more and I will apply it.';
      await persistTurn(chatSessionId, message, text);
      sendReply(res, chatSessionId, false, text);
      return true;
    }

    logger.info('[EDITOR_CONFIRM] Replayed confirmed write', {
      toolName: pending.toolName,
      chatSessionId,
      success: result.success,
    });

    await persistTurn(chatSessionId, message, result.message);
    sendReply(res, chatSessionId, result.success, result.message);
    return true;
  } catch (err) {
    logger.error('[EDITOR_CONFIRM] Failed to execute confirmed op', {
      toolName: pending.toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to save the change. Please try again.',
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
    }
    return true;
  }
}
