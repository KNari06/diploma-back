import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getTelegramToken,
  sendMessage,
  getChat,
  sendDocument,
  getMe,
  isValidTelegramChatId,
} from '@/services/api/telegram.service';
import { IntegrationTokenService } from '@/services/api/integration-token.service';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TELEGRAM SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Telegram Bot integration for sending messages and notifications.
 * Provides: send message, get chat info, send document
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Telegram skill tools
 */
const TELEGRAM_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'telegram_connect',
      description:
        'Connect or update a Telegram bot for the user. Use when user asks to connect/setup/integrate Telegram OR change their bot token/chat ID. If already connected, calling again with a new token will replace the old one. Guides user to get a bot token from @BotFather, then saves it. Does NOT require an existing connection — always available.',
      parameters: {
        type: 'object',
        properties: {
          bot_token: {
            type: 'string',
            description: 'Bot token from @BotFather (format: 123456789:ABCdef...)',
          },
          chat_id: {
            type: 'string',
            description:
              'Default chat/group/channel ID to send messages to. User can get this from @userinfobot or @getidsbot in Telegram.',
          },
          description: {
            type: 'string',
            description: 'Optional label for this bot (e.g. "QA Notifications")',
          },
        },
        required: ['bot_token', 'chat_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_status',
      description:
        'Check if Telegram bot is connected for the user. Returns connection status, bot username, and default chat ID. Always available.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_disconnect',
      description:
        'Disconnect the Telegram bot integration for the user. Use when user asks to disconnect/remove/unlink Telegram. Requires confirmation. Always available (does not require an existing connection).',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after warning user that Telegram will be disconnected AND receiving explicit approval.',
          },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_send_message',
      description: 'Send a text message to a Telegram chat or group. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'Telegram chat ID or @channel_username to send the message to',
          },
          text: {
            type: 'string',
            description: 'Message text to send. Supports HTML formatting (<b>bold</b>, <i>italic</i>, <code>code</code>).',
          },
          parse_mode: {
            type: 'string',
            enum: ['HTML', 'Markdown', 'MarkdownV2'],
            description: 'Message formatting mode. Default: HTML',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_get_chat',
      description: 'Get information about a Telegram chat, group, or channel.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'Telegram chat ID or @channel_username',
          },
        },
        required: ['chat_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_send_document',
      description: 'Send a document/file to a Telegram chat via URL. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'Telegram chat ID or @channel_username',
          },
          document_url: {
            type: 'string',
            description: 'URL of the document to send',
          },
          caption: {
            type: 'string',
            description: 'Optional caption for the document',
          },
        },
        required: ['chat_id', 'document_url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_send_notification',
      description: 'Send a formatted notification message (e.g., test results, build status, alerts) to a Telegram chat. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'Telegram chat ID or @channel_username',
          },
          title: {
            type: 'string',
            description: 'Notification title',
          },
          body: {
            type: 'string',
            description: 'Notification body text',
          },
          level: {
            type: 'string',
            enum: ['info', 'success', 'warning', 'error'],
            description: 'Notification severity level. Default: info',
          },
        },
        required: ['chat_id', 'title', 'body'],
      },
    },
  },
];

/**
 * Telegram skill definition
 */
