/**
 * normalizeMobileBriefing — the safety gate for client-supplied app briefings.
 * The load-bearing test: a credential-ish payload can NEVER survive into the
 * briefing blob (credentials ride the runner's answer/redaction seam). Also
 * pins the shape normalization + caps.
 */
import { normalizeMobileBriefing } from '../mobile-briefing.util';

describe('normalizeMobileBriefing', () => {
  it('keeps only the safe fields (incl. dataHints + successCriteria)', () => {
    const out = normalizeMobileBriefing({
      description: 'A banking app',
      region: 'Germany',
      keyFlows: ['transfer money', 'add payee'],
      avoid: ['send a real transfer'],
      dataHints: 'IBAN = 22 chars',
      successCriteria: ['a confirmation screen appears'],
    });
    expect(out).toEqual({
      description: 'A banking app',
      region: 'Germany',
      keyFlows: ['transfer money', 'add payee'],
      avoid: ['send a real transfer'],
      dataHints: 'IBAN = 22 chars',
      successCriteria: ['a confirmation screen appears'],
    });
  });

  it('STRIPS credential-ish fields — no plaintext-credential sink [security]', () => {
    const out = normalizeMobileBriefing({
      description: 'app',
      password: 'hunter2',
      token: 'eyJhbGc.abc.def',
      username: 'admin',
      testCredentials: { user: 'a', pass: 'b' },
      apiKey: 'sk-123',
    });
    expect(out).toEqual({ description: 'app' }); // everything else dropped
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('eyJhbGc');
    expect(blob).not.toContain('admin');
    expect(blob).not.toContain('sk-123');
  });

  it('returns undefined for junk / empty input', () => {
    expect(normalizeMobileBriefing(undefined)).toBeUndefined();
    expect(normalizeMobileBriefing(null)).toBeUndefined();
    expect(normalizeMobileBriefing('a string')).toBeUndefined();
    expect(normalizeMobileBriefing({})).toBeUndefined();
    expect(normalizeMobileBriefing({ description: '   ' })).toBeUndefined();
    expect(normalizeMobileBriefing({ keyFlows: [] })).toBeUndefined();
  });

  it('trims + caps strings and arrays; drops non-string array items', () => {
    const out = normalizeMobileBriefing({
      description: '  x  ',
      keyFlows: ['  flow one  ', 42, null, 'flow two', ''],
      avoid: Array.from({ length: 30 }, (_, i) => `a${i}`),
    });
    expect(out?.description).toBe('x');
    expect(out?.keyFlows).toEqual(['flow one', 'flow two']); // trimmed, non-strings dropped
    expect(out?.avoid?.length).toBe(20); // capped at 20
  });

  it('caps description length at 2000 chars', () => {
    const out = normalizeMobileBriefing({ description: 'z'.repeat(5000) });
    expect(out?.description?.length).toBe(2000);
  });
});
