import { dismissalToStep, buildSelfContainedSteps } from '../overlay-step.util';
import { ESCAPE_KEY, type DismissalAttempt } from '../overlay-dismisser';
import type { DiscoveredStep } from '../types';

const base: DismissalAttempt = {
  ref: 'e5',
  obstacleType: 'cookie_consent',
  recovery: 'dismiss_escape',
  dismissed: true,
  method: 'escape',
};

const URL = 'https://app.example.com/';

describe('dismissalToStep', () => {
  it('maps a successful escape dismissal to a keyless press step', () => {
    const step = dismissalToStep({ ...base, method: 'escape' }, URL, 1);
    expect(step).toMatchObject({
      stepNumber: 1,
      action: 'press',
      value: ESCAPE_KEY,
      pageUrl: URL,
    });
    // No selector/ref needed — Escape is page-level and always replayable.
    expect(step?.ref).toBeUndefined();
    expect(step?.description).toMatch(/cookie_consent/);
  });

  it('drops a dismissal that did not actually dismiss', () => {
    expect(dismissalToStep({ ...base, dismissed: false }, URL, 1)).toBeNull();
  });

  it('maps a button dismissal to a click ONLY with a durable selector', () => {
    const step = dismissalToStep(
      { ...base, method: 'button', ref: '[data-testid="cookie-close"]' },
      URL,
      2,
    );
    expect(step).toMatchObject({ stepNumber: 2, action: 'click', ref: '[data-testid="cookie-close"]' });
  });

  it('drops a button dismissal whose ref is an EPHEMERAL snapshot ref (eN / sN / ifrN_M)', () => {
    for (const ref of ['e12', 's3', 'ifr0_4']) {
      expect(dismissalToStep({ ...base, method: 'button', ref }, URL, 1)).toBeNull();
    }
  });

  it('drops a button dismissal with no usable ref', () => {
    expect(dismissalToStep({ ...base, method: 'button', ref: '' }, URL, 1)).toBeNull();
    expect(dismissalToStep({ ...base, method: 'button', ref: '   ' }, URL, 1)).toBeNull();
  });

  it('drops click_away and wait (no replayable single-step representation)', () => {
    expect(dismissalToStep({ ...base, method: 'click_away' }, URL, 1)).toBeNull();
    expect(dismissalToStep({ ...base, method: 'wait' }, URL, 1)).toBeNull();
  });

  it('drops a dismissal with no method', () => {
    expect(dismissalToStep({ ...base, method: undefined }, URL, 1)).toBeNull();
  });

  it('carries the obstacle type into the description for readability', () => {
    const step = dismissalToStep({ ...base, method: 'escape', obstacleType: 'chat_widget' }, URL, 1);
    expect(step?.description).toMatch(/chat_widget/);
  });

  it('drops a button dismissal with a durable selector that did NOT dismiss', () => {
    expect(
      dismissalToStep({ ...base, method: 'button', ref: '#close', dismissed: false }, URL, 1),
    ).toBeNull();
  });
});

describe('buildSelfContainedSteps', () => {
  const flowStep = (n: number, action: DiscoveredStep['action'] = 'click', value?: string): DiscoveredStep => ({
    stepNumber: n,
    description: `flow step ${n}`,
    action,
    value,
    pageUrl: URL,
  });
  const escapeDismissal = { attempt: { ...base, method: 'escape' as const }, pageUrl: URL };

  it('prepends navigate + dismiss steps before flow steps, 1-based contiguous', () => {
    const out = buildSelfContainedSteps(URL, [escapeDismissal], [flowStep(1), flowStep(2)]);
    expect(out.map((s) => s.action)).toEqual(['navigate', 'press', 'click', 'click']);
    expect(out.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4]); // resequenced
    expect(out[0].value).toBe(URL); // navigate to entry
    expect(out[1].value).toBe(ESCAPE_KEY); // dismiss
  });

  it('does NOT duplicate navigation when the flow already navigates to the entry URL', () => {
    const out = buildSelfContainedSteps(URL, [], [flowStep(1, 'navigate', URL), flowStep(2)]);
    expect(out.filter((s) => s.action === 'navigate')).toHaveLength(1);
    expect(out[0].action).toBe('navigate');
  });

  it('still prepends navigation when the flow navigates to a DIFFERENT url', () => {
    const out = buildSelfContainedSteps(URL, [], [flowStep(1, 'navigate', 'https://other.example/x')]);
    expect(out.filter((s) => s.action === 'navigate')).toHaveLength(2);
    expect(out[0].value).toBe(URL);
  });

  it('skips the leading navigate when entryUrl is empty/whitespace', () => {
    expect(buildSelfContainedSteps('', [], [flowStep(1)]).some((s) => s.action === 'navigate')).toBe(false);
    expect(buildSelfContainedSteps('   ', [], [flowStep(1)])[0].action).toBe('click');
  });

  it('drops non-replayable dismissals (click_away) from the assembled list', () => {
    const out = buildSelfContainedSteps(URL, [
      { attempt: { ...base, method: 'click_away' }, pageUrl: URL },
      escapeDismissal,
    ], [flowStep(1)]);
    // click_away dropped, escape kept → navigate + press + click
    expect(out.map((s) => s.action)).toEqual(['navigate', 'press', 'click']);
  });

  it('preserves flow steps when there is nothing to prepend', () => {
    const out = buildSelfContainedSteps(undefined, [], [flowStep(1), flowStep(2)]);
    expect(out.map((s) => s.action)).toEqual(['click', 'click']);
    expect(out.map((s) => s.stepNumber)).toEqual([1, 2]);
  });
});
