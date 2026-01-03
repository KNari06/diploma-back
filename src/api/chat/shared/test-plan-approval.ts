import { supabaseAdmin } from '@/db/supabase';
import { detectUserApproval } from '@/services/ai/helpers/ai-helpers.service';
import { getLatestPendingTestPlan, getTestPlan } from '@/services/testing/plans/exploration-cache.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import { Request, Response } from 'express';
import { MESSAGES } from './constants';
import { executeApprovedTestPlan } from './test-execution';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';


/**
 * STEP 3: CHECK FOR PENDING TEST PLAN APPROVAL (MUST BE FIRST!)
 */
export async function checkPendingApproval(params: {
  req: Request;
  res: Response;
  message: string;
  conversationId?: string;
  userId: string;
  chatSessionId?: string;
  workspace_id: string;
  checkRequestTimeout: () => void;
  abortSignal?: AbortSignal;
  logger?: FunctionLogger;
}): Promise<boolean> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: CHECK FOR PENDING TEST PLAN APPROVAL (MUST BE FIRST!)
  // ═══════════════════════════════════════════════════════════════════════

  const handlePendingTestPlanApprovalWithLogging = params.logger
    ? withFunctionLogging(handlePendingTestPlanApproval, 'handlePendingTestPlanApproval', params.logger)
    : handlePendingTestPlanApproval;
  const approvalHandled = await handlePendingTestPlanApprovalWithLogging({
    req: params.req,
    res: params.res,
    message: params.message,
    conversationId: params.conversationId,
    userId: params.userId,
    chatSessionId: params.chatSessionId,
    workspace_id: params.workspace_id,
    abortSignal: params.abortSignal,
    logger: params.logger,
  });

  // If approval was handled (approved/rejected/clarification), return early
  if (approvalHandled) {
    return true;
  }

  params.checkRequestTimeout();

  return false;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: HANDLE PENDING TEST PLAN APPROVAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Checks if user has a pending test plan and processes their approval/rejection.
 * Returns true if approval was handled (and response sent), false otherwise.
 */
