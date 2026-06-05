/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTIFY SKILL — notify_owner
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One composable tool the agent can chain after a run/check step:
 *   run_test → get_run_status → notify_owner(owner, ...)
 *
 * It resolves an `owner_ref` to concrete recipients, then fans the message out
 * across every channel that recipient has connected (Telegram, Slack) plus an
 * in-app notification. It does NOT invent new sending logic — it reuses the
 * existing senders and token lookups.
 *
 * MVP owner_ref forms (map to something real TODAY):
 *   - "me"          → the calling user (context.userId)
 *   - "user:<uuid>" → that specific user
 * Deferred (need new infra): project:* (team broadcast), jira:component:*,
 * codeowner:*, slack:channel:*.
 *
 * Not gated by confirm: a notification is a low-risk outbound message, and
 * gating it would break the autonomous run→notify chain (it would pause for a
 * yes/no on every ping). Mirrors slack_send_notification, which is also ungated.
 *
 * Best-effort: a channel failure is logged and counted, never thrown — one dead
 * webhook must not fail the whole agent turn.
 *
 * Dedup: there is NO notification-level dedup in this codebase (createNotification
 * just inserts). So this tool self-guards with a short-lived Redis marker keyed
 * by (userId + content), preventing a double-send if the agent re-invokes within
 * the window (loop / retry).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createHash } from 'crypto';
import { redisConnection } from '@/config/infrastructure/queues';
import { getTelegramToken, sendMessage as sendTelegramMessage } from '@/services/api/telegram.service';
import { getSlackToken, sendSlackMessage } from '@/services/api/slack.service';
import { NotificationService } from '@/services/notifications/notification.service';
import { logger } from '@/utils/core/logger';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';

type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

const LEVEL_ICON: Record<NotifyLevel, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
};

const DEDUP_TTL_SECONDS = 120; // a re-send of the same content within 2 min is a dup

/**
 * Escape text for Telegram's HTML parse_mode. Without this, a '<', '>' or '&'
 * in an LLM/user-authored title or body makes Telegram reject the message (400)
 * and nothing is delivered. Mirrors the escaping in docs-auth.middleware.
 */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve an owner_ref to a list of QAIT user IDs.
 * MVP: only "me" and "user:<id>". Returns [] for unsupported forms so the
 * caller can surface a clear "not supported yet" message.
 */
export function resolveOwnerToUserIds(ownerRef: string, context: SkillContext): string[] {
  const ref = (ownerRef || '').trim();
  if (!ref || ref.toLowerCase() === 'me') {
    return context.userId ? [context.userId] : [];
  }
  if (ref.startsWith('user:')) {
    const id = ref.slice('user:'.length).trim();
    return id ? [id] : [];
  }
  // project:* / jira:* / codeowner:* / slack:channel:* — not wired yet.
  return [];
}

interface ChannelOutcome {
  channel: 'telegram' | 'slack' | 'in_app';
  userId: string;
  ok: boolean;
  /** 'sent' | 'skipped' (no integration) | 'error' */
  status: 'sent' | 'skipped' | 'error';
  error?: string;
}

