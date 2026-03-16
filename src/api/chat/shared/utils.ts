import { supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import { ChatProcessingStepPayload } from '@/websocket/types/types';
import { webSocketService } from '@/websocket/core/websocket.service';
import { Response } from 'express';
import { PROGRESS } from './constants';

/**
 * Normalize URL by adding protocol if missing
 * - Adds https:// for public URLs
 * - Adds http:// for localhost/127.0.0.1 (development)
 * - Preserves existing protocol
 * - Validates result
 */
export function normalizeUrl(url: string): string {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return url;
  }

  const trimmedUrl = url.trim();

  // If URL already has protocol, return as-is
  if (trimmedUrl.includes('://')) {
    return trimmedUrl;
  }

  // Determine if this is localhost (use http:// for development)
  // Note: Private IPs (192.168.x, 10.x, 172.16-31.x) will get https://
  // and be validated/blocked at a higher level if needed
  const isLocalhost =
    trimmedUrl.startsWith('localhost') ||
    trimmedUrl.startsWith('127.0.0.1') ||
    trimmedUrl.startsWith('0.0.0.0');

  // Use http:// for localhost, https:// for public URLs
  const protocol = isLocalhost ? 'http://' : 'https://';
  const normalized = `${protocol}${trimmedUrl}`;

  // Basic validation: try to parse as URL
  try {
    new URL(normalized);
    return normalized;
  } catch {
    // If validation fails, return original (let caller handle error)
    logger.warn('[NORMALIZE_URL] Failed to validate normalized URL', {
      original: url.substring(0, 100),
      normalized: normalized.substring(0, 100),
    });
    return normalized; // Still return normalized, but log warning
  }
}

/**
 * Compress long test plans in message content
 */
export function compressMessageContent(content: string, metadata?: Record<string, any>): string {
  // Draft step messages must never be compressed — they contain structured
  // step data that the AI needs to reconstruct on the next turn
  if (metadata?.hasDraftSteps === true) {
    return content;
  }

  // If content contains a test plan (detected by length and keywords)
  if (content.length > 1000 && (
    content.includes('Test Plan') ||
    content.includes('test plan') ||
    content.includes('✅') && content.includes('❌')
  )) {
    // Extract key info
    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    const url = urlMatch ? urlMatch[0] : 'URL';

    const approvalMatch = content.match(/approved|rejected/i);
    const status = approvalMatch ? approvalMatch[0] : 'shown';

    return `[Test plan for ${url} - ${status}]`;
  }

  // If content is very long, truncate
  if (content.length > 2000) {
    return content.substring(0, 2000) + '... [truncated]';
  }

  return content;
}

/**
 * Get or create the single workspace chat session.
 * Each workspace has exactly ONE shared chat session used by all members.
 *
 * @param userId - User ID (must be a workspace member)
 * @param workspaceId - Workspace ID
 * @param providedSessionId - Optional session ID for backward compatibility
 * @returns Chat session ID or undefined for anonymous users
 */
export async function getOrCreateWorkspaceChat(
  userId: string,
  workspaceId: string,
  providedSessionId?: string
): Promise<string | undefined> {
  if (!isValidUUID(userId)) {
    return undefined;
  }

  // Validate workspace membership
  const isMember = await WorkspaceAccessService.isMember(userId, workspaceId);
  if (!isMember) {
    logger.warn('[CHAT_SESSION] User is not a workspace member', { userId, workspaceId });
    throw new Error('Not a member of this workspace');
  }

  // If providedSessionId given, validate it belongs to this workspace
  if (providedSessionId) {
    const { data: existing } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, workspace_id')
      .eq('id', providedSessionId)
      .maybeSingle();

    if (existing && existing.workspace_id === workspaceId) {
      logger.info('[CHAT_SESSION] Using provided workspace session', { sessionId: existing.id, workspaceId });
      return existing.id;
    }
    // If session doesn't match workspace, fall through to find/create the correct one
    if (existing) {
      logger.warn('[CHAT_SESSION] Provided session belongs to different workspace, ignoring', {
        providedSessionId,
        sessionWorkspace: existing.workspace_id,
        requestedWorkspace: workspaceId,
      });
    }
  }

  // Find the single workspace chat session (no user_id filter — shared)
  const { data: workspaceSession } = await supabaseAdmin
    .from('chat_sessions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true }) // Use the first (oldest) session
    .limit(1)
    .maybeSingle();

  if (workspaceSession) {
    logger.info('[CHAT_SESSION] Using existing workspace session', {
      sessionId: workspaceSession.id,
      workspaceId,
    });
    return workspaceSession.id;
  }

  // No session exists — create the workspace's single chat session
  logger.info('[CHAT_SESSION] Creating workspace chat session', { userId, workspaceId });
  return await ChatService.createChatSession(userId, workspaceId);
}

/**
 * @deprecated Use getOrCreateWorkspaceChat instead. Kept for backward compatibility.
 */
export async function getOrCreateChatSession(
  userId: string,
  providedSessionId: string | undefined,
  workspaceId: string,
  createNew: boolean = false
): Promise<string | undefined> {
  return getOrCreateWorkspaceChat(userId, workspaceId, providedSessionId);
}

/**
 * Emit WebSocket processing step update
 * ✅ FIX: Added validation to prevent sending events in wrong cases
 */
export function emitProcessingStep(
  sessionId: string | undefined,
  step: ChatProcessingStepPayload['step'],
  message: string,
  progress: number,
  metadata?: Record<string, any>
): void {
  // ✅ FIX: Skip if no sessionId (can't send to chat room)
  if (!sessionId) {
    logger.debug('[CHAT] Skipping emitProcessingStep - no sessionId', { step, message });
    return;
  }

  // ✅ FIX: Validate sessionId format (must be UUID)
  if (!isValidUUID(sessionId)) {
    logger.warn('[CHAT] Skipping emitProcessingStep - invalid sessionId format', {
      sessionId: sessionId.substring(0, 20) + '...',
      step,
      message,
    });
    return;
  }

  // ✅ FIX: Validate step and message (prevent empty/invalid data)
  if (!step || !message || typeof message !== 'string' || message.trim().length === 0) {
    logger.warn('[CHAT] Skipping emitProcessingStep - invalid step or message', {
      sessionId,
      step,
      message: message?.substring(0, 50),
    });
    return;
  }

  // ✅ FIX: Validate progress (must be 0-100)
  if (typeof progress !== 'number' || progress < 0 || progress > 100 || isNaN(progress)) {
    logger.warn('[CHAT] Skipping emitProcessingStep - invalid progress', {
      sessionId,
      step,
      message,
      progress,
    });
    return;
  }

  try {
    const payload: ChatProcessingStepPayload = {
      sessionId,
      step,
      message,
      progress,
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && { metadata }),
      timestamp: new Date().toISOString(),
    };

    webSocketService.emitChatProcessingStep(sessionId, payload);
  } catch (error) {
    // ✅ CRITICAL: Don't let WebSocket errors break the HTTP request
    // Log error but continue processing - WebSocket is optional for progress updates
    logger.warn('[CHAT] Failed to emit WebSocket progress (non-critical)', {
      sessionId,
      step,
      message,
      progress,
      error: error instanceof Error ? error.message : String(error),
    });
    // Continue execution - WebSocket errors should not break HTTP requests
  }
}

