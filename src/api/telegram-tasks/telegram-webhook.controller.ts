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
interface TgPhotoSize { file_id: string; file_size?: number }
interface TgMessage {
  message_id: number;
  text?: string;
  caption?: string;
  chat?: { id: number };
  from?: TgUser;
  reply_to_message?: { message_id: number; from?: TgUser };
  // Photo comes as ascending-resolution sizes; the LAST is the largest. A
  // document image (screenshot sent as file) carries its own mime.
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string };
  // Set when this message is part of an album (multiple media in one post).
  media_group_id?: string;
}

// Albums arrive as N separate messages sharing one media_group_id; the caption
// is only on the first. Process just the first per group to avoid N vision
// calls + N duplicate reconciles. Tiny bounded LRU of recently-seen group ids.
const seenAlbums = new Set<string>();
const SEEN_ALBUMS_CAP = 500;
function isDuplicateAlbumPart(groupId: string | undefined): boolean {
  if (!groupId) return false;
  if (seenAlbums.has(groupId)) return true;
  if (seenAlbums.size >= SEEN_ALBUMS_CAP) seenAlbums.clear();
  seenAlbums.add(groupId);
  return false;
}
interface TgUpdate { message?: TgMessage; edited_message?: TgMessage }

/** The bot's real @username, resolved from Telegram (getMe) at startup. Falls
 *  back to the configured TELEGRAM_BOT_USERNAME until then. setResolvedBotUsername
 *  is called once on boot so we never depend on the env being byte-exact (e.g.
 *  "qait_task" configured vs the real "qait_task_bot"). */
let resolvedBotUsername: string | undefined;
export function setResolvedBotUsername(username: string | undefined): void {
  resolvedBotUsername = username?.replace(/^@/, '').toLowerCase();
}

/** True when `text` @mentions the bot. Matches the exact username AND tolerates
 *  the conventional `_bot` suffix in either direction (config "qait_task" still
 *  matches "@qait_task_bot"), while still rejecting an unrelated longer handle
 *  (@qait_tasker). Exported for testing. */
export function mentionsBot(text: string, botUsername: string | undefined): boolean {
  const candidates = new Set<string>();
  for (const raw of [resolvedBotUsername, botUsername?.replace(/^@/, '').toLowerCase()]) {
    if (!raw) continue;
    candidates.add(raw);
    candidates.add(raw.endsWith('_bot') ? raw.slice(0, -4) : `${raw}_bot`);
  }
  for (const uname of candidates) {
    if (new RegExp(`@${uname}(?![a-z0-9_])`, 'i').test(text)) return true;
  }
  return false;
}

/** True when the message is addressed to OUR bot — a reply to one of our bot's
 *  messages, or an @mention of our username. Drives the model's question-vs-
 *  action decision. NB: a reply must be to OUR bot, not just any bot in the
 *  group (a group can have several). When our username isn't configured we
 *  can't disambiguate, so we fall back to any-bot reply. */
function isAddressedToBot(msg: TgMessage, text: string): boolean {
  const replied = msg.reply_to_message?.from;
  if (replied?.is_bot) {
    const ours = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '').toLowerCase();
    if (!ours) return true; // can't tell which bot; assume ours (single-bot default)
    if (replied.username?.toLowerCase() === ours) return true;
    // replied to a DIFFERENT bot — fall through to the @mention check
  }
  return mentionsBot(text, env.TELEGRAM_BOT_USERNAME);
}

/** The file_id of an attached image (largest photo size, or an image document),
 *  or undefined. Used so the service can read the picture with a vision LLM. */
function imageFileId(msg: TgMessage): string | undefined {
  if (msg.photo && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id; // largest
  if (msg.document?.mime_type?.startsWith('image/')) return msg.document.file_id;
  return undefined;
}

/** Map a Telegram message object to our inbound shape, or null if not usable. */
function toInbound(msg: TgMessage | undefined, isEdit: boolean): InboundMessage | null {
  if (!msg || !msg.chat) return null;
  if (msg.from?.is_bot) return null; // never ingest bot messages (incl. our own)
  // Skip the 2nd+ photos of an album — only the first (with the caption) is
  // processed, so one album = one reconcile, not N. Edits never carry a new group.
  if (!isEdit && isDuplicateAlbumPart(msg.media_group_id)) return null;
  const text = msg.text ?? msg.caption ?? '';
  const imageFile = imageFileId(msg);
  // Usable if it has text OR an image. A caption-less photo was previously
  // dropped entirely; now it flows through (the service reads it via vision).
  if (!text && !imageFile) return null;
  return {
    chatId: msg.chat.id,
    msgId: msg.message_id,
    text,
    imageFileId: imageFile,
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
