/**
 * The cross-flow learnings block. The rule under test is which section
 * SURVIVES the char cap — a Planner that loses the blocker list walks straight
 * back into a dead end another flow already paid for.
 */

import {
  buildPriorLearnings,
  PRIOR_LEARNINGS_MAX_CHARS,
  PRIOR_LEARNINGS_MAX_ACCOMPLISHMENTS,
} from '../prior-learnings';

const input = (over: Partial<Parameters<typeof buildPriorLearnings>[0]> = {}) => ({
  blockersByCategory: {},
  accomplishments: [],
  maxFocusAreas: 5,
  ...over,
});

describe('buildPriorLearnings', () => {
  it('returns undefined for the first flow — nothing has been learned yet', () => {
    expect(buildPriorLearnings(input())).toBeUndefined();
  });

  it('renders what earlier flows tried', () => {
    const text = buildPriorLearnings(input({ accomplishments: ['Sign in (auth) — done'] }));
    expect(text).toBe('What earlier flows already tried: Sign in (auth) — done');
  });

  it('does not claim every entry succeeded — failures ride the same list', () => {
    const text = buildPriorLearnings(input({ accomplishments: ['Checkout (commerce) — failed'] }))!;
    expect(text).not.toMatch(/already done/i);
    expect(text).toContain('— failed');
  });

  it('renders blockers per category', () => {
    const text = buildPriorLearnings(input({ blockersByCategory: { auth: 'hCaptcha' } }));
    expect(text).toBe('Blockers other flows hit: auth: hCaptcha');
  });

  it('puts blockers FIRST — they are what a Planner can least afford to lose', () => {
    const text = buildPriorLearnings(
      input({
        blockersByCategory: { auth: 'hCaptcha' },
        accomplishments: ['Browse (content) — done'],
        focusAreas: ['checkout'],
      }),
    )!;
    const lines = text.split('\n');
    expect(lines[0]).toContain('Blockers');
    expect(lines[1]).toContain('Strategy focus');
    expect(lines[2]).toContain('already tried');
  });

  it('keeps only the most recent accomplishments', () => {
    const many = Array.from({ length: 12 }, (_, i) => `F${i}`);
    const text = buildPriorLearnings(input({ accomplishments: many }))!;
    expect(text).toContain('F11');
    expect(text).not.toContain('F0;');
    expect(text.split('; ')).toHaveLength(PRIOR_LEARNINGS_MAX_ACCOMPLISHMENTS);
  });

  describe('the char cap', () => {
    // Sized to genuinely overflow: 5 × ~120 chars is already past the 500 cap
    // on its own, so the cap has to make a real choice.
    const longWins = Array.from(
      { length: 5 },
      (_, i) =>
        `A very long flow name that pads this particular entry out well past any reasonable length number ${i} (cat${i}) — done`,
    );

    it('drops the least important section instead of truncating mid-sentence', () => {
      const text = buildPriorLearnings(
        input({ blockersByCategory: { commerce: 'PAYMENT WALL' }, accomplishments: longWins }),
      )!;

      expect(text.length).toBeLessThanOrEqual(PRIOR_LEARNINGS_MAX_CHARS);
      // The blocker survives; the bulky "already tried" section is what goes.
      expect(text).toContain('PAYMENT WALL');
      expect(text).not.toContain('already tried');
    });

    it('never emits a partial line', () => {
      const text = buildPriorLearnings(
        input({ blockersByCategory: { a: 'x'.repeat(200) }, accomplishments: longWins }),
      )!;
      for (const line of text.split('\n')) {
        expect(line).toMatch(/^(Blockers other flows hit|Strategy focus|What earlier flows already tried):/);
      }
    });

    it('still caps a single oversized section', () => {
      const text = buildPriorLearnings(input({ blockersByCategory: { a: 'y'.repeat(900) } }))!;
      expect(text).toHaveLength(PRIOR_LEARNINGS_MAX_CHARS);
    });
  });
});