export const TelegramSkill: SkillDefinition = {
  id: 'telegram',
  name: 'Telegram',
  provider: 'telegram',
  description: 'Send messages, notifications, and documents to Telegram chats, groups, and channels. Connect your Telegram bot to enable.',
  tools: TELEGRAM_TOOLS,

  /**
   * Always available — telegram_connect tool works without an existing token.
   * Other tools will fail gracefully if not connected.
   */
  async isAvailable(_context: SkillContext): Promise<boolean> {
    return true;
  },

  /**
   * Execute a Telegram tool
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[TELEGRAM_SKILL] Executing tool', {
      toolName,
      args: JSON.stringify(args),
      userId: context.userId,
    });

    try {
      // these tools do not need an existing token — handle first
      if (toolName === 'telegram_connect') {
        return await handleConnect(args, context);
      }

      if (toolName === 'telegram_disconnect') {
        return await handleDisconnect(args, context);
      }

      if (toolName === 'telegram_status') {
        return await handleStatus(context);
      }

      // All other tools require an existing token
      const tokenData = await getTelegramToken(context.userId, context.workspaceId);
      if (!tokenData) {
        // Distinguish "disabled" from "never connected"
        const hasDisabled = await hasDisabledTelegramToken(context.userId, context.workspaceId);
        return {
          success: false,
          message: hasDisabled
            ? 'Telegram was previously connected but is now disabled. Ask the user for their bot token from @BotFather (format: 123456789:ABCdef...) to reconnect, then call telegram_connect.'
            : 'Telegram is not connected. Ask the user for their bot token from @BotFather in Telegram (format: 123456789:ABCdef...). Once they provide it, call telegram_connect with bot_token parameter.',
          displayToUser: true,
        };
      }

      const botToken = tokenData.access_token;

      // Route to appropriate handler
      let result: SkillResult;
      switch (toolName) {
        case 'telegram_send_message':
          result = await handleSendMessage(botToken, args);
          break;

        case 'telegram_get_chat':
          result = await handleGetChat(botToken, args);
          break;

        case 'telegram_send_document':
          result = await handleSendDocument(botToken, args);
          break;

        case 'telegram_send_notification':
          result = await handleSendNotification(botToken, args);
          break;

        default:
          return {
            success: false,
            message: `Unknown Telegram tool: ${toolName}`,
            displayToUser: false,
          };
      }

      // Detect revoked/invalid token from failed results
      if (!result.success && isTelegramTokenRevokedError(result.message)) {
        return {
          success: false,
          message: 'The Telegram bot token has been revoked or is invalid. Please reconnect using telegram_connect with a new token from @BotFather.',
          displayToUser: true,
        };
      }

      // A 400 is a bad message/chat problem, NOT a token problem — give the
      // user an accurate, actionable message instead of "token revoked".
      if (!result.success && isTelegramBadRequestError(result.message)) {
        return {
          success: false,
          message: telegramBadRequestMessage(result.message),
          displayToUser: true,
        };
      }

      return result;
    } catch (error) {
      logger.error('[TELEGRAM_SKILL] Execution error', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      // Catch revoked token at the top-level catch too
      if (isTelegramTokenRevokedError(error)) {
        return {
          success: false,
          message: 'The Telegram bot token has been revoked or is invalid. Please reconnect using telegram_connect with a new token from @BotFather.',
          displayToUser: true,
        };
      }

      // 400 Bad Request → bad chat/message, not a token issue.
      if (isTelegramBadRequestError(error)) {
        return {
          success: false,
          message: telegramBadRequestMessage(error),
          displayToUser: true,
        };
      }

      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }
  },
};

/**
 * Connect Telegram bot handler
 * Called by telegram_connect tool — saves bot token for the user
 */
async function handleConnect(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const { bot_token, chat_id, description } = args;

  if (!bot_token || typeof bot_token !== 'string') {
    return {
      success: false,
      message: 'bot_token is required. Ask user to get it from @BotFather in Telegram.',
      displayToUser: true,
    };
  }

  if (!chat_id) {
    return {
      success: false,
      message: 'chat_id is required for notifications to work. Ask user to send a message to the bot, then get their chat ID from @userinfobot or @getidsbot.',
      displayToUser: true,
    };
  }

  // Validate chat_id SHAPE — must be a numeric id or an @channel handle, never
  // the bot's own username (a real incident stored "<bot>_bot" here, which made
  // every send fail with a misleading "token invalid" error).
  if (!isValidTelegramChatId(chat_id)) {
    return {
      success: false,
      message:
        'That does not look like a chat ID. A chat ID is a NUMBER (e.g. 8238452651, or a negative number for groups) or a public @channel handle — not the bot username. Ask the user to message their bot, then get the numeric chat ID from @userinfobot or @getidsbot.',
      displayToUser: true,
    };
  }

  // Validate token format
  if (!/^\d+:[\w-]+$/.test(bot_token)) {
    return {
      success: false,
      message:
        'Invalid bot token format. It should look like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz. Ask user to copy it again from @BotFather.',
      displayToUser: true,
    };
  }

  // Verify token against Telegram API
  let botInfo: { id: number; is_bot: boolean; first_name: string; username: string };
  try {
    botInfo = await getMe(bot_token);
  } catch {
    return {
      success: false,
      message:
        'Could not verify the bot token with Telegram. Please double-check the token from @BotFather.',
      displayToUser: true,
    };
  }

  if (!botInfo.is_bot) {
    return {
      success: false,
      message: 'The token provided is not a bot token. Please use a token from @BotFather.',
      displayToUser: true,
    };
  }

  // Save token
  try {
    await IntegrationTokenService.saveToken(context.userId, context.workspaceId, 'telegram', {
      access_token: bot_token,
      token_type: 'Bot',
      external_id: String(chat_id),
      external_url: `https://t.me/${botInfo.username}`,
      metadata: {
        bot_id: botInfo.id,
        bot_username: botInfo.username,
        bot_name: botInfo.first_name,
        description: description || undefined,
      },
    });
  } catch (error) {
    logger.error('[TELEGRAM_SKILL] Failed to save token', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to save the bot token. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[TELEGRAM_SKILL] Bot connected via chat', {
    userId: context.userId,
    botUsername: botInfo.username,
  });

  return {
    success: true,
    data: {
      botUsername: botInfo.username,
      botName: botInfo.first_name,
      chatId: chat_id,
    },
    message: `Telegram bot @${botInfo.username} connected successfully. Default chat set to ${chat_id}.`,
    displayToUser: true,
  };
}

/**
 * Check if an error indicates a revoked/invalid bot token (401/403 from Telegram API)
 */
function isTelegramTokenRevokedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /Telegram API error: (401|403)/i.test(msg) || /Unauthorized/i.test(msg);
}

