/**
 * Unit tests for LiteEngine per-step credit billing.
 *
 * Product decision (2026-07-17): lite AI chat runs bill 1 credit per executed
 * step, matching the web replay path (test-executor.ts). No refund on failed
 * runs — steps that ran are charged.
 *
 * Bill-the-winner (fix, 2026-07-17): the execution paths fall through on
 * failure (hybrid → pipeline v2 → legacy loop). Charging eagerly billed EVERY
 * path a run touched, double-charging internal retries. Billing now ACCRUES
 * per step into `billableStepCount` and settles ONCE at run end
 * (`settleStepCharges`); a fall-through boundary calls `resetPathCharges()` to
 * discard the abandoned path's tally, so only the winning path is billed.
 *
 * The full LiteEngine needs a live Playwright Page + ~30 collaborators, so we
 * exercise the billing logic directly on the prototype with only the fields it
 * reads (`config`, `creditsExhausted`, `billableStepCount`). This keeps the
 * test a true unit test of the billing contract, not an integration boot.
 */

import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { LiteEngine } from '../lite-engine';
import type { ExecutionRound } from '../pipeline/types';

jest.mock('@/services/core/credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductStepCredit: jest.fn() },
}));

const mockDeduct = CreditCostTrackerService.deductStepCredit as jest.MockedFunction<
  typeof CreditCostTrackerService.deductStepCredit
>;

interface BillingEngine {
  chargeStepCredit: (action: string) => void;
  chargeForPipelineRound: (round: ExecutionRound) => void;
  resetPathCharges: () => void;
  settleStepCharges: () => Promise<void>;
  creditsExhausted: boolean;
  billableStepCount: number;
}

/**
 * Build a bare LiteEngine whose billing methods are callable without booting
 * the engine. Only `config`, `creditsExhausted`, `billableStepCount` are
 * touched by the methods under test.
 */
function makeEngine(config: { userId?: string; testId?: string }): BillingEngine {
  const engine = Object.create(LiteEngine.prototype);
  engine.config = { testId: 'test-123', ...config };
  // Field initializers run in the constructor, which Object.create bypasses —
  // set the ones the methods under test read.
  engine.creditsExhausted = false;
  engine.billableStepCount = 0;
  return engine;
}

/** A pipeline round carrying one command with the given name + success. */
function roundWith(commands: Array<{ name: string; success: boolean }>): ExecutionRound {
  return {
    roundNumber: 1,
    durationMs: 0,
    pageSnapshotBefore: '',
    commands: commands.map((c) => ({
      command: { name: c.name as any, args: {} },
      result: { success: c.success, output: '' },
      durationMs: 0,
    })),
  };
}

beforeEach(() => {
  mockDeduct.mockReset();
  mockDeduct.mockResolvedValue({ success: true, newBalance: 99 });
});

