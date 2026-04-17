/**
 * network-assertions tests.
 *
 * Covers:
 *   - Capture shape (url pattern, status, relative timestamp)
 *   - Round-based attribution of calls to the last interactive step
 *   - Tail-call attribution (async work after the final action)
 *   - Dedup across methods / patterns / status families
 *   - Assertion formatting + hard cap
 *   - Filters: 3xx/4xx/5xx, OPTIONS/HEAD, static assets
 */

import {
  attributeCallsToSteps,
  buildAssertionsFromSteps,
  buildCapturedApiCall,
  dedupeCalls,
} from '../network-assertions';
import type { DiscoveredStep, CapturedApiCall } from '../types';
import type { NetworkSuccess } from '../../lite-types';
import type { ExecutionRound } from '../../pipeline/types';

function ns(overrides: Partial<NetworkSuccess>): NetworkSuccess {
  return {
    url: 'https://api.example.com/v1/resource',
    method: 'GET',
    status: 200,
    timestamp: Date.now(),
    resourceType: 'fetch',
    ...overrides,
  };
}

function step(overrides: Partial<DiscoveredStep> & { stepNumber: number }): DiscoveredStep {
  return {
    description: `step ${overrides.stepNumber}`,
    action: 'click',
    pageUrl: 'https://app.example.com',
    ...overrides,
  };
}

function round(overrides: Partial<ExecutionRound> & { roundNumber: number }): ExecutionRound {
  return {
    commands: [],
    pageSnapshotBefore: '',
    durationMs: 1000,
    ...overrides,
  };
}

describe('buildCapturedApiCall', () => {
  it('normalizes URL to a stable pattern and drops query string', () => {
    const cap = buildCapturedApiCall(
      ns({ url: 'https://api.example.com/users/42?foo=bar', method: 'get', status: 200, timestamp: 1_000 }),
      500,
    );
    expect(cap.urlPattern).toBe('https://api.example.com/users/:id');
    expect(cap.method).toBe('GET'); // uppercased
    expect(cap.status).toBe(200);
    expect(cap.timestampMs).toBe(500); // relative to flowStart=500
  });

  it('clamps negative relative timestamps (edge case: clock skew)', () => {
    const cap = buildCapturedApiCall(ns({ timestamp: 100 }), 500);
    expect(cap.timestampMs).toBe(0);
  });

  it('defaults method to GET when missing', () => {
    const cap = buildCapturedApiCall(ns({ method: '' as any }), 0);
    expect(cap.method).toBe('GET');
  });
});

describe('attributeCallsToSteps — round bucketing', () => {
  it('attaches a call to the last interactive step of the round it falls in', () => {
    const steps = [step({ stepNumber: 1 }), step({ stepNumber: 2 }), step({ stepNumber: 3 })];
    const rounds = [round({ roundNumber: 1, durationMs: 500 }), round({ roundNumber: 2, durationMs: 500 })];
    const calls = [
      // First call inside round 0 (ms 0..500). Must attach to step index 1 (last in round 0).
      ns({ url: 'https://api.example.com/v1/login', method: 'POST', timestamp: 1_200 }),
      // Second call inside round 1 (ms 500..1000). Must attach to step index 2.
      ns({ url: 'https://api.example.com/v1/profile', method: 'GET', timestamp: 1_700 }),
    ];
    const flowStart = 1_000;

    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [1, 2], // round 0 → last step idx 1, round 1 → last step idx 2
      rounds,
      flowStartTime: flowStart,
      successfulCalls: calls,
    });

    expect(result[0].networkCalls).toBeUndefined();
    expect(result[1].networkCalls?.map((c) => c.urlPattern)).toEqual([
      'https://api.example.com/v1/login',
    ]);
    expect(result[2].networkCalls?.map((c) => c.urlPattern)).toEqual([
      'https://api.example.com/v1/profile',
    ]);
  });

  it('attributes tail traffic (after last round) to the final step', () => {
    const steps = [step({ stepNumber: 1 })];
    const rounds = [round({ roundNumber: 1, durationMs: 200 })];
    const calls = [
      // Call arrives 500ms after the final round's boundary (ms 200).
      ns({ url: 'https://api.example.com/v1/async', method: 'POST', timestamp: 700 }),
    ];

    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [0],
      rounds,
      flowStartTime: 0,
      successfulCalls: calls,
    });
    expect(result[0].networkCalls).toHaveLength(1);
  });

  it('falls back to last step when a round has no interactive step', () => {
    const steps = [step({ stepNumber: 1 })]; // only one emitted — the second round was pure observe
    const rounds = [
      round({ roundNumber: 1, durationMs: 100 }),
      round({ roundNumber: 2, durationMs: 100 }),
    ];
    const calls = [
      ns({ url: 'https://api.example.com/ping', timestamp: 150 }), // inside round 2
    ];
    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [0, null],
      rounds,
      flowStartTime: 0,
      successfulCalls: calls,
    });
    // The observe-only round has null — fall back to last step.
    expect(result[0].networkCalls).toHaveLength(1);
  });

  it('filters OPTIONS/HEAD preflights', () => {
    const steps = [step({ stepNumber: 1 })];
    const rounds = [round({ roundNumber: 1, durationMs: 100 })];
    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [0],
      rounds,
      flowStartTime: 0,
      successfulCalls: [
        ns({ method: 'OPTIONS', timestamp: 50 }),
        ns({ method: 'HEAD', timestamp: 60 }),
      ],
    });
    expect(result[0].networkCalls).toBeUndefined();
  });

  it('filters static-asset URLs that slipped through', () => {
    const steps = [step({ stepNumber: 1 })];
    const rounds = [round({ roundNumber: 1, durationMs: 100 })];
    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [0],
      rounds,
      flowStartTime: 0,
      successfulCalls: [
        ns({ url: 'https://cdn.example.com/app.js', timestamp: 50 }),
        ns({ url: 'https://cdn.example.com/logo.png?v=2', timestamp: 60 }),
      ],
    });
    expect(result[0].networkCalls).toBeUndefined();
  });

  it('drops non-2xx/3xx responses', () => {
    const steps = [step({ stepNumber: 1 })];
    const rounds = [round({ roundNumber: 1, durationMs: 100 })];
    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [0],
      rounds,
      flowStartTime: 0,
      successfulCalls: [
        ns({ status: 404, timestamp: 50 }),
        ns({ status: 500, timestamp: 60 }),
      ],
    });
    expect(result[0].networkCalls).toBeUndefined();
  });

  it('returns steps unchanged when there are no calls', () => {
    const steps = [step({ stepNumber: 1 })];
    const result = attributeCallsToSteps({
      steps,
      stepsByRound: [0],
      rounds: [round({ roundNumber: 1 })],
      flowStartTime: 0,
      successfulCalls: [],
    });
    expect(result).toEqual(steps);
  });

  it('handles empty steps without crashing', () => {
    const result = attributeCallsToSteps({
      steps: [],
      stepsByRound: [],
      rounds: [],
      flowStartTime: 0,
      successfulCalls: [ns({})],
    });
    expect(result).toEqual([]);
  });
});

