import { IntentStepConverterService } from '../intent-step-converter.service';
import type { IntentStep } from '../preview.types';

/**
 * Scroll-by-container: a scroll step that names a scrollable container by
 * description must forward that description into `intentMeta` so background
 * replay resolves the container (LLM/vision) and scrolls inside it — matching
 * the editor's behaviour. Without forwarding, regression runs silently fall
 * back to page scroll.
 */
describe('IntentStepConverter — scroll container by description', () => {
  it('forwards options.scrollContainerDescription into intentMeta', () => {
    const step: IntentStep = {
      id: 'scroll-1',
      type: 'scroll',
      description: 'Scroll down 300px',
      value: '300,0',
      options: { scrollContainerDescription: 'the comments list' },
    } as IntentStep;

    const cmd = IntentStepConverterService.convertSingleStep(step, 0, 'https://example.com');

    expect((cmd.intentMeta as any)?.scrollContainerDescription).toBe('the comments list');
    // Recorded delta still travels so the scroll distance matches.
    expect(cmd.value).toBe('300,0');
  });

  it('does not set scrollContainerDescription when absent (page scroll)', () => {
    const step: IntentStep = {
      id: 'scroll-2',
      type: 'scroll',
      description: 'Scroll down 300px',
      value: '300,0',
    } as IntentStep;

    const cmd = IntentStepConverterService.convertSingleStep(step, 0, 'https://example.com');

    expect((cmd.intentMeta as any)?.scrollContainerDescription).toBeUndefined();
  });
});
