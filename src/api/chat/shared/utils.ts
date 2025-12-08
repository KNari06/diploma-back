import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { isValidUUID } from '@/utils/validation';
import { ChatService } from '@/services/utils/chat.service';
import { ChatProcessingStepPayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { PROGRESS } from './constants';

/**
 * Normalize URL by adding protocol if missing
 */
export function normalizeUrl(url: string): string {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return url;
  }

  const trimmedUrl = url.trim();

  // If URL doesn't have protocol, add https://
  if (!trimmedUrl.includes('://')) {
    return `https://${trimmedUrl}`;
  }

  return trimmedUrl;
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

// Re-export PROGRESS for convenience
export { PROGRESS };
