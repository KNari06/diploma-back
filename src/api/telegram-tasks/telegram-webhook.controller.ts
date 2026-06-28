import { env } from '@/config/environment/env';
import { ingestMessage, type InboundMessage } from '@/services/telegram-tasks/telegram-task.service';
import { logger } from '@/utils/core/logger';
import type { Request, Response } from 'express';

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
  reply_to_message?: { message_id: number };
}
interface TgUpdate { message?: TgMessage; edited_message?: TgMessage }

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
  const secret = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    res.sendStatus(401);
    return;
  }

  // Parse the raw body (this path uses express.raw, so req.body is a Buffer).
  let update: TgUpdate;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    res.sendStatus(200); // malformed → ack so Telegram doesn't retry forever
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
