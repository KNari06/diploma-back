/**
 * Contract tests for the authoring step → runner command converter.
 *
 * Two guarantees:
 *   1. ACCEPTED_STEP_TYPES and toRunnerCommand stay in sync — every type
 *      the authoring tool accepts converts to a command type the runner's
 *      zod schema (qait-mobile-runner command.schema.ts) actually declares.
 *   2. Each mapping mirrors the runner's own intent-step-converter so a
 *      draft run behaves the same as the saved test case's later replay.
 */

import { ACCEPTED_STEP_TYPES, toRunnerCommand } from '../tools';
import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';

/**
 * Mirror of the runner's zod discriminated union (qait-mobile-runner
 * src/api/schemas/command.schema.ts). A command type outside this list is
 * rejected by the runner's /commands batch route with a generic 400.
 */
const RUNNER_COMMAND_TYPES = new Set([
  'observe_page', 'tap', 'type_text', 'scroll', 'swipe', 'press_key',
  'long_press', 'double_tap', 'drag', 'pinch_zoom', 'assert_visible',
  'assert_text', 'extract_text', 'screenshot', 'get_accessibility_tree',
  'install_app', 'launch_app', 'close_app', 'go_back', 'go_home', 'dismiss',
  'biometric', 'otp', 'permission_dialog', 'set_clipboard', 'get_clipboard',
  'send_push_notification', 'set_network_condition', 'clear_network_condition',
  'ai_visual_check', 'open_url', 'open_notifications', 'upload_file',
  'get_logs', 'get_network_logs', 'get_app_info', 'get_app_cache',
  'check_package', 'tap_notification', 'dismiss_notification',
  'clear_all_notifications', 'assert_notification', 'switch_context',
  'web_navigate', 'web_evaluate', 'web_click', 'web_type',
  'web_assert_element', 'web_assert_text', 'web_screenshot', 'web_get_url',
]);

function step(
  overrides: Omit<Partial<MobileIntentStep>, 'type'> & { type: string },
): MobileIntentStep {
  return {
    id: 'step_1',
    description: 'test step',
    ...overrides,
    type: overrides.type as MobileIntentStep['type'],
  };
}

function expectCommand(s: MobileIntentStep): Record<string, unknown> {
  const result = toRunnerCommand(s);
  if (!result.ok) throw new Error(`expected ok conversion, got: ${result.reason}`);
  return result.command;
}

