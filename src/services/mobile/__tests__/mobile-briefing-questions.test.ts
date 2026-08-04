/**
 * Which questions a mobile exploration asks before it starts.
 *
 * Mobile ASKS where web DERIVES: an appId has no landing page to read, and an
 * APK manifest carries permissions and activity names — technical data that
 * cannot say what the business does or whether this build touches production.
 *
 * So the tests are mostly about RESTRAINT — what must NOT be asked — plus the
 * safety rule that survives everything else.
 */

import {
  planMobileBriefingQuestions,
  applyMobileBriefingAnswers,
  MAX_MOBILE_BRIEFING_QUESTIONS,
} from '../mobile-briefing-questions';

const keys = (b?: any, goal?: string) => planMobileBriefingQuestions(b, goal).map((q) => q.key);

describe('restraint — zero questions is the target outcome', () => {
  it('asks nothing when the user already supplied a full briefing', () => {
    expect(keys({
      description: 'A grocery delivery app',
      avoid: ['do not place real orders'],
      keyFlows: ['checkout'],
      dataHints: 'phone must be local format',
    })).toEqual([]);
  });

  it('never asks more than the cap', () => {
    expect(planMobileBriefingQuestions(undefined).length).toBeLessThanOrEqual(MAX_MOBILE_BRIEFING_QUESTIONS);
  });

  it('does not re-ask a field the user already answered', () => {
    expect(keys({ avoid: ['no payments'] })).not.toContain('avoid');
    expect(keys({ description: 'A shop' })).not.toContain('description');
  });

  it('does not ask about flows when the goal already names them', () => {
    // The user said it once when starting the run; asking again reads as not
    // having listened.
    expect(keys(undefined, 'test checkout and sign-up')).not.toContain('keyFlows');
  });

  it('treats a region as answering the data-format question', () => {
    // `region` already tells the FormFiller which local formats to generate.
    expect(keys({ region: 'KZ' })).not.toContain('dataHints');
  });
});

describe('safety pre-empt', () => {
  it('asks what to avoid FIRST when nothing is known', () => {
    // A mobile agent taps a REAL app on a REAL device — it can place an order
    // or delete an account for real.
    expect(planMobileBriefingQuestions(undefined)[0].key).toBe('avoid');
  });

  it('offers concrete choices rather than free text', () => {
    const q = planMobileBriefingQuestions(undefined).find((x) => x.key === 'avoid');
    expect(q?.options?.length).toBeGreaterThan(1);
  });
});

describe('applyMobileBriefingAnswers', () => {
  it('maps a chosen prohibition to a concrete rule', () => {
    const b = applyMobileBriefingAnswers(undefined, [
      { key: 'avoid', answer: 'Do not complete payments or transfers' },
    ]);
    expect(b.avoid).toEqual(['complete payments or transfers']);
  });

  it('records "nothing" as an explicit grant, so it is not re-asked', () => {
    // An empty `avoid` would look like an unanswered question forever.
    const b = applyMobileBriefingAnswers(undefined, [
      { key: 'avoid', answer: 'Nothing — it is a test build with fake data' },
    ]);
    expect(b.avoid?.length).toBe(1);
    expect(keys(b)).not.toContain('avoid');
  });

  it('keeps an unrecognised prohibition verbatim rather than dropping it', () => {
    const b = applyMobileBriefingAnswers(undefined, [
      { key: 'avoid', answer: 'never call the pharmacy hotline' },
    ]);
    expect(b.avoid).toEqual(['never call the pharmacy hotline']);
  });

  it('parses a free-text flow list', () => {
    const b = applyMobileBriefingAnswers(undefined, [
      { key: 'keyFlows', answer: '1. Sign up; 2. Checkout; 3. Track order' },
    ]);
    expect(b.keyFlows).toEqual(['Sign up', 'Checkout', 'Track order']);
  });

  it('leaves a skipped answer absent so a later run can ask again', () => {
    const b = applyMobileBriefingAnswers(undefined, [{ key: 'description', answer: null }]);
    expect(b.description).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const before = { description: 'x' };
    const snapshot = JSON.stringify(before);
    applyMobileBriefingAnswers(before, [{ key: 'keyFlows', answer: 'a' }]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('never throws on malformed input', () => {
    expect(() => applyMobileBriefingAnswers(undefined, [{ key: 'nope', answer: 'x' }])).not.toThrow();
    expect(() => planMobileBriefingQuestions({} as any)).not.toThrow();
  });
});
