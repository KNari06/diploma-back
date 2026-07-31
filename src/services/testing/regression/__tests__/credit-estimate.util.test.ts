import { computeUiStepCredits, type UiStepCountRow } from '../credit-estimate.util';
import { MOBILE_STEP_CREDIT_MULTIPLIER } from '@/services/core/token-calculator.service';

const M = MOBILE_STEP_CREDIT_MULTIPLIER; // 4

const web = (id: string) => ({ testCaseId: id, testType: 'ui' as const, platform: undefined });
const mobile = (id: string) => ({ testCaseId: id, testType: 'ui' as const, platform: 'mobile_android' });

const stepsRow = (id: string, n: number): UiStepCountRow => ({
  id,
  // steps_json path adds +1 for the initial goto
  steps_json: Array.from({ length: n }, (_, i) => ({ i })),
});

describe('computeUiStepCredits', () => {
  it('returns 0 when there are no UI cases', () => {
    expect(computeUiStepCredits([], [])).toBe(0);
  });

  it('charges web cases at 1× per step (steps_json + 1 goto)', () => {
    // 3 steps + 1 goto = 4 credits
    expect(computeUiStepCredits([web('a')], [stepsRow('a', 3)])).toBe(4);
  });

  it('charges mobile cases at the mobile multiplier per step', () => {
    // (3 + 1) steps × 4 = 16
    expect(computeUiStepCredits([mobile('a')], [stepsRow('a', 3)])).toBe((3 + 1) * M);
  });

  it('applies the multiplier per-case in a mixed run (web 1×, mobile 4×)', () => {
    const total = computeUiStepCredits(
      [web('w'), mobile('m')],
      [stepsRow('w', 3), stepsRow('m', 3)],
    );
    expect(total).toBe(4 /* web */ + (3 + 1) * M /* mobile */);
  });

  it('counts setup_steps + teardown_steps and applies the case rate to them', () => {
    const row: UiStepCountRow = { id: 'm', steps_json: [{}, {}], setup_steps: [{}], teardown_steps: [{}] };
    // steps_json(2)+goto(1)=3, +setup(1)+teardown(1)=5, ×4 = 20
    expect(computeUiStepCredits([mobile('m')], [row])).toBe(5 * M);
  });

  it('counts a commands-strategy row by command length (no +1 goto)', () => {
    const row: UiStepCountRow = { id: 'm', replay_strategy: 'commands', commands: [{}, {}, {}] };
    expect(computeUiStepCredits([mobile('m')], [row])).toBe(3 * M);
  });

  it('applies a per-case minimum of one step at the case rate', () => {
    // Row present but uncountable (no steps/commands) → min 1 step
    const web0: UiStepCountRow = { id: 'w' };
    const mob0: UiStepCountRow = { id: 'm' };
    expect(computeUiStepCredits([web('w')], [web0])).toBe(1);
    expect(computeUiStepCredits([mobile('m')], [mob0])).toBe(M);
  });

  it('charges the case rate as the minimum for IDs missing from the DB rows', () => {
    // No rows returned at all → each case charged its per-step minimum
    expect(computeUiStepCredits([web('w'), mobile('m')], [])).toBe(1 + M);
  });

  it('does not let a web case be charged the mobile rate (regression guard for the 4× bug)', () => {
    // The whole point: a mobile run must NOT estimate at 1×.
    const webTotal = computeUiStepCredits([web('a')], [stepsRow('a', 10)]);
    const mobTotal = computeUiStepCredits([mobile('a')], [stepsRow('a', 10)]);
    expect(mobTotal).toBe(webTotal * M);
  });

  describe('expandedLengthById (link_test_case expansion)', () => {
    it('uses the expanded length instead of the row\'s raw steps_json.length when present', () => {
      // row has 1 raw step (a single link_test_case marker) but the linked
      // test case has 100 steps — the estimate must reflect 100, not 1.
      const row = stepsRow('a', 1);
      const withoutExpansion = computeUiStepCredits([web('a')], [row]);
      const withExpansion = computeUiStepCredits([web('a')], [row], new Map([['a', 100]]));

      expect(withoutExpansion).toBe(2); // 1 step + 1 goto
      expect(withExpansion).toBe(101); // 100 expanded steps + 1 goto
    });

    it('falls back to the row\'s own steps_json.length for a row with no entry in the map (no links)', () => {
      const row = stepsRow('a', 5);
      expect(computeUiStepCredits([web('a')], [row], new Map([['other-id', 999]]))).toBe(6);
    });

    it('applies the case rate on top of the expanded length for a mobile case', () => {
      const row = stepsRow('m', 1);
      const total = computeUiStepCredits([mobile('m')], [row], new Map([['m', 10]]));
      expect(total).toBe((10 + 1) * M);
    });
  });

  describe('author-disabled steps (options.enabled === false)', () => {
    const disabled = () => ({ options: { enabled: false } });
    const enabled = () => ({ options: { enabled: true } });

    it('excludes a disabled step from the estimate', () => {
      // 3 steps, 1 disabled → 2 billable + 1 goto = 3
      const row: UiStepCountRow = { id: 'a', steps_json: [{}, disabled(), {}] };
      expect(computeUiStepCredits([web('a')], [row])).toBe(3);
    });

    it('counts a step with enabled:true and one with no flag identically', () => {
      const explicit: UiStepCountRow = { id: 'a', steps_json: [enabled(), enabled()] };
      const implicit: UiStepCountRow = { id: 'a', steps_json: [{}, {}] };
      expect(computeUiStepCredits([web('a')], [explicit]))
        .toBe(computeUiStepCredits([web('a')], [implicit]));
    });

    it('keeps the +1 goto when every step is disabled — the initial navigation still runs', () => {
      const row: UiStepCountRow = { id: 'a', steps_json: [disabled(), disabled()] };
      expect(computeUiStepCredits([web('a')], [row])).toBe(1);
    });

    it('applies the mobile multiplier only to the steps that will run', () => {
      const row: UiStepCountRow = { id: 'm', steps_json: [{}, disabled(), disabled()] };
      // 1 billable + 1 goto = 2, ×4
      expect(computeUiStepCredits([mobile('m')], [row])).toBe(2 * M);
    });

    it('excludes disabled setup_steps and teardown_steps', () => {
      const row: UiStepCountRow = {
        id: 'a',
        steps_json: [{}],
        setup_steps: [{}, disabled()],
        teardown_steps: [disabled()],
      };
      // steps_json(1) + goto(1) + setup(1) + teardown(0) = 3
      expect(computeUiStepCredits([web('a')], [row])).toBe(3);
    });

    it('excludes disabled commands on the commands replay strategy', () => {
      const row: UiStepCountRow = {
        id: 'a',
        replay_strategy: 'commands',
        commands: [{}, disabled(), {}],
      };
      // commands path has no +1 goto (the goto is already a command)
      expect(computeUiStepCredits([web('a')], [row])).toBe(2);
    });

    it('still charges the per-case minimum of 1 when all steps are disabled on the commands path', () => {
      const row: UiStepCountRow = {
        id: 'a',
        replay_strategy: 'commands',
        commands: [disabled(), disabled()],
      };
      expect(computeUiStepCredits([web('a')], [row])).toBe(1);
    });
  });
});
