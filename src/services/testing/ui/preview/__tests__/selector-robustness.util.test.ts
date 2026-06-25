/**
 * #4 — Selector robustness scorer (pure, advisory).
 */

import { computeSelectorRobustness } from '../selector-robustness.util';
import type { TargetFingerprint } from '../preview.types';

const fp = (o: Partial<TargetFingerprint>): TargetFingerprint => ({ tag: 'button', ...o }) as TargetFingerprint;

describe('computeSelectorRobustness', () => {
  it('rates a stable testId as strong', () => {
    const r = computeSelectorRobustness(fp({ testIdAttr: 'submit-btn' }));
    expect(r.level).toBe('strong');
    expect(r.score).toBe(0.9);
    expect(r.risks).toEqual([]);
  });

  it('rates a non-dynamic id as strong', () => {
    expect(computeSelectorRobustness(fp({ elementId: 'login' })).level).toBe('strong');
  });

  it('rates role + accessible name as strong (slightly below identity)', () => {
    const r = computeSelectorRobustness(fp({ role: 'button', text: 'Start for free' }));
    expect(r.level).toBe('strong');
    expect(r.score).toBe(0.82);
  });

  it('rates a placeholder-only input as medium', () => {
    const r = computeSelectorRobustness(fp({ tag: 'input', placeholder: 'Email' }));
    expect(r.level).toBe('medium');
    expect(r.score).toBe(0.6);
  });

  it('rates a bare element with no anchors as weak', () => {
    const r = computeSelectorRobustness(fp({ tag: 'div' }));
    expect(r.level).toBe('weak');
    expect(r.risks).toContain('no_durable_anchor');
  });

  it('forces weak + cross_origin regardless of how rich the fingerprint looks', () => {
    const r = computeSelectorRobustness(fp({ testIdAttr: 'x', role: 'button', text: 'Login' }), { crossOriginIframe: true });
    expect(r.level).toBe('weak');
    expect(r.score).toBe(0.15);
    expect(r.risks).toContain('cross_origin');
  });

  it('flags an image target', () => {
    const r = computeSelectorRobustness(fp({ tag: 'img', alt: 'Company logo' }));
    expect(r.risks).toContain('image_target');
  });

  it('flags icon-only when only an icon hint is present', () => {
    const r = computeSelectorRobustness(fp({ tag: 'span', iconLabel: 'menu' }));
    expect(r.risks).toContain('icon_only');
  });

  it('flags text_only for a role-less text node', () => {
    const r = computeSelectorRobustness(fp({ tag: 'span', text: 'Подписать' }));
    expect(r.risks).toContain('text_only');
  });
});
