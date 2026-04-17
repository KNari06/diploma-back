/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NETWORK ASSERTIONS — turn captured XHR/fetch calls into test expectations
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exploration piggybacks on NetworkTracker, which already records every
 * successful API call triggered during a flow. The Autonomous Web Explorer
 * design treats each of those calls as free test material:
 *
 *   After "User Login" succeeded:
 *     POST /api/auth  → 200   becomes  assertion: "POST /api/auth returns 2xx"
 *
 * This module is the glue. It:
 *   1. Normalizes captured NetworkSuccess records into stable CapturedApiCall
 *      shapes (url patterns instead of concrete urls so the assertion survives
 *      id changes between runs).
 *   2. Attributes calls to rounds using a monotonic round timeline — no need
 *      for per-command start times.
 *   3. Deduplicates calls that are effectively the same assertion
 *      (same method + pattern + status family) so a polling endpoint does
 *      not produce 30 identical assertions.
 *   4. Produces the final test-case-level TestAssertion[] list, capped so a
 *      single flow cannot drown the output.
 */

import type { NetworkSuccess } from '../lite-types';
import type { ExecutionRound } from '../pipeline/types';
import type { CapturedApiCall, DiscoveredStep, TestAssertion } from './types';
import { normalizeUrlWithPattern } from './url-pattern';

/**
 * Cap on assertions emitted per test case. A chatty dashboard can trigger
 * dozens of similar calls on load; we dedup first but also want a hard
 * ceiling so the output stays reviewable.
 */
const MAX_ASSERTIONS_PER_TEST_CASE = 8;

/**
 * Status bucketing used in assertion text ("2xx", "3xx", ...). Keeps
 * assertions stable when the server legitimately alternates between e.g.
 * 200 and 204.
 */
function statusFamily(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Is this a call worth asserting on? Drops preflight/analytics-ish things
 * that sneak past NetworkTracker's own filters (some apps proxy analytics
 * through their own origin).
 */
function isAssertable(call: NetworkSuccess): boolean {
  if (call.status < 200 || call.status >= 400) return false;
  const method = (call.method || '').toUpperCase();
  if (method === 'OPTIONS' || method === 'HEAD') return false;
  // Static-asset-ish paths — rare for xhr/fetch but guard anyway.
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i.test(call.url)) return false;
  return true;
}

/**
 * Build the CapturedApiCall projection from a raw NetworkSuccess. URL is
 * parameterized so assertions are stable across runs (otherwise every run
 * produces different numeric-id strings).
 */
export function buildCapturedApiCall(
  call: NetworkSuccess,
  flowStartTime: number,
): CapturedApiCall {
  return {
    method: (call.method || 'GET').toUpperCase(),
    urlPattern: normalizeUrlWithPattern(call.url),
    status: call.status,
    timestampMs: Math.max(0, call.timestamp - flowStartTime),
  };
}

/**
 * Attribute successful API calls to the interactive step that most likely
 * triggered them, using the round timeline. We treat each round as a
 * half-open time bucket [roundStart, nextRoundStart); any call whose
 * absolute timestamp falls in that bucket is attached to the last
 * interactive step of that round.
 *
 * `stepsByRound` maps round index (0-based) to the *final* DiscoveredStep
 * index within that round (or null if the round emitted no interactive
 * step). Steps outside any round bucket (trailing tail after the last
 * round) are attached to the very last step so they are not lost.
 */
export function attributeCallsToSteps(params: {
  steps: DiscoveredStep[];
  stepsByRound: Array<number | null>;
  rounds: ExecutionRound[];
  flowStartTime: number;
  successfulCalls: NetworkSuccess[];
}): DiscoveredStep[] {
  const { steps, stepsByRound, rounds, flowStartTime, successfulCalls } = params;
  if (steps.length === 0) return steps;

  // Build cumulative round boundaries in absolute ms.
  // Round i covers [flowStartTime + sumDurationsBefore(i),
  //                 flowStartTime + sumDurationsUpTo(i))
  const roundStartsAbsolute: number[] = [flowStartTime];
  for (const round of rounds) {
    const last = roundStartsAbsolute[roundStartsAbsolute.length - 1];
    roundStartsAbsolute.push(last + (round.durationMs || 0));
  }

  const attached: Array<CapturedApiCall[]> = steps.map(() => []);
  const lastStepIndex = steps.length - 1;

  for (const raw of successfulCalls) {
    if (!isAssertable(raw)) continue;
    const cap = buildCapturedApiCall(raw, flowStartTime);

    // Locate the round this call fell into.
    let roundIdx = rounds.length - 1;
    for (let i = 0; i < rounds.length; i++) {
      if (raw.timestamp < roundStartsAbsolute[i + 1]) {
        roundIdx = i;
        break;
      }
    }

    // Map back to the step that ended the round, falling back to the last
    // step in the flow for tail traffic (async work after the final action).
    const stepIdxForRound = stepsByRound[roundIdx];
    const targetIdx = stepIdxForRound ?? lastStepIndex;
    if (targetIdx >= 0 && targetIdx < attached.length) {
      attached[targetIdx].push(cap);
    }
  }

  return steps.map((step, i) => {
    if (attached[i].length === 0) return step;
    return { ...step, networkCalls: attached[i] };
  });
}

/**
 * Collapse a list of captured calls to one entry per unique
 * method+pattern+status-family tuple. A polling loop produces hundreds of
 * identical GETs — we only want one assertion for it. Keeps the earliest
 * sample so `timestampMs` still carries meaningful ordering.
 */
export function dedupeCalls(calls: CapturedApiCall[]): CapturedApiCall[] {
  const seen = new Map<string, CapturedApiCall>();
  for (const call of calls) {
    const key = `${call.method} ${call.urlPattern} ${statusFamily(call.status)}`;
    if (!seen.has(key)) seen.set(key, call);
  }
  return Array.from(seen.values()).sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * Build the test-case-level TestAssertion[] from the network calls attached
 * to a flow's steps. Deduplicates, caps output, and formats expectations
 * as stable "METHOD pattern returns Nxx" strings.
 */
export function buildAssertionsFromSteps(steps: DiscoveredStep[]): TestAssertion[] {
  const all: CapturedApiCall[] = [];
  for (const step of steps) {
    if (step.networkCalls?.length) all.push(...step.networkCalls);
  }
  if (all.length === 0) return [];

  const deduped = dedupeCalls(all);
  const capped = deduped.slice(0, MAX_ASSERTIONS_PER_TEST_CASE);

  return capped.map((call): TestAssertion => ({
    type: 'network',
    expect: `${call.method} ${call.urlPattern} returns ${statusFamily(call.status)}`,
    source: {
      method: call.method,
      urlPattern: call.urlPattern,
      status: call.status,
    },
  }));
}
