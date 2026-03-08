import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { ChatService } from '@/services/utils/chat.service';
import { getPageContext } from '@/services/chat/editor-context.service';
import { getPreviewSessionService } from '@/services/testing/ui/preview';
import { PreviewStepApplyService } from '@/services/testing/ui/preview/preview-step-apply.service';
import type { IntentStep, IntentActionType } from '@/services/testing/ui/preview/preview.types';
import { webSocketService } from '@/websocket/core/websocket.service';
import { createRoomName, type PreviewPagePayload, type ChatMessagePayload } from '@/websocket/types/types';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { handleGeneralChat } from '../general/handler';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: EDITOR ACTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Executes a SINGLE direct action on the live preview in editor mode.
 * Short-circuits the full test plan generation flow for simple actions
 * like "click the login button" or "type 'hello' in the search input".
 *
 * Uses PreviewStepApplyService.applyStep() for immediate execution.
 * Falls back to handleGeneralChat if action extraction fails.
 */
export async function handleEditorAction(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    context?: any;
    abortSignal?: AbortSignal;
    mode?: 'lite' | 'pro' | 'editor';
  }
): Promise<void> {
  const { message, parsedIntent, userId, chatSessionId, context, abortSignal, mode } = params;

  // Parse context to extract previewSessionId
  let contextObj: any = null;
  if (typeof context === 'string') {
    try {
      contextObj = JSON.parse(context);
    } catch {
      contextObj = null;
    }
  } else if (typeof context === 'object' && context !== null) {
    contextObj = context;
  }

  const previewSessionId = contextObj?.previewSessionId;

  // Guard: must have a preview session to execute editor actions
  if (!previewSessionId) {
    logger.warn('[EDITOR_ACTION] No previewSessionId found, falling back to general_chat', { userId });
    return fallbackToGeneralChat(req, res, params);
  }

  // Verify session exists and is owned by user
  const sessionService = getPreviewSessionService();
  if (!sessionService.isSessionOwned(previewSessionId, userId)) {
    logger.warn('[EDITOR_ACTION] Session not owned by user, falling back to general_chat', {
      previewSessionId,
      userId,
    });
    return fallbackToGeneralChat(req, res, params);
  }

  logger.info('[EDITOR_ACTION] Processing editor action', {
    previewSessionId,
    userId,
    messagePreview: message.slice(0, 80),
  });

  try {
    // Editor trace: log AI action request
    const eaTrace = EditorTraceService.get(previewSessionId);
    if (eaTrace) eaTrace.writeEditorActionRequest({ message: message.slice(0, 500), previewSessionId });

    // Step 1: Get page context for AI action extraction
    const pageContext = await getPageContext(previewSessionId, userId);
    if (!pageContext) {
      logger.warn('[EDITOR_ACTION] Could not get page context, falling back to general_chat', {
        previewSessionId,
      });
      return fallbackToGeneralChat(req, res, params);
    }

    // Step 2: Extract action from user message using AI
    const extracted = await extractActionWithAI(message, pageContext.domSummary, abortSignal);

    // Editor trace: log AI extraction result
    if (eaTrace) eaTrace.writeEditorActionExtract(extracted);

    if (!extracted) {
      logger.info('[EDITOR_ACTION] AI could not extract action, falling back to general_chat', {
        previewSessionId,
      });
      return fallbackToGeneralChat(req, res, params);
    }
    const actionType = extracted.type;
    const actionDescription = extracted.description;
    const actionValue = extracted.value;

    // Step 3: Build IntentStep
    const stepId = `ea_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const stepDraft: IntentStep = {
      id: stepId,
      type: actionType,
      description: actionDescription,
      ...(actionValue !== undefined && { value: actionValue }),
    };

    logger.info('[EDITOR_ACTION] Executing step', {
      previewSessionId,
      stepId,
      type: actionType,
      description: actionDescription.slice(0, 80),
    });

    // Step 4: Execute the action via PreviewStepApplyService
    const result = await PreviewStepApplyService.applyStep({
      previewSessionId,
      stepDraft,
      userId,
    });

    // Editor trace: log apply result
    if (eaTrace) eaTrace.writeEditorActionResult({
      success: result.success, error: result.error, actionType, stepId,
    });

    // Step 5: Build response message
    let responseMessage: string;
    if (result.success) {
      responseMessage = buildSuccessMessage(actionType, actionDescription);
    } else {
      responseMessage = `I tried to ${actionDescription}, but it didn't work: ${result.error || 'unknown error'}. You can try describing the element more specifically.`;
    }

    // Step 6: Emit snapshot update to preview room (async, non-blocking)
    if (result.success) {
      emitSnapshotUpdate(previewSessionId, userId);
    }

    // Step 7: Save chat messages
    if (chatSessionId) {
      try {
        await ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
            content: responseMessage,
            metadata: {
              editorAction: true,
              actionType,
              actionDescription,
              success: result.success,
              error: result.error,
            },
          },
        ]);
      } catch (saveError) {
        logger.warn('[EDITOR_ACTION] Failed to save chat messages (non-critical)', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
      }
    }

    // Step 8: Emit chat message via WebSocket
    if (chatSessionId) {
      try {
        const aiMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const chatPayload: ChatMessagePayload = {
          sessionId: chatSessionId,
          messageId: aiMessageId,
          role: 'assistant',
          content: responseMessage,
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitChatMessage(chatSessionId, chatPayload);
      } catch (wsError) {
        logger.warn('[EDITOR_ACTION] Failed to emit WebSocket message (non-critical)', {
          error: wsError instanceof Error ? wsError.message : String(wsError),
        });
      }
    }

    // Step 9: Send HTTP response
    res.json({
      response: responseMessage,
      intent: 'editor_action',
      editorAction: {
        type: actionType,
        description: actionDescription,
        success: result.success,
        error: result.error,
        stepId,
      },
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  } catch (error) {
    logger.error('[EDITOR_ACTION] Unexpected error, falling back to general_chat', {
      error: error instanceof Error ? error.message : String(error),
      previewSessionId,
      userId,
    });
    // Editor trace: log unexpected error
    const errTrace = EditorTraceService.get(previewSessionId);
    if (errTrace) errTrace.writeError('editor_action_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackToGeneralChat(req, res, params);
  }
}

/**
 * Extract action from user message using a small AI call.
 * Returns null if the message doesn't describe a clear single action.
 */
async function extractActionWithAI(
  message: string,
  domSummary: string,
  abortSignal?: AbortSignal
): Promise<{ type: IntentActionType; description: string; value?: string } | null> {
  const systemPrompt = `You extract a SINGLE browser action from the user's message.

AVAILABLE ACTIONS: click, type, scroll, press, hover, select, check, uncheck, navigate, upload

PAGE ELEMENTS:
${domSummary}

Return ONLY valid JSON:
{
  "type": "click" | "type" | "scroll" | "press" | "hover" | "select" | "check" | "uncheck" | "navigate" | "upload",
  "description": "human-readable description of the target element (e.g., 'Login button', 'Email input field')",
  "value": "text to type or key to press (only for type/press/select actions, omit otherwise)"
}

If the message does NOT describe a single clear action, return: {"type": null}

Examples:
- "click the login button" → {"type": "click", "description": "Login button"}
- "type hello in the search box" → {"type": "type", "description": "search box", "value": "hello"}
- "scroll down" → {"type": "scroll", "description": "scroll down"}
- "press Enter" → {"type": "press", "description": "press Enter", "value": "Enter"}
- "hover over the menu" → {"type": "hover", "description": "menu"}
- "upload a profile photo" → {"type": "upload", "description": "profile photo file input", "value": "photo.jpg"}
- "what does this page do?" → {"type": null}`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

  try {
    const result = await getChatCompletionWithMessages(messages, {
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      model: AI_TASK_MODELS.intentLint,
      abortSignal,
    });

    const content = typeof result === 'string' ? result : result?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    if (!parsed.type || parsed.type === null) return null;

    const validTypes: IntentActionType[] = [
      'click', 'type', 'scroll', 'press', 'hover', 'select', 'check', 'uncheck', 'navigate', 'upload',
    ];
    if (!validTypes.includes(parsed.type)) return null;

    return {
      type: parsed.type as IntentActionType,
      description: parsed.description || message,
      value: parsed.value || undefined,
    };
  } catch (error) {
    logger.warn('[EDITOR_ACTION] AI action extraction failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Build a user-friendly success message for the executed action.
 */
function buildSuccessMessage(type: IntentActionType, description: string): string {
  switch (type) {
    case 'click':
      return `Done! I clicked on "${description}".`;
    case 'type':
      return `Done! I typed the text into "${description}".`;
    case 'scroll':
      return `Done! I scrolled the page.`;
    case 'press':
      return `Done! I pressed the key.`;
    case 'hover':
      return `Done! I hovered over "${description}".`;
    case 'select':
      return `Done! I selected the option in "${description}".`;
    case 'check':
      return `Done! I checked "${description}".`;
    case 'uncheck':
      return `Done! I unchecked "${description}".`;
    case 'navigate':
      return `Done! Navigating to the specified URL.`;
    case 'upload':
      return `Done! I uploaded the file to "${description}".`;
    default:
      return `Done! Action "${type}" completed on "${description}".`;
  }
}

/**
 * Emit snapshot update to the preview room after a successful action.
 * Runs asynchronously — does not block the response.
 */
function emitSnapshotUpdate(previewSessionId: string, userId: string): void {
  setImmediate(async () => {
    try {
      const sessionService = getPreviewSessionService();
      const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
        force: true,
        includeDomNodes: true,
        onlyIfChanged: true,
      });

      if (snapshot && snapshot.changed) {
        const room = createRoomName('preview', previewSessionId);
        const payload: PreviewPagePayload = {
          previewSessionId,
          url: snapshot.url,
          domVersion: snapshot.domVersion,
          pageSignature: snapshot.pageSignature,
          domNodes: snapshot.domNodes,
          timestamp: new Date().toISOString(),
        };

        webSocketService.emitToRoom('preview', previewSessionId, 'preview:page', payload);

        logger.debug('[EDITOR_ACTION] Emitted preview:page after action', {
          previewSessionId,
          domVersion: snapshot.domVersion,
        });
      }
    } catch (error) {
      logger.warn('[EDITOR_ACTION] Failed to emit snapshot update (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId,
      });
    }
  });
}

/**
 * Fallback to general chat handler when editor action cannot be executed.
 */
function fallbackToGeneralChat(
  req: Request,
  res: Response,
  params: {
    message: string;
    userId: string;
    chatSessionId?: string;
    context?: any;
    workspace_id?: string;
    abortSignal?: AbortSignal;
    mode?: 'lite' | 'pro' | 'editor';
  }
): Promise<void> {
  return handleGeneralChat(req, res, {
    message: params.message,
    userId: params.userId,
    chatSessionId: params.chatSessionId,
    context: params.context,
    workspace_id: params.workspace_id,
    abortSignal: params.abortSignal,
    mode: params.mode,
  });
}
