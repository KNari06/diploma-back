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
  result: Partial<{
    success: boolean;
    output: string;
    resolvedElement: unknown;
    injectedCredentialKind: string;
  }> = {},
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
    ['assert_text', { ref: 'e10', expected: '1 result' }, 'assert'],
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

describe('commandToStep — credential binding (rung 4)', () => {
  const keyForKind = (kind: string): string | undefined =>
    ({ password: 'login_password', email: 'login_email' } as Record<string, string>)[kind];

  it('freezes a {{secrets.*}} placeholder for the credential kind that was injected', () => {
    const step = commandToStep(
      exec('fill_field', { ref: 'e1', value: 'user@test.com', is_sensitive: true }, {
        injectedCredentialKind: 'password',
      }),
      1,
      '',
      keyForKind,
    );
    expect(step!.value).toBe('{{secrets.login_password}}');
    expect(step!.isSensitive).toBe(true);
  });

  it('keys off the INJECTED kind, never the command args (args hold the LLM placeholder)', () => {
    const step = commandToStep(
      // The LLM's arg value is a throwaway — it must not influence the mapping,
      // and must never be frozen into the step.
      exec('fill_field', { ref: 'e1', value: 'totally-made-up@example.com', is_sensitive: true }, {
        injectedCredentialKind: 'email',
      }),
      1,
      '',
      keyForKind,
    );
    expect(step!.value).toBe('{{secrets.login_email}}');
    expect(step!.value).not.toContain('made-up');
  });

  it('drops the value when a credential was injected but the kind has no mapped key', () => {
    const step = commandToStep(
      exec('fill_field', { ref: 'e1', value: 'x', is_sensitive: true }, { injectedCredentialKind: 'phone' }),
      1,
      '',
      keyForKind, // no phone key
    );
    expect(step!.value).toBeUndefined();
  });

  it('drops the value when NO credential was injected, even with a mapper', () => {
    // A sensitive field the classifier could not identify: the executor kept the
    // LLM's placeholder, so there is no real credential behind it to bind.
    const step = commandToStep(
      exec('fill_field', { ref: 'e1', value: 'promo-code-123', is_sensitive: true }),
      1,
      '',
      keyForKind,
    );
    expect(step!.value).toBeUndefined();
  });

  it('leaves exploration unchanged — no mapper means the old value-less behaviour', () => {
    const step = commandToStep(
      exec('fill_field', { ref: 'e1', value: 'hunter2', is_sensitive: true }, {
        injectedCredentialKind: 'password',
      }),
      1,
      '',
    );
    expect(step!.value).toBeUndefined();
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

describe('commandToStep — assert_text (deterministic assertion authoring)', () => {
  it('carries the expected value as the step value (load-bearing for text-contains)', () => {
    const step = commandToStep(exec('assert_text', { ref: 'e1', expected: '$126.35' }), 1, '');
    expect(step!.action).toBe('assert');
    expect(step!.value).toBe('$126.35'); // → converter builds assertion.expected from this
    expect(step!.ref).toBe('e1');
    expect(step!.expectedOutcome).toContain('$126.35');
  });

  it('pins a data-testid structural selector from the resolved element', () => {
    const step = commandToStep(
      exec('assert_text', { ref: 'e1', expected: '1 result' }, { resolvedElement: { ref: 'e1', testIdAttr: 'result-count' } }),
      1,
      '',
    );
    expect(step!.selector).toBe('[data-testid="result-count"]');
  });

  it('falls back to an [id="…"] structural selector when there is no testid', () => {
    const step = commandToStep(
      exec('assert_text', { ref: 'e1', expected: '1 result' }, { resolvedElement: { ref: 'e1', id: 'result-count' } }),
      1,
      '',
    );
    expect(step!.selector).toBe('[id="result-count"]');
  });

  it('leaves the selector undefined when the resolved element has no stable identity', () => {
    const step = commandToStep(
      exec('assert_text', { ref: 'e1', expected: '1 result' }, { resolvedElement: { ref: 'e1' } }),
      1,
      '',
    );
    expect(step!.selector).toBeUndefined();
  });

  it('prefers the provided description over the generated one', () => {
    const step = commandToStep(
      exec('assert_text', { ref: 'e1', expected: '1 result', description: 'Result count shows one match' }),
      1,
      '',
    );
    expect(step!.description).toBe('Result count shows one match');
  });
});
