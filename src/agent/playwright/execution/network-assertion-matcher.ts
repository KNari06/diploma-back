/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NETWORK ASSERTION MATCHER — did an expected API call actually happen?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifies an exploration-authored network assertion against calls a replay run
 * observed. Pure and synchronous so it is trivially testable and cannot fail a
 * step by throwing unexpectedly — the CALLER decides what a miss means.
 *
 * DESIGN RULE: prefer a false GREEN over a false RED.
 *
 * An exploration-authored assertion is created autonomously, with no human
 * reviewing it, and lands in the user's project. A check that fires spuriously
 * turns a whole discovered suite into noise the user must triage — strictly
 * worse than a check that occasionally misses a regression. So:
 *
 *   - Match on status FAMILY (2xx), never the exact status. An app that
 *     legitimately switches 200 → 204 must not go red.
 *   - Match on the URL PATTERN produced by `normalizeUrlWithPattern`, applied to
 *     BOTH sides. `/orders/123` and `/orders/456` both normalize to
 *     `/orders/:id`, so a per-run id cannot false-fail. This is the same
 *     function exploration used when authoring, so authoring and verification
 *     stay symmetric by construction.
 *   - An assertion with no usable `source` is UNVERIFIABLE, not failed — the
 *     `expect` string is prose for humans, and inventing a comparison from it
 *     would be guesswork.
 */

import { normalizeUrlWithPattern } from '@/agent/core/lite/exploration/url-pattern';
import type { TestAssertion } from '@/agent/core/lite/exploration/types';
import type { RecordedCall } from './network-call-recorder';

export type NetworkAssertionOutcome = 'passed' | 'failed' | 'unverifiable';

export interface NetworkAssertionResult {
  outcome: NetworkAssertionOutcome;
  /** Human-readable reason, safe to surface in a step error. */
  detail: string;
  /**
   * True ONLY for the unambiguous case: a 2xx was expected and a 5xx was
   * observed on that endpoint. This is the one mismatch that cannot be a matter
   * of opinion — the API broke — so it is the only one a caller should treat as
   * fatal for an autonomously-authored assertion. A missing call, a 4xx, or a
   * family drift are all legitimately explainable (different data, changed
   * validation, a flow that took another branch) and must stay non-fatal.
   */
  serverError?: boolean;
}

/** `200` → `'2xx'`. Keeps an assertion stable across 200/201/204 drift. */
function statusFamily(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Verify one network assertion against the observed calls.
 *
 * Never throws. Returns `unverifiable` when the assertion lacks the data needed
 * to check it, so a caller can skip rather than fail.
 */
export function matchNetworkAssertion(
  assertion: TestAssertion,
  calls: RecordedCall[],
): NetworkAssertionResult {
  if (assertion.type !== 'network') {
    return { outcome: 'unverifiable', detail: `Not a network assertion (type: ${assertion.type})` };
  }

  const method = assertion.source?.method?.toUpperCase();
  const expectedPattern = assertion.source?.urlPattern;
  const expectedStatus = assertion.source?.status;

  // Method + URL pattern are the identity of the call. Without them there is
  // nothing to look for; `expect` is prose, not a machine-checkable predicate.
  if (!method || !expectedPattern) {
    return {
      outcome: 'unverifiable',
      detail: `Assertion "${assertion.expect}" has no method/urlPattern to match on`,
    };
  }

  const expectedFamily = typeof expectedStatus === 'number' ? statusFamily(expectedStatus) : undefined;

  // Same-method candidates, compared on normalized patterns so a per-run id in
  // the path cannot cause a miss.
  const sameEndpoint = calls.filter(
    (c) => c.method.toUpperCase() === method && normalizeUrlWithPattern(c.url) === expectedPattern,
  );

  if (sameEndpoint.length === 0) {
    return {
      outcome: 'failed',
      detail: `Expected ${method} ${expectedPattern} to be called, but no matching request was observed`,
    };
  }

  // No expected status recorded → the call happening at all is the assertion.
  if (!expectedFamily) {
    return { outcome: 'passed', detail: `${method} ${expectedPattern} was called` };
  }

  const matching = sameEndpoint.filter((c) => statusFamily(c.status) === expectedFamily);
  if (matching.length > 0) {
    return {
      outcome: 'passed',
      detail: `${method} ${expectedPattern} returned ${matching[0].status} (${expectedFamily})`,
    };
  }

  const observedStatuses = [...new Set(sameEndpoint.map((c) => c.status))];
  const observed = observedStatuses.join(', ');
  // Only "expected success, got a server error" is unambiguous. Every observed
  // status must be 5xx — a single 200 among them means the endpoint does work and
  // the flow simply took a different branch.
  const serverError =
    expectedFamily === '2xx' && observedStatuses.every((s) => s >= 500);

  return {
    outcome: 'failed',
    serverError,
    detail: `Expected ${method} ${expectedPattern} to return ${expectedFamily}, but observed status ${observed}`,
  };
}

/**
 * Verify a whole assertion list. Returns only the FAILURES, so an empty array
 * means "nothing contradicted". `unverifiable` entries are deliberately dropped:
 * they carry no signal and must not be reported as problems.
 */
export function findNetworkAssertionFailures(
  assertions: TestAssertion[],
  calls: RecordedCall[],
): NetworkAssertionResult[] {
  return assertions
    .filter((a) => a.type === 'network')
    .map((a) => matchNetworkAssertion(a, calls))
    .filter((r) => r.outcome === 'failed');
}
