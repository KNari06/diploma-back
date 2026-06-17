import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TELEGRAM BOT API SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Telegram Bot API client for sending messages, managing chats,
 * and interacting with Telegram through the QAIT agent.
 *
 * Uses the Bot API directly (no grammy/telegraf dependency).
 * Token stored per-user in integration_tokens.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TELEGRAM_API_URL = 'https://api.telegram.org';

export interface TelegramTokenData {
  id: string;
  user_id: string;
  workspace_id?: string;
  access_token: string; // Bot token
  external_id?: string; // Chat ID or bot username
  external_url?: string;
  metadata?: Record<string, any>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
    type: string;
    title?: string;
    username?: string;
  };
  text?: string;
  date: number;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  description?: string;
}

interface TelegramApiResponse<T = any> {
  ok: boolean;
  result: T;
  description?: string;
}

/**
 * Get Telegram bot token for user from integration_tokens.
 * When workspaceId is provided, scopes lookup to that workspace.
 * Returns null if no personal token exists.
 */
export async function getTelegramToken(userId: string, workspaceId?: string): Promise<TelegramTokenData | null> {
  try {
    let query = supabaseAdmin
      .from('integration_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'telegram')
      .eq('enabled', true);

    if (workspaceId) {
      // Match workspace-scoped tokens OR global tokens (workspace_id IS NULL),
      // mirroring IntegrationTokenService.getToken — a globally-connected bot
      // must still resolve when a caller passes a workspaceId.
      query = query.or(`workspace_id.eq.${workspaceId},workspace_id.is.null`);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('[TELEGRAM_SERVICE] Failed to get token', {
        error: error.message,
        userId,
      });
      throw error;
    }

    return (data as TelegramTokenData) ?? null;
  } catch (error) {
    logger.error('[TELEGRAM_SERVICE] Get token error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    throw error;
  }
}

/**
 * Send a text message to a Telegram chat
 */
export async function sendMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  parseMode: 'HTML' | 'Markdown' | 'MarkdownV2' = 'HTML',
  options?: { disableLinkPreview?: boolean },
): Promise<TelegramMessage> {
  try {
    logger.info('[TELEGRAM_SERVICE] Sending message', { chatId, textLength: text.length });

    const response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        ...(options?.disableLinkPreview && {
          link_preview_options: { is_disabled: true },
        }),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[TELEGRAM_SERVICE] Failed to send message', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Telegram API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as TelegramApiResponse<TelegramMessage>;
    if (!result.ok) {
      throw new Error(`Telegram API returned error: ${result.description}`);
    }

    logger.info('[TELEGRAM_SERVICE] Message sent', {
      messageId: result.result.message_id,
      chatId,
    });

    return result.result;
  } catch (error) {
    logger.error('[TELEGRAM_SERVICE] Send message error', {
      error: error instanceof Error ? error.message : String(error),
      chatId,
    });
    throw error;
  }
}

/**
 * Get chat information
 */
export async function getChat(
  botToken: string,
  chatId: string | number
): Promise<TelegramChat> {
  try {
    logger.info('[TELEGRAM_SERVICE] Getting chat info', { chatId });

    const response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as TelegramApiResponse<TelegramChat>;
    if (!result.ok) {
      throw new Error(`Telegram API returned error: ${result.description}`);
    }

    return result.result;
  } catch (error) {
    logger.error('[TELEGRAM_SERVICE] Get chat error', {
      error: error instanceof Error ? error.message : String(error),
      chatId,
    });
    throw error;
  }
}

/**
 * Send a document/file to a Telegram chat
 */
export async function sendDocument(
  botToken: string,
  chatId: string | number,
  documentUrl: string,
  caption?: string
): Promise<TelegramMessage> {
  try {
    logger.info('[TELEGRAM_SERVICE] Sending document', { chatId, documentUrl });

    const response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        document: documentUrl,
        caption,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as TelegramApiResponse<TelegramMessage>;
    if (!result.ok) {
      throw new Error(`Telegram API returned error: ${result.description}`);
    }

    return result.result;
  } catch (error) {
    logger.error('[TELEGRAM_SERVICE] Send document error', {
      error: error instanceof Error ? error.message : String(error),
      chatId,
    });
    throw error;
  }
}

/**
 * Get bot information (whoami)
 */
export async function getMe(botToken: string): Promise<{
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}> {
  try {
    const response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/getMe`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as TelegramApiResponse<{ id: number; is_bot: boolean; first_name: string; username: string }>;
    if (!result.ok) {
      throw new Error(`Telegram API returned error: ${result.description}`);
    }

    return result.result;
  } catch (error) {
    logger.error('[TELEGRAM_SERVICE] getMe error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Pin a message in a chat
 */
export async function pinMessage(
  botToken: string,
  chatId: string | number,
  messageId: number
): Promise<boolean> {
  try {
    const response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as TelegramApiResponse<boolean>;
    return result.ok;
  } catch (error) {
    logger.error('[TELEGRAM_SERVICE] Pin message error', {
      error: error instanceof Error ? error.message : String(error),
      chatId,
      messageId,
    });
    throw error;
  }
}
