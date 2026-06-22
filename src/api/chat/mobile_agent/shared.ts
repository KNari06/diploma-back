/**
 * Shared helpers for mobile-editor intents (mobile_action + mobile_agent).
 *
 * Both handlers need the same things:
 *   - Resolve `mobileSessionId` from the chat context object (string or JSON).
 *   - Persist user + AI messages with `editorKind: 'mobile'` metadata.
 *   - Reject cleanly when no runner session is attached.
 *
 * Keep this thin — it's plumbing, not business logic.
 */

import { ChatPersistence } from '@/services/utils/chat-persistence';
import { GLOBAL_STORE, type ChatStore } from '@/services/utils/chat-store';
import { logger } from '@/utils/core/logger';

export interface MobileChatContext {
  mobileSessionId?: string;
  mobileEditorMode?: boolean;
  projectId?: string;
  [key: string]: unknown;
}

/**
 * Safely extract the context object from the chat request. The frontend may
 * serialise it as JSON string or send it as a nested object — both shapes
 * arrive here. Anything unparseable → null.
 */
export function parseMobileContext(context: unknown): MobileChatContext | null {
  if (!context) return null;
  if (typeof context === 'string') {
    try {
      return JSON.parse(context) as MobileChatContext;
    } catch {
      return null;
    }
  }
  if (typeof context === 'object') return context as MobileChatContext;
  return null;
}

/**
 * Persist both turns of the exchange, tagged with `editorKind: 'mobile'` so
 * analytics / history filters can distinguish mobile-editor chats from web.
 * Best-effort — a DB failure must not break the user-visible reply.
 *
 * `store` selects the persistence backend (mirrors web's editor_action):
 * GLOBAL_STORE for workspace-level mobile chat, TESTCASE_STORE when the
 * mobile editor is scoped to a saved test case. Defaults to GLOBAL_STORE so
 * callers that don't yet thread the store keep their previous behaviour.
 */
export async function saveMobileChatTurn(
  chatSessionId: string | undefined,
  userMessage: string,
  aiReply: string,
  metadata: Record<string, unknown>,
  intentTag: 'mobile_action' | 'mobile_agent',
  store: ChatStore = GLOBAL_STORE,
): Promise<void> {
  if (!chatSessionId) return;
  try {
    await ChatPersistence.saveMessages(store, chatSessionId, [
      {
        role: 'user',
        content: userMessage,
        metadata: { editorKind: 'mobile', intent: intentTag },
      },
      {
        role: 'ai',
        content: aiReply,
        metadata: { editorKind: 'mobile', intent: intentTag, ...metadata },
      },
    ]);
  } catch (err) {
    logger.warn(`[${intentTag.toUpperCase()}] Failed to persist chat messages`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Standard rejection when no runner session is attached. Both handlers need
 * exactly the same response, so keeping it here avoids divergence.
 */
export const NO_SESSION_REPLY =
  '📱 No active mobile session. Start a device in the editor, then ask again.';
