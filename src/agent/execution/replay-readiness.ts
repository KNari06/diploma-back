/**
 * Replay readiness recollect — pure decision helpers.
 *
 * Background/regression replay collects an interactive-node snapshot right
 * before LLM element resolution (command-executor.ts). On redirect-heavy flows
 * (SSO/OAuth chains) that snapshot can land on a half-loaded / mid-redirect
 * page exposing only a handful of nodes — the resolver then "confidently" picks
 * a stray element (logo, search box, "Sign up"), drifting the whole run onto
 * the wrong page while every step still reports success.
 *
 * The editor and lite paths avoid this via `waitForPageInteractive` (URL settle
 * + DOM stable + >=1 interactive). This module decides whether the replay path
 * should run that same gate + recollect — but only when the fresh snapshot is
 * suspiciously sparse, so healthy pages pay no extra wait.
 *
 * Kept free of `env` / Playwright imports so the decision is unit-testable in
 * isolation. The flag accessor lives in config/features/replay-readiness.ts.
 */

/**
 * A fresh background snapshot with fewer interactive nodes than this is treated
 * as "page not settled yet" and is eligible for one readiness-gated recollect.
 * Real app pages comfortably exceed this (observed 120–200+ on documentolog);
 * mid-redirect snapshots were ~0–7.
 */
export const MIN_HEALTHY_INTERACTIVE_NODES = 10;

/**
 * Budget for the single readiness gate before recollect (ms). Kept short so a
 * genuinely-sparse page (e.g. a minimal login form) does not stall the step.
 */
export const REPLAY_READINESS_MAX_WAIT_MS = 4000;

/**
 * Decide whether to run one readiness gate + recollect before resolving.
 *
 * Only on the first attempt — retries already force a fresh collection and have
 * their own scroll-retry logic, so we never interfere with or double-wait them.
 * Only when the fresh snapshot is sparser than a real page would be.
 */
export function shouldRecollectForReadiness(input: {
  enabled: boolean;
  domNodeCount: number;
  attempt: number;
}): boolean {
  const { enabled, domNodeCount, attempt } = input;
  if (!enabled) return false;
  if (attempt !== 0) return false;
  return domNodeCount < MIN_HEALTHY_INTERACTIVE_NODES;
}
