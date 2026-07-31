import { IntentStepConverterService } from '../intent-step-converter.service';
import type { IntentStep } from '../preview.types';

/**
 * Author-disabled steps (`options.enabled === false`) must never become
 * Playwright commands.
 *
 * The filtering happens in the converter rather than inside the executor loop
 * on purpose: the executor's step counter feeds credit memos, screenshot
 * filenames, `executed_steps` rows and its own `commands[currentStepIndex]`
 * lookahead, so skipping mid-loop would leave a hole in the persisted sequence
 * and bill a step that never ran.
 */
describe('IntentStepConverter — author-disabled steps', () => {
  const START_URL = 'https://example.com';

  const step = (id: string, over: Partial<IntentStep> = {}): IntentStep =>
    ({ id, type: 'click', description: id, ...over } as IntentStep);

  const disabled = (id: string, over: Partial<IntentStep> = {}): IntentStep =>
    step(id, { ...over, options: { ...(over.options ?? {}), enabled: false } });

  /** Commands minus the synthetic initial `goto` the converter always prepends. */
  const stepCommandsOf = (steps: IntentStep[]) =>
    IntentStepConverterService.convertToCommands(steps, START_URL).slice(1);

  it('omits a disabled step from the emitted commands', () => {
    const commands = stepCommandsOf([step('a'), disabled('b'), step('c')]);

    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.intentMeta?.stepId)).toEqual(['a', 'c']);
  });

  it('keeps steps with enabled:true and steps with no flag at all', () => {
    const commands = stepCommandsOf([
      step('a'),
      step('b', { options: { enabled: true } }),
    ]);

    expect(commands.map((c) => c.intentMeta?.stepId)).toEqual(['a', 'b']);
  });

  it('still prepends the initial goto when every step is disabled', () => {
    // The initial navigation is not a user step — it must survive so the run
    // lands on the right page instead of about:blank.
    const all = IntentStepConverterService.convertToCommands(
      [disabled('a'), disabled('b')],
      START_URL,
    );

    expect(all).toHaveLength(1);
    expect(all[0].action).toBe('goto');
    expect(all[0].url).toBe(START_URL);
  });

  it('preserves other option fields on a step that is left enabled', () => {
    const commands = stepCommandsOf([
      step('a', { options: { enabled: true, continueOnError: true } }),
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0].continueOnError).toBe(true);
  });

  it('pairs the awaitNavigation lookahead across a disabled neighbour', () => {
    // The lookahead marks a click as navigation-awaiting when the NEXT step is
    // a `wait_for` with a URL change. Filtering before the loop is what keeps
    // that pairing correct when a disabled step sits between the two — a
    // mid-loop skip would compare against the disabled step and lose the flag.
    const waitFor = step('w', {
      type: 'wait_for',
      options: { urlMatcher: { changedFrom: START_URL } },
    });

    const commands = stepCommandsOf([step('click-me'), disabled('off'), waitFor]);

    expect(commands.map((c) => c.intentMeta?.stepId)).toEqual(['click-me', 'w']);
    expect(commands[0].awaitNavigation).toBe(true);
  });

  it('does not mark awaitNavigation when the wait_for itself is disabled', () => {
    const disabledWaitFor = disabled('w', {
      type: 'wait_for',
      options: { urlMatcher: { changedFrom: START_URL } },
    });

    const commands = stepCommandsOf([step('click-me'), disabledWaitFor]);

    expect(commands).toHaveLength(1);
    expect(commands[0].awaitNavigation).toBeUndefined();
  });
});
