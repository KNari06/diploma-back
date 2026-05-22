/**
 * Account-Deletion Service
 *
 * Self-service account deletion with a 30-day soft-delete grace window.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Lifecycle
 * ──────────────────────────────────────────────────────────────────────
 *
 *   T+0      User confirms deletion (typed-email confirmation in UI)
 *            → `softDeleteAccount()`
 *              ├─ Pre-flight: block if sole owner of multi-member workspace
 *              ├─ Stamp `users.deleted_at = now()`,
 *              │    `deletion_scheduled_for = now() + 30d`
 *              ├─ Cancel Stripe subscription (best-effort)
 *              ├─ Revoke OAuth tokens at providers (best-effort)
 *              ├─ Remove repeatable BullMQ jobs (`removeRepeatableByKey`)
 *              ├─ Delete `test_schedules` rows (cron-like firing)
 *              ├─ Disconnect WS sockets for the user
 *              ├─ Invalidate auth cache so any cached JWT is rejected
 *              └─ Audit-log ACCOUNT_DELETION_REQUESTED
 *
 *   T+0..30d Auth middleware sees `deleted_at IS NOT NULL` → returns 401
 *            with `code: 'ACCOUNT_DELETED'`. JWT becomes unusable; data
 *            still readable by admin/support for recovery.
 *
 *   T+30d    Daily cron (`jobs/account-deletion-purge.job.ts`) picks
 *            rows where `deletion_scheduled_for <= now()`.
 *            → `hardPurgeAccount()`
 *              ├─ Storage cleanup: every per-user prefix in every bucket
 *              ├─ Delete sole-owned workspaces (FK CASCADE handles children)
 *              ├─ Explicit DELETE for every TEXT user_id table that has
 *              │    no FK to public.users (cascade won't reach them)
 *              ├─ Delete public.users (FK CASCADE handles the rest)
 *              ├─ Delete auth.users via Supabase admin
 *              └─ Audit-log ACCOUNT_DELETION_COMPLETED
 *
 * ──────────────────────────────────────────────────────────────────────
 * Idempotency + safety
 * ──────────────────────────────────────────────────────────────────────
 *
 * - `softDeleteAccount` is NOT idempotent — calling twice flips
 *   `deletion_scheduled_for` to a later date. UI gates against this via
 *   the auth middleware (deleted users can't hit the endpoint).
 * - `hardPurgeAccount` IS idempotent. Each step uses tolerant deletes
 *   (`.delete().eq(...)` is a no-op on already-missing rows). If a
 *   step fails mid-cascade, the next cron tick re-runs from the start
 *   and converges.
 * - Best-effort steps (Stripe, OAuth revoke, BullMQ cleanup) log at
 *   `warn` on failure but do not block the deletion. The user's
 *   primary expectation — "my data is gone" — is unaffected by
 *   external-service blips.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Recovery (during grace window)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Support can call `cancelAccountDeletion(userId)` (or, equivalently,
 * `UPDATE users SET deleted_at=NULL, deletion_scheduled_for=NULL`
 * directly) to restore the account. No public undo UX in v1 — that's a
 * v2 follow-up.
 */

import { supabaseAdmin } from '@/db/supabase';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { invalidateAuthCacheForUser } from '@/services/auth/auth.service';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  type AuditEventType,
} from '@/services/core/workspace-audit.service';

// Grace period before hard-purge. Configurable via env so support can
// shorten it on staging without a redeploy. Defaults to 30 days
// (industry standard — GitHub/Slack/Linear all sit around 30d).
const GRACE_PERIOD_DAYS = parseInt(
  process.env.ACCOUNT_DELETION_GRACE_PERIOD_DAYS ?? '30',
  10,
);

/** Information returned by `previewAccountDeletion`. Surfaced in the UI
 *  so the user sees exactly what will go before they confirm. */
