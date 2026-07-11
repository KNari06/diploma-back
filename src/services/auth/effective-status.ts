import { env } from '@/config/environment/env';

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
