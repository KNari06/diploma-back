import { ActionPatternDetector } from '../action-pattern-detector';

// ActionResult-shaped builder. Defaults: a successful click that navigated.
const A = (action: string, over: any = {}): any => ({
  action: {
    action,
    selector: over.selector ?? '#x',
    description: over.description ?? '',
  },
  success: over.success ?? true,
  error: over.error,
  urlChanged: over.urlChanged ?? true,
  urlAfter: over.urlAfter ?? 'http://x/1',
});

const state = (completedActions: any[]): any => ({ completedActions });
const find = (res: any, type: string) => res.patterns.find((p: any) => p.type === type);

describe('detectPatterns — no patterns', () => {
  it('reports nothing for an empty action list', () => {
    const res = ActionPatternDetector.detectPatterns(state([]));
    expect(res).toMatchObject({ hasPattern: false, shouldStop: false, patterns: [] });
  });
});

describe('detectPatterns — repeated actions', () => {
  it('flags 4 identical consecutive actions as critical', () => {
    const acts = Array.from({ length: 4 }, () => A('click', { selector: '#btn' }));
    const res = ActionPatternDetector.detectPatterns(state(acts));
    const p = find(res, 'repeated_action');
    expect(p?.severity).toBe('critical');
    expect(res.shouldStop).toBe(true);
  });

  it('flags 3 identical consecutive actions as high (no stop)', () => {
    const acts = Array.from({ length: 3 }, () => A('click', { selector: '#btn' }));
    const res = ActionPatternDetector.detectPatterns(state(acts));
    expect(find(res, 'repeated_action')?.severity).toBe('high');
    expect(res.shouldStop).toBe(false);
  });

  it('ignores a repeated fill that follows a validation error (normal retry)', () => {
    const acts = [
      A('fill', { selector: '#email' }),
      A('fill', { selector: '#email', success: false, error: 'validation failed' }),
      A('fill', { selector: '#email' }),
    ];
    const res = ActionPatternDetector.detectPatterns(state(acts));
    expect(find(res, 'repeated_action')).toBeUndefined();
  });
});

describe('detectPatterns — failed chains', () => {
  it('flags 5 consecutive failures as critical', () => {
    const acts = Array.from({ length: 5 }, (_, i) =>
      A('click', { selector: `#s${i}`, success: false, error: 'not found', urlAfter: `http://x/${i}` }),
    );
    const res = ActionPatternDetector.detectPatterns(state(acts));
    expect(find(res, 'failed_chain')?.severity).toBe('critical');
    expect(res.shouldStop).toBe(true);
  });

  it('flags 3 consecutive failures as high', () => {
    const acts = Array.from({ length: 3 }, (_, i) =>
      A('click', { selector: `#s${i}`, success: false, error: 'not found', urlAfter: `http://x/${i}` }),
    );
    expect(find(ActionPatternDetector.detectPatterns(state(acts)), 'failed_chain')?.severity).toBe('high');
  });

  it('does not flag failures broken by a success', () => {
    const acts = [
      A('click', { selector: '#a', success: false, error: 'x', urlAfter: 'http://x/a' }),
      A('click', { selector: '#b', urlAfter: 'http://x/b' }),
      A('click', { selector: '#c', success: false, error: 'x', urlAfter: 'http://x/c' }),
      A('click', { selector: '#d', success: false, error: 'x', urlAfter: 'http://x/d' }),
    ];
    expect(find(ActionPatternDetector.detectPatterns(state(acts)), 'failed_chain')).toBeUndefined();
  });
});

describe('detectPatterns — timeout chains', () => {
  it('flags 2 consecutive timeouts as high', () => {
    const acts = Array.from({ length: 2 }, (_, i) =>
      A('click', { selector: `#s${i}`, success: false, error: 'Timeout 30000ms exceeded', urlAfter: `http://x/${i}` }),
    );
    const res = ActionPatternDetector.detectPatterns(state(acts));
    expect(find(res, 'timeout_chain')?.severity).toBe('high');
    expect(res.shouldStop).toBe(false);
  });

  it('flags 3 consecutive timeouts as critical', () => {
    const acts = Array.from({ length: 3 }, (_, i) =>
      A('click', { selector: `#s${i}`, success: false, error: 'timeout exceeded', urlAfter: `http://x/${i}` }),
    );
    const res = ActionPatternDetector.detectPatterns(state(acts));
    expect(find(res, 'timeout_chain')?.severity).toBe('critical');
    expect(res.shouldStop).toBe(true);
  });
});

describe('detectPatterns — stuck state', () => {
  it('flags a medium stuck state when actions do not navigate but some succeed', () => {
    const acts = [
      A('click', { selector: '#a', success: false, error: 'x', urlChanged: false, urlAfter: 'http://x/p' }),
      A('click', { selector: '#b', success: false, error: 'x', urlChanged: false, urlAfter: 'http://x/p' }),
      A('click', { selector: '#c', success: false, error: 'x', urlChanged: false, urlAfter: 'http://x/p' }),
      A('click', { selector: '#d', urlChanged: false, urlAfter: 'http://x/p' }),
      A('click', { selector: '#e', urlChanged: false, urlAfter: 'http://x/p' }),
    ];
    expect(find(ActionPatternDetector.detectPatterns(state(acts)), 'stuck')?.severity).toBe('medium');
  });

  it('ignores no-navigation actions that are modal interactions (SPA pattern)', () => {
    const acts = Array.from({ length: 5 }, (_, i) =>
      A('click', { selector: `#s${i}`, description: 'open modal', urlChanged: false, urlAfter: 'http://x/p' }),
    );
    expect(find(ActionPatternDetector.detectPatterns(state(acts)), 'stuck')).toBeUndefined();
  });
});

describe('shouldStopTest & getRecommendations', () => {
  const criticalState = state(Array.from({ length: 4 }, () => A('click', { selector: '#btn' })));

  it('shouldStopTest returns true with a reason for a critical pattern', () => {
    const r = ActionPatternDetector.shouldStopTest(criticalState);
    expect(r.shouldStop).toBe(true);
    expect(typeof r.reason).toBe('string');
  });

  it('shouldStopTest returns false when no critical pattern exists', () => {
    const r = ActionPatternDetector.shouldStopTest(state([A('click', { selector: '#a' })]));
    expect(r).toEqual({ shouldStop: false });
  });

  it('getRecommendations returns the suggestions for detected patterns', () => {
    const recs = ActionPatternDetector.getRecommendations(criticalState);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.some(r => /repeating/i.test(r))).toBe(true);
  });
});
