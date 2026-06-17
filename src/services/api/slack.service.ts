import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SLACK WEBHOOK SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Slack Incoming Webhook client for sending messages and notifications.
 * Uses Incoming Webhooks (no OAuth required — user provides webhook URL).
 * Token stored per-user in integration_tokens.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface SlackTokenData {
  id: string;
  user_id: string;
  workspace_id?: string;
  access_token: string; // Incoming webhook URL
  external_id?: string; // Channel name (e.g. #general)
  external_url?: string; // Slack workspace URL
  metadata?: Record<string, any>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{ type: string; text: string }>;
  accessory?: Record<string, any>;
}

export interface SlackMessagePayload {
  text?: string;
  blocks?: SlackBlock[];
  username?: string;
  icon_emoji?: string;
}

/**
 * Get Slack webhook token for user from integration_tokens.
 * When workspaceId is provided, scopes lookup to that workspace.
 * Returns null if no personal token exists.
 */
export async function getSlackToken(userId: string, workspaceId?: string): Promise<SlackTokenData | null> {
  try {
    let query = supabaseAdmin
      .from('integration_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'slack')
      .eq('enabled', true);

    if (workspaceId) {
      // Match workspace-scoped tokens OR global tokens (workspace_id IS NULL),
      // mirroring IntegrationTokenService.getToken — a globally-connected
      // webhook must still resolve when a caller passes a workspaceId.
      query = query.or(`workspace_id.eq.${workspaceId},workspace_id.is.null`);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('[SLACK_SERVICE] Failed to get token', {
        error: error.message,
        userId,
      });
      throw error;
    }

    return (data as SlackTokenData) ?? null;
  } catch (error) {
    logger.error('[SLACK_SERVICE] Get token error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    throw error;
  }
}

/**
 * Send a message via Slack Incoming Webhook
 */
export async function sendSlackMessage(
  webhookUrl: string,
  payload: SlackMessagePayload
): Promise<void> {
  logger.info('[SLACK_SERVICE] Sending message', {
    channel: payload.username,
    textLength: payload.text?.length,
  });

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('[SLACK_SERVICE] Failed to send message', {
      status: response.status,
      error: errorText,
    });
    throw new Error(`Slack webhook error: ${response.status} ${errorText}`);
  }

  // Slack webhooks return plain "ok" text on success (trim in case of trailing newline)
  const body = await response.text();
  if (body.trim() !== 'ok') {
    throw new Error(`Slack webhook returned unexpected response: ${body}`);
  }

  logger.info('[SLACK_SERVICE] Message sent successfully');
}

/**
 * Validate a Slack Incoming Webhook URL by sending a silent test payload.
 * Throws if the URL is invalid.
 */
export async function validateWebhookUrl(webhookUrl: string): Promise<void> {
  // Slack webhooks must start with https://hooks.slack.com/
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    throw new Error(
      'Invalid Slack webhook URL. It must start with https://hooks.slack.com/'
    );
  }

  // Send a minimal test message to verify the URL works
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'QAIT Slack integration connected successfully.' }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Could not verify Slack webhook URL: ${response.status} ${errorText}`
    );
  }

  const body = await response.text();
  if (body.trim() !== 'ok') {
    throw new Error(`Slack webhook verification failed: ${body}`);
  }
}
