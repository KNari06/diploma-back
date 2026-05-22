import { shouldOpenAsNewTab } from '../new-tab-opener';

describe('shouldOpenAsNewTab', () => {
  const here = 'https://example.com/page';

  it('returns null for non-anchor probes', () => {
    expect(shouldOpenAsNewTab({ tag: 'button', href: 'https://example.com' }, here)).toBeNull();
    expect(shouldOpenAsNewTab({ tag: 'div' }, here)).toBeNull();
  });

  it('returns null when href is missing', () => {
    expect(shouldOpenAsNewTab({ tag: 'a' }, here)).toBeNull();
  });

  it('returns null for non-http(s) schemes', () => {
    expect(shouldOpenAsNewTab({ tag: 'a', href: 'mailto:user@x.com' }, here)).toBeNull();
    expect(shouldOpenAsNewTab({ tag: 'a', href: 'javascript:void(0)' }, here)).toBeNull();
    expect(shouldOpenAsNewTab({ tag: 'a', href: 'tel:+123456' }, here)).toBeNull();
    expect(shouldOpenAsNewTab({ tag: 'a', href: 'data:text/plain,x' }, here)).toBeNull();
  });

  it('returns null for in-page hash jumps on the same path+query', () => {
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://example.com/page#section-2' }, here),
    ).toBeNull();
  });

  it('promotes anchors with target=_blank to new tab (explicit)', () => {
    const result = shouldOpenAsNewTab(
      { tag: 'a', href: 'https://example.com/page2', target: '_blank' },
      here,
    );
    expect(result).toEqual({
      reason: 'explicit_target',
      href: 'https://example.com/page2',
      target: '_blank',
    });
  });

  it('promotes anchors with a named target to new tab', () => {
    const result = shouldOpenAsNewTab(
      { tag: 'a', href: 'https://example.com/page2', target: 'preview' },
      here,
    );
    expect(result?.reason).toBe('explicit_target');
    expect(result?.target).toBe('preview');
  });

  it('does NOT promote target=_self / _top / _parent (case-insensitive)', () => {
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://example.com/x', target: '_self' }, here),
    ).toBeNull();
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://example.com/x', target: '_TOP' }, here),
    ).toBeNull();
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://example.com/x', target: '_Parent' }, here),
    ).toBeNull();
  });

  it('promotes cross-origin anchors without explicit target', () => {
    const result = shouldOpenAsNewTab(
      { tag: 'a', href: 'https://other-site.com/landing' },
      here,
    );
    expect(result).toEqual({
      reason: 'cross_origin_anchor',
      href: 'https://other-site.com/landing',
    });
  });

  it('does NOT promote same-origin anchors without target', () => {
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://example.com/other' }, here),
    ).toBeNull();
  });

  it('treats subdomain variants as same-app (no promotion)', () => {
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://www.example.com/x' }, here),
    ).toBeNull();
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://api.example.com/x' }, here),
    ).toBeNull();
    // last-2-labels rule: same registrable domain → same app.
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://billing.example.com/x' }, here),
    ).toBeNull();
  });

  it('still promotes explicit target=_blank even on same origin (user authored intent)', () => {
    const result = shouldOpenAsNewTab(
      { tag: 'a', href: 'https://example.com/print', target: '_blank' },
      here,
    );
    expect(result?.reason).toBe('explicit_target');
  });

  it('survives unparseable currentUrl (still honours explicit target)', () => {
    expect(
      shouldOpenAsNewTab({ tag: 'a', href: 'https://x.com', target: '_blank' }, 'about:blank')
        ?.reason,
    ).toBe('explicit_target');
  });
});