describe('LiteEngine billing — accrue then settle', () => {
  it('accrues per step but does NOT deduct until settle', async () => {
    const engine = makeEngine({ userId: 'user-1' });

    engine.chargeStepCredit('click');
    engine.chargeStepCredit('fill');

    // Nothing hits the tracker during the run…
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(engine.billableStepCount).toBe(2);

    // …until settle bills the accrued steps as a batch.
    await engine.settleStepCharges();
    expect(mockDeduct).toHaveBeenCalledTimes(2);
    expect(mockDeduct).toHaveBeenCalledWith('user-1', 'test-123', 'Lite step');
  });

  it('does not accrue or deduct when the run has no userId (anonymous/system run)', async () => {
    const engine = makeEngine({ userId: undefined });

    engine.chargeStepCredit('fill');
    await engine.settleStepCharges();

    expect(engine.billableStepCount).toBe(0);
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('latches creditsExhausted at settle and stops deducting the remainder', async () => {
    const engine = makeEngine({ userId: 'user-1' });
    // 3 steps accrued; the 1st settle deduction fails → latch, stop.
    engine.chargeStepCredit('click');
    engine.chargeStepCredit('fill');
    engine.chargeStepCredit('scroll');
    mockDeduct.mockResolvedValueOnce({ success: false, newBalance: 0 });

    await engine.settleStepCharges();

    expect(engine.creditsExhausted).toBe(true);
    // Only the first (failing) attempt hit the tracker; the rest short-circuit.
    expect(mockDeduct).toHaveBeenCalledTimes(1);
  });

  it('settle is idempotent — a second call does not re-bill', async () => {
    const engine = makeEngine({ userId: 'user-1' });
    engine.chargeStepCredit('click');

    await engine.settleStepCharges();
    await engine.settleStepCharges(); // re-entrant buildResult must not double-charge

    expect(mockDeduct).toHaveBeenCalledTimes(1);
    expect(engine.billableStepCount).toBe(0);
  });

  it('settle never throws — deduction failure is non-fatal to the run', async () => {
    const engine = makeEngine({ userId: 'user-1' });
    engine.chargeStepCredit('click');
    mockDeduct.mockRejectedValue(new Error('DB down'));

    // settleStepCharges swallows / latches; it must not reject.
    await expect(engine.settleStepCharges()).resolves.toBeUndefined();
  });
});

describe('LiteEngine.chargeForPipelineRound (accrual)', () => {
  it('accrues 1 per successful real-action command', async () => {
    const engine = makeEngine({ userId: 'user-1' });

    engine.chargeForPipelineRound(
      roundWith([
        { name: 'click_element', success: true },
        { name: 'fill_field', success: true },
      ]),
    );

    expect(engine.billableStepCount).toBe(2);
    await engine.settleStepCharges();
    expect(mockDeduct).toHaveBeenCalledTimes(2);
  });

  it('does NOT accrue failed commands', () => {
    const engine = makeEngine({ userId: 'user-1' });

    engine.chargeForPipelineRound(
      roundWith([
        { name: 'click_element', success: false },
        { name: 'fill_field', success: true },
      ]),
    );

    expect(engine.billableStepCount).toBe(1);
  });

  it('does NOT accrue meta commands (observe_page / mark_done / report_blocked)', () => {
    const engine = makeEngine({ userId: 'user-1' });

    engine.chargeForPipelineRound(
      roundWith([
        { name: 'observe_page', success: true },
        { name: 'mark_done', success: true },
        { name: 'report_blocked', success: true },
        { name: 'click_element', success: true },
      ]),
    );

    // Only the click accrues — the three meta commands map to null via toAICommand.
    expect(engine.billableStepCount).toBe(1);
  });

  it('accrues scroll / wait / hover — same real-action set as the legacy loop', () => {
    const engine = makeEngine({ userId: 'user-1' });

    engine.chargeForPipelineRound(
      roundWith([
        { name: 'scroll_page', success: true },
        { name: 'wait_for_page', success: true },
        { name: 'hover_element', success: true },
      ]),
    );

    expect(engine.billableStepCount).toBe(3);
  });

  it('does not accrue anything when the run has no userId', () => {
    const engine = makeEngine({ userId: undefined });

    engine.chargeForPipelineRound(roundWith([{ name: 'click_element', success: true }]));

    expect(engine.billableStepCount).toBe(0);
  });
});

describe('LiteEngine billing — bill-the-winner on fall-through', () => {
  it('bills ONLY the winning path when hybrid falls through to pipeline v2', async () => {
    // Hybrid runs 5 real steps then fails → resetPathCharges → pipeline v2 runs
    // 8 real steps and wins. User must pay 8, not 13.
    const engine = makeEngine({ userId: 'user-1' });

    // Abandoned hybrid attempt (5 steps).
    for (let i = 0; i < 5; i++) engine.chargeStepCredit('click');
    expect(engine.billableStepCount).toBe(5);

    // Fall-through boundary discards the abandoned attempt.
    engine.resetPathCharges();
    expect(engine.billableStepCount).toBe(0);

    // Winning pipeline v2 path (8 steps).
    engine.chargeForPipelineRound(
      roundWith(Array.from({ length: 8 }, () => ({ name: 'click_element', success: true }))),
    );

    await engine.settleStepCharges();
    expect(mockDeduct).toHaveBeenCalledTimes(8);
  });

  it('bills ONLY the legacy path when pipeline v2 throws and falls through', async () => {
    // Pipeline v2 accrues 4 steps, then throws → resetPathCharges → legacy loop
    // runs 3 steps and wins. User must pay 3, not 7.
    const engine = makeEngine({ userId: 'user-1' });

    engine.chargeForPipelineRound(
      roundWith(Array.from({ length: 4 }, () => ({ name: 'fill_field', success: true }))),
    );
    expect(engine.billableStepCount).toBe(4);

    engine.resetPathCharges(); // pipeline threw

    for (let i = 0; i < 3; i++) engine.chargeStepCredit('fill');

    await engine.settleStepCharges();
    expect(mockDeduct).toHaveBeenCalledTimes(3);
  });

  it('bills nothing when every path is abandoned before settle', async () => {
    const engine = makeEngine({ userId: 'user-1' });

    for (let i = 0; i < 5; i++) engine.chargeStepCredit('click');
    engine.resetPathCharges(); // hybrid abandoned, and (contrived) nothing runs after

    await engine.settleStepCharges();
    expect(mockDeduct).not.toHaveBeenCalled();
  });
});
