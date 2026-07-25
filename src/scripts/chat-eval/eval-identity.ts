/**
 * Tier-2b shared synthetic identity.
 *
 * These ids were duplicated in `author-on-fixture.ts` and `fixture-runner.ts`.
 * That was harmless while the eval wrote nothing — but once a credential is
 * seeded, the user id becomes load-bearing: `loadDecrypted(resourceId, userId)`
 * filters on `user_id`, so a seed under one id and a replay under another
 * silently returns null and the `required: true` binding throws. Single-sourced
 * here so seed → author → replay can never drift.
 *
 * Valid-format UUIDs: the run path scopes by UUID (a non-UUID trips a 22P02 at
 * preflight).
 *
 * These ids DO reach the database on a credential-bound `--author` run: the
 * seeded `test_resources` row, plus the `user_credits` / `credit_transactions`
 * rows that per-step billing creates once a userId is present. All of them are
 * removed by the teardown in `seed-eval-credential.ts`. An unbound run still
 * writes nothing.
 */

export const EVAL_USER_ID = '00000000-0000-4000-8000-000000000001';
export const EVAL_PROJECT_ID = '00000000-0000-4000-8000-000000000003';
