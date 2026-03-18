import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { ChatAttachment, ChatRequest } from '../chat.types';
import { CONSTANTS, MESSAGES } from './constants';
import { PROGRESS, emitProcessingStep, getOrCreateWorkspaceChat } from './utils';

/**
 * STEP 0: INPUT VALIDATION (FIX #1 & #2)
 */
export interface Step0Result {
  userId: string;
  message: string;
  context: any;
  sessionId?: string;
  conversationId?: string;
  answers?: Record<string, any>;
  mode?: 'lite' | 'pro' | 'editor'; // Test execution mode (default: 'lite')
  executionStrategy?: 'standard' | 'exploration'; // Execution strategy from frontend
  attachments?: ChatAttachment[]; // Processed file attachments (images + documents)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function validateInput(
  req: Request,
  res: Response,
  checkConnection: () => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // _functionLogger?: FunctionLogger
): Promise<Step0Result | null> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 0: INPUT VALIDATION (FIX #1 & #2)
  // ═══════════════════════════════════════════════════════════════════════

  // Validate req.user (FIX #2)
  if (!req.user || !req.user.id) {
    logger.error('[CHAT] Authentication required - req.user missing', {
      hasReqUser: !!req.user,
      hasUserId: !!req.user?.id,
    });
    res.status(401).json({
      success: false,
      error: MESSAGES.AUTH_REQUIRED,
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  const userId = req.user.id;

  // Validate req.body (FIX #1)
  if (!req.body || typeof req.body !== 'object') {
    logger.error('[CHAT] Invalid request body', { userId });
    res.status(400).json({
      success: false,
      error: MESSAGES.INVALID_REQUEST,
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  // Check connection after validation
  checkConnection();

  const { message, context, sessionId, conversationId, answers, mode, executionStrategy } = req.body as ChatRequest;

  // Validate message (FIX #1) — allow empty message when files are attached
  const files = req.files as Express.Multer.File[] | undefined;
  const hasFiles = files && files.length > 0;
  if ((!message || typeof message !== 'string' || message.trim().length === 0) && !hasFiles) {
    logger.error('[CHAT] Message is required (no files attached)', { userId, messageType: typeof message });
    res.status(400).json({
      success: false,
      error: MESSAGES.INVALID_REQUEST,
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  logger.info('[CHAT] Request received', {
    userId,
    messageLength: message.length,
    hasSession: !!sessionId,
    hasConversation: !!conversationId,
    hasAnswers: !!answers,
    mode: mode || 'lite',
    timeout: CONSTANTS.CHAT_REQUEST_TIMEOUT,
  });

  // Process uploaded files (if any)
  const attachments = await processUploadedFiles(req);

  return {
    userId,
    message,
    context,
    sessionId,
    conversationId,
    answers,
    mode: (mode as 'lite' | 'pro' | 'editor') || 'lite', // Default to 'lite' mode
    executionStrategy: executionStrategy === 'exploration' ? 'exploration' : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FILE PROCESSING FOR CHAT ATTACHMENTS
// ═══════════════════════════════════════════════════════════════════════

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_EXTRACTED_TEXT_LENGTH = 50_000;

async function processUploadedFiles(req: Request): Promise<ChatAttachment[]> {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) return [];

  const attachments: ChatAttachment[] = [];

  for (const file of files) {
    try {
      if (IMAGE_MIMES.includes(file.mimetype)) {
        // Convert image buffer to base64 data URL
        const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        attachments.push({
          type: 'image',
          name: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          base64,
        });
      } else {
        // Document: extract text via fileParser
        let extractedText = '';
        try {
          const { promises: fs } = await import('fs');
          const path = await import('path');
          const os = await import('os');
          const { parseFile } = await import('@/utils/parsing/fileParser');

          // Write buffer to temp file (fileParser requires file path)
          const tmpDir = os.tmpdir();
          const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const tmpPath = path.join(tmpDir, `chat-upload-${uniqueSuffix}-${file.originalname}`);
          await fs.writeFile(tmpPath, file.buffer);

          try {
            const parsed = await parseFile(tmpPath, file.originalname);
            extractedText = parsed.content;
          } finally {
            // Cleanup temp file
            await fs.unlink(tmpPath).catch(() => {});
          }
        } catch (parseError) {
          logger.warn('[CHAT] Failed to parse uploaded document, using raw text fallback', {
            fileName: file.originalname,
            mimeType: file.mimetype,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          });
          // Fallback: for text-like files try UTF-8, for binary formats give a clear message
          const isBinaryMime = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype);
          extractedText = isBinaryMime
            ? `[Could not extract text from "${file.originalname}"]`
            : file.buffer.toString('utf-8');
        }

        // Truncate if too long
        if (extractedText.length > MAX_EXTRACTED_TEXT_LENGTH) {
          extractedText = extractedText.substring(0, MAX_EXTRACTED_TEXT_LENGTH)
            + `\n\n[... truncated — original file was ${extractedText.length} characters]`;
        }

        attachments.push({
          type: 'document',
          name: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          extractedText,
        });
      }
    } catch (fileError) {
      logger.error('[CHAT] Failed to process uploaded file', {
        fileName: file.originalname,
        mimeType: file.mimetype,
        error: fileError instanceof Error ? fileError.message : String(fileError),
      });
      // Skip this file, continue with others
    }
  }

  if (attachments.length > 0) {
    logger.info('[CHAT] Processed uploaded files', {
      total: attachments.length,
      images: attachments.filter(a => a.type === 'image').length,
      documents: attachments.filter(a => a.type === 'document').length,
    });
  }

  return attachments;
}

/**
 * STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
 */
export async function checkWorkspace(
  userId: string,
  sessionId?: string,
  // functionLogger?: FunctionLogger
): Promise<string> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
  // ═══════════════════════════════════════════════════════════════════════

  try {
    // 1) If sessionId is provided, verify ownership and use workspace_id from session
    if (sessionId) {
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, workspace_id, user_id')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError) {
        logger.warn('[CHAT] Failed to read chat session workspace_id', {
          userId,
          sessionId,
          code: (sessionError as any)?.code,
          message: (sessionError as any)?.message,
          details: (sessionError as any)?.details,
        });
      } else if (session?.workspace_id) {
        // Per-user chat: verify session belongs to this user
        if (session.user_id && session.user_id !== userId) {
          logger.warn('[CHAT] Session belongs to different user, ignoring provided sessionId', {
            userId,
            sessionId,
            sessionUserId: session.user_id,
          });
          // Fall through to resolve workspace from active workspace
        } else {
          return String(session.workspace_id);
        }
      }

      // If the session exists but has no workspace_id (legacy/bad data), attach it once and keep it fixed
      if (session?.id && !session.workspace_id && session.user_id === userId) {
        const activeWorkspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
        const fallbackWorkspaceId = activeWorkspaceId
          ? activeWorkspaceId
          : (await WorkspaceService.createWorkspaceForUser(userId)).workspace_id;

        const { error: updateError } = await supabaseAdmin
          .from('chat_sessions')
          .update({ workspace_id: fallbackWorkspaceId })
          .eq('id', sessionId);

        if (updateError) {
          logger.warn('[CHAT] Failed to backfill chat_sessions.workspace_id (non-fatal)', {
            userId,
            sessionId,
            workspaceId: fallbackWorkspaceId,
            code: (updateError as any)?.code,
            message: (updateError as any)?.message,
            details: (updateError as any)?.details,
          });
        }

        return fallbackWorkspaceId;
      }
    }

    // 2) No sessionId (or session not found): resolve active workspace (multi-workspace aware)
    const activeWorkspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
    if (activeWorkspaceId) {
      return activeWorkspaceId;
    }

    // 3) No workspaces at all -> create one
    const { workspace_id } = await WorkspaceService.createWorkspaceForUser(userId);
    logger.info('[CHAT] Created new workspace for chat', { userId, workspace_id });
    return workspace_id;
  } catch (workspaceError) {
    // Better error logging for PostgREST/Supabase errors
    const errorDetails = workspaceError instanceof Error
      ? {
        message: workspaceError.message,
        stack: workspaceError.stack,
      }
      : (workspaceError as any)?.code || (workspaceError as any)?.message
        ? {
          code: (workspaceError as any)?.code,
          message: (workspaceError as any)?.message,
          details: (workspaceError as any)?.details,
          hint: (workspaceError as any)?.hint,
        }
        : { raw: String(workspaceError) };

    logger.error('[CHAT] WorkspaceService failed', {
      error: errorDetails,
      userId,
    });

    // Extract readable error message for user
    const errorMessage = workspaceError instanceof Error
      ? workspaceError.message
      : (workspaceError as any)?.message || (workspaceError as any)?.code || 'Unknown error';

    throw new Error(`Failed to initialize workspace: ${errorMessage}`);
  }
}

/**
 * STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
 */
export async function manageChatSession(
  userId: string,
  sessionId: string | undefined,
  workspace_id: string,
  checkRequestTimeout: () => void,
  functionLogger?: FunctionLogger
): Promise<string | undefined> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
  // ═══════════════════════════════════════════════════════════════════════

  let chatSessionId: string | undefined;
  try {
    const getOrCreateWorkspaceChatWithLogging = functionLogger
      ? withFunctionLogging(getOrCreateWorkspaceChat, 'getOrCreateWorkspaceChat', functionLogger)
      : getOrCreateWorkspaceChat;
    chatSessionId = await getOrCreateWorkspaceChatWithLogging(userId, workspace_id, sessionId);
    logger.debug('[CHAT] Workspace chat session ready', {
      chatSessionId: chatSessionId || 'none',
      providedSessionId: sessionId || 'none',
    });
  } catch (sessionError) {
    logger.warn('[CHAT] getOrCreateChatSession failed, continuing without session', {
      error: sessionError instanceof Error ? sessionError.message : String(sessionError),
      userId,
    });
    // Continue without session (graceful degradation)
    chatSessionId = undefined;
  }

  // Emit: Enriching context (FIX #11: Using PROGRESS constants)
  const emitProcessingStepWithLogging = functionLogger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
    : emitProcessingStep;
  emitProcessingStepWithLogging(chatSessionId, 'enriching_context', 'Analyzing your request...', PROGRESS.ENRICHING);

  checkRequestTimeout();

  return chatSessionId;
}
