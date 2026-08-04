/**
 * `normalizeProductBrief` — the safety boundary for Phase 0.
 *
 * Input is untrusted by definition (an LLM response, a user edit, a persisted
 * blob), and the brief is threaded into FOUR agent prompts. So the guarantees
 * below are enforced in code, not in a prompt:
 *
 *   1. whitelist — an extra key cannot survive (no credential sink)
 *   2. fail-closed — payments/irreversible actions default to conservative
 *   3. evidence or it didn't happen — an unbacked claim is downgraded
 *   4. unknown beats a guess — a malformed field collapses, never fabricates
 */

import { normalizeProductBrief, briefHasSignal } from '../product-brief.util';

const ORIGIN = 'https://acme.com/';

describe('whitelist — the credential-sink guarantee', () => {
  it('drops any key that is not part of the schema', () => {
    const brief = normalizeProductBrief(
      {
        purpose: { value: 'A shop', source: 'observed', basis: 'meta' },
        password: 'hunter2',
        apiKey: 'sk-live-123',
        creditCard: '4242424242424242',
        nested: { token: 'abc' },
      },
      ORIGIN,
    );

    const serialized = JSON.stringify(brief);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-123');
    expect(serialized).not.toContain('4242');
    expect(serialized).not.toContain('token');
    expect(brief.purpose.value).toBe('A shop');
  });

  it('redacts a credential the analyst copied out of a docs page', () => {
    // `/docs` pages routinely print demo credentials verbatim, and this text is
    // LLM-facing (folder invariant #3).
    const brief = normalizeProductBrief(
      {
        purpose: { value: 'Log in with demo@acme.com / s3cret-pw', source: 'observed', basis: 'docs' },
        dataHints: { value: 'password is s3cret-pw', source: 'observed', basis: 'docs' },
      },
      ORIGIN,
      { email: 'demo@acme.com', password: 's3cret-pw' },
    );

    expect(brief.purpose.value).not.toContain('s3cret-pw');
    expect(brief.purpose.value).not.toContain('demo@acme.com');
    expect(brief.dataHints.value).not.toContain('s3cret-pw');
  });

  it('redacts inside array fields too', () => {
    const brief = normalizeProductBrief(
      {
        mustNeverTouch: { value: ['never email s3cret-pw to anyone'], source: 'user', basis: 'x' },
      },
      ORIGIN,
      { password: 's3cret-pw' },
    );

    expect(JSON.stringify(brief.mustNeverTouch.value)).not.toContain('s3cret-pw');
  });
});

describe('fail-closed safety', () => {
  it('defaults paymentPolicy to never when absent', () => {
    const brief = normalizeProductBrief({}, ORIGIN);
    expect(brief.paymentPolicy.value).toBe('never');
  });

  it('defaults paymentPolicy to never on an unrecognised value', () => {
    const brief = normalizeProductBrief(
      { paymentPolicy: { value: 'yolo_just_pay', source: 'inferred', basis: 'x' } },
      ORIGIN,
    );
    expect(brief.paymentPolicy.value).toBe('never');
  });

  it('honours an explicit sandbox grant from a USER', () => {
    const brief = normalizeProductBrief(
      { paymentPolicy: { value: 'allowed_sandbox', source: 'user', confidence: 'high', basis: 'user said so' } },
      ORIGIN,
    );
    expect(brief.paymentPolicy.value).toBe('allowed_sandbox');
  });

  it('DOWNGRADES a sandbox grant that did not come from a user', () => {
    // Only a human can authorise completing a real payment. An LLM that decided
    // a hostname "looked like staging" must not be able to place real orders —
    // and the analyst prompt forbidding it is not a guard.
    for (const source of ['inferred', 'observed', 'unknown']) {
      const brief = normalizeProductBrief(
        { paymentPolicy: { value: 'allowed_sandbox', source, confidence: 'high', basis: 'looks like staging' } },
        ORIGIN,
      );
      expect(brief.paymentPolicy.value).not.toBe('allowed_sandbox');
    }
  });

  it('forces stopBeforeCommit on an INFERRED critical flow', () => {
    // An irreversible action must never be attempted on a guess.
    const brief = normalizeProductBrief(
      {
        criticalFlows: {
          value: [{ name: 'Checkout', rank: 1, source: 'inferred', stopBeforeCommit: false }],
          source: 'inferred',
          basis: 'pricing page',
        },
      },
      ORIGIN,
    );

    expect(brief.criticalFlows.value[0].stopBeforeCommit).toBe(true);
  });

  it('lets a USER explicitly waive stopBeforeCommit', () => {
    const brief = normalizeProductBrief(
      {
        criticalFlows: {
          value: [{ name: 'Checkout', rank: 1, source: 'user', stopBeforeCommit: false }],
          source: 'user',
          basis: 'confirmed',
        },
      },
      ORIGIN,
    );

    expect(brief.criticalFlows.value[0].stopBeforeCommit).toBe(false);
  });

  it('defaults environmentKind to unknown, which is what gates payments', () => {
    const brief = normalizeProductBrief({}, ORIGIN);
    expect(brief.environmentKind.value).toBe('unknown');
    expect(brief.environmentKind.source).toBe('unknown');
  });
});

