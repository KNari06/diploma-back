import { env } from '@/config/environment/env';
import { approvePendingUser } from '@/services/core/db/self-serve.db';
import { logger } from '@/utils/core/logger';

/**
 * Approval status is a DERIVED value when self-serve is on — not a stored fact.
 *
 * With AUTO_APPROVE_SIGNUP=true the product is self-serve: every non-rejected
 * user is effectively approved. Computing this on every read (instead of
 * writing users.status once at an auth event) removes the class of bug where a
 * transient failure during provision leaves a user stuck at 'pending_approval'
 * forever — the pending-approval screen makes no further auth call that would
 * retry, so the drift never heals. Deriving on read makes "stuck" impossible.
 *
 * Precedence:
 *   1. 'rejected'  — a manual admin decision, always honoured (the flag must
 *                    never silently un-reject someone).
 *   2. self-serve  — AUTO_APPROVE_SIGNUP → 'approved'.
 *   3. otherwise   — the stored status (B2B manual-approval flow).
 *
 * users.status is still written by provision()/admin for audit + the B2B path;
 * this only changes what auth RESPONSES report, which is what gates access.
 */
export function resolveEffectiveStatus(storedStatus: string | null | undefined): string {
  const status = storedStatus || 'pending_approval';
  if (status === 'rejected') return 'rejected';
  if (env.AUTO_APPROVE_SIGNUP) return 'approved';
  return status;
}

/**
 * Persist the derived approval back to the DB when self-serve is on and the
 * stored status is still pending — a fire-and-forget self-heal.
 *
 * resolveEffectiveStatus only fixes what the AUTH RESPONSE reports, so the user
 * gets access; but users.status stays 'pending_approval' in the DB, which means
 * the admin approvals list and any DB-reading code still see them as pending
 * (the "why is this B2C user still waiting?" bug). Calling this from the main
 * read path (/auth/me) reconciles the row on the user's next request.
 *
 * Best-effort: never throws (wrapped by the caller too), scoped to pending rows
 * only (approvePendingUser has an `.eq('status','pending_approval')` guard) so a
 * manual 'rejected' is never overwritten. No email is sent here — that belongs
 * to the provision path; this is a silent data reconciliation.
 */
export async function healApprovalIfNeeded(
  userId: string,
  storedStatus: string | null | undefined,
): Promise<void> {
  if (!env.AUTO_APPROVE_SIGNUP) return;
  if (!userId) return;
  if (storedStatus !== 'pending_approval') return; // already approved/rejected

  try {
    const healed = await approvePendingUser(userId);
    if (healed) {
      logger.info('[SELF_HEAL] Reconciled stuck pending user to approved', { userId });
    }
  } catch (error) {
    logger.warn('[SELF_HEAL] Approval reconciliation failed (non-critical)', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
