import { supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
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
export function compressMessageContent(content: string): string {
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
 * Get or create chat session with multi-chat support
 * @param userId - User ID
 * @param providedSessionId - Existing session ID (optional)
 * @param workspaceId - Workspace ID
 * @param createNew - Force create new session (for multi-chat support)
 * @returns Chat session ID or undefined for anonymous
 */
export async function getOrCreateChatSession(
  userId: string,
  providedSessionId: string | undefined,
  workspaceId: string,
  createNew: boolean = false
): Promise<string | undefined> {
  // FIX #7: Use centralized UUID validation
  if (!isValidUUID(userId)) {
    // Anonymous user - no session
    return undefined;
  }

  // If providedSessionId exists, verify and use it
  if (providedSessionId) {
    const { data: existing } = await supabaseAdmin
      .from('chat_sessions')
      .select('id')
      .eq('id', providedSessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      logger.info('[CHAT_SESSION] Using provided session', { sessionId: existing.id, userId });
      return existing.id;
    } else {
      logger.warn('[CHAT_SESSION] Provided session not found, will create new', {
        providedSessionId,
        userId,
      });
    }
  }

  // If createNew = true, always create new session (multi-chat support)
  if (createNew) {
    logger.info('[CHAT_SESSION] Creating new chat session (multi-chat)', { userId, workspaceId });
    return await ChatService.createChatSession(userId, workspaceId);
  }

  // Otherwise, find latest session (backward compatibility)
  const { data: existing } = await supabaseAdmin
    .from('chat_sessions')
    .select('id')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false }) // Sort by updated_at for recent activity
    .limit(1)
    .maybeSingle();

  if (existing) {
    logger.info('[CHAT_SESSION] Using existing session', { sessionId: existing.id, userId });
    return existing.id;
  }

  // Create new session if none exists
  logger.info('[CHAT_SESSION] No existing session, creating new', { userId, workspaceId });
  return await ChatService.createChatSession(userId, workspaceId);
}

/**
 * Emit WebSocket processing step update
 */
export function emitProcessingStep(
  sessionId: string | undefined,
  step: ChatProcessingStepPayload['step'],
  message: string,
  progress: number
): void {
  if (!sessionId) return;

  try {
    const payload: ChatProcessingStepPayload = {
      sessionId,
      step,
      message,
      progress,
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