/**
 * Check if an error is a 400 Bad Request from Telegram — a BAD MESSAGE/CHAT
 * problem (wrong chat_id, message too long, unparseable HTML), NOT a token
 * problem. Surfacing this as "token revoked" (the old behaviour) misled users
 * into reconnecting a perfectly valid bot. Distinguish the common chat_id case.
 */
function isTelegramBadRequestError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /Telegram API error: 400/i.test(msg);
}

function telegramBadRequestMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  // The most common 400 in practice: the stored chat_id is wrong (e.g. a bot
  // username was saved instead of a numeric chat ID, or the bot was never
  // messaged from that chat).
  if (/chat not found|chat_id is empty|invalid.*chat|peer_id_invalid/i.test(msg)) {
    return 'Could not deliver: the chat ID looks wrong or the bot was never started in that chat. Send your bot a message, get the numeric chat ID from @userinfobot, then reconnect with telegram_connect.';
  }
  if (/can't parse entities|message text is empty|message is too long/i.test(msg)) {
    return 'Could not deliver: the message could not be formatted for Telegram. This is a formatting issue on our side, not your bot — please report it.';
  }
  return 'Could not deliver the Telegram message (bad request). Your bot token is fine — check the chat ID, or try again.';
}

/**
 * Check for a disabled token (exists but enabled=false).
 * Used to distinguish "never connected" from "was connected but disabled".
 */
