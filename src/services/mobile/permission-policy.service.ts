/**
 * Mobile runtime-permission policy resolver.
 *
 * Centralises the lookup of the per-project runtime-permission policy
 * (`auto_allow` | `auto_deny` | `manual`) and its application to a live
 * runner session. Used by every entry point that acquires a mobile
 * session so the user's project-level setting actually takes effect:
 *
 *   - Editor warmup (`session.controller.ts:warmupSession`)
 *   - Regression worker (`jobs/mobile-test-run.job.ts`)
 *   - CI-triggered runs (queued into the same worker via
 *     `api/mobile/ci.controller.ts`)
 *
 * Before this module existed, only the editor warmup applied the policy.
 * The regression worker fell back to the runner's hard-coded default
 * (`auto_allow`) regardless of what the user picked in Settings, which
 * silently diverged the two execution paths.
 *
 * Why a service and not just an export from session.controller:
 * importing app-controller helpers from worker code couples lifecycle
 * boundaries we'd rather keep separate. A small focused service has
 * no HTTP/Express dependency and is the right home for shared logic
 * between request handlers and queue workers.
 */

import { ProjectService } from '@/services/core/project.service';
import { MobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { logger } from '@/utils/core/logger';

export type MobilePermissionPolicy = 'auto_allow' | 'auto_deny' | 'manual';

export const VALID_PERMISSION_POLICIES: readonly MobilePermissionPolicy[] = [
  'auto_allow',
  'auto_deny',
  'manual',
];

const isValidPolicy = (v: unknown): v is MobilePermissionPolicy =>
  typeof v === 'string' && (VALID_PERMISSION_POLICIES as readonly string[]).includes(v);

/**
 * Read the project-level policy from `project.settings.mobilePermissionPolicy`.
 *
 * Precedence chain (this function covers step 2 only — callers compose
 * the rest):
 *   1. Test-level override   — applied by the caller AFTER this
 *   2. Project default       — what we return here
 *   3. Runner default        — when we return `null`, callers skip the
 *                              PATCH and the runner's own default
 *                              (`auto_allow`) applies
 *
 * Returns `null` on:
 *   - Missing project / access denied
 *   - Missing / malformed `mobilePermissionPolicy` field
 *   - DB or network error (swallowed — we never want a permission
 *     lookup to fail a run; the runner default is a safe fallback)
 */
export async function resolveProjectPermissionPolicy(
  projectId: string,
  userId: string,
): Promise<MobilePermissionPolicy | null> {
  try {
    const project = await ProjectService.getProject(projectId, userId);
    const stored = project?.settings?.mobilePermissionPolicy;
    if (isValidPolicy(stored)) {
      return stored;
    }
  } catch (err) {
    // Non-fatal — we explicitly choose "fall back to runner default"
    // over "fail the test" because the alternative would block a
    // regression run on a transient Supabase blip.
    logger.debug('[PERMISSION_POLICY] resolve failed (non-fatal, falling back to runner default)', {
      projectId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/**
 * Resolve the project policy and PATCH it onto a live runner session.
 *
 * Idempotent — safe to call after every session acquisition path
 * (pool / warmup / cold). The PATCH itself is also idempotent on the
 * runner side, so re-applying the same value is effectively a no-op
 * after the first call.
 *
 * Non-fatal at every step:
 *   - Missing/invalid stored policy → skip the PATCH (runner default
 *     applies)
 *   - Runner PATCH failure          → log + continue (same fallback)
 *
 * @returns the policy that was actually applied, or `null` if none.
 */
export async function applyProjectPolicyToSession(params: {
  client: MobileRunnerClient;
  sessionId: string;
  projectId: string | null | undefined;
  userId: string;
  /** For log lines so failures can be correlated to a test/run. */
  context?: Record<string, unknown>;
}): Promise<MobilePermissionPolicy | null> {
  const { client, sessionId, projectId, userId, context } = params;
  if (!projectId) return null;

  const policy = await resolveProjectPermissionPolicy(projectId, userId);
  if (!policy) return null;

  try {
    await client.setPermissionPolicy(sessionId, policy);
    return policy;
  } catch (err) {
    logger.debug('[PERMISSION_POLICY] runner PATCH failed (non-fatal)', {
      ...(context || {}),
      sessionId,
      projectId,
      policy,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
