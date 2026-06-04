/**
 * Management Confirmation (two-phase confirm for manage_* intents)
 *
 * Problem this solves: write management ops (manage_schedule/module/plan) need
 * a describe→approve→execute flow. On the preview turn the handler shows a
 * human-readable preview; but on the NEXT turn a bare "yes" is classified as
 * general_chat (the preview ends in "?"), so the approval never reaches the
 * management handler and the operation is silently dropped.
 *
 * Fix (mirrors exploration-confirmation.ts): persist the pending op in Redis
 * keyed by session. Before intent parsing on the next turn, intercept the
 * reply; on confirm, re-invoke the SAME tool with the SAME args + confirm:true
 * (deterministic — no LLM re-inference of params, which also closes the
 * "preview lacks machine-readable params" gap).
 */

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { redisConnection } from '@/config/infrastructure/queues';
import { executeTool } from '@/services/skills/tool-executor';
import type { SkillContext } from '@/services/skills/types';
import { logger } from '@/utils/core/logger';
import { classifyConfirmation } from '../../shared/confirmation-classifier';

const PENDING_MANAGE_PREFIX = 'pending_manage:';
const PENDING_TTL_SECONDS = 300; // 5min — matches the SkillRegistry confirm guard TTL.

interface PendingManageOp {
  toolName: string;
  /** Args WITHOUT confirm — confirm is set true only when the op is executed. */
  args: Record<string, any>;
  skillContext: SkillContext;
  previewDescription?: string;
}

function keyFor(chatSessionId: string | undefined, userId: string): string {
  return `${PENDING_MANAGE_PREFIX}${chatSessionId || userId}`;
}

/**
 * Record a pending management op (called by runManageTool on the preview turn).
 * Best-effort: a Redis failure must not break the preview response.
 */
export async function storePendingManageOp(
  chatSessionId: string | undefined,
  userId: string,
  op: PendingManageOp,
): Promise<void> {
  try {
    await redisConnection.set(
      keyFor(chatSessionId, userId),
      JSON.stringify(op),
      'EX',
      PENDING_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn('[MANAGE_CONFIRM] Failed to store pending op', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Intercept a reply to a pending management confirmation. Returns true if the
 * message was handled (response already sent), false to let the normal intent
 * flow proceed. Called from the controller BEFORE intent parsing — mirrors
 * handlePendingExplorationConfirmation.
 */
export async function handlePendingManageConfirmation(
  _req: Request,
  res: Response,
  message: string,
  chatSessionId: string,
  userId: string,
): Promise<boolean> {
  const key = keyFor(chatSessionId, userId);

  let pendingRaw: string | null;
  try {
    pendingRaw = await redisConnection.get(key);
  } catch {
    return false;
  }
  if (!pendingRaw) return false;

  const intent = await classifyConfirmation(message, 'apply the change you just described');

  // Ambiguous reply → drop the pending op and let normal flow handle it (the
  // user likely moved on). Same behavior as the exploration flow.
  if (intent === 'other') {
    await redisConnection.del(key).catch(() => {});
    return false;
  }

  await redisConnection.del(key).catch(() => {});

  if (intent === 'decline') {
    res.json({
      success: true,
      message: 'Okay, cancelled — no changes made. What would you like to do instead?',
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  }

  // intent === 'confirm' → execute the stored op with confirm:true.
  let pending: PendingManageOp;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    return false;
  }

  try {
    const callResult = await executeTool({
      toolName: pending.toolName,
      toolCallId: `mgmt_confirm_${randomUUID()}`,
      args: { ...pending.args, confirm: true },
      skillContext: pending.skillContext,
    });
    const result = callResult.toolResult;

    res.json({
      success: result.success,
      message: result.message,
      data: result.data ?? undefined,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  } catch (err) {
    logger.error('[MANAGE_CONFIRM] Failed to execute confirmed op', {
      toolName: pending.toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to apply the change. Please try again.',
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  }
}
