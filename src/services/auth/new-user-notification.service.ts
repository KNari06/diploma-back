import { env } from '@/config/environment/env';
import { QueueManager } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { EmailService } from '@/services/core/email.service';
import { logger } from '@/utils/core/logger';
import { getTelegramToken, sendTelegramNotification } from '@/utils/notifications/telegram-notify';

export type SignupProvider = 'email' | 'google' | 'github' | 'gitlab' | 'bitbucket';

export interface NewUserSignupPayload {
  userId: string;
  email: string;
  name?: string;
  provider: SignupProvider;
  signedUpAt?: string;
}

/**
 * In-memory dedupe to avoid double notifications from double-submits or
 * signup + verify hitting the dispatcher within a short window.
 * Key = userId. TTL = 10 minutes. Best-effort only (process-local).
 */
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const recentlyNotified = new Map<string, number>();

function isDuplicate(userId: string): boolean {
  const now = Date.now();
  // Purge stale entries opportunistically
  if (recentlyNotified.size > 500) {
    for (const [key, ts] of recentlyNotified.entries()) {
      if (now - ts > DEDUPE_TTL_MS) recentlyNotified.delete(key);
    }
  }
  const ts = recentlyNotified.get(userId);
  if (ts && now - ts < DEDUPE_TTL_MS) return true;
  recentlyNotified.set(userId, now);
  return false;
}

interface AdminRecord {
  id: string;
  email: string | null;
}

/**
 * Fetch admin users (id + email) for notification delivery.
 */
async function getAdmins(): Promise<AdminRecord[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('role', 'admin');

    if (error) {
      logger.error('[NEW_USER_NOTIFY] Failed to load admins', { error: error.message });
      return [];
    }

    return (data ?? []).filter((u): u is AdminRecord => !!u && typeof u.id === 'string');
  } catch (error) {
    logger.error('[NEW_USER_NOTIFY] Error loading admins', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Queue email notifications to every admin for a new signup.
 */
async function notifyAdminsByEmail(
  payload: NewUserSignupPayload,
  admins: AdminRecord[],
): Promise<void> {
  const adminEmails = admins
    .map((a) => a.email)
    .filter((e): e is string => typeof e === 'string' && e.length > 0);

  if (adminEmails.length === 0) {
    logger.warn('[NEW_USER_NOTIFY] No admin emails found, skipping email notification', {
      userId: payload.userId,
    });
    return;
  }

  const pendingUsersUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/admin/users?status=pending`;

  const email = EmailService.buildNewUserSignupEmail({
    userId: payload.userId,
    userEmail: payload.email,
    userName: payload.name,
    provider: payload.provider,
    signedUpAt: payload.signedUpAt ?? new Date().toISOString(),
    pendingUsersUrl,
  });

  for (const adminEmail of adminEmails) {
    try {
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient: adminEmail,
        subject: email.subject,
        message: email.text,
        htmlContent: email.html,
        data: {
          newUserId: payload.userId,
          provider: payload.provider,
        },
      });
    } catch (error) {
      logger.error('[NEW_USER_NOTIFY] Failed to queue email for admin', {
        error: error instanceof Error ? error.message : String(error),
        adminEmail,
        userId: payload.userId,
      });
    }
  }

  logger.info('[NEW_USER_NOTIFY] Admin email notifications queued', {
    userId: payload.userId,
    adminCount: adminEmails.length,
  });
}

/**
 * Send Telegram alerts to every admin who has a connected bot.
 */
async function notifyAdminsByTelegram(
  payload: NewUserSignupPayload,
  admins: AdminRecord[],
): Promise<void> {
  const dashboardUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/admin/users?status=pending`;
  const displayName = payload.name?.trim() || payload.email.split('@')[0];

  let delivered = 0;
  for (const admin of admins) {
    try {
      const tokenData = await getTelegramToken(admin.id);
      if (!tokenData || !tokenData.external_id) continue;

      const ok = await sendTelegramNotification(tokenData, {
        icon: '\uD83D\uDC64',
        title: 'New user awaiting approval',
        fields: [
          { label: 'Name', value: displayName },
          { label: 'Email', value: payload.email },
          { label: 'Provider', value: payload.provider },
          { label: 'User ID', value: payload.userId },
        ],
        ctaLabel: 'Review pending users',
        ctaUrl: dashboardUrl,
      });

      if (ok) delivered += 1;
    } catch (error) {
      logger.warn('[NEW_USER_NOTIFY] Telegram delivery failed for admin', {
        error: error instanceof Error ? error.message : String(error),
        adminId: admin.id,
      });
    }
  }

  if (delivered > 0) {
    logger.info('[NEW_USER_NOTIFY] Telegram alerts delivered', {
      userId: payload.userId,
      delivered,
    });
  }
}

/**
 * Notify all admins (email + Telegram) that a new user has signed up.
 * Fire-and-forget: never throws, never blocks the auth response.
 */
export function notifyAdminsOfNewUser(payload: NewUserSignupPayload): void {
  if (isDuplicate(payload.userId)) {
    logger.debug('[NEW_USER_NOTIFY] Skipping duplicate within dedupe window', {
      userId: payload.userId,
    });
    return;
  }

  setImmediate(async () => {
    try {
      logger.info('[NEW_USER_NOTIFY] Dispatching new-user signup notifications', {
        userId: payload.userId,
        provider: payload.provider,
      });

      const admins = await getAdmins();
      if (admins.length === 0) {
        logger.warn('[NEW_USER_NOTIFY] No admins configured, skipping', {
          userId: payload.userId,
        });
        return;
      }

      await Promise.allSettled([
        notifyAdminsByEmail(payload, admins),
        notifyAdminsByTelegram(payload, admins),
      ]);
    } catch (error) {
      logger.error('[NEW_USER_NOTIFY] Unexpected error while notifying admins', {
        error: error instanceof Error ? error.message : String(error),
        userId: payload.userId,
      });
    }
  });
}
