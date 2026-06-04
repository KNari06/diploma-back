/**
 * Manage-Tool Helper (Phase 2)
 *
 * Shared core for the first-class management intents (manage_schedule,
 * manage_module, manage_plan, flaky_report). Each thin handler extracts its
 * typed params, then delegates here to invoke the corresponding qa_* tool.
 *
 * Why executeTool (not QASkill.execute, not the SubAgentPipeline):
 *   - executeTool is the sanctioned single entry point. Routing through it
 *     keeps the centralized confirm-preview guard, loop detection, retry, and
 *     timeout — calling the skill directly would bypass all of that.
 *   - It skips ONLY the fragile Router/Planner LLM agents (the actual win the
 *     plan wanted): the classifier already knew the intent, so re-discovering
 *     the tool via a second LLM round-trip is pure latency + flakiness.
 *
 * Two-phase confirm: WRITE tools require `confirm:true`, and the registry only
 * honors it when a prior `confirm:false` preview exists for the session (max
 * 5min). So the natural flow is: first turn → confirm:false → tool returns a
 * "describe + approve" message; user approves → next turn → confirm:true.
 * Approval detection is the caller's job (see resolveConfirmation).
 */

import { randomUUID } from 'crypto';
import { executeTool } from '@/services/skills/tool-executor';
import type { SkillContext, SkillResult } from '@/services/skills/types';
import { logger } from '@/utils/core/logger';
import { Response } from 'express';

/** The handler params subset the helper needs to build a SkillContext. */
export interface ManageToolParams {
  userId: string;
  workspace_id: string;
  chatSessionId?: string;
  context?: any;
  abortSignal?: AbortSignal;
}

export interface RunManageToolInput {
  toolName: string;
  args: Record<string, any>;
  params: ManageToolParams;
  res: Response;
  /** Tag used in the WS/log channel and the (rare) error fallback. */
  logTag: string;
}

/**
 * Build the SkillContext from handler params + a resolved project id.
 * projectId is resolved by the caller (it owns descriptor→project logic) and
 * passed into `args.project_id` separately; here we only populate the context.
 */
export function buildSkillContext(params: ManageToolParams): SkillContext {
  return {
    userId: params.userId,
    workspaceId: params.workspace_id,
    chatSessionId: params.chatSessionId,
    projectId: params.context?.projectId,
    mode: params.context?.mode,
  };
}

/**
 * Decide the `confirm` flag for a WRITE management tool from the user's latest
 * turn. The central registry still gates confirm:true on a prior preview, so a
 * false positive here cannot execute a write without the describe step having
 * happened first — this only decides whether to ATTEMPT confirm:true.
 *
 * Pure + exported for unit testing.
 */
export function resolveConfirmation(input: {
  message?: string;
  answers?: Record<string, any>;
}): boolean {
  // Explicit structured approval from the frontend wins.
  if (input.answers && typeof input.answers.confirm === 'boolean') {
    return input.answers.confirm;
  }
  const text = (input.message || '').trim().toLowerCase();
  if (!text) return false;
  // Conservative affirmative whitelist (EN + RU). Anything else → preview first.
  const AFFIRMATIVE = new Set([
    'yes', 'y', 'yeah', 'yep', 'ok', 'okay', 'sure', 'confirm', 'confirmed',
    'go ahead', 'do it', 'proceed', 'go',
    'да', 'ага', 'давай', 'подтверждаю', 'подтвердить', 'ок', 'окей', 'выполняй',
  ]);
  return AFFIRMATIVE.has(text);
}

/**
 * Invoke a management tool through the central pipeline and write the response.
 * Always emits an HTTP response (never a silent return). Returns the raw
 * SkillResult so callers can branch if they need to (most don't).
 */
export async function runManageTool(input: RunManageToolInput): Promise<SkillResult> {
  const { toolName, args, params, res, logTag } = input;

  const skillContext = buildSkillContext(params);

  let result: SkillResult;
  try {
    const callResult = await executeTool({
      toolName,
      toolCallId: `mgmt_${randomUUID()}`,
      args,
      skillContext,
      abortSignal: params.abortSignal,
    });
    result = callResult.toolResult;
  } catch (err) {
    logger.error(`[${logTag}] manage tool execution failed`, {
      toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to run the requested operation.',
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
    return { success: false, message: 'execution failed' };
  }

  // Map SkillResult → chat response. A confirm:false preview comes back as
  // success:false with an instructional message — surface it as a normal
  // assistant turn (not an error), so the user sees the "approve?" prompt.
  res.json({
    success: result.success,
    message: result.message,
    data: result.data ?? undefined,
    timestamp: new Date().toISOString(),
    sessionId: params.chatSessionId,
  });

  return result;
}