async function notifyTelegram(
  userId: string,
  workspaceId: string | undefined,
  icon: string,
  title: string,
  message: string,
  actionUrl: string | undefined,
): Promise<ChannelOutcome> {
  try {
    const tg = await getTelegramToken(userId, workspaceId);
    // No connected Telegram → not an error, just skip this channel.
    if (!tg?.access_token || !tg.external_id) {
      return { channel: 'telegram', userId, ok: false, status: 'skipped' };
    }
    const body =
      `${icon} <b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(message)}` +
      (actionUrl ? `\n\n${escapeTelegramHtml(actionUrl)}` : '');
    await sendTelegramMessage(tg.access_token, tg.external_id, body, 'HTML');
    return { channel: 'telegram', userId, ok: true, status: 'sent' };
  } catch (err) {
    logger.warn('[NOTIFY_OWNER] Telegram send failed', { userId, error: String(err) });
    return {
      channel: 'telegram',
      userId,
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function notifySlack(
  userId: string,
  workspaceId: string | undefined,
  icon: string,
  title: string,
  message: string,
  actionUrl: string | undefined,
): Promise<ChannelOutcome> {
  try {
    const slack = await getSlackToken(userId, workspaceId);
    if (!slack?.access_token) {
      return { channel: 'slack', userId, ok: false, status: 'skipped' };
    }
    // Slack mrkdwn: '*bold*' and '<url|label>'. Slack does not need HTML escaping.
    const text =
      `${icon} *${title}*\n${message}` + (actionUrl ? `\n<${actionUrl}|Open>` : '');
    await sendSlackMessage(slack.access_token, { text });
    return { channel: 'slack', userId, ok: true, status: 'sent' };
  } catch (err) {
    logger.warn('[NOTIFY_OWNER] Slack send failed', { userId, error: String(err) });
    return {
      channel: 'slack',
      userId,
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function notifyInApp(
  userId: string,
  level: NotifyLevel,
  title: string,
  message: string,
  actionUrl: string | undefined,
): Promise<ChannelOutcome> {
  try {
    await NotificationService.createNotification({
      userId,
      type: 'personal',
      category: 'test',
      title,
      message,
      actionUrl,
      metadata: { level, source: 'notify_owner' },
    });
    return { channel: 'in_app', userId, ok: true, status: 'sent' };
  } catch (err) {
    logger.warn('[NOTIFY_OWNER] In-app notify failed', { userId, error: String(err) });
    return {
      channel: 'in_app',
      userId,
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function notifyOneUser(
  userId: string,
  workspaceId: string | undefined,
  level: NotifyLevel,
  title: string,
  message: string,
  actionUrl: string | undefined,
): Promise<ChannelOutcome[]> {
  const icon = LEVEL_ICON[level];
  return [
    await notifyTelegram(userId, workspaceId, icon, title, message, actionUrl),
    await notifySlack(userId, workspaceId, icon, title, message, actionUrl),
    await notifyInApp(userId, level, title, message, actionUrl),
  ];
}

/**
 * Best-effort dedup: returns true if this exact notification (same user + title
 * + message) was already sent within DEDUP_TTL_SECONDS. Uses Redis SET NX.
 * A Redis failure must NOT block sending — degrade to "not a dup".
 */
async function isDuplicate(userId: string, title: string, message: string): Promise<boolean> {
  try {
    const hash = createHash('sha1').update(`${title}\n${message}`).digest('hex').slice(0, 16);
    const key = `notify_dedup:${userId}:${hash}`;
    // SET key 1 NX EX ttl → returns 'OK' if newly set (not a dup), null if it existed.
    const res = await redisConnection.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    return res === null; // null = key already existed = duplicate
  } catch (err) {
    logger.warn('[NOTIFY_OWNER] dedup check failed (continuing)', { error: String(err) });
    return false;
  }
}

async function handleNotifyOwner(args: Record<string, any>, context: SkillContext): Promise<SkillResult> {
  const ownerRef = String(args.owner_ref ?? 'me');
  const title = String(args.title ?? '').trim();
  const message = String(args.message ?? '').trim();
  const level: NotifyLevel = ['info', 'success', 'warning', 'error'].includes(args.level)
    ? args.level
    : 'info';
  const actionUrl = args.action_url ? String(args.action_url) : undefined;
  // Correlation id for post-hoc debugging: `rg "<runId>"` traces the whole
  // run → notify chain across processes. 'runId' is the repo-wide convention.
  const runId = args.run_id ? String(args.run_id) : undefined;

  if (!title || !message) {
    return {
      success: false,
      message: 'notify_owner needs both a title and a message.',
      displayToUser: false,
    };
  }

  const userIds = resolveOwnerToUserIds(ownerRef, context);
  if (userIds.length === 0) {
    return {
      success: false,
      message:
        `Cannot resolve owner "${ownerRef}" yet. Supported forms: "me" or "user:<id>". ` +
        `Team/component/channel routing is not wired yet.`,
      displayToUser: false,
    };
  }

  const all: ChannelOutcome[] = [];
  let skippedDuplicate = false;

  for (const uid of userIds) {
    if (await isDuplicate(uid, title, message)) {
      skippedDuplicate = true;
      logger.info('[NOTIFY_OWNER] Skipped duplicate notification', { runId, userId: uid, title });
      continue;
    }
    const outcomes = await notifyOneUser(uid, context.workspaceId, level, title, message, actionUrl);
    all.push(...outcomes);
  }

  const sent = all.filter((o) => o.ok).length;
  const failed = all.filter((o) => o.status === 'error').length;
  const channelsUsed = [...new Set(all.filter((o) => o.ok).map((o) => o.channel))];

  // ONE structured summary per call (success, skip AND fail are all visible —
  // not only errors). Keyed by runId so post-hoc "did the notify for run X
  // fire?" is a single grep. Errored channels listed with their reason.
  logger.info('[CHAIN] notify_result', {
    runId,
    ownerRef,
    recipients: userIds.length,
    sent,
    failed,
    deduped: skippedDuplicate,
    channels: channelsUsed,
    errors: all
      .filter((o) => o.status === 'error')
      .map((o) => ({ channel: o.channel, error: o.error })),
  });

  if (all.length === 0 && skippedDuplicate) {
    return {
      success: true,
      message: 'Already notified — skipped a duplicate.',
      data: { recipients: userIds.length, sent: 0, failed: 0, channels: [], deduped: true },
      displayToUser: false,
    };
  }

  return {
    success: sent > 0,
    message:
      sent > 0
        ? `Notified ${userIds.length} recipient(s) via ${channelsUsed.join(', ')}.`
        : `Could not deliver the notification (no connected channels and in-app failed).`,
    data: { recipients: userIds.length, sent, failed, channels: channelsUsed },
    displayToUser: false,
  };
}

export const NotifySkill: SkillDefinition = {
  id: 'notify',
  name: 'Notify',
  provider: 'qa',
  description:
    'Notify a person about an event (e.g. a failed run) across their connected channels (Telegram, Slack) plus in-app. Use as the final step of a run→check→notify flow.',

  tools: [
    {
      type: 'function',
      function: {
        name: 'notify_owner',
        description:
          'Send a notification to an owner across their connected channels (Telegram, Slack) and in-app. Use after checking a run result, e.g. to ping the owner only if a run failed. Low-risk outbound message — no confirmation needed.',
        parameters: {
          type: 'object',
          properties: {
            owner_ref: {
              type: 'string',
              description:
                'Who to notify. Supported: "me" (the current user) or "user:<id>". Defaults to "me".',
            },
            title: { type: 'string', description: 'Short notification title.' },
            message: { type: 'string', description: 'Notification body (plain text).' },
            level: {
              type: 'string',
              enum: ['info', 'success', 'warning', 'error'],
              description: 'Severity — controls the icon. Use "error" for failures.',
            },
            action_url: {
              type: 'string',
              description: 'Optional link to the run report or relevant page.',
            },
            run_id: {
              type: 'string',
              description:
                'Optional id of the run this notification is about (from qa_run_test). Pass it through for traceability — it correlates logs across the run→notify chain.',
            },
          },
          required: ['title', 'message'],
        },
      },
    },
  ],

  // Always available — recipient resolution + channel availability is handled
  // per-call (a user with no connected channels still gets an in-app notice).
  isAvailable: async () => true,

  execute: async (toolName, args, context): Promise<SkillResult> => {
    if (toolName === 'notify_owner') {
      return handleNotifyOwner(args, context);
    }
    return { success: false, message: `Unknown notify tool: ${toolName}`, displayToUser: false };
  },
};

export default NotifySkill;