export async function handlePendingTestPlanApproval(params: {
  req: Request;
  res: Response;
  message: string;
  conversationId?: string;
  userId: string;
  chatSessionId?: string;
  workspace_id: string;
  abortSignal?: AbortSignal;
  logger?: FunctionLogger;
}): Promise<boolean> {
  const { req, res, message, conversationId, userId, chatSessionId, workspace_id } = params;

  logger.info('🔍 [APPROVAL_CHECK] Checking for pending test plan approval', {
    userId: userId.substring(0, 8) + '...',
    message: message.substring(0, 50),
    hasConversationId: !!conversationId,
    conversationId: conversationId || 'NOT PROVIDED',
    chatSessionId: chatSessionId?.substring(0, 8) + '...' || 'none',
  });

  // CRITICAL: Check if LAST AI MESSAGE was a test plan OR expired plan choice
  // This prevents false approvals when user says "yes" but last message wasn't a plan
  let lastAiMessageWasTestPlan = false;
  let lastAiMessageWasExpiredChoice = false;

  if (chatSessionId) {
    try {
      const getRecentMessagesWithLogging = params.logger
        ? withFunctionLogging(ChatService.getRecentMessages.bind(ChatService), 'ChatService.getRecentMessages', params.logger)
        : ChatService.getRecentMessages.bind(ChatService);
      const recentMessages = await getRecentMessagesWithLogging(chatSessionId, userId, 5); // Last 5 messages (SECURITY: Pass userId)

      // Find last AI message
      // ✅ getRecentMessages returns messages in chronological order (oldest first) after .reverse()
      // So we need .reverse() to get newest first, then .find() to get the most recent AI message
      const lastAiMessage = recentMessages
        .slice()
        .reverse()
        .find((msg: any) => msg.role === 'ai');

      if (lastAiMessage?.metadata) {
        // Check if last AI message was a test plan
        lastAiMessageWasTestPlan =
          lastAiMessage.metadata.requiresApproval === true ||
          !!lastAiMessage.metadata.testPlan ||
          !!lastAiMessage.metadata.conversationId; // conversationId indicates test plan

        logger.info('[APPROVAL_CHECK] Last AI message analysis', {
          wasTestPlan: lastAiMessageWasTestPlan,
          hasRequiresApproval: lastAiMessage.metadata.requiresApproval,
          hasTestPlan: !!lastAiMessage.metadata.testPlan,
          hasConversationId: !!lastAiMessage.metadata.conversationId,
        });
      }

      // Check if last AI message was offering expired plan choice
      if (lastAiMessage?.content?.includes('⚠️ Этот тест-план истек')) {
        lastAiMessageWasExpiredChoice = true;
        logger.info('[APPROVAL_CHECK] Last AI message was expired plan choice');
      }
    } catch (error) {
      logger.warn('[APPROVAL_CHECK] Failed to check last AI message', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without this check (fallback to plan search)
    }
  }

  // Find pending test plan (parallel search for performance)
  // If pending plan exists, it means there WAS a test plan, even if last AI message doesn't have metadata
  const findPendingTestPlanWithLogging = params.logger
    ? withFunctionLogging(findPendingTestPlan, 'findPendingTestPlan', params.logger)
    : findPendingTestPlan;
  const pendingPlan = await findPendingTestPlanWithLogging(conversationId, userId, params.logger);

  // If we found a pending plan, treat it as if last AI message was a test plan
  // This handles cases where AI responded with "Yes, I remember..." but plan exists in DB
  if (pendingPlan && pendingPlan.status === 'pending_confirmation') {
    lastAiMessageWasTestPlan = true;
    logger.info('[APPROVAL_CHECK] Found pending plan in DB, treating as test plan context', {
      planId: pendingPlan.id,
      scope: pendingPlan.scope,
      hasMetadataInLastMessage: lastAiMessageWasTestPlan,
    });
  }

  // If last AI message was NOT a test plan and NO pending plan exists, skip approval handling
  if (!lastAiMessageWasTestPlan && !lastAiMessageWasExpiredChoice) {
    logger.info('[APPROVAL_CHECK] Last AI message was not a test plan and no pending plan found, no approval to handle', {
      chatSessionId: chatSessionId?.substring(0, 8) + '...' || 'none',
    });
    return false; // Continue with intent parsing
  }

  // If no pending plan found, but we already checked above, return false
  if (!pendingPlan) {
    logger.info('[CHAT] No pending test plan found', {
      userId: userId.substring(0, 8) + '...',
      conversationId: conversationId || 'none',
    });
    return false; // No approval to handle
  }

  if (pendingPlan.status !== 'pending_confirmation') {
    logger.info('[CHAT] Found plan but not pending confirmation', {
      planId: pendingPlan.id,
      status: pendingPlan.status,
    });
    return false; // Plan exists but not awaiting approval
  }

  // ✅ FIX: Check expires_at and offer choice to user
  if (pendingPlan.expiresAt && new Date(pendingPlan.expiresAt) <= new Date()) {
    const expiredHoursAgo = Math.floor(
      (Date.now() - new Date(pendingPlan.expiresAt).getTime()) / (1000 * 60 * 60)
    );

    logger.info('[APPROVAL_CHECK] Plan expired, offering choice', {
      planId: pendingPlan.id,
      expiresAt: pendingPlan.expiresAt,
      expiredHoursAgo,
    });

    // Check if user is responding to expired plan choice
    const messageLower = message.toLowerCase().trim();

    // User wants to run old plan
    if (messageLower.includes('старый') || messageLower.includes('old') || messageLower.includes('запустить')) {
      logger.info('[APPROVAL_CHECK] User chose to run expired plan', {
        planId: pendingPlan.id,
        userMessage: message,
      });

      // Extend expiry to 3 days from now
      const { error: renewError } = await supabaseAdmin
        .from('test_plans')
        .update({
          expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
          status: 'pending_confirmation', // Restore status if was expired
        })
        .eq('id', pendingPlan.id);

      if (renewError) {
        logger.warn('[APPROVAL_CHECK] Failed to renew plan', { error: renewError, planId: pendingPlan.id });
      } else {
        logger.info('[APPROVAL_CHECK] Expired plan renewed', { planId: pendingPlan.id });
      }

      // Execute the plan
      const executeApprovedTestPlanWithLogging = params.logger
        ? withFunctionLogging(executeApprovedTestPlan, 'executeApprovedTestPlan', params.logger)
        : executeApprovedTestPlan;
      await executeApprovedTestPlanWithLogging(req, res, {
        planId: pendingPlan.id,
        userId,
        chatSessionId,
        workspace_id,
        userMessage: message,
      });
      return true;
    }

    // User wants to create new plan
    if (messageLower.includes('новый') || messageLower.includes('new') || messageLower.includes('создать')) {
      logger.info('[APPROVAL_CHECK] User chose to create new plan', {
        planId: pendingPlan.id,
        userMessage: message,
      });

      // Mark old plan as expired
      const { error: expireError } = await supabaseAdmin
        .from('test_plans')
        .update({ status: 'expired' })
        .eq('id', pendingPlan.id);

      if (expireError) {
        logger.warn('[APPROVAL_CHECK] Failed to mark plan as expired', { error: expireError, planId: pendingPlan.id });
      }

      const saveAndRespondWithLogging = params.logger
        ? withFunctionLogging(saveAndRespond, 'saveAndRespond', params.logger)
        : saveAndRespond;
      await saveAndRespondWithLogging(
        chatSessionId,
        res,
        message,
        'Понял, создаю новый тест-план. Пожалуйста, опишите, что вы хотите протестировать.',
        params.logger
      );
      return true;
    }

    // First time showing expired plan - offer choice
    const expiredMessage = expiredHoursAgo < 24
      ? `${expiredHoursAgo} ${expiredHoursAgo === 1 ? 'час' : expiredHoursAgo < 5 ? 'часа' : 'часов'} назад`
      : `${Math.floor(expiredHoursAgo / 24)} ${Math.floor(expiredHoursAgo / 24) === 1 ? 'день' : 'дня'} назад`;

    const saveAndRespondWithLogging = params.logger
      ? withFunctionLogging(saveAndRespond, 'saveAndRespond', params.logger)
      : saveAndRespond;
    await saveAndRespondWithLogging(
      chatSessionId,
      res,
      message,
      `⚠️ Этот тест-план истек ${expiredMessage}.\n\n` +
      `**URL:** ${pendingPlan.url}\n` +
      `**Scope:** ${pendingPlan.scope}\n\n` +
      `**Варианты:**\n` +
      `1️⃣ Создать новый план (рекомендуется)\n` +
      `2️⃣ Запустить старый план (может быть устаревшим)\n\n` +
      `Ответьте **"новый"** или **"старый"**`
    );
    return true;
  }

  // Check if request was cancelled
  if (params.abortSignal) {
    const { checkRequestAborted } = await import('./request-cancellation');
    const checkRequestAbortedWithLogging = params.logger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', params.logger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(params.abortSignal);
  }

  // User is responding to test plan - process approval/rejection
  logger.info('🔍 [CHAT] Found pending test plan, checking for approval/rejection', {
    planId: pendingPlan.id,
    scope: pendingPlan.scope,
    createdAt: pendingPlan.createdAt,
    userMessage: message,
  });

  // Use AI-based approval detection with context
  // Pass context that last AI message was a test plan (or pending plan exists in DB)
  const detectUserApprovalWithLogging = params.logger
    ? withFunctionLogging(detectUserApproval, 'detectUserApproval', params.logger)
    : detectUserApproval;
  const approvalResult = await detectUserApprovalWithLogging(message, {
    lastAiMessageWasTestPlan: lastAiMessageWasTestPlan,
  });

  // Check if request was cancelled after AI call
  if (params.abortSignal) {
    const { checkRequestAborted } = await import('./request-cancellation');
    const checkRequestAbortedWithLogging = params.logger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', params.logger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(params.abortSignal);
  }

  logger.info('[CHAT] Test plan response detected', {
    planId: pendingPlan.id,
    approved: approvalResult.approved,
    confidence: approvalResult.confidence,
  });

  // Handle unclear response - if confidence is too low, continue with normal flow
  // This allows users to ask questions or modify the plan instead of just approving/rejecting
  if (approvalResult.confidence < 0.5) {
    logger.info('[CHAT] Approval detection unclear, continuing with normal chat flow', {
      planId: pendingPlan.id,
      message: message.substring(0, 50),
      confidence: approvalResult.confidence,
      reasoning: 'User message might be a question or modification request, not approval/rejection',
    });
    // Return false to continue with normal intent parsing flow
    // User can still approve/reject later with clearer message
    return false;
  }

  // Handle approval
  if (approvalResult.approved === true) {
    logger.info('🟢 [APPROVAL] Test approved, executing now...', {
      planId: pendingPlan.id,
      userId,
      chatSessionId,
      scope: pendingPlan.scope,
    });

    const executeApprovedTestPlanWithLogging = params.logger
      ? withFunctionLogging(executeApprovedTestPlan, 'executeApprovedTestPlan', params.logger)
      : executeApprovedTestPlan;
    await executeApprovedTestPlanWithLogging(req, res, {
      planId: pendingPlan.id,
      userId,
      chatSessionId,
      workspace_id,
      userMessage: message, // FIX #14: Pass actual user message
    });
    return true;
  }

  // Handle rejection
  if (approvalResult.approved === false) {
    logger.info('[CHAT] Test plan rejected', { planId: pendingPlan.id });

    const saveAndRespondWithLogging = params.logger
      ? withFunctionLogging(saveAndRespond, 'saveAndRespond', params.logger)
      : saveAndRespond;
    await saveAndRespondWithLogging(
      chatSessionId,
      res,
      message,
      MESSAGES.TEST_REJECTED,
      params.logger
    );
    return true;
  }

  // Shouldn't reach here, but handle gracefully
  return false;
}

/**
 * Find pending test plan (parallel search for performance)
 */
export async function findPendingTestPlan(
  conversationId: string | undefined,
  userId: string,
  functionLogger?: FunctionLogger
): Promise<any | null> {
  logger.info('🔍 [PENDING_PLAN_SEARCH] Starting parallel search', {
    conversationId: conversationId || 'NONE',
    userId: userId.substring(0, 8) + '...',
  });

  // Validate conversationId format
  const isValidConversationId = conversationId && isValidUUID(conversationId);

  if (conversationId && !isValidConversationId) {
    logger.warn('⚠️ [PENDING_PLAN_SEARCH] Invalid conversationId format, ignoring', {
      conversationId,
      userId,
    });
  }

  // Run both queries in parallel (50ms instead of 100ms)
  const getTestPlanWithLogging = functionLogger
    ? withFunctionLogging(getTestPlan, 'getTestPlan', functionLogger)
    : getTestPlan;
  const getLatestPendingTestPlanWithLogging = functionLogger
    ? withFunctionLogging(getLatestPendingTestPlan, 'getLatestPendingTestPlan', functionLogger)
    : getLatestPendingTestPlan;
  const [planByConversation, latestPlan] = await Promise.all([
    isValidConversationId ? getTestPlanWithLogging(conversationId, userId) : Promise.resolve(null),
    getLatestPendingTestPlanWithLogging(userId),
  ]);

  // ✅ FIX: Check expires_at for planByConversation (getTestPlan already checks, but double-check for safety)
  let validPlanByConversation = planByConversation;
  if (planByConversation && planByConversation.expiresAt) {
    if (new Date(planByConversation.expiresAt) <= new Date()) {
      logger.warn('[PENDING_PLAN_SEARCH] Plan by conversationId expired', {
        planId: planByConversation.id,
        expiresAt: planByConversation.expiresAt,
      });
      validPlanByConversation = null; // Use fallback instead
    }
  }

  // Prefer plan by conversationId, fallback to latest
  const pendingPlan = validPlanByConversation || latestPlan;

  if (pendingPlan) {
    if (validPlanByConversation) {
      logger.info('✅ [PENDING_PLAN_SEARCH] Found plan by conversationId!', {
        planId: pendingPlan.id,
        status: pendingPlan.status,
        scope: pendingPlan.scope,
        searchMethod: 'conversationId',
      });
    } else {
      logger.info('✅ [PENDING_PLAN_SEARCH] Found plan via FALLBACK (latest pending)!', {
        planId: pendingPlan.id,
        status: pendingPlan.status,
        scope: pendingPlan.scope,
        createdAt: pendingPlan.createdAt,
        searchMethod: 'fallback',
        reason: planByConversation ? 'conversationId_plan_expired' : 'no_conversationId',
      });
    }
  } else {
    logger.info('ℹ️ [PENDING_PLAN_SEARCH] No pending plan found', {
      userId,
      triedConversationId: conversationId || 'none',
      conversationIdValid: isValidConversationId,
    });
  }

  return pendingPlan;
}

/**
 * Save message to chat history and send response
 */
export async function saveAndRespond(
  chatSessionId: string | undefined,
  res: Response,
  userMessage: string,
  aiMessage: string,
  functionLogger?: FunctionLogger
): Promise<void> {
  if (chatSessionId) {
    const saveChatMessagesWithLogging = functionLogger
      ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
      : ChatService.saveChatMessages.bind(ChatService);
    await saveChatMessagesWithLogging(chatSessionId, [
      { role: 'user', content: userMessage },
      { role: 'ai', content: aiMessage },
    ]);
  }

  res.json({
    success: true, // ← Frontend expects this!
    reply: aiMessage,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}