describe('dedupeCalls', () => {
  it('collapses repeated calls with same method+pattern+status family', () => {
    const calls: CapturedApiCall[] = [
      { method: 'GET', urlPattern: 'https://api.example.com/items', status: 200, timestampMs: 100 },
      { method: 'GET', urlPattern: 'https://api.example.com/items', status: 204, timestampMs: 500 }, // same 2xx family
      { method: 'GET', urlPattern: 'https://api.example.com/items', status: 200, timestampMs: 900 },
    ];
    const deduped = dedupeCalls(calls);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].timestampMs).toBe(100); // earliest sample kept
  });

  it('keeps distinct methods separate', () => {
    const deduped = dedupeCalls([
      { method: 'GET', urlPattern: '/x', status: 200, timestampMs: 0 },
      { method: 'POST', urlPattern: '/x', status: 200, timestampMs: 1 },
    ]);
    expect(deduped).toHaveLength(2);
  });

  it('keeps distinct status families separate', () => {
    const deduped = dedupeCalls([
      { method: 'GET', urlPattern: '/x', status: 200, timestampMs: 0 },
      { method: 'GET', urlPattern: '/x', status: 304, timestampMs: 1 },
    ]);
    expect(deduped).toHaveLength(2);
  });
});

describe('buildAssertionsFromSteps', () => {
  it('emits one assertion per unique call, formatted with status family', () => {
    const steps: DiscoveredStep[] = [
      step({
        stepNumber: 1,
        networkCalls: [
          { method: 'POST', urlPattern: 'https://api.example.com/auth', status: 200, timestampMs: 10 },
          { method: 'GET', urlPattern: 'https://api.example.com/profile', status: 200, timestampMs: 20 },
        ],
      }),
    ];
    const asserts = buildAssertionsFromSteps(steps);
    expect(asserts.map((a) => a.expect)).toEqual([
      'POST https://api.example.com/auth returns 2xx',
      'GET https://api.example.com/profile returns 2xx',
    ]);
    expect(asserts.every((a) => a.type === 'network')).toBe(true);
  });

  it('caps output at 8 assertions even if more unique calls are present', () => {
    const manyCalls: CapturedApiCall[] = Array.from({ length: 20 }, (_, i) => ({
      method: 'GET',
      urlPattern: `https://api.example.com/resource-${i}`,
      status: 200,
      timestampMs: i,
    }));
    const asserts = buildAssertionsFromSteps([step({ stepNumber: 1, networkCalls: manyCalls })]);
    expect(asserts).toHaveLength(8);
  });

  it('returns [] when no steps carry network calls', () => {
    expect(buildAssertionsFromSteps([step({ stepNumber: 1 })])).toEqual([]);
  });

  it('aggregates calls spread across multiple steps with dedup', () => {
    const steps: DiscoveredStep[] = [
      step({
        stepNumber: 1,
        networkCalls: [{ method: 'GET', urlPattern: '/a', status: 200, timestampMs: 10 }],
      }),
      step({
        stepNumber: 2,
        networkCalls: [{ method: 'GET', urlPattern: '/a', status: 200, timestampMs: 100 }],
      }),
    ];
    const asserts = buildAssertionsFromSteps(steps);
    expect(asserts).toHaveLength(1);
  });
});
