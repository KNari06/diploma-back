import { SafetyGuard, DEFAULT_SAFETY_CONFIG } from '../safety-guard';

const action = (over: any = {}): any => ({ action: 'click', description: 'View dashboard', ...over });
const ctx = (over: any = {}): any => ({ url: 'https://app.com/home', pageType: 'home', warnings: [], ...over });
const state = (over: any = {}): any => ({ pagesAnalyzed: 0, startTime: Date.now(), estimatedCost: 0, errors: [], completedActions: [], ...over });

describe('SafetyGuard.checkAction', () => {
  it('rejects invalid inputs', () => {
    expect(SafetyGuard.checkAction(null as any, ctx())).toMatchObject({ safe: false });
  });

  it('allows a benign action', () => {
    expect(SafetyGuard.checkAction(action(), ctx())).toEqual({ safe: true });
  });

  it('blocks a dangerous keyword in the action (description/selector/value)', () => {
    expect(SafetyGuard.checkAction(action({ description: 'Delete my account' }), ctx())).toMatchObject({ safe: false, requiresApproval: true });
    expect(SafetyGuard.checkAction(action({ description: 'go', value: 'place order' }), ctx())).toMatchObject({ safe: false });
  });

  it('blocks actions on a payment/checkout page but allows read-only ones', () => {
    expect(SafetyGuard.checkAction(action({ description: 'Continue' }), ctx({ pageType: 'payment' }))).toMatchObject({ safe: false, requiresApproval: true });
    expect(SafetyGuard.checkAction(action({ action: 'scroll', description: 'Continue' }), ctx({ pageType: 'checkout' }))).toEqual({ safe: true });
  });

  it('blocks when context warns of a payment form or a CAPTCHA', () => {
    expect(SafetyGuard.checkAction(action({ description: 'Continue' }), ctx({ warnings: ['Payment form present'] }))).toMatchObject({ safe: false });
    expect(SafetyGuard.checkAction(action({ description: 'Continue' }), ctx({ warnings: ['CAPTCHA challenge detected'] }))).toMatchObject({ safe: false });
  });

  it('blocks a forbidden current URL and a forbidden goto target', () => {
    expect(SafetyGuard.checkAction(action({ description: 'open' }), ctx({ url: 'https://app.com/billing' }))).toMatchObject({ safe: false });
    expect(SafetyGuard.checkAction(action({ action: 'goto', description: 'open', url: 'https://app.com/payment' }), ctx())).toMatchObject({ safe: false });
  });

  it('blocks a goto to a domain outside the allowlist and allows one inside it', () => {
    const config = { ...DEFAULT_SAFETY_CONFIG, allowedDomains: ['example.com'] };
    expect(SafetyGuard.checkAction(action({ action: 'goto', description: 'go', url: 'https://evil.com/x' }), ctx(), config)).toMatchObject({ safe: false, requiresApproval: true });
    expect(SafetyGuard.checkAction(action({ action: 'goto', description: 'go', url: 'https://example.com/x' }), ctx(), config)).toEqual({ safe: true });
  });
});

describe('SafetyGuard.checkLimits', () => {
  it('rejects invalid inputs', () => {
    expect(SafetyGuard.checkLimits(null as any)).toMatchObject({ safe: false });
  });

  it('passes when within all limits', () => {
    expect(SafetyGuard.checkLimits(state())).toEqual({ safe: true });
  });

  it('stops at the page limit', () => {
    expect(SafetyGuard.checkLimits(state({ pagesAnalyzed: 10 }))).toMatchObject({ safe: false, reason: expect.stringContaining('Page limit') });
  });

  it('stops at the duration limit', () => {
    expect(SafetyGuard.checkLimits(state({ startTime: Date.now() - 6 * 60 * 1000 }))).toMatchObject({ safe: false, reason: expect.stringContaining('Duration limit') });
  });

  it('stops at the cost limit', () => {
    expect(SafetyGuard.checkLimits(state({ estimatedCost: 0.5 }))).toMatchObject({ safe: false, reason: expect.stringContaining('Cost limit') });
  });

  it('stops on a high error rate (only once enough actions ran)', () => {
    const errs = Array.from({ length: 6 }, (_, i) => ({ i }));
    const acts = Array.from({ length: 10 }, (_, i) => ({ i }));
    expect(SafetyGuard.checkLimits(state({ errors: errs, completedActions: acts }))).toMatchObject({ safe: false, reason: expect.stringContaining('error rate') });
    // few actions → error-rate gate does not fire
    expect(SafetyGuard.checkLimits(state({ errors: [{}, {}, {}], completedActions: [{}, {}, {}] }))).toEqual({ safe: true });
  });

  it('tolerates malformed state fields without throwing', () => {
    expect(SafetyGuard.checkLimits(state({ pagesAnalyzed: NaN, estimatedCost: -5, errors: 'nope', completedActions: null }))).toEqual({ safe: true });
  });
});