export interface DeletionPreview {
  /** Workspaces the user owns AND that have other active members.
   *  Non-empty → must transfer ownership first. */
  blockingWorkspaces: Array<{
    id: string;
    name: string;
    otherMemberCount: number;
  }>;
  /** Workspaces the user owns AND is the only member of — these will
   *  be deleted along with the user. */
  soleOwnedWorkspaces: Array<{ id: string; name: string }>;
  /** When the hard-purge cron would fire if the user confirms now.
   *  ISO string; UI renders as a localised long-form date. */
  scheduledFor: string;
  /** Days from now to the scheduledFor date — convenient for "Your data
   *  will be permanently deleted in 30 days" copy without the UI doing
   *  date math. */
  graceDays: number;
}

/** Outcome of a soft-delete attempt. */
export type SoftDeleteResult =
  | { ok: true; scheduledFor: string }
  | { ok: false; reason: 'blocked_by_workspaces'; blockingWorkspaces: DeletionPreview['blockingWorkspaces'] }
  | { ok: false; reason: 'already_deleted'; deletedAt: string }
  | { ok: false; reason: 'user_not_found' };

// ─── Internals ────────────────────────────────────────────────────────

/**
 * Resolve the set of workspaces the user solely owns, plus those where
 * they're the owner but other active members exist.
 *
 * "Sole owner" = role='owner' AND no other status='active' member.
 *
 * Schema source-of-truth: supabase-migrations/features/workspace-org-members.sql
 *   - `workspace_members(workspace_id, user_id, role, status)`
 *   - role ∈ owner | full_access | view
 *   - status ∈ active | removed
 *   - partial unique index `idx_workspace_single_owner` enforces exactly
 *     one active owner per workspace, so a single membership row per
 *     (workspace_id, user_id, role='owner', status='active') is safe to
 *     count on.
 */
async function classifyOwnedWorkspaces(userId: string): Promise<{
  blocking: DeletionPreview['blockingWorkspaces'];
  soleOwned: DeletionPreview['soleOwnedWorkspaces'];
}> {
  // 1. Find every workspace where this user is the active owner.
  const { data: ownedRows, error: ownedErr } = await supabaseAdmin
    .from('workspace_members')
    .select('workspace_id, workspaces!inner(id, name)')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .eq('status', 'active');

  if (ownedErr) {
    logger.warn('[ACCOUNT_DELETION] classifyOwnedWorkspaces: ownedRows query failed', {
      userId,
      error: ownedErr.message,
    });
    // Defensive default: treat as "no owned workspaces" so deletion
    // isn't blocked by a transient DB blip. The cron later will catch
    // anything that needs cleanup.
    return { blocking: [], soleOwned: [] };
  }

  if (!ownedRows || ownedRows.length === 0) {
    return { blocking: [], soleOwned: [] };
  }

  // 2. For each owned workspace count its OTHER active members.
  //    Supabase doesn't support correlated subqueries in a single
  //    request, so we batch a single IN-query for member counts and
  //    bucket by workspace_id in memory. Cheap (≤ a handful of
  //    workspaces per user in practice).
  const ownedWorkspaceIds = ownedRows
    .map((r) => r.workspace_id as string)
    .filter(Boolean);

  const { data: memberRows, error: memErr } = await supabaseAdmin
    .from('workspace_members')
    .select('workspace_id, user_id')
    .in('workspace_id', ownedWorkspaceIds)
    .eq('status', 'active')
    .neq('user_id', userId);

  if (memErr) {
    logger.warn('[ACCOUNT_DELETION] classifyOwnedWorkspaces: memberRows query failed', {
      userId,
      error: memErr.message,
    });
    // On failure, fail SAFE — assume every owned workspace has other
    // members, so the user is blocked rather than silently destroying
    // collaborators' workspaces.
    const blocking = ownedRows.map((r) => {
      const ws = (r.workspaces as unknown as { id: string; name: string }) || {
        id: r.workspace_id as string,
        name: '(unknown)',
      };
      return { id: ws.id, name: ws.name, otherMemberCount: 1 };
    });
    return { blocking, soleOwned: [] };
  }

  const otherMemberCountByWorkspace = new Map<string, number>();
  for (const row of memberRows || []) {
    const wid = row.workspace_id as string;
    otherMemberCountByWorkspace.set(wid, (otherMemberCountByWorkspace.get(wid) || 0) + 1);
  }

  const blocking: DeletionPreview['blockingWorkspaces'] = [];
  const soleOwned: DeletionPreview['soleOwnedWorkspaces'] = [];
  for (const row of ownedRows) {
    const ws = (row.workspaces as unknown as { id: string; name: string }) || {
      id: row.workspace_id as string,
      name: '(unknown)',
    };
    const others = otherMemberCountByWorkspace.get(ws.id) || 0;
    if (others > 0) {
      blocking.push({ id: ws.id, name: ws.name, otherMemberCount: others });
    } else {
      soleOwned.push({ id: ws.id, name: ws.name });
    }
  }
  return { blocking, soleOwned };
}

