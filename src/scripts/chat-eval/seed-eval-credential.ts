/**
 * Tier-2b credential seeding (impure) — put the fixture's demo login into the
 * REAL encrypted credential store, so an authored login test can bind to it and
 * replay green.
 *
 * This deliberately goes through the production `createResource` path rather
 * than hand-injecting a runVariables map: that exercises the real
 * validate → splitSensitive → encryptEnvelope (AES-256-GCM) → row write chain,
 * and replay then reads it back through the real
 * `applyBindingsToContext` → `loadDecrypted` → `secretAdapter.apply` path. A
 * shortcut here would prove the eval's own plumbing, not the product's.
 *
 * Footprint: ONE `test_resources` row, namespaced by name, deleted by
 * `deleteEvalCredential` in the caller's `finally`.
 *
 * FK note: `test_resources.project_id` REFERENCES `projects(id)`, while
 * `user_id` is free-form TEXT. The eval's synthetic project id is not a real
 * row, so we borrow an existing project purely to satisfy the FK — the borrowed
 * row is never read or mutated. `user_id` stays EVAL_USER_ID, which is what
 * `loadDecrypted` actually filters on at replay.
 */

import { supabaseAdmin } from '@/db/supabase';
import { createResource, deleteResource } from '@/services/test-resource/test-resource.service';
import { logger } from '@/utils/core/logger';
import { EVAL_USER_ID } from './eval-identity';

/** Key names inside the secret's `values` map. Names are not secret; values are. */
export const EVAL_SECRET_EMAIL_KEY = 'login_email';
export const EVAL_SECRET_PASSWORD_KEY = 'login_password';

/** Namespaced so a leftover row is obvious as eval debris. */
const EVAL_SECRET_NAME = '__chat_eval_fixture_login__';

export interface SeededCredential {
  resourceId: string;
  emailKey: string;
  passwordKey: string;
}

/**
 * Create the encrypted `secret` holding the fixture's demo credentials.
 * Throws with an actionable message if the environment can't support it —
 * silently skipping would turn a missing run-proof into a false green.
 */
export async function seedEvalCredential(credentials: {
  username: string;
  password: string;
}): Promise<SeededCredential> {
  const projectId = await borrowProjectId();

  const created = await createResource({
    userId: EVAL_USER_ID,
    projectId,
    kind: 'secret',
    name: EVAL_SECRET_NAME,
    description: 'Ephemeral chat-eval fixture login. Deleted after the run.',
    config: {
      values: {
        [EVAL_SECRET_EMAIL_KEY]: credentials.username,
        [EVAL_SECRET_PASSWORD_KEY]: credentials.password,
      },
    },
  });

  // Names only — never the values (CLAUDE.md invariant #10).
  logger.info('[CHAT_EVAL] Seeded credential secret', {
    resourceId: created.id,
    keys: [EVAL_SECRET_EMAIL_KEY, EVAL_SECRET_PASSWORD_KEY],
  });

  return {
    resourceId: created.id,
    emailKey: EVAL_SECRET_EMAIL_KEY,
    passwordKey: EVAL_SECRET_PASSWORD_KEY,
  };
}

/** Best-effort teardown — a failure here must not mask the run's own result. */
export async function deleteEvalCredential(resourceId: string): Promise<void> {
  try {
    // `deleteResource` reports a DB failure via the returned flag, not a throw —
    // claiming success on a failed delete would hide an orphaned credential row.
    const { deleted } = await deleteResource(resourceId, EVAL_USER_ID);
    if (!deleted) {
      logger.warn('[CHAT_EVAL] Credential secret was NOT deleted — remove it manually', {
        resourceId, name: EVAL_SECRET_NAME,
      });
      return;
    }
    logger.info('[CHAT_EVAL] Deleted credential secret', { resourceId });
  } catch (err) {
    logger.warn('[CHAT_EVAL] Failed to delete credential secret — remove it manually', {
      resourceId,
      name: EVAL_SECRET_NAME,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Remove what CAN be removed of the billing rows a bound run creates for the
 * synthetic eval user.
 *
 * Binding a credential forces us to pass `userId` (that's what `loadDecrypted`
 * authorizes on), which switches on per-step credit deduction.
 * `getOrCreateUserCredits` then upserts a `user_credits` row — `user_id` is
 * free-form TEXT with no FK, so the insert succeeds — grants a welcome bonus,
 * and appends a `credit_transactions` row per step.
 *
 * `user_credits` is deleted here. **`credit_transactions` is NOT and cannot
 * be:** it is an append-only ledger enforced by a DB trigger ("DELETE is not
 * allowed"), which is a deliberate financial-integrity property we should not
 * work around from an eval script. So a bound `--author` run leaves a handful
 * of ledger rows for a synthetic all-zeros user id that no real account can
 * hold. They are inert (no real user, no balance once `user_credits` is gone)
 * but they DO accumulate — the honest trade for exercising the real
 * authorization path. Documented in the eval README.
 */
export async function cleanupEvalUserBilling(): Promise<void> {
  const { error } = await supabaseAdmin
    .from('user_credits')
    .delete()
    .eq('user_id', EVAL_USER_ID);

  if (error) {
    logger.warn('[CHAT_EVAL] Failed to clean eval user_credits — remove it manually', {
      userId: EVAL_USER_ID,
      error: error.message,
    });
    return;
  }
  logger.info('[CHAT_EVAL] Cleaned eval user_credits (credit_transactions is append-only and remains)', {
    userId: EVAL_USER_ID,
  });
}

/**
 * Any real project id, purely to satisfy the NOT NULL FK. We never read or
 * write the borrowed project; `loadDecrypted` filters on id + user_id only, so
 * which project the row points at doesn't affect resolution.
 */
async function borrowProjectId(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Cannot seed the eval credential — reading a project failed (${error.message}). ` +
      'Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in qai-backend/.env.',
    );
  }
  if (!data?.id) {
    throw new Error(
      'Cannot seed the eval credential — no rows in `projects`, and ' +
      'test_resources.project_id has a NOT NULL FK to it. Create any project first.',
    );
  }
  return data.id as string;
}
