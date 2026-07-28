/**
 * Data-access for CI/CD API-key authentication.
 *
 * db/ sublayer contract: queries + row→type mapping only. No business logic,
 * no service calls. `requireCiApiKey` is the sole consumer.
 *
 * The key lookup is a DIRECT match on the stored SHA-256 hash. It used to be
 * "fetch up to 100 CI-keyed projects, linear-scan in Node", which silently
 * returned 401 for an arbitrary subset of VALID keys past 100 such projects.
 * The `.not(...)` filter is redundant for correctness but kept deliberately:
 * it restates the partial-index predicate in the WHERE clause so the planner
 * can match `idx_projects_ci_api_key_hash` instead of sequentially scanning
 * `projects` (see 20260727_projects_ci_api_key_hash_index.sql).
 *
 * No timing-safe compare is needed here: a caller must already possess the
 * exact SHA-256 preimage for the lookup to match at all, so there is no
 * secret left to leak through comparison timing.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface CiProjectRow {
  id: string;
  user_id: string;
  workspace_id: string;
  settings: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Owner account state, as the CI front door needs it. Mirrors what
 * `requireAuth` + `requireApproved` enforce for JWT callers.
 */
export interface CiOwnerAuthState {
  deletedAt: string | null;
  status: string | null;
}

/**
 * Discriminates "the owner row says X" from "we could not find out".
 * The caller fails CLOSED on a definite bad state and OPEN on `ok: false`
 * (matching `requireAuth`'s deleted_at check) — a Supabase blip must not
 * lock every customer's pipeline out.
 */
export type CiOwnerAuthLookup =
  | { ok: true; owner: CiOwnerAuthState | null }
  | { ok: false };

/** Thrown when the key lookup itself fails, so the caller can answer 500 (not 401). */
export class CiKeyLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CiKeyLookupError';
  }
}

/**
 * Find the project whose stored CI-key hash equals `hash`, or null when none does.
 *
 * @throws {CiKeyLookupError} when the query fails — a DB outage must not be
 *         reported to the caller as "invalid key".
 */
export async function findProjectByCiKeyHash(hash: string): Promise<CiProjectRow | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('*')
    .not('settings->ciApiKey', 'is', null)
    .eq('settings->ciApiKey->>hash', hash)
    .maybeSingle();

  if (error) {
    throw new CiKeyLookupError(error.message || 'CI key lookup failed');
  }

  return (data as CiProjectRow | null) ?? null;
}

/**
 * Read the owning account's gate-relevant state.
 *
 * Never throws: a failure resolves to `{ ok: false }` so the caller can decide
 * to fail open.
 */
export async function getCiOwnerAuthState(userId: string): Promise<CiOwnerAuthLookup> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('deleted_at, status')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      logger.warn('[CI_AUTH_DB] Owner state lookup failed', { userId, error: error.message });
      return { ok: false };
    }
    if (!data) return { ok: true, owner: null };

    const row = data as { deleted_at?: string | null; status?: string | null };
    return {
      ok: true,
      owner: { deletedAt: row.deleted_at ?? null, status: row.status ?? null },
    };
  } catch (err) {
    logger.warn('[CI_AUTH_DB] Owner state lookup threw', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}