/**
 * Check if user has enough credits for chat message
 * Returns false and sends 402 response if insufficient credits
 * @param userId - User ID
 * @param res - Express response object
 * @returns True if user has enough credits, false otherwise
 */
export async function checkChatCredits(
  userId: string,
  res: Response
): Promise<boolean> {
  try {
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'chat');

    if (!creditCheck.hasEnough) {
      logger.warn('[CHAT_CREDITS] Insufficient credits', {
        userId: userId.substring(0, 8) + '...',
        required: creditCheck.required,
        available: creditCheck.available,
        shortage: creditCheck.shortage,
      });

      // Check if response already sent
      if (res.headersSent) {
        return false;
      }

      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        message: `You need ${creditCheck.required} credits to send a chat message. You have ${creditCheck.available} credits. Please purchase ${creditCheck.shortage} more credits.`,
        required: creditCheck.required,
        available: creditCheck.available,
        shortage: creditCheck.shortage,
        timestamp: new Date().toISOString(),
      });
      return false;
    }

    logger.info('[CHAT_CREDITS] Credit check passed', {
      userId: userId.substring(0, 8) + '...',
      required: creditCheck.required,
      available: creditCheck.available,
    });

    return true;
  } catch (error) {
    logger.error('[CHAT_CREDITS] Exception checking credits', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 8) + '...',
    });

    // On error, don't block the request (graceful degradation)
    // But log the error for investigation
    return true; // Allow request to proceed
  }
}

/**
 * Deduct credits for chat message after successful OpenAI response
 * @param userId - User ID
 * @param shouldDeduct - Whether to deduct credits (false for fallback responses)
 * @returns Credit deduction result
 */
export async function deductChatCredits(
  userId: string,
  shouldDeduct: boolean
): Promise<{
  success: boolean;
  newBalance?: number;
}> {
  if (!shouldDeduct) {
    return { success: true };
  }

  try {
    const chatMessageId = `chat_${Date.now()}`;
    const creditResult = await CreditCostTrackerService.deductCreditsForTest({
      userId,
      testType: 'chat',
      credits: 1,
      costUSD: 0.001,
      testId: chatMessageId,
      description: 'Chat message',
    });

    if (creditResult.success) {
      logger.info('[CHAT_CREDITS] Credits deducted successfully', {
        userId: userId.substring(0, 8) + '...',
        newBalance: creditResult.newBalance,
      });
    } else {
      // Log error but don't interrupt response (we already checked balance above)
      logger.error('[CHAT_CREDITS] Failed to deduct credits after successful response', {
        userId: userId.substring(0, 8) + '...',
        error: creditResult.error,
      });
    }

    return {
      success: creditResult.success,
      newBalance: creditResult.newBalance,
    };
  } catch (creditError) {
    // Log error but don't interrupt response
    logger.error('[CHAT_CREDITS] Exception deducting credits', {
      error: creditError instanceof Error ? creditError.message : String(creditError),
      userId: userId.substring(0, 8) + '...',
    });

    return { success: false };
  }
}

// Re-export PROGRESS for convenience
export { PROGRESS };