describe('evidence or it did not happen', () => {
  it('downgrades an observed claim with no basis to low confidence', () => {
    const brief = normalizeProductBrief(
      { purpose: { value: 'A bank', source: 'observed', confidence: 'high' } },
      ORIGIN,
    );

    expect(brief.purpose.confidence).toBe('low');
  });

  it('keeps high confidence when a basis is present', () => {
    const brief = normalizeProductBrief(
      { purpose: { value: 'A bank', source: 'observed', confidence: 'high', basis: 'JSON-LD BankOrCreditUnion' } },
      ORIGIN,
    );

    expect(brief.purpose.confidence).toBe('high');
  });

  it('does not downgrade a USER-supplied value that has no basis', () => {
    // The user IS the evidence.
    const brief = normalizeProductBrief(
      { region: { value: 'Kazakhstan', source: 'user', confidence: 'high' } },
      ORIGIN,
    );

    expect(brief.region.confidence).toBe('high');
  });
});

describe('unknown beats a guess', () => {
  it('returns an all-unknown brief for garbage input rather than undefined', () => {
    // One downstream path is better than two, and the UI can still render.
    for (const input of [null, undefined, 42, 'nope', [], true]) {
      const brief = normalizeProductBrief(input, ORIGIN);
      expect(brief.schemaVersion).toBe(1);
      expect(brief.purpose.source).toBe('unknown');
      expect(briefHasSignal(brief)).toBe(false);
    }
  });

  it('collapses a bare value (not wrapped in a BriefField) to unknown', () => {
    const brief = normalizeProductBrief({ purpose: 'a shop' }, ORIGIN);

    expect(brief.purpose.source).toBe('unknown');
    expect(brief.purpose.value).toBe('');
  });

  it('collapses an empty array field to unknown, not to an empty "answer"', () => {
    const brief = normalizeProductBrief(
      { roles: { value: [], source: 'observed', basis: 'nav' } },
      ORIGIN,
    );

    expect(brief.roles.source).toBe('unknown');
  });

  it('survives property ACCESS that throws — "never throws" is a contract', () => {
    // Not an LLM shape, but a rehydrated blob or a Proxy can do this, and this
    // function sits between untrusted input and four agent prompts. Found by
    // adversarially probing the normalizer, not by the happy-path tests.
    const evil: Record<string, unknown> = { purpose: {} };
    Object.defineProperty(evil.purpose as object, 'value', {
      get() { throw new Error('boom'); },
    });

    let brief!: ReturnType<typeof normalizeProductBrief>;
    expect(() => { brief = normalizeProductBrief(evil, ORIGIN); }).not.toThrow();
    expect(brief.schemaVersion).toBe(1);
    expect(brief.purpose.source).toBe('unknown');
    // The degraded brief must still be safe to consume.
    expect(brief.paymentPolicy.value).toBe('never');
  });

  it('does not let prototype-pollution keys through', () => {
    const brief = normalizeProductBrief(
      JSON.parse('{"__proto__":{"polluted":true},"purpose":{"value":"x","source":"user"}}'),
      ORIGIN,
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(brief.purpose.value).toBe('x');
  });

  it('does not mutate the caller\'s input', () => {
    const input = {
      purpose: { value: '  padded  ', source: 'user' },
      entities: { value: ['a'], source: 'user' },
    };
    const snapshot = JSON.stringify(input);

    normalizeProductBrief(input, ORIGIN);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('survives non-object items inside array fields', () => {
    expect(() =>
      normalizeProductBrief(
        {
          roles: { value: [null, 'x', 42, { name: 'seller' }], source: 'inferred', basis: 'nav' },
          criticalFlows: { value: [null, {}, { name: 'Checkout' }], source: 'inferred', basis: 'p' },
          glossary: { value: [{ term: 'run' }, { term: 'run', meaning: 'a test' }], source: 'inferred', basis: 'd' },
        },
        ORIGIN,
      ),
    ).not.toThrow();

    const brief = normalizeProductBrief(
      { roles: { value: [null, 42, { name: 'seller' }], source: 'inferred', basis: 'nav' } },
      ORIGIN,
    );
    expect(brief.roles.value).toEqual([{ name: 'seller', source: 'inferred' }]);
  });
});

describe('caps and ordering', () => {
  it('caps critical flows and sorts them by rank', () => {
    const flows = Array.from({ length: 12 }, (_, i) => ({
      name: `Flow ${i}`,
      rank: 12 - i,
      source: 'inferred',
    }));
    const brief = normalizeProductBrief(
      { criticalFlows: { value: flows, source: 'inferred', basis: 'x' } },
      ORIGIN,
    );

    expect(brief.criticalFlows.value).toHaveLength(6);
    const ranks = brief.criticalFlows.value.map((f) => f.rank);
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('caps the ask log at 3 — the product decision', () => {
    const brief = normalizeProductBrief(
      {
        purpose: { value: 'x', source: 'user' },
        askLog: [
          { key: 'a', answered: true }, { key: 'b', answered: false },
          { key: 'c', answered: true }, { key: 'd', answered: true },
        ],
      },
      ORIGIN,
    );

    expect(brief.askLog).toHaveLength(3);
  });

  it('truncates over-long strings instead of rejecting them', () => {
    const brief = normalizeProductBrief(
      { purpose: { value: 'x'.repeat(5000), source: 'observed', basis: 'b' } },
      ORIGIN,
    );

    expect(brief.purpose.value.length).toBe(2000);
  });

  it('assigns a fallback rank when one is missing or invalid', () => {
    const brief = normalizeProductBrief(
      {
        criticalFlows: {
          value: [{ name: 'A', source: 'inferred' }, { name: 'B', rank: -5, source: 'inferred' }],
          source: 'inferred',
          basis: 'x',
        },
      },
      ORIGIN,
    );

    expect(brief.criticalFlows.value.every((f) => f.rank > 0)).toBe(true);
  });
});

describe('provenance', () => {
  it('always stamps the origin the caller supplied, never one from the payload', () => {
    const brief = normalizeProductBrief({ originUrl: 'https://evil.example.com/' }, ORIGIN);
    expect(brief.originUrl).toBe(ORIGIN);
  });

  it('generates a timestamp when absent', () => {
    const brief = normalizeProductBrief({}, ORIGIN);
    expect(Date.parse(brief.generatedAt)).not.toBeNaN();
  });
});

describe('briefHasSignal', () => {
  it('is false for undefined and for an all-unknown brief', () => {
    expect(briefHasSignal(undefined)).toBe(false);
    expect(briefHasSignal(normalizeProductBrief({}, ORIGIN))).toBe(false);
  });

  it('is true once any consumer-relevant field is known', () => {
    const brief = normalizeProductBrief(
      { productType: { value: 'ecommerce', source: 'observed', basis: 'JSON-LD Product' } },
      ORIGIN,
    );
    expect(briefHasSignal(brief)).toBe(true);
  });
});
