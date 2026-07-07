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

    it('rejects a swipe without coordinates rather than shipping empty params', () => {
      const r = toRunnerCommand(mk({ type: 'swipe' as any, description: 'swipe up' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/coordinates|scroll/i);
    });

    it('accepts a swipe WITH full coordinates', () => {
      const r = toRunnerCommand(
        mk({ type: 'swipe' as any, description: 'swipe', options: { startX: 1, startY: 2, endX: 3, endY: 4 } as any }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.command.type).toBe('swipe');
    });

    it('rejects a drag without coordinates', () => {
      const r = toRunnerCommand(mk({ type: 'drag' as any, description: 'drag' }));
      expect(r.ok).toBe(false);
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
