import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getSlackToken,
  sendSlackMessage,
  validateWebhookUrl,
} from '@/services/api/slack.service';
import { IntegrationTokenService } from '@/services/api/integration-token.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SLACK SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Slack Incoming Webhook integration for sending messages and notifications.
 * Provides: status, connect, disconnect, send_message, send_notification, send_blocks
 *
 * Uses Incoming Webhooks — no OAuth required.
 * User provides webhook URL from Slack App settings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SLACK_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'slack_status',
      description:
        'Check if Slack is connected for the user. Returns connection status, channel, and workspace URL. Always available.',
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
      name: 'slack_connect',
      description:
        'Connect Slack via an Incoming Webhook URL. Use when user asks to connect/setup/integrate Slack. ' +
        'Guide user to: Slack App settings → Incoming Webhooks → Activate → Add New Webhook → copy URL. ' +
        'Does NOT require an existing connection — always available.',
      parameters: {
        type: 'object',
        properties: {
          webhook_url: {
            type: 'string',
            description:
              'Slack Incoming Webhook URL (format: https://hooks.slack.com/services/...)',
          },
          channel: {
            type: 'string',
            description:
              'Channel name this webhook posts to (e.g. #general). Optional — for display purposes.',
          },
          description: {
            type: 'string',
            description: 'Optional label for this connection (e.g. "QA Alerts")',
          },
        },
        required: ['webhook_url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_disconnect',
      description:
        'Disconnect the Slack integration for the user. Requires confirmation. Always available.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after warning user that Slack will be disconnected AND receiving explicit approval.',
          },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_send_message',
      description:
        'Send a plain text message to the connected Slack channel. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Message text. Supports Slack mrkdwn: *bold*, _italic_, `code`, <url|label>.',
          },
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after describing the message to the user AND receiving explicit approval.',
          },
        },
        required: ['text', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_send_notification',
      description:
        'Send a formatted notification (e.g. test results, build status, alerts) to Slack. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
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
            description: 'Severity level. Default: info',
          },
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after describing the notification to the user AND receiving explicit approval.',
          },
        },
        required: ['title', 'body', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_send_blocks',
      description:
        'Send a rich Block Kit message to Slack. Use for structured content like tables, test summaries, or reports. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          blocks: {
            type: 'array',
            description:
              'Array of Slack Block Kit blocks. Each block is an object with at minimum a "type" field.',
            items: { type: 'object' },
          },
          fallback_text: {
            type: 'string',
            description: 'Plain text fallback shown in notifications where blocks are not supported.',
          },
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after describing the message to the user AND receiving explicit approval.',
          },
        },
        required: ['blocks', 'fallback_text', 'confirm'],
      },
    },
  },
];

/**
 * Slack skill definition
 */
export const SlackSkill: SkillDefinition = {
  id: 'slack',
  name: 'Slack',
  provider: 'slack',
  description:
    'Send messages, notifications, and rich Block Kit messages to Slack channels via Incoming Webhooks. Connect, disconnect, and check status through chat.',
  tools: SLACK_TOOLS,

  /**
   * Always available — slack_connect / slack_status / slack_disconnect work without a token.
   * Other tools fail gracefully if not connected.
   */
  async isAvailable(_context: SkillContext): Promise<boolean> {
    return true;
  },

  /**
   * Execute a Slack tool
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[SLACK_SKILL] Executing tool', {
      toolName,
      userId: context.userId,
    });

    try {
      // Tools that do not require an existing token
      if (toolName === 'slack_status') {
        return await handleStatus(context);
      }

      if (toolName === 'slack_connect') {
        return await handleConnect(args, context);
      }

      if (toolName === 'slack_disconnect') {
        return await handleDisconnect(args, context);
      }

      // All other tools require an existing token
      const tokenData = await getSlackToken(context.userId);
      if (!tokenData) {
        return {
          success: false,
          message:
            'Slack is not connected. Ask the user to provide their Incoming Webhook URL from Slack App settings, then call slack_connect.',
          displayToUser: true,
        };
      }

      const webhookUrl = tokenData.access_token;

      switch (toolName) {
        case 'slack_send_message':
          return await handleSendMessage(webhookUrl, args);

        case 'slack_send_notification':
          return await handleSendNotification(webhookUrl, args);

        case 'slack_send_blocks':
          return await handleSendBlocks(webhookUrl, args);

        default:
          return {
            success: false,
            message: `Unknown Slack tool: ${toolName}`,
            displayToUser: false,
          };
      }
    } catch (error) {
      logger.error('[SLACK_SKILL] Execution error', {
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

// ═══════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════

/**
 * Check Slack connection status
 */
async function handleStatus(context: SkillContext): Promise<SkillResult> {
  const tokenData = await getSlackToken(context.userId);

  if (!tokenData) {
    return {
      success: true,
      data: { connected: false },
      message: 'Slack is not connected. Use slack_connect to set it up.',
      displayToUser: true,
    };
  }

  const meta = tokenData.metadata || {};
  const channel = tokenData.external_id || meta.channel || null;

  return {
    success: true,
    data: {
      connected: true,
      channel,
      workspaceUrl: tokenData.external_url || null,
      description: meta.description || null,
      connectedAt: tokenData.created_at,
    },
    message: `Slack connected${channel ? `, channel: ${channel}` : ''}.`,
    displayToUser: true,
  };
}

/**
 * Connect Slack via Incoming Webhook URL
 */
async function handleConnect(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const { webhook_url, channel, description } = args;

  if (!webhook_url || typeof webhook_url !== 'string') {
    return {
      success: false,
      message:
        'webhook_url is required. Ask user to get it from Slack App settings → Incoming Webhooks.',
      displayToUser: true,
    };
  }

  // Validate format and connectivity
  try {
    await validateWebhookUrl(webhook_url);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Could not verify Slack webhook URL.',
      displayToUser: true,
    };
  }

  // Derive channel display name from URL path if not provided
  // Webhook URL format: https://hooks.slack.com/services/T.../B.../xxx
  // Channel must come from user input — we can't retrieve it from the URL alone
  const channelDisplay = channel ? String(channel) : null;

  try {
    await IntegrationTokenService.saveToken(context.userId, context.workspaceId, 'slack', {
      access_token: webhook_url,
      token_type: 'IncomingWebhook',
      external_id: channelDisplay || 'default',
      external_url: undefined,
      metadata: {
        channel: channelDisplay,
        description: description || undefined,
      },
    });
  } catch (error) {
    logger.error('[SLACK_SKILL] Failed to save token', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to save the Slack webhook URL. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[SLACK_SKILL] Slack connected via chat', {
    userId: context.userId,
    channel: channelDisplay,
  });

  return {
    success: true,
    data: { channel: channelDisplay },
    message: `Slack connected successfully!${channelDisplay ? ` Messages will be sent to ${channelDisplay}.` : ''}`,
    displayToUser: true,
  };
}