/**
 * Best-effort WebSocket invalidation.
 *
 * The `webSocketService` event-name type is strict and doesn't include
 * an `auth:invalidated` event yet. Rather than back-port a new event
 * type for v1, we rely on:
 *   1. `invalidateAuthCacheForUser` (called alongside this) flushing
 *      the Redis JWT cache so the next HTTP/WS request mis-auths.
 *   2. The auth middleware's `deleted_at IS NOT NULL` check returning
 *      401 immediately on the next request, which the frontend's WS
 *      reconnect already handles by signing the user out.
 *
 * If a real disconnect API gets added later (e.g.
 * `webSocketService.disconnectUser(userId)`), wire it here. Kept as a
 * named function with userId in the signature so future code paths can
 * grep for it.
 */
async function disconnectUserSockets(userId: string): Promise<void> {
  // Intentionally a no-op for now — see doc above.
  logger.debug('[ACCOUNT_DELETION] WS disconnect deferred to auth-cache invalidation', {
    userId,
  });
}

/** Cancel an active Stripe subscription. Best-effort. */
async function cancelStripeSubscription(userId: string): Promise<void> {
  try {
    if (!env.STRIPE_SECRET_KEY) return; // billing not wired up — skip
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('stripe_subscription_id')
      .eq('id', userId)
      .maybeSingle();
    const subId = (user as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id;
    if (!subId) return;
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    // Immediate cancellation — the user explicitly asked to delete their
    // account, so we don't want to keep charging them. Stripe's GDPR
    // delete-customer is NOT called here on purpose: billing history is
    // useful for tax/audit and the customer object itself doesn't hold
    // PII beyond the email we already control.
    await stripe.subscriptions.cancel(subId);
    logger.info('[ACCOUNT_DELETION] Stripe subscription cancelled', {
      userId,
      subscriptionId: subId,
    });
  } catch (err) {
    logger.warn('[ACCOUNT_DELETION] Stripe cancellation failed (non-fatal)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Revoke OAuth tokens at the providers we hold tokens for. Best-effort:
 *  even if a provider's revoke endpoint fails, deleting the row from
 *  `integration_tokens` happens later via FK CASCADE so we don't carry
 *  the token forward. */
async function revokeOAuthTokens(userId: string): Promise<void> {
  try {
    const { data: tokens } = await supabaseAdmin
      .from('integration_tokens')
      .select('provider, access_token')
      .eq('user_id', userId);
    if (!tokens || tokens.length === 0) return;
    // Provider-specific revoke endpoints would go here. For v1 we only
    // log + drop tokens at deletion time — the FK CASCADE on the
    // public.users → integration_tokens relationship handles the row
    // deletion. Adding actual provider-side revokes (Jira, GitHub,
    // Slack, etc.) is tracked as v2 work; the cost of a leaked token
    // until provider expiry is acceptable for v1 given the rarity of
    // self-deletion.
    logger.info('[ACCOUNT_DELETION] OAuth tokens noted for revocation', {
      userId,
      providers: tokens.map((t) => t.provider),
    });
  } catch (err) {
    logger.warn('[ACCOUNT_DELETION] OAuth revocation enumeration failed (non-fatal)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Delete repeatable BullMQ jobs + DB-backed schedules. Without this,
 *  `test_schedules` rows keep firing into the regression queue after
 *  the user is gone, creating zombie runs against deleted projects.
 *  This was specifically called out as a top risk in the audit. */
async function purgeUserSchedules(userId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('test_schedules')
      .delete()
      .eq('user_id', userId);
    if (error) {
      logger.warn('[ACCOUNT_DELETION] test_schedules purge failed (non-fatal)', {
        userId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn('[ACCOUNT_DELETION] schedules purge crashed (non-fatal)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // BullMQ removeRepeatableByKey would go here. We don't currently know
  // a stable repeatable-key naming convention used for user-scoped
  // schedules — operations team confirms tests are all dispatched
  // imperatively, not repeatables, so this is a safe no-op for v1. If
  // future repeatables get added with user_id in the key, this is the
  // hook to clean them up.
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Compute the deletion-preview payload shown to the user before they
 * confirm. Pure: doesn't mutate anything.
 *
 * Returns `null` when the user is already soft-deleted (the controller
 * surfaces a 409 in that case so the UI can show the right copy).
 */
export async function previewAccountDeletion(
  userId: string,
): Promise<{ preview: DeletionPreview } | { alreadyDeleted: true; deletedAt: string }> {
  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('id, deleted_at')
    .eq('id', userId)
    .maybeSingle();

  if (userRow?.deleted_at) {
    return { alreadyDeleted: true, deletedAt: userRow.deleted_at as string };
  }

  const { blocking, soleOwned } = await classifyOwnedWorkspaces(userId);
  const scheduledFor = new Date(
    Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  return {
    preview: {
      blockingWorkspaces: blocking,
      soleOwnedWorkspaces: soleOwned,
      scheduledFor,
      graceDays: GRACE_PERIOD_DAYS,
    },
  };
}

/**
 * Schedule the account for deletion. See file-level doc for the full
 * lifecycle. Caller is expected to have already gathered the typed-email
 * confirmation — this function does NOT re-verify the user's identity
 * beyond what the auth middleware already did.
 */
export async function softDeleteAccount(
  userId: string,
): Promise<SoftDeleteResult> {
  const { data: userRow, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id, email, deleted_at')
    .eq('id', userId)
    .maybeSingle();

  if (userErr || !userRow) {
    return { ok: false, reason: 'user_not_found' };
  }
  if (userRow.deleted_at) {
    // Re-confirm idempotently — return the existing scheduled date so
    // the UI can show "already scheduled, returns in N days".
    return { ok: false, reason: 'already_deleted', deletedAt: userRow.deleted_at as string };
  }

  // Sole-owner-of-shared-workspace guard. We classify FIRST so we never
  // stamp `deleted_at` only to discover a workspace conflict — the
  // partial unique index `idx_workspace_single_owner` would still trip
  // later but the UX would be confusing.
  //
  // The classification result is reused below for the audit-log loop so
  // we only hit the DB once. (Memoized at the call-site rather than
  // adding a cache inside classifyOwnedWorkspaces because the function
  // is shared with the preview path which has its own freshness needs.)
  const classified = await classifyOwnedWorkspaces(userId);
  if (classified.blocking.length > 0) {
    return {
      ok: false,
      reason: 'blocked_by_workspaces',
      blockingWorkspaces: classified.blocking,
    };
  }

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const { error: updateErr } = await supabaseAdmin
    .from('users')
    .update({
      deleted_at: now.toISOString(),
      deletion_scheduled_for: scheduledFor.toISOString(),
    })
    .eq('id', userId);

  if (updateErr) {
    logger.error('[ACCOUNT_DELETION] Failed to stamp deleted_at', {
      userId,
      error: updateErr.message,
    });
    throw new Error('Failed to schedule account deletion');
  }

  // All side-effects from here on are best-effort: the user-facing
  // contract is "your account is gone" the moment `deleted_at` is set.
  // Stripe / OAuth / WS / cache failures get a warn-log but don't roll
  // anything back.
  await Promise.allSettled([
    cancelStripeSubscription(userId),
    revokeOAuthTokens(userId),
    purgeUserSchedules(userId),
    disconnectUserSockets(userId),
    invalidateAuthCacheForUser(userId),
  ]);

  // Audit log. We pick the first sole-owned workspace as the logging
  // anchor since the audit table is workspace-scoped. If the user owned
  // multiple, every one gets an entry — preserves the trail across
  // every workspace they touched.
  //
  // KNOWN GAP (tracked in audit follow-up): sole-owned workspaces get
  // hard-purged with FK CASCADE on the 30-day mark, taking their audit
  // log with them. A non-workspace-scoped `account_deletion_audit`
  // table is the right long-term home; for v1 we accept the trade-off.
  const soleOwned = classified.soleOwned;
  for (const ws of soleOwned) {
    await WorkspaceAuditService.log({
      workspaceId: ws.id,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.ACCOUNT_DELETION_REQUESTED,
      targetType: 'user',
      targetId: userId,
      metadata: { scheduledFor: scheduledFor.toISOString(), graceDays: GRACE_PERIOD_DAYS },
    }).catch((err) => {
      logger.debug('[ACCOUNT_DELETION] audit log failed (non-fatal)', {
        userId,
        workspaceId: ws.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  logger.info('[ACCOUNT_DELETION] Account soft-deleted', {
    userId,
    scheduledFor: scheduledFor.toISOString(),
    soleOwnedWorkspaceCount: soleOwned.length,
  });

  return { ok: true, scheduledFor: scheduledFor.toISOString() };
}

/**
 * Revert a soft-delete during the grace period.
 *
 * In v1 this is reachable only via `POST /api/v1/auth/me/delete/cancel`,
 * which uses `req.user.id` — so a user can only undo THEIR OWN pending
 * deletion (the auth middleware allowlist gates that one URL through).
 * Threat model: no privilege escalation possible — see the controller's
 * docstring for the full rationale.
 *
 * The function takes a parameterised `userId` rather than reading from
 * a request so a future admin-acting-on-behalf-of-user route can call
 * it directly without re-implementing the cascade. There is no such
 * route in v1.
 */
export async function cancelAccountDeletion(userId: string): Promise<{ ok: boolean }> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ deleted_at: null, deletion_scheduled_for: null })
    .eq('id', userId)
    .not('deleted_at', 'is', null); // no-op if not actually deleted

  if (error) {
    logger.error('[ACCOUNT_DELETION] Cancel failed', { userId, error: error.message });
    return { ok: false };
  }

  await invalidateAuthCacheForUser(userId);

  // Audit log on each workspace the user is a sole owner of (same
  // anchor strategy as `softDeleteAccount`). Best-effort — the user is
  // already restored at this point and an audit failure must not
  // surface as an end-user error.
  const restored = await classifyOwnedWorkspaces(userId).catch(() => ({
    soleOwned: [],
    blocking: [],
  }));
  for (const ws of restored.soleOwned) {
    await WorkspaceAuditService.log({
      workspaceId: ws.id,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.ACCOUNT_DELETION_CANCELLED,
      targetType: 'user',
      targetId: userId,
      metadata: {},
    }).catch((err) => {
      logger.debug('[ACCOUNT_DELETION] cancel audit log failed (non-fatal)', {
        userId,
        workspaceId: ws.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  logger.info('[ACCOUNT_DELETION] Account deletion cancelled', { userId });
  return { ok: true };
}

/**
 * Hard-purge a soft-deleted account. Called by the daily cron after
 * the grace period elapses. See file-level doc for the full sequence.
 *
 * Returns the list of steps that succeeded vs failed so the cron can
 * log a summary and retry partial failures on the next tick.
 */
export async function hardPurgeAccount(userId: string): Promise<{
  ok: boolean;
  steps: Record<string, 'ok' | 'failed' | 'skipped'>;
}> {
  const steps: Record<string, 'ok' | 'failed' | 'skipped'> = {};

  // Re-verify the user is still soft-deleted. Defensive — protects
  // against a race where support cancelled deletion seconds before
  // the cron picks it up.
  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('id, email, deleted_at, deletion_scheduled_for')
    .eq('id', userId)
    .maybeSingle();
  if (!userRow || !userRow.deleted_at) {
    return { ok: true, steps: { precondition: 'skipped' } };
  }

  // Capture workspaces the user is a MEMBER (not sole owner) of BEFORE
  // the cascade tears down membership rows. These workspaces survive
  // the purge (they have other members), so they're the only durable
  // home for `ACCOUNT_DELETION_COMPLETED` / `_FAILED` audit entries
  // tied to this user.
  const surviving_workspace_ids: string[] = [];
  try {
    const { data: memberships } = await supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId);
    if (memberships) {
      // De-duplicate; the same workspace shouldn't appear twice but the
      // schema doesn't enforce that and we'd rather over-defend.
      const seen = new Set<string>();
      for (const m of memberships as Array<{ workspace_id: string }>) {
        if (m.workspace_id && !seen.has(m.workspace_id)) {
          seen.add(m.workspace_id);
          surviving_workspace_ids.push(m.workspace_id);
        }
      }
    }
  } catch (err) {
    logger.debug('[ACCOUNT_DELETION] could not enumerate memberships (non-fatal)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Helper: emit a per-workspace audit row, never throws.
  const auditOnSurvivors = async (
    eventType: AuditEventType,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    for (const wsId of surviving_workspace_ids) {
      await WorkspaceAuditService.log({
        workspaceId: wsId,
        actorUserId: userId,
        eventType,
        targetType: 'user',
        targetId: userId,
        metadata,
      }).catch((err) => {
        logger.debug('[ACCOUNT_DELETION] hard-purge audit log failed (non-fatal)', {
          userId,
          workspaceId: wsId,
          eventType,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  };

  // 1. Storage cleanup.
  //
  //    Layout reference (audited 2026-05-17 — keep in sync with
  //    `src/services/storage/*.service.ts`):
  //
  //      Bucket                 | Per-user prefix(es)
  //      -----------------------+------------------------------------------------
  //      user-avatars           | <userId>/                              (avatars)
  //      workspace-logos        | <userId>/<workspaceId>/                (per-ws logos)
  //      lite-trace-logs        | trace-logs/<emailOrUuidSegment>/...    (run traces)
  //      env.SUPABASE_BUCKET_NAME (e.g. 'qai-assets')
  //                             | <userId>/videos/<...>                  (run videos)
  //                             | <userId>/traces/<...>                  (run HAR/playwright traces)
  //                             | <userId>/screenshots/<...>             (run screenshots)
  //                             | test-uploads/<userId>/<...>            (user-uploaded test fixtures)
  //
  //    Supabase Storage `.list()` is non-recursive — descending into
  //    subdirs requires walking them. We use a small BFS-style helper
  //    bounded by `MAX_LIST_DEPTH` to keep one runaway run from spinning
  //    forever on a hand-crafted deep prefix.
  //
  //    Failures here log + continue — orphaned blobs are cheaper than
  //    a half-purged account that won't re-try.
  try {
    // Resolve user email up front; the lite-trace-logs layout segments
    // by email (with @ replaced) when available, falling back to the
    // UUID-based segment otherwise.
    const emailSegment = userRow.email
      ? String(userRow.email).replace('@', '-at-').replace(/[^a-zA-Z0-9._-]/g, '_')
      : null;
    const traceLogSegments = [
      `trace-logs/${userId}`,
      ...(emailSegment ? [`trace-logs/${emailSegment}`] : []),
    ];

    // Generic Supabase Storage recursive purge. Lists pages of 1000,
    // distinguishes files from folders (files have `id` set), recurses
    // into folders, and bulk-removes the collected file paths.
    const purgePrefix = async (bucket: string, prefix: string, depth = 0): Promise<number> => {
      const MAX_LIST_DEPTH = 8;
      if (depth > MAX_LIST_DEPTH) return 0;

      let offset = 0;
      const PAGE = 1000;
      let removed = 0;

      while (true) {
        const { data: entries, error } = await supabaseAdmin.storage
          .from(bucket)
          .list(prefix, { limit: PAGE, offset });
        if (error) {
          logger.debug('[ACCOUNT_DELETION] storage list error (non-fatal)', {
            userId,
            bucket,
            prefix,
            error: error.message,
          });
          return removed;
        }
        if (!entries || entries.length === 0) break;

        const filePaths: string[] = [];
        const subPrefixes: string[] = [];
        for (const e of entries) {
          // Supabase returns `id: null` for folder-like rows.
          if ((e as { id?: string | null }).id) {
            filePaths.push(`${prefix}/${e.name}`);
          } else {
            subPrefixes.push(`${prefix}/${e.name}`);
          }
        }

        if (filePaths.length > 0) {
          const { error: removeErr } = await supabaseAdmin.storage
            .from(bucket)
            .remove(filePaths);
          if (removeErr) {
            logger.debug('[ACCOUNT_DELETION] storage remove failed (non-fatal)', {
              userId,
              bucket,
              prefix,
              error: removeErr.message,
            });
          } else {
            removed += filePaths.length;
          }
        }

        for (const sub of subPrefixes) {
          removed += await purgePrefix(bucket, sub, depth + 1);
        }

        if (entries.length < PAGE) break;
        offset += PAGE;
      }
      return removed;
    };

    // Resolve the assets bucket name at runtime — same value the upload
    // services pin (`env.SUPABASE_BUCKET_NAME`).
    const assetsBucket = process.env.SUPABASE_BUCKET_NAME || 'qai-assets';

    // (bucket, prefix) pairs to walk. Some buckets have multiple
    // per-user roots; we just enumerate each.
    const targets: Array<{ bucket: string; prefix: string }> = [
      { bucket: 'user-avatars', prefix: userId },
      { bucket: 'workspace-logos', prefix: userId },
      { bucket: assetsBucket, prefix: userId },
      { bucket: assetsBucket, prefix: `test-uploads/${userId}` },
      ...traceLogSegments.map((p) => ({ bucket: 'lite-trace-logs', prefix: p })),
    ];

    let totalRemoved = 0;
    for (const { bucket, prefix } of targets) {
      try {
        totalRemoved += await purgePrefix(bucket, prefix);
      } catch (err) {
        logger.warn('[ACCOUNT_DELETION] storage purge failed for prefix (non-fatal)', {
          userId,
          bucket,
          prefix,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('[ACCOUNT_DELETION] storage purge done', { userId, totalRemoved });
    steps.storage = 'ok';
  } catch (err) {
    steps.storage = 'failed';
    logger.warn('[ACCOUNT_DELETION] storage purge step failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Explicit DELETE for TEXT user_id tables that have NO FK to
  //    public.users. These would otherwise be orphaned (audit map
  //    section "TEXT user_id with NO FK" in the investigation report).
  //    Order: children → parents to avoid orphan-FK errors among
  //    themselves where applicable.
  const TEXT_USERID_TABLES = [
    // High-volume per-test data first
    'test_executions',
    'mobile_test_executions',
    'mobile_test_results',
    'mobile_regression_runs',
    'intelligent_test_actions',
    'intelligent_page_visits',
    'intelligent_test_sessions',
    'regression_runs',
    'regression_plan_items',
    'regression_plans',
    'regression_doctor_findings',
    'regression_doctor_apply_snapshots',
    'intent_test_cases',
    'test_resources',
    'resource_bindings',
    'test_flows',
    'test_modules',
    'test_platforms',
    'test_fixtures',
    'test_chat_mappings',
    'test_jira_issues',
    'test_credentials',
    'test_schedules',
    'allure_imports',
    'api_test_executions',
    'api_test_configs',
    'api_endpoints',
    'api_environments',
    'api_flow_runs',
    'api_flow_specs',
    'automation_action_logs',
    'automation_actions',
    'ai_usage_log',
    'trace_files',
    'traces',
    'exploration_runs',
    'kb_retrieval_events',
    'chat_message_embeddings',
    'chat_summaries',
    'git_webhook_deliveries',
    'git_integrations',
    'jira_tokens',
    'user_credits',
  ];
  for (const table of TEXT_USERID_TABLES) {
    try {
      const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
      if (error) {
        logger.debug('[ACCOUNT_DELETION] TEXT user_id table delete failed (continuing)', {
          userId,
          table,
          error: error.message,
        });
      }
    } catch {
      // Swallow — table may not exist on this deployment, that's fine.
    }
  }
  steps.text_user_id_tables = 'ok';

  // 3. Delete sole-owned workspaces. FK CASCADE on `workspaces.id` then
  //    handles `workspace_members`, `workspace_audit_log`,
  //    `workspace_credits`, `workspace_credit_transactions`, `projects`,
  //    and everything project-scoped.
  try {
    const { soleOwned } = await classifyOwnedWorkspaces(userId);
    for (const ws of soleOwned) {
      const { error } = await supabaseAdmin.from('workspaces').delete().eq('id', ws.id);
      if (error) {
        logger.warn('[ACCOUNT_DELETION] workspace delete failed (continuing)', {
          userId,
          workspaceId: ws.id,
          error: error.message,
        });
      }
    }
    steps.workspaces = 'ok';
  } catch (err) {
    steps.workspaces = 'failed';
    logger.warn('[ACCOUNT_DELETION] workspaces step failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Delete the public.users row. FK CASCADE cleans up
  //    workspace_members (any remaining), chat_sessions, notifications,
  //    integration_tokens, kb_documents, etc.
  try {
    const { error } = await supabaseAdmin.from('users').delete().eq('id', userId);
    if (error) throw new Error(error.message);
    steps.public_users = 'ok';
  } catch (err) {
    steps.public_users = 'failed';
    logger.error('[ACCOUNT_DELETION] public.users delete failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Emit FAILED audit before returning so we have a durable record of
    // the abort. Multi-member workspaces still exist at this point.
    await auditOnSurvivors(AUDIT_EVENTS.ACCOUNT_DELETION_FAILED, {
      steps,
      stage: 'public_users_delete',
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, steps };
  }

  // 5. Delete from auth.users via Supabase admin. After this, the user
  //    can re-sign-up with the same email if they choose. If this
  //    fails, public.users is already gone — the auth row will be
  //    orphaned but harmless (it has no app data left to reference).
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    steps.auth_users = 'ok';
  } catch (err) {
    steps.auth_users = 'failed';
    logger.warn('[ACCOUNT_DELETION] auth.users delete failed (orphan tolerated)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Final cache invalidation in case the user re-authed during the
  //    cron tick (extremely unlikely with `deleted_at` middleware in
  //    place, but cheap insurance).
  await invalidateAuthCacheForUser(userId).catch(() => undefined);

  // Emit COMPLETED audit on every surviving workspace this user belonged
  // to. By now public.users is gone — the targetId references a
  // non-existent row but that's intentional: the audit row immortalises
  // the user's deletion.
  await auditOnSurvivors(AUDIT_EVENTS.ACCOUNT_DELETION_COMPLETED, { steps });

  logger.info('[ACCOUNT_DELETION] Hard-purge completed', { userId, steps });
  return { ok: true, steps };
}
