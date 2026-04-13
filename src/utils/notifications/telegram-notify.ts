/**
 * Shared Telegram notification builder.
 * Formats messages with consistent UX and sends via the Telegram Bot API.
 *
 * Re-exports `getTelegramToken` so callers only need one import.
 */
import {
  getTelegramToken,
  sendMessage,
  type TelegramTokenData,
} from '@/services/api/telegram.service';
import { logger } from '@/utils/core/logger';

export { getTelegramToken };

// ─── Telegram HTML escaping ─────────────────────────────────────────────
// Telegram HTML mode only supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>.
// ALL other text must have <, >, & escaped.

function escTg(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Types ──────────────────────────────────────────────────────────────

interface TgField {
  label: string;
  value: string;
}

interface TgBug {
  severity: string;
  category?: string;
  message: string;
}

export interface TgNotificationPayload {
  /** Emoji icon (use real Unicode, not HTML entities) */
  icon: string;
  /** Bold title line */
  title: string;
  /** Key-value fields shown after the title */
  fields?: TgField[];
  /** Error message (shown in code block) */
  error?: string;
  /** Bug list for critical issues */
  bugs?: TgBug[];
  /** Total bug count (if more than shown) */
  bugsTotal?: number;
  /** CTA link text */
  ctaLabel: string;
  /** CTA URL */
  ctaUrl: string;
}

// ─── Severity emoji mapping ─────────────────────────────────────────────

const SEVERITY_ICON: Record<string, string> = {
  critical: '\uD83D\uDD34', // red circle
  high: '\uD83D\uDFE0',     // orange circle
  medium: '\uD83D\uDFE1',   // yellow circle
  low: '\uD83D\uDFE2',      // green circle
};

// ─── Builder ────────────────────────────────────────────────────────────

function buildTelegramMessage(payload: TgNotificationPayload): string {
  const lines: string[] = [];

  // Header
  lines.push(`${payload.icon} <b>${escTg(payload.title)}</b>`);
  lines.push('');

  // Fields
  if (payload.fields?.length) {
    for (const f of payload.fields) {
      lines.push(`<b>${escTg(f.label)}:</b> ${escTg(f.value)}`);
    }
    lines.push('');
  }

  // Error block
  if (payload.error) {
    // Truncate to 400 chars max for readability
    const truncated = payload.error.length > 400
      ? payload.error.slice(0, 397) + '...'
      : payload.error;
    lines.push(`<b>Error:</b>`);
    lines.push(`<code>${escTg(truncated)}</code>`);
    lines.push('');
  }

  // Bug list
  if (payload.bugs?.length) {
    for (const bug of payload.bugs) {
      const icon = SEVERITY_ICON[bug.severity] || '\u26AA'; // white circle fallback
      const sev = bug.severity.toUpperCase();
      const cat = bug.category ? ` (${escTg(bug.category)})` : '';
      // Truncate long messages
      const msg = bug.message.length > 150
        ? bug.message.slice(0, 147) + '...'
        : bug.message;
      lines.push(`${icon} <b>${escTg(sev)}</b>${cat} ${escTg(msg)}`);
    }
    if (payload.bugsTotal && payload.bugsTotal > payload.bugs.length) {
      lines.push(`   ... +${payload.bugsTotal - payload.bugs.length} more`);
    }
    lines.push('');
  }

  // CTA
  lines.push(`<a href="${payload.ctaUrl}">${escTg(payload.ctaLabel)}</a>`);

  return lines.join('\n');
}

// ─── Send ───────────────────────────────────────────────────────────────

/**
 * Build and send a formatted Telegram notification.
 * Never throws — logs warnings on failure so the caller's pipeline isn't broken.
 */
export async function sendTelegramNotification(
  tokenData: TelegramTokenData,
  payload: TgNotificationPayload,
): Promise<boolean> {
  try {
    const text = buildTelegramMessage(payload);

    await sendMessage(
      tokenData.access_token,
      tokenData.external_id!,
      text,
      'HTML',
      { disableLinkPreview: true },
    );

    return true;
  } catch (error) {
    logger.warn('[TELEGRAM_NOTIFY] Failed to send notification', {
      error: error instanceof Error ? error.message : String(error),
      chatId: tokenData.external_id,
      title: payload.title,
    });
    return false;
  }
}
