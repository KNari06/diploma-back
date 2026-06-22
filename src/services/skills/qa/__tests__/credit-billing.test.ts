import {
  computeAuthoringExtraCredits,
  MAX_BILLABLE_AUTHORING_ROUNDS,
} from '../qa-tool-handlers';

/**
 * Billing math for iterative test authoring. This is real money — the function
 * must NEVER over-charge, under-charge, charge garbage, or go unbounded.
 *
 * Contract: total credits for a run = `roundsExecuted` on success.
 * The chat turn already deducts a base 1 on success, so this helper returns the
 * REMAINDER (`rounds - 1`). On failure the chat turn charges nothing, so this
 * returns 0 — total 0.
 */
describe('computeAuthoringExtraCredits', () => {
  describe('happy path — total equals rounds (base 1 + extra)', () => {
    it.each([
      [1, 0], // 1 round → base 1 covers it → 0 extra (total 1)
      [2, 1], // total 2
      [3, 2],
      [5, 4],
      [12, 11], // default max rounds → total 12
    ])('success with %i rounds → %i extra credits', (rounds, expected) => {
      expect(computeAuthoringExtraCredits(true, rounds)).toBe(expected);
    });

    it('total charged (base + extra) equals roundsExecuted', () => {
      for (const rounds of [1, 2, 7, 12]) {
        const extra = computeAuthoringExtraCredits(true, rounds);
        expect(1 /* base from chat turn */ + extra).toBe(rounds);
      }
    });
  });

  describe('failure path — charge NOTHING extra', () => {
    // On failure the chat turn deducts no base credit either, so total must be 0.
    it.each([0, 1, 3, 12, 99])('failed run with %i rounds → 0 extra', (rounds) => {
      expect(computeAuthoringExtraCredits(false, rounds)).toBe(0);
    });
  });

  describe('never charges garbage (NaN / non-finite / negative)', () => {
    it.each([
      [NaN],
      [Infinity],
      [-Infinity],
      [-1],
      [-100],
      [0],
    ])('success with rounds=%p → 0 (no charge)', (rounds) => {
      expect(computeAuthoringExtraCredits(true, rounds as number)).toBe(0);
    });

    it('never returns NaN or a negative number for any finite input', () => {
      for (let r = -5; r <= 30; r++) {
        const out = computeAuthoringExtraCredits(true, r);
        expect(Number.isFinite(out)).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('never OVER-charges (runaway rounds are clamped)', () => {
    it('clamps to MAX_BILLABLE_AUTHORING_ROUNDS - 1', () => {
      expect(computeAuthoringExtraCredits(true, 1000)).toBe(MAX_BILLABLE_AUTHORING_ROUNDS - 1);
      expect(computeAuthoringExtraCredits(true, MAX_BILLABLE_AUTHORING_ROUNDS + 50))
        .toBe(MAX_BILLABLE_AUTHORING_ROUNDS - 1);
    });

    it('extra never exceeds the cap regardless of input', () => {
      for (const rounds of [13, 20, 21, 100, 100000]) {
        expect(computeAuthoringExtraCredits(true, rounds))
          .toBeLessThanOrEqual(MAX_BILLABLE_AUTHORING_ROUNDS - 1);
      }
    });
  });

  describe('fractional rounds are floored (never round up a charge)', () => {
    it.each([
      [2.9, 1], // floor(2.9)=2 → extra 1
      [3.1, 2],
      [1.9, 0],
    ])('success with rounds=%p → %i extra', (rounds, expected) => {
      expect(computeAuthoringExtraCredits(true, rounds)).toBe(expected);
    });
  });
});
