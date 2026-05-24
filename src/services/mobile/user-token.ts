/**
 * Mobile Runner User Token
 *
 * Mints `X-User-Token` values consumed by qait-mobile-runner.
 *
 * Wire format (mirrored from runner src/auth/user-token.ts):
 *   `<userId>.<expiresAtMs>.<hexHmacSha256>`
 *
 * Where `hexHmacSha256 = HMAC-SHA256(secret, userId + '.' + expiresAtMs)`.
 *
 * The runner verifies against env `RUNNER_USER_TOKEN_SECRET`. Both sides MUST
 * use the same secret — coordinate via deploy config. When the backend secret
 * is empty we treat that as "don't mint", which leaves the runner in legacy
 * mode (RUNNER_REQUIRE_USER_ID=0 — missing tokens pass through).
 */

import crypto from 'crypto';

const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes — matches runner's accepted window

export function mintRunnerUserToken(
  userId: string,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  // Defense in depth — Node's `createHmac('', '')` doesn't throw, it
  // silently computes an HMAC keyed by an empty string. That produces
  // tokens the runner correctly rejects, but we'd rather fail loud at
  // mint time than ship every request with a garbage header. Callers
  // (currently only `mobile-runner-client.ts:request`) are expected to
  // gate on `env.RUNNER_USER_TOKEN_SECRET` truthy before invoking; this
  // throw catches any future callsite that forgets the gate.
  if (!secret) {
    throw new Error('mintRunnerUserToken: secret is empty — refusing to mint a useless token');
  }
  if (!userId) {
    throw new Error('mintRunnerUserToken: userId is empty');
  }
  const expiresAtMs = Date.now() + ttlMs;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${userId}.${expiresAtMs}`)
    .digest('hex');
  return `${userId}.${expiresAtMs}.${hmac}`;
}
