import { env } from '@/config/environment/env';
import { ingestMessage, type InboundMessage } from '@/services/telegram-tasks/telegram-task.service';
import { logger } from '@/utils/core/logger';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

/** Constant-time secret compare. timingSafeEqual throws on length mismatch, so
 *  gate on length first (the length check itself is not secret-dependent — the
 *  configured secret's length is fixed). Defends against a timing side-channel
 *  even though the secret is high-entropy and a remote attack is impractical. */
function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Telegram webhook receiver for QAIT Tasker.
 *
 * HTTP-only: authenticate via Telegram's secret-token header, ack 200 FAST
 * (Telegram retries on non-200 / slow responses and would re-deliver — we never
 * want duplicate ingestion), then process the update asynchronously. Mounted on
 * a raw-body path and public (no requireAuth) — the secret token is the auth.
 */

interface TgUser { username?: string; first_name?: string; is_bot?: boolean }
interface TgMessage {
  message_id: number;
  text?: string;
  caption?: string;
  chat?: { id: number };
  from?: TgUser;
  reply_to_message?: { message_id: number; from?: TgUser };
}
interface TgUpdate { message?: TgMessage; edited_message?: TgMessage }

/** True when `text` @mentions the given bot username (word-boundary aware so
 *  `@qait_task` matches but `@qait_tasker` does not). Exported for testing. */
export function mentionsBot(text: string, botUsername: string | undefined): boolean {
  const uname = botUsername?.replace(/^@/, '').toLowerCase();
  if (!uname) return false;
  return new RegExp(`@${uname}(?![a-z0-9_])`, 'i').test(text);
}

/** True when the message is addressed to the bot — either a reply to one of the
 *  bot's own messages, or an @mention of the bot's username. Drives Q&A mode. */
function isAddressedToBot(msg: TgMessage, text: string): boolean {
  if (msg.reply_to_message?.from?.is_bot) return true;
  return mentionsBot(text, env.TELEGRAM_BOT_USERNAME);
}

/** Map a Telegram message object to our inbound shape, or null if not usable. */
function toInbound(msg: TgMessage | undefined, isEdit: boolean): InboundMessage | null {
  if (!msg || !msg.chat) return null;
  if (msg.from?.is_bot) return null; // never ingest bot messages (incl. our own)
  const text = msg.text ?? msg.caption;
  if (!text) return null;
  return {
    chatId: msg.chat.id,
    msgId: msg.message_id,
    text,
    authorUsername: msg.from?.username,
    authorName: msg.from?.first_name,
    isEdit,
    replyToMsgId: msg.reply_to_message?.message_id,
    addressedToBot: isAddressedToBot(msg, text),
  };
}

export function handleTelegramWebhook(req: Request, res: Response): void {
  // Feature gate + auth. Respond 200 even on auth failure? No — a wrong secret
  // should be rejected so a misconfigured/forged caller is visible. But never
  // leak which check failed.
  if (!env.TELEGRAM_TASKS_ENABLED) {
    res.sendStatus(200); // silently accept-and-ignore when disabled
    return;
  }
  if (!secretMatches(req.header('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    res.sendStatus(401);
    return;
  }

  // This path is mounted with express.raw, so req.body MUST be a Buffer. If it
  // isn't, the raw-body middleware didn't run (misconfiguration) — fail LOUD
  // rather than silently accept-and-ignore, which would mask zero-ingestion.
  if (!Buffer.isBuffer(req.body)) {
    logger.error('[TELEGRAM_TASKS] webhook body is not a Buffer — raw parser not applied to this path', {
      bodyType: typeof req.body,
    });
    res.sendStatus(500);
    return;
  }

  let update: TgUpdate;
  try {
    update = JSON.parse(req.body.toString('utf8')) as TgUpdate;
  } catch {
    res.sendStatus(200); // malformed JSON → ack so Telegram doesn't retry forever
    return;
  }

  // Ack immediately; process after responding.
  res.sendStatus(200);

  const inbound = toInbound(update.message, false) ?? toInbound(update.edited_message, true);
  if (!inbound) return;

  // Fire-and-forget; ingestMessage never throws, but guard anyway.
  void ingestMessage(inbound).catch((err) => {
    logger.error('[TELEGRAM_TASKS] webhook processing failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
