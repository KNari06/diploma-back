import { toRunnerCommand, ACCEPTED_STEP_TYPES } from '../tools';
import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';

function mk(partial: Partial<MobileIntentStep>): MobileIntentStep {
  return { id: 's1', type: 'tap', description: 'x', ...partial } as MobileIntentStep;
}

describe('toRunnerCommand', () => {
  describe('maps supported types to runner commands', () => {
    it('normalises alias types (type_text/tap/launch_app) onto runner commands', () => {
      expect(toRunnerCommand(mk({ type: 'type_text' as any, value: 'hi', description: 'Email' }))).toEqual({
        ok: true,
        command: { type: 'type_text', params: { intent: 'Email', text: 'hi', clearFirst: true } },
      });
      const tap = toRunnerCommand(mk({ type: 'tap' as any, description: 'Login' }));
      expect(tap).toMatchObject({ ok: true, command: { type: 'tap' } });
    });

    it('maps extract_text with a backfilled variableName the runner schema requires', () => {
      const r = toRunnerCommand(mk({ type: 'extract_text' as any, description: 'Order number' }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.command.type).toBe('extract_text');
        expect((r.command.params as any).variableName).toBe('order_number');
      }
    });
  });

  describe('rejects steps the runner batch schema would 400 on', () => {
    it.each(['wait', 'wait_for', 'navigate', 'pinch', 'clipboard', 'network'])(
      'rejects unsupported type "%s" with a reason (never ships to runner)',
      (type) => {
        const r = toRunnerCommand(mk({ type: type as any, description: 'x' }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/\S/);
      },
    );

    it('rejects a swipe with neither coordinates nor direction', () => {
      const r = toRunnerCommand(mk({ type: 'swipe' as any, description: 'swipe' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/direction|coordinates|scroll/i);
    });

    it('accepts a swipe WITH full coordinates', () => {
      const r = toRunnerCommand(
        mk({ type: 'swipe' as any, description: 'swipe', options: { startX: 1, startY: 2, endX: 3, endY: 4 } as any }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.command.type).toBe('swipe');
    });

    it('computes coords for a DIRECTIONAL swipe (options.direction) — runs like replay', () => {
      const r = toRunnerCommand(mk({ type: 'swipe' as any, description: 'swipe up', options: { direction: 'up' } as any }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        const p = r.command.params as any;
        expect(r.command.type).toBe('swipe');
        // up = start below center, end above center (startY > endY).
        expect(p.startY).toBeGreaterThan(p.endY);
        expect(typeof p.startX).toBe('number');
      }
    });

    it('forwards scroll direction + amount (does not drop scrollAmount)', () => {
      const r = toRunnerCommand(mk({ type: 'scroll' as any, description: 'scroll down half', options: { direction: 'down', scrollAmount: 0.5 } as any }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        const p = r.command.params as any;
        expect(p.direction).toBe('down');
        expect(p.amount).toBe(0.5);
      }
    });

    it('rejects a drag without coordinates (no direction default for drag)', () => {
      const r = toRunnerCommand(mk({ type: 'drag' as any, description: 'drag' }));
      expect(r.ok).toBe(false);
    });
  });

  describe('press_key emits a real Android keycode (not a bare alias)', () => {
    it('maps enter -> KEYCODE_ENTER', () => {
      const r = toRunnerCommand(mk({ type: 'press_key' as any, description: 'press enter', value: 'enter' }));
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.command.params as any).keycode).toBe('KEYCODE_ENTER');
    });
    it('defaults a bare press to KEYCODE_ENTER, never the literal "enter"', () => {
      const r = toRunnerCommand(mk({ type: 'press' as any, description: 'press' }));
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.command.params as any).keycode).toBe('KEYCODE_ENTER');
    });
  });

  describe('assertions route so the expected value is actually verified', () => {
    it('ai_check + aiCheckSource -> ai_visual_check', () => {
      const r = toRunnerCommand(mk({ type: 'ai_check' as any, description: 'success banner shows', options: { aiCheckSource: 'screenshot' } as any }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.command.type).toBe('ai_visual_check');
        expect((r.command.params as any).source).toBe('screenshot');
      }
    });
    it('assert with expected text -> assert_text (NOT assert_visible which drops expectedText)', () => {
      const r = toRunnerCommand(mk({ type: 'assert' as any, description: 'check total', assertionText: '$50.00' } as any));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.command.type).toBe('assert_text');
        expect((r.command.params as any).expectedText).toBe('$50.00');
      }
    });
    it('assert with no expected text -> assert_visible (pure visibility)', () => {
      const r = toRunnerCommand(mk({ type: 'assert_visible' as any, description: 'cart icon visible' }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.command.type).toBe('assert_visible');
    });
  });

  describe('accepted-type/runtime-support contract', () => {
    it('every unsupported-at-runtime type is still an ACCEPTED authoring type (so the draft card can show it)', () => {
      for (const t of ['wait', 'wait_for', 'navigate', 'pinch', 'clipboard', 'network']) {
        expect(ACCEPTED_STEP_TYPES.has(t)).toBe(true);
      }
    });
  });
});