/**
 * Disconnect Slack
 */
async function handleDisconnect(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Disconnecting Slack requires confirmation. Warn the user that the integration will be removed. Set confirm=true after explicit approval.',
      displayToUser: true,
    };
  }

  const tokenData = await getSlackToken(context.userId);
  if (!tokenData) {
    return {
      success: false,
      message: 'Slack is not connected — nothing to disconnect.',
      displayToUser: true,
    };
  }

  try {
    await IntegrationTokenService.deleteToken(context.userId, 'slack');
  } catch (error) {
    logger.error('[SLACK_SKILL] Failed to disconnect', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to disconnect Slack. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[SLACK_SKILL] Slack disconnected via chat', { userId: context.userId });

  return {
    success: true,
    data: { disconnected: true },
    message:
      'Slack disconnected successfully. You can reconnect anytime using slack_connect.',
    displayToUser: true,
  };
}

/**
 * Send plain text message
 */
async function handleSendMessage(
  webhookUrl: string,
  args: Record<string, any>
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Sending a Slack message requires confirmation. Describe the message to the user and set confirm=true after approval.',
      displayToUser: true,
    };
  }

  const { text } = args;

  if (!text || typeof text !== 'string') {
    return {
      success: false,
      message: 'text is required.',
      displayToUser: false,
    };
  }

  try {
    await sendSlackMessage(webhookUrl, { text });
  } catch (error) {
    return {
      success: false,
      message: `Failed to send Slack message: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }

  return {
    success: true,
    data: {},
    message: 'Message sent to Slack.',
    displayToUser: true,
  };
}

/**
 * Send formatted notification
 */
async function handleSendNotification(
  webhookUrl: string,
  args: Record<string, any>
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Sending a Slack notification requires confirmation. Describe it to the user and set confirm=true after approval.',
      displayToUser: true,
    };
  }

  const { title, body, level = 'info' } = args;

  if (!title || !body) {
    return {
      success: false,
      message: 'title and body are required.',
      displayToUser: false,
    };
  }

  const levelEmoji: Record<string, string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
  };

  const emoji = levelEmoji[level] ?? levelEmoji.info;
  const text = `${emoji} *${title}*\n\n${body}\n\n_Sent via QAIT_`;

  try {
    await sendSlackMessage(webhookUrl, { text });
  } catch (error) {
    return {
      success: false,
      message: `Failed to send Slack notification: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }

  return {
    success: true,
    data: { level },
    message: `Sent ${level} notification to Slack.`,
    displayToUser: true,
  };
}

/**
 * Send Block Kit message
 */
async function handleSendBlocks(
  webhookUrl: string,
  args: Record<string, any>
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Sending a Slack block message requires confirmation. Describe it to the user and set confirm=true after approval.',
      displayToUser: true,
    };
  }

  const { blocks, fallback_text } = args;

  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return {
      success: false,
      message: 'blocks array is required and must not be empty.',
      displayToUser: false,
    };
  }

  if (!fallback_text || typeof fallback_text !== 'string') {
    return {
      success: false,
      message: 'fallback_text is required.',
      displayToUser: false,
    };
  }

  try {
    await sendSlackMessage(webhookUrl, { text: fallback_text, blocks });
  } catch (error) {
    return {
      success: false,
      message: `Failed to send Slack block message: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }

  return {
    success: true,
    data: { blockCount: blocks.length },
    message: `Sent block message to Slack (${blocks.length} block${blocks.length > 1 ? 's' : ''}).`,
    displayToUser: true,
  };
}