async function hasDisabledTelegramToken(userId: string, workspaceId?: string): Promise<boolean> {
  try {
    let query = supabaseAdmin
      .from('integration_tokens')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', 'telegram')
      .eq('enabled', false);

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data } = await query.limit(1).maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Status handler — check if Telegram is connected
 */
async function handleStatus(context: SkillContext): Promise<SkillResult> {
  const tokenData = await getTelegramToken(context.userId, context.workspaceId);

  if (!tokenData) {
    // Check if there's a disabled token — different message than "never connected"
    const hasDisabled = await hasDisabledTelegramToken(context.userId, context.workspaceId);

    if (hasDisabled) {
      return {
        success: true,
        data: { connected: false, disabled: true },
        message: 'Telegram was previously connected but is now disabled. Ask the user for their bot token from @BotFather (format: 123456789:ABCdef...) to reconnect, then call telegram_connect with bot_token parameter.',
        displayToUser: true,
      };
    }

    return {
      success: true,
      data: { connected: false },
      message: 'Telegram is not connected. To connect: ask the user for their bot token from @BotFather in Telegram (format: 123456789:ABCdef...). Once they provide it, call telegram_connect with bot_token parameter.',
      displayToUser: true,
    };
  }

  const meta = tokenData.metadata || {};
  return {
    success: true,
    data: {
      connected: true,
      botUsername: meta.bot_username || null,
      botName: meta.bot_name || null,
      chatId: tokenData.external_id || null,
      description: meta.description || null,
      connectedAt: tokenData.created_at,
    },
    message: `Telegram connected: @${meta.bot_username || 'unknown'}${tokenData.external_id ? `, default chat: ${tokenData.external_id}` : ''}`,
    displayToUser: true,
  };
}

/**
 * Disconnect Telegram bot handler
 */
async function handleDisconnect(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Disconnecting Telegram requires confirmation. Warn the user that the bot will be removed and they will need to reconnect it. Set confirm=true after explicit approval.',
      displayToUser: true,
    };
  }

  // Check if connected at all
  const tokenData = await getTelegramToken(context.userId, context.workspaceId);
  if (!tokenData) {
    return {
      success: false,
      message: 'Telegram is not connected — nothing to disconnect.',
      displayToUser: true,
    };
  }

  try {
    await IntegrationTokenService.deleteToken(context.userId, 'telegram', undefined, context.workspaceId);
  } catch (error) {
    logger.error('[TELEGRAM_SKILL] Failed to disconnect', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to disconnect Telegram. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[TELEGRAM_SKILL] Bot disconnected via chat', { userId: context.userId });

  return {
    success: true,
    data: { disconnected: true },
    message: 'Telegram bot disconnected successfully. You can reconnect anytime using telegram_connect.',
    displayToUser: true,
  };
}

/**
 * Send message handler
 */
async function handleSendMessage(
  botToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { chat_id, text, parse_mode = 'HTML' } = args;

  if (!chat_id || !text) {
    return {
      success: false,
      message: 'Missing required fields: chat_id, text',
      displayToUser: false,
    };
  }

  try {
    const message = await sendMessage(botToken, chat_id, text, parse_mode);

    logger.info('[TELEGRAM_SKILL] Message sent', {
      messageId: message.message_id,
      chatId: chat_id,
    });

    return {
      success: true,
      data: { messageId: message.message_id, chatId: chat_id },
      message: `Sent message to Telegram chat ${chat_id}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[TELEGRAM_SKILL] Failed to send message', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Get chat handler
 */
async function handleGetChat(
  botToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { chat_id } = args;

  if (!chat_id) {
    return {
      success: false,
      message: 'Missing required field: chat_id',
      displayToUser: false,
    };
  }

  try {
    const chat = await getChat(botToken, chat_id);

    logger.info('[TELEGRAM_SKILL] Chat info retrieved', { chatId: chat_id });

    return {
      success: true,
      data: {
        id: chat.id,
        type: chat.type,
        title: chat.title || chat.first_name,
        username: chat.username,
        description: chat.description,
      },
      message: `Chat: ${chat.title || chat.first_name || chat.username || chat.id} (${chat.type})`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[TELEGRAM_SKILL] Failed to get chat', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to get chat info: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Send document handler
 */
async function handleSendDocument(
  botToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { chat_id, document_url, caption } = args;

  if (!chat_id || !document_url) {
    return {
      success: false,
      message: 'Missing required fields: chat_id, document_url',
      displayToUser: false,
    };
  }

  try {
    const message = await sendDocument(botToken, chat_id, document_url, caption);

    logger.info('[TELEGRAM_SKILL] Document sent', {
      messageId: message.message_id,
      chatId: chat_id,
    });

    return {
      success: true,
      data: { messageId: message.message_id, chatId: chat_id },
      message: `Sent document to Telegram chat ${chat_id}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[TELEGRAM_SKILL] Failed to send document', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to send document: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Send notification handler (formatted message)
 */
async function handleSendNotification(
  botToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { chat_id, title, body, level = 'info' } = args;

  if (!chat_id || !title || !body) {
    return {
      success: false,
      message: 'Missing required fields: chat_id, title, body',
      displayToUser: false,
    };
  }

  // Format notification with emoji based on level
  const levelEmoji: Record<string, string> = {
    info: '\u2139\uFE0F',
    success: '\u2705',
    warning: '\u26A0\uFE0F',
    error: '\u274C',
  };

  const emoji = levelEmoji[level] || levelEmoji.info;
  const formattedText = `${emoji} <b>${title}</b>\n\n${body}\n\n<i>Sent via QAIT</i>`;

  try {
    const message = await sendMessage(botToken, chat_id, formattedText, 'HTML');

    logger.info('[TELEGRAM_SKILL] Notification sent', {
      messageId: message.message_id,
      chatId: chat_id,
      level,
    });

    return {
      success: true,
      data: { messageId: message.message_id, chatId: chat_id, level },
      message: `Sent ${level} notification to Telegram chat ${chat_id}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[TELEGRAM_SKILL] Failed to send notification', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to send notification: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

export default TelegramSkill;
