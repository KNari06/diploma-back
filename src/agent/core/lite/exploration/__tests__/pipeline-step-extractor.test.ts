/**
 * Unit tests for `commandToStep` — the pure mapping from an executed pipeline
 * command to a DiscoveredStep, shared by exploration AND editor iterative
 * authoring. This is the contract that decides what becomes a test step, so it
 * must map every supported action, drop infrastructure commands, and NEVER leak
 * a sensitive value into the step.
 */

import { commandToStep } from '../pipeline-step-extractor';
import type { ExecutedCommand } from '../../pipeline/types';

function exec(
  name: string,
  args: Record<string, unknown> = {},
  result: Partial<{ success: boolean; output: string }> = {},
): ExecutedCommand {
  return {
    command: { name, args } as ExecutedCommand['command'],
    result: { success: true, output: '', ...result } as ExecutedCommand['result'],
  } as ExecutedCommand;
}

describe('commandToStep — action mapping', () => {
  it.each([
    ['click_element', { ref: 'e1' }, 'click'],
    ['fill_field', { ref: 'e2', value: 'hello' }, 'fill'],
    ['select_option', { ref: 'e3', value: 'opt' }, 'select'],
    ['press_key', { key: 'Enter' }, 'press'],
    ['hover_element', { ref: 'e4' }, 'hover'],
    ['scroll_page', { direction: 'down' }, 'scroll'],
    ['scroll_to_element', { ref: 'e5' }, 'scroll'],
    ['navigate_to', { url: 'https://x.test' }, 'navigate'],
    ['toggle_element', { ref: 'e6' }, 'toggle'],
    ['set_range', { ref: 'e7', value: '5' }, 'setRange'],
    ['select_date', { ref: 'e8', value: '2026-01-01' }, 'selectDate'],
    ['clear_field', { ref: 'e9' }, 'clear'],
    ['mark_done', { evidence: 'logged in' }, 'verify'],
  ])('maps %s → action "%s"', (name, args, expectedAction) => {
    const step = commandToStep(exec(name, args), 1, 'https://x.test');
    expect(step).not.toBeNull();
    expect(step!.action).toBe(expectedAction);
    expect(step!.stepNumber).toBe(1);
    expect(step!.pageUrl).toBe('https://x.test');
  });

  it('drops infrastructure / non-replayable commands → null', () => {
    for (const name of ['observe_page', 'wait_for_page', 'report_blocked', 'totally_unknown']) {
      expect(commandToStep(exec(name), 1, '')).toBeNull();
    }
  });
});

describe('commandToStep — value + secret handling', () => {
  it('carries a non-sensitive fill value', () => {
    const step = commandToStep(exec('fill_field', { ref: 'e1', value: 'jane@x.test' }), 1, '');
    expect(step!.value).toBe('jane@x.test');
    expect(step!.isSensitive).toBeFalsy();
  });

  it('NEVER carries a sensitive fill value (value dropped, marked sensitive)', () => {
    const step = commandToStep(
      exec('fill_field', { ref: 'e1', value: 'hunter2', is_sensitive: true }),
      1,
      '',
    );
    expect(step!.isSensitive).toBe(true);
    expect(step!.value).toBeUndefined(); // secret must not survive into the step
    expect(step!.description).not.toContain('hunter2'); // nor into the description
    expect(step!.description).toContain('[credential]');
  });
});

describe('commandToStep — description', () => {
  it('uses the executor output as the human description', () => {
    const step = commandToStep(exec('click_element', { ref: 'e1' }, { output: 'Clicked "Login" (button)' }), 1, '');
    expect(step!.description).toBe('Clicked "Login" (button)');
  });

  it('strips the internal [POST-ACTION: …] suffix from the description', () => {
    const step = commandToStep(
      exec('click_element', { ref: 'e1' }, { output: 'Clicked "Login" [POST-ACTION: navigated to /home]' }),
      1,
      '',
    );
    expect(step!.description).toBe('Clicked "Login"');
    expect(step!.description).not.toContain('POST-ACTION');
  });

  it('falls back to a generated description when output is empty', () => {
    const step = commandToStep(exec('click_element', { ref: 'e1' }, { output: '' }), 1, '');
    expect(step!.description).toContain('e1');
  });
});