describe('ACCEPTED_STEP_TYPES ↔ toRunnerCommand sync', () => {
  // Extra fields some types need before they can produce a command.
  const fixtures: Record<string, Partial<MobileIntentStep>> = {
    navigate: { value: 'https://example.com' },
    extract_text: { options: { extractVariable: 'price' } },
    drag: { options: { startX: 100, startY: 200, endX: 300, endY: 400 } },
  };

  it('every whitelisted type converts to a command type the runner schema declares', () => {
    for (const type of ACCEPTED_STEP_TYPES) {
      const result = toRunnerCommand(step({ type, ...fixtures[type] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(RUNNER_COMMAND_TYPES).toContain(result.command.type);
      }
    }
  });

  it('includes extract_text (canonical MobileIntentActionType)', () => {
    expect(ACCEPTED_STEP_TYPES.has('extract_text')).toBe(true);
  });
});

describe('toRunnerCommand — tap family & existing mappings stay intact', () => {
  it('maps click to tap with the description as intent', () => {
    expect(expectCommand(step({ type: 'click', description: 'Login button' }))).toEqual({
      type: 'tap',
      params: { intent: 'Login button' },
    });
  });

  it('maps hover to tap (no hover on mobile)', () => {
    expect(expectCommand(step({ type: 'hover' })).type).toBe('tap');
  });

  it('maps type to type_text with clearFirst', () => {
    expect(
      expectCommand(step({ type: 'type', description: 'Email field', value: 'a@b.c' })),
    ).toEqual({
      type: 'type_text',
      params: { intent: 'Email field', text: 'a@b.c', clearFirst: true },
    });
  });
});

describe('toRunnerCommand — swipe defaults', () => {
  it('fills direction-based default coordinates when no options are given', () => {
    // Runner replay default direction is 'down' — draft run must match.
    expect(expectCommand(step({ type: 'swipe' }))).toEqual({
      type: 'swipe',
      params: { startX: 540, startY: 460, endX: 540, endY: 1460, durationMs: 300 },
    });
  });

  it('derives coordinates from options.direction', () => {
    expect(expectCommand(step({ type: 'swipe', options: { direction: 'left' } })).params).toEqual({
      startX: 860, startY: 960, endX: 220, endY: 960, durationMs: 300,
    });
  });

  it('honours scrollDirection as a fallback direction hint', () => {
    expect(
      expectCommand(step({ type: 'swipe', options: { scrollDirection: 'up' } })).params,
    ).toEqual({ startX: 540, startY: 1460, endX: 540, endY: 460, durationMs: 300 });
  });

  it('respects explicit full coordinates and durationMs', () => {
    expect(
      expectCommand(
        step({
          type: 'swipe',
          options: { startX: 10, startY: 20, endX: 30, endY: 40, durationMs: 999 },
        }),
      ).params,
    ).toEqual({ startX: 10, startY: 20, endX: 30, endY: 40, durationMs: 999 });
  });

  it('falls back to direction defaults when coordinates are incomplete', () => {
    expect(
      expectCommand(step({ type: 'swipe', options: { startX: 10, direction: 'down' } })).params,
    ).toEqual({ startX: 540, startY: 460, endX: 540, endY: 1460, durationMs: 300 });
  });
});

describe('toRunnerCommand — wait / wait_for', () => {
  it('maps a numeric wait to observe_page with an extended timeout', () => {
    expect(expectCommand(step({ type: 'wait', value: '3000' }))).toEqual({
      type: 'observe_page',
      params: {},
      timeout: 5000,
    });
    expect(expectCommand(step({ type: 'wait_for', value: '10000' })).timeout).toBe(12000);
  });

  it('maps a valueless wait to observe_page without a timeout override', () => {
    expect(expectCommand(step({ type: 'wait_for' }))).toEqual({
      type: 'observe_page',
      params: {},
    });
  });
});

describe('toRunnerCommand — navigate', () => {
  it('maps a URL to open_url', () => {
    expect(expectCommand(step({ type: 'navigate', value: 'https://example.com/x' }))).toEqual({
      type: 'open_url',
      params: { url: 'https://example.com/x' },
    });
  });

  it('maps a deep link to open_url', () => {
    expect(expectCommand(step({ type: 'navigate', value: 'myapp://home' })).type).toBe('open_url');
  });

  it('maps a package ID to launch_app', () => {
    expect(expectCommand(step({ type: 'navigate', value: 'com.example.app' }))).toEqual({
      type: 'launch_app',
      params: { packageName: 'com.example.app' },
    });
  });

  it('accepts a URL-shaped description when value is absent', () => {
    expect(
      expectCommand(step({ type: 'navigate', description: 'https://example.com' })).type,
    ).toBe('open_url');
  });

  it('rejects when no valid target exists', () => {
    const result = toRunnerCommand(step({ type: 'navigate', description: 'go somewhere' }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('navigate requires') });
  });
});

describe('toRunnerCommand — gestures', () => {
  it('maps drag with full coordinates', () => {
    expect(
      expectCommand(
        step({ type: 'drag', options: { startX: 1, startY: 2, endX: 3, endY: 4 } }),
      ),
    ).toEqual({
      type: 'drag',
      params: { startX: 1, startY: 2, endX: 3, endY: 4, holdDurationMs: 500, durationMs: 800 },
    });
  });

  it('rejects drag without complete coordinates', () => {
    const result = toRunnerCommand(step({ type: 'drag', options: { startX: 1, startY: 2 } }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('drag requires') });
  });

  it('maps pinch to pinch_zoom with runner defaults', () => {
    expect(expectCommand(step({ type: 'pinch' }))).toEqual({
      type: 'pinch_zoom',
      params: { direction: 'out', scale: 2.0 },
    });
  });

  it('forwards pinch options', () => {
    expect(
      expectCommand(
        step({
          type: 'pinch',
          options: { pinchDirection: 'in', pinchScale: 0.5, startX: 100, startY: 200 },
        }),
      ).params,
    ).toEqual({ direction: 'in', scale: 0.5, x: 100, y: 200 });
  });
});

describe('toRunnerCommand — clipboard / network / screenshot / close', () => {
  it('maps clipboard with a value to set_clipboard', () => {
    expect(expectCommand(step({ type: 'clipboard', value: 'hello' }))).toEqual({
      type: 'set_clipboard',
      params: { text: 'hello' },
    });
  });

  it('maps clipboard without a value to get_clipboard', () => {
    expect(expectCommand(step({ type: 'clipboard' })).type).toBe('get_clipboard');
  });

  it('maps network with a preset to set_network_condition', () => {
    expect(expectCommand(step({ type: 'network', options: { networkPreset: '3g' } }))).toEqual({
      type: 'set_network_condition',
      params: { preset: '3g' },
    });
  });

  it('maps network custom params without a preset to set_network_condition', () => {
    expect(
      expectCommand(step({ type: 'network', options: { networkLatencyMs: 200 } })).params,
    ).toEqual({ latencyMs: 200 });
  });

  it('maps network without conditions to clear_network_condition', () => {
    expect(expectCommand(step({ type: 'network' })).type).toBe('clear_network_condition');
  });

  it('maps screenshot to the screenshot command', () => {
    expect(expectCommand(step({ type: 'screenshot' }))).toEqual({
      type: 'screenshot',
      params: {},
    });
  });

  it('maps close with a package-like value to close_app', () => {
    expect(expectCommand(step({ type: 'close', value: 'com.example.app' }))).toEqual({
      type: 'close_app',
      params: { packageName: 'com.example.app' },
    });
  });

  it('maps close without a package value to a tap on the close element', () => {
    expect(expectCommand(step({ type: 'close', description: 'close dialog button' }))).toEqual({
      type: 'tap',
      params: { intent: 'close dialog button' },
    });
  });
});

describe('toRunnerCommand — extract_text', () => {
  it('maps extract_text with a variable name', () => {
    expect(
      expectCommand(
        step({
          type: 'extract_text',
          description: 'order total',
          options: { extractVariable: 'total' },
        }),
      ),
    ).toEqual({
      type: 'extract_text',
      params: { intent: 'order total', variableName: 'total' },
    });
  });

  it('rejects extract_text without options.extractVariable', () => {
    const result = toRunnerCommand(step({ type: 'extract_text' }));
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('extractVariable'),
    });
  });
});

describe('toRunnerCommand — unknown type', () => {
  it('rejects a type outside the whitelist/converter with a sync message', () => {
    const result = toRunnerCommand(step({ type: 'teleport' }));
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('out of sync'),
    });
  });
});
