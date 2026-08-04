/**
 * Network assertion matching.
 *
 * The governing rule is **prefer a false GREEN over a false RED**: these
 * assertions are authored autonomously by exploration, nobody reviews them, and
 * they land in the user's project. A check that fires spuriously turns a whole
 * discovered suite into triage noise — worse than occasionally missing a
 * regression. Most of these tests exist to pin that asymmetry.
 */

import { matchNetworkAssertion, findNetworkAssertionFailures } from '../network-assertion-matcher';
import type { RecordedCall } from '../network-call-recorder';
import type { TestAssertion } from '@/agent/core/lite/exploration/types';

const call = (method: string, url: string, status: number, timestamp = 1000): RecordedCall => ({
  method,
  url,
  status,
  timestamp,
});

const netAssertion = (
  method: string,
  urlPattern: string,
  status?: number,
): TestAssertion => ({
  type: 'network',
  expect: `${method} ${urlPattern} returns ${status ?? 'a response'}`,
  source: { method, urlPattern, status },
});

describe('matchNetworkAssertion', () => {
  it('passes when the expected call happened with a matching status family', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/auth', 200),
      [call('POST', 'https://acme.com/api/auth', 200)],
    );

    expect(result.outcome).toBe('passed');
  });

  it('fails when the expected call never happened', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/auth', 200),
      [call('GET', 'https://acme.com/api/products', 200)],
    );

    expect(result.outcome).toBe('failed');
    expect(result.detail).toMatch(/no matching request was observed/i);
  });

  // ── The false-RED guards ──

  it('does NOT fail when the status drifts within the same family (200 -> 204)', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/items', 200),
      [call('POST', 'https://acme.com/api/items', 204)],
    );

    expect(result.outcome).toBe('passed');
  });

  it('does NOT fail when a path id differs between runs', () => {
    // Authored against /orders/123, replayed against /orders/999. Both normalize
    // to /orders/:id, so a per-run id must not turn the test red.
    const authored = netAssertion('GET', 'https://acme.com/orders/:id', 200);
    const result = matchNetworkAssertion(authored, [
      call('GET', 'https://acme.com/orders/999', 200),
    ]);

    expect(result.outcome).toBe('passed');
  });

  it('ignores query strings, which vary per run', () => {
    const result = matchNetworkAssertion(
      netAssertion('GET', 'https://acme.com/api/search', 200),
      [call('GET', 'https://acme.com/api/search?q=laptop&ts=1720000000', 200)],
    );

    expect(result.outcome).toBe('passed');
  });

  it('treats a missing source as UNVERIFIABLE, never as failed', () => {
    // `expect` is prose for humans; guessing a predicate from it would be
    // invention, and inventing a failing check is the worst outcome.
    const vague: TestAssertion = { type: 'network', expect: 'the login API works' };

    expect(matchNetworkAssertion(vague, []).outcome).toBe('unverifiable');
  });

  it('treats a source without a urlPattern as unverifiable', () => {
    const partial: TestAssertion = {
      type: 'network',
      expect: 'POST returns 2xx',
      source: { method: 'POST', status: 200 },
    };

    expect(matchNetworkAssertion(partial, []).outcome).toBe('unverifiable');
  });

  it('passes on mere occurrence when no status was recorded', () => {
    const noStatus = netAssertion('POST', 'https://acme.com/api/track');
    delete (noStatus.source as { status?: number }).status;

    const result = matchNetworkAssertion(noStatus, [call('POST', 'https://acme.com/api/track', 500)]);

    // No expected status → the call happening IS the assertion. Asserting a
    // status we never captured would be inventing an expectation.
    expect(result.outcome).toBe('passed');
  });

  it('rejects a non-network assertion as unverifiable rather than failing it', () => {
    const textAssertion: TestAssertion = { type: 'url', expect: 'url contains /dashboard' };

    expect(matchNetworkAssertion(textAssertion, []).outcome).toBe('unverifiable');
  });

  // ── Genuine regressions it SHOULD catch ──

  it('fails when the endpoint returns a server error instead of success', () => {
    // The whole point: a UI that still renders while its API is broken.
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/checkout', 200),
      [call('POST', 'https://acme.com/api/checkout', 500)],
    );

    expect(result.outcome).toBe('failed');
    expect(result.detail).toMatch(/observed status 500/);
  });

  it('fails when the endpoint starts rejecting with 4xx', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/auth', 200),
      [call('POST', 'https://acme.com/api/auth', 403)],
    );

    expect(result.outcome).toBe('failed');
  });

  it('matches the right call when several endpoints were hit', () => {
    const calls = [
      call('GET', 'https://acme.com/api/me', 200),
      call('POST', 'https://acme.com/api/checkout', 500),
      call('GET', 'https://acme.com/api/cart', 200),
    ];

    expect(matchNetworkAssertion(netAssertion('POST', 'https://acme.com/api/checkout', 200), calls).outcome)
      .toBe('failed');
    expect(matchNetworkAssertion(netAssertion('GET', 'https://acme.com/api/cart', 200), calls).outcome)
      .toBe('passed');
  });

  it('passes when the endpoint was called twice and at least one succeeded', () => {
    // A retried request whose second attempt worked is not a regression.
    const calls = [
      call('POST', 'https://acme.com/api/save', 429),
      call('POST', 'https://acme.com/api/save', 200),
    ];

    expect(matchNetworkAssertion(netAssertion('POST', 'https://acme.com/api/save', 200), calls).outcome)
      .toBe('passed');
  });

  it('distinguishes methods on the same path', () => {
    const calls = [call('GET', 'https://acme.com/api/items', 200)];

    expect(matchNetworkAssertion(netAssertion('DELETE', 'https://acme.com/api/items', 200), calls).outcome)
      .toBe('failed');
  });

  it('is case-insensitive on the method', () => {
    const assertion = netAssertion('post', 'https://acme.com/api/auth', 200);
    const result = matchNetworkAssertion(assertion, [call('POST', 'https://acme.com/api/auth', 200)]);

    expect(result.outcome).toBe('passed');
  });

  it('does not cross origins', () => {
    // The pattern includes the origin, so a same-path call on another host is
    // not the asserted endpoint.
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/auth', 200),
      [call('POST', 'https://evil.example.com/api/auth', 200)],
    );

    expect(result.outcome).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// serverError flag — the ONLY mismatch replay treats as fatal (policy "c")
// ═══════════════════════════════════════════════════════════════════════════

describe('serverError flag', () => {
  it('is set when 2xx was expected and only 5xx was observed', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/checkout', 200),
      [call('POST', 'https://acme.com/api/checkout', 500)],
    );

    expect(result.outcome).toBe('failed');
    expect(result.serverError).toBe(true);
  });

  it('is set for 502/503 too', () => {
    for (const status of [502, 503, 504]) {
      const result = matchNetworkAssertion(
        netAssertion('GET', 'https://acme.com/api/x', 200),
        [call('GET', 'https://acme.com/api/x', status)],
      );
      expect(result.serverError).toBe(true);
    }
  });

  it('is NOT set for a 4xx — validation changes are explainable, not an outage', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/auth', 200),
      [call('POST', 'https://acme.com/api/auth', 403)],
    );

    expect(result.outcome).toBe('failed');
    expect(result.serverError).toBeFalsy();
  });

  it('is NOT set when the call is simply absent — the flow may have branched', () => {
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/checkout', 200),
      [],
    );

    expect(result.outcome).toBe('failed');
    expect(result.serverError).toBeFalsy();
  });

  it('is NOT set when at least one call succeeded alongside a 5xx', () => {
    // A retried request whose second attempt worked proves the endpoint works.
    const result = matchNetworkAssertion(
      netAssertion('POST', 'https://acme.com/api/save', 200),
      [call('POST', 'https://acme.com/api/save', 500), call('POST', 'https://acme.com/api/save', 200)],
    );

    // Passes outright — a success is present.
    expect(result.outcome).toBe('passed');
  });

  it('is NOT set when a 5xx appears but 2xx was never the expectation', () => {
    // Discovery itself recorded a 5xx; the endpoint returning 5xx again is not
    // a regression against that baseline.
    const result = matchNetworkAssertion(
      netAssertion('GET', 'https://acme.com/api/flaky', 503),
      [call('GET', 'https://acme.com/api/flaky', 404)],
    );

    expect(result.outcome).toBe('failed');
    expect(result.serverError).toBeFalsy();
  });
});

describe('findNetworkAssertionFailures', () => {
  it('returns only failures, never unverifiable entries', () => {
    const assertions: TestAssertion[] = [
      netAssertion('GET', 'https://acme.com/api/ok', 200),
      netAssertion('POST', 'https://acme.com/api/broken', 200),
      { type: 'network', expect: 'something vague' },
      { type: 'console', expect: 'no console errors' },
    ];
    const calls = [
      call('GET', 'https://acme.com/api/ok', 200),
      call('POST', 'https://acme.com/api/broken', 500),
    ];

    const failures = findNetworkAssertionFailures(assertions, calls);

    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toMatch(/api\/broken/);
  });

  it('returns an empty array when nothing contradicts', () => {
    expect(findNetworkAssertionFailures([], [])).toEqual([]);
  });

  it('does not fail a run whose assertions are all unverifiable', () => {
    const assertions: TestAssertion[] = [{ type: 'network', expect: 'vague' }];

    expect(findNetworkAssertionFailures(assertions, [])).toEqual([]);
  });
});
