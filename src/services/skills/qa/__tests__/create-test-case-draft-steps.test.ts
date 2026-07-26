import { stepsMatchCachedDraft } from '../qa-tool-handlers';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

/**
 * `handleCreateTestCase` prefers the SERVER's cached draft over the steps the
 * model re-emits, because only the cache carries the compiled locator plans.
 *
 * That preference must NOT be unconditional: the editor prompt tells the model
 * to reuse the cached steps when the user asks to run, save, OR MODIFY them, so
 * a "save it, but drop the last step" turn re-emits a deliberately different
 * array — and nothing rewrites the cache on that path. Preferring the cache
 * there would silently discard the user's edit and then report the cached count
 * back, so the confirmation would look correct.
 */
const step = (over: Partial<IntentStep>): IntentStep => ({
  id: 'a', type: 'click', description: 'x', ...over,
} as IntentStep);

describe('stepsMatchCachedDraft', () => {
  it('matches when the model echoed the draft faithfully', () => {
    const cached = [step({ id: '1', type: 'type', value: 'hello' }), step({ id: '2' })];
    const fromModel = [step({ id: '1', type: 'type', value: 'hello' }), step({ id: '2' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(true);
  });

  it('does NOT match when the user dropped a step', () => {
    const cached = [step({ id: '1' }), step({ id: '2' }), step({ id: '3' })];
    const fromModel = [step({ id: '1' }), step({ id: '2' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(false);
  });

  it('does NOT match when the user changed a typed value', () => {
    const cached = [step({ type: 'type', value: 'old@example.com' })];
    const fromModel = [step({ type: 'type', value: 'new@example.com' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(false);
  });

  it('does NOT match when the user changed an assertion', () => {
    const cached = [step({ type: 'ai_check', assertionText: 'shows the dashboard' })];
    const fromModel = [step({ type: 'ai_check', assertionText: 'shows an error' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(false);
  });

  it('does NOT match when a step type changed', () => {
    expect(stepsMatchCachedDraft([step({ type: 'click' })], [step({ type: 'type' })])).toBe(false);
  });

  it('ignores whitespace-only differences the model introduces', () => {
    const cached = [step({ type: 'type', value: 'hello' })];
    const fromModel = [step({ type: 'type', value: '  hello ' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(true);
  });

  it('ignores the fields the model is EXPECTED to drop (compiled plans, evidence)', () => {
    // This is the whole reason to prefer the cache — the model's copy loses
    // these, and restoring them is the point.
    const cached = [step({
      id: '1',
      type: 'click',
      compiled: {
        locatorPlan: [{ strategy: 'testId', value: 'submit', confidence: 0.9 }],
        action: { type: 'click' },
        context: { pageUrl: 'https://app.test', compiledAt: '2026-07-25T00:00:00Z' },
      },
    } as unknown as Partial<IntentStep>)];
    const fromModel = [step({ id: '1', type: 'click' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(true);
  });

  it('preserves a frozen credential placeholder as a value difference when the model mangles it', () => {
    const cached = [step({ type: 'type', value: '{{secrets.login_password}}' })];
    const fromModel = [step({ type: 'type', value: '{{password}}' })];

    expect(stepsMatchCachedDraft(fromModel, cached)).toBe(false);
  });
});
