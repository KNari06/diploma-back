/**
 * Tests for applyStepOptionsToCommand — forwards a saved step's `options.*`
 * onto the IntentPlaywrightCommand the executor runs.
 *
 * The contract is "only set when explicitly opted in", because the executor
 * treats `undefined` as its historical default. Over-forwarding (e.g. setting a
 * toggle to false) silently flips behaviour for every old saved step; under-
 * forwarding means the user's toggle is ignored. So each field's set/skip
 * boundary is pinned here, plus the cssSelector override + trimming and the
 * type-step gating.
 */

import { applyStepOptionsToCommand } from '../intent-step-options-forwarder';
import type { IntentStep } from '../preview.types';
import type { IntentPlaywrightCommand } from '../intent-step-converter.service';

function command(over: Partial<IntentPlaywrightCommand> = {}): IntentPlaywrightCommand {
  return { selector: '#orig', intentMeta: {}, ...over } as IntentPlaywrightCommand;
}

function step(type: string, options: Record<string, unknown> | undefined): IntentStep {
  return { type, options } as unknown as IntentStep;
}

describe('applyStepOptionsToCommand — no-op cases', () => {
  it('does nothing when there are no options', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', undefined), cmd);
    expect(cmd.selector).toBe('#orig');
    expect(cmd.intentMeta).toEqual({});
  });
});

describe('stability / caching toggles (set only when === true)', () => {
  it('sets disableStabilityChecks / disableCaching when explicitly true', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', { disableStabilityChecks: true, disableCaching: true }), cmd);
    expect(cmd.intentMeta!.disableStabilityChecks).toBe(true);
    expect(cmd.intentMeta!.disableCaching).toBe(true);
  });

  it('does NOT set them when false or undefined', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', { disableStabilityChecks: false }), cmd);
    expect(cmd.intentMeta!.disableStabilityChecks).toBeUndefined();
    expect(cmd.intentMeta!.disableCaching).toBeUndefined();
  });
});

describe('cssSelector override', () => {
  it('routes a pinned selector into command.selector and intentMeta.cssSelectorOverride', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', { cssSelector: '#pinned' }), cmd);
    expect(cmd.selector).toBe('#pinned');
    expect(cmd.intentMeta!.cssSelectorOverride).toBe('#pinned');
  });

  it('trims surrounding whitespace', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', { cssSelector: '  .btn  ' }), cmd);
    expect(cmd.selector).toBe('.btn');
    expect(cmd.intentMeta!.cssSelectorOverride).toBe('.btn');
  });

  it('ignores an empty / whitespace-only selector (keeps original)', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', { cssSelector: '   ' }), cmd);
    expect(cmd.selector).toBe('#orig');
    expect(cmd.intentMeta!.cssSelectorOverride).toBeUndefined();
  });
});

describe('type-step toggles (replaceContent + keyPressDelay)', () => {
  it('forwards replaceContent for a type step, including an explicit false', () => {
    const cmdTrue = command();
    applyStepOptionsToCommand(step('type', { replaceContent: true }), cmdTrue);
    expect(cmdTrue.intentMeta!.replaceContent).toBe(true);

    const cmdFalse = command();
    applyStepOptionsToCommand(step('type', { replaceContent: false }), cmdFalse);
    expect(cmdFalse.intentMeta!.replaceContent).toBe(false); // defined → forwarded
  });

  it('does NOT forward replaceContent when undefined', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('type', { keyPressDelay: 10 }), cmd);
    expect(cmd.intentMeta!.replaceContent).toBeUndefined();
  });

  it('forwards a finite non-negative keyPressDelay', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('type', { keyPressDelay: 50 }), cmd);
    expect(cmd.intentMeta!.keyPressDelay).toBe(50);

    const cmdZero = command();
    applyStepOptionsToCommand(step('type', { keyPressDelay: 0 }), cmdZero);
    expect(cmdZero.intentMeta!.keyPressDelay).toBe(0);
  });

  it('drops a negative / non-finite keyPressDelay', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cmd = command();
      applyStepOptionsToCommand(step('type', { keyPressDelay: bad }), cmd);
      expect(cmd.intentMeta!.keyPressDelay).toBeUndefined();
    }
  });

  it('does NOT forward type-only toggles for a non-type step', () => {
    const cmd = command();
    applyStepOptionsToCommand(step('click', { replaceContent: true, keyPressDelay: 25 }), cmd);
    expect(cmd.intentMeta!.replaceContent).toBeUndefined();
    expect(cmd.intentMeta!.keyPressDelay).toBeUndefined();
  });
});
