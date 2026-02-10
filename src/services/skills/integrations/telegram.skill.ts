import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getTelegramToken,
  sendMessage,
  getChat,
  sendDocument,
} from '@/services/api/telegram.service';
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
   * Check if user has Telegram bot configured
   */
  async isAvailable(context: SkillContext): Promise<boolean> {
    try {
      const token = await getTelegramToken(context.userId);
      return token !== null;
    } catch (error) {
      logger.error('[TELEGRAM_SKILL] Error checking availability', {
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
      });
      return false;
    }
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
      // Get Telegram token
      const tokenData = await getTelegramToken(context.userId);
      if (!tokenData) {
        return {
          success: false,
          message: 'Telegram bot not configured. Please set TELEGRAM_BOT_TOKEN or connect via integrations.',
          displayToUser: true,
        };
      }

      const botToken = tokenData.access_token;

      // Route to appropriate handler
      switch (toolName) {
        case 'telegram_send_message':
          return await handleSendMessage(botToken, args);

        case 'telegram_get_chat':
          return await handleGetChat(botToken, args);

        case 'telegram_send_document':
          return await handleSendDocument(botToken, args);

        case 'telegram_send_notification':
          return await handleSendNotification(botToken, args);

        default:
          return {
            success: false,
            message: `Unknown Telegram tool: ${toolName}`,
            displayToUser: false,
          };
      }
    } catch (error) {
      logger.error('[TELEGRAM_SKILL] Execution error', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }
  },
};

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
