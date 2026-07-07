import {
  parseAncestorAnchors,
  buildChildSelectors,
  buildAncestorScopedLocators,
} from '../ancestor-scoped-locator.util';
import type { InteractiveNode, TargetFingerprint } from '../preview.types';

const node = (fields: Partial<InteractiveNode> = {}): InteractiveNode =>
  ({ tag: 'svg', ref: 'e1', ...fields }) as InteractiveNode;

const fp = (fields: Partial<TargetFingerprint> = {}): TargetFingerprint => ({
  ancestorSummary: 'header#layout-header > div.icon-group > svg',
  ...fields,
});

describe('parseAncestorAnchors', () => {
  it('extracts #id anchors, innermost first, and skips the target segment', () => {
    const anchors = parseAncestorAnchors('header#layout-header > div#inner > svg');
    expect(anchors).toEqual([
      { tag: 'div', kind: 'id', value: 'inner' },
      { tag: 'header', kind: 'id', value: 'layout-header' },
    ]);
  });

  it('extracts data-testid anchors', () => {
    const anchors = parseAncestorAnchors('nav[data-testid=main-nav] > ul > li');
    expect(anchors).toEqual([{ tag: 'nav', kind: 'testId', value: 'main-nav' }]);
  });

  it('skips role, text, and class segments — weak anchors are not scoping material', () => {
    expect(parseAncestorAnchors("form[role=form] > div[text='Login'] > span.icon > button")).toEqual([]);
  });

  it('returns empty for missing or single-segment summaries', () => {
    expect(parseAncestorAnchors(undefined)).toEqual([]);
    expect(parseAncestorAnchors('button')).toEqual([]);
  });
});

describe('buildChildSelectors', () => {
  it('prefers aria-label over text', () => {
    const sel = buildChildSelectors({ tag: 'button', ariaLabel: 'Close dialog', text: 'X' });
    expect(sel[0]).toBe('button[aria-label="Close dialog"]');
  });

  it('uses has-text for short visible text', () => {
    expect(buildChildSelectors({ tag: 'button', text: 'Войти' })).toEqual([
      'button:has-text("Войти")',
    ]);
  });

  it('skips text above the drift cap but keeps other channels', () => {
    const longText = 'a'.repeat(60);
    expect(buildChildSelectors({ tag: 'button', text: longText })).toEqual([]);
  });

  it('falls back to the bare tag only for narrow tags', () => {
    expect(buildChildSelectors({ tag: 'svg' })).toEqual(['svg']);
    expect(buildChildSelectors({ tag: 'div' })).toEqual([]);
  });
});

describe('buildAncestorScopedLocators', () => {
  it('builds a scoped chain for an icon-only target inside an anchored ancestor', () => {
    const entries = buildAncestorScopedLocators({ fingerprint: fp(), node: node() });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      strategy: 'css',
      value: '#layout-header svg',
      tier: 'STRUCTURAL',
    });
  });

  it('combines a testId ancestor with a has-text child', () => {
    const entries = buildAncestorScopedLocators({
      fingerprint: fp({ ancestorSummary: 'nav[data-testid=main-nav] > div > button' }),
      node: node({ tag: 'button', text: 'Войти' }),
    });
    expect(entries.map((e) => e.value)).toEqual(['[data-testid="main-nav"] button:has-text("Войти")']);
  });

  it('returns nothing when the target has its own strong identity', () => {
    expect(
      buildAncestorScopedLocators({ fingerprint: fp(), node: node({ testIdAttr: 'login-btn' }) }),
    ).toEqual([]);
    expect(
      buildAncestorScopedLocators({ fingerprint: fp(), node: node({ id: 'stable-id' }) }),
    ).toEqual([]);
  });

  it('still scopes when the target id is dynamic', () => {
    const entries = buildAncestorScopedLocators({
      fingerprint: fp(),
      node: node({ id: 'radix-:r6:', isDynamicId: true }),
    });
    expect(entries).toHaveLength(1);
  });

  it('returns nothing without an ancestorSummary or without anchors', () => {
    expect(buildAncestorScopedLocators({ fingerprint: undefined, node: node() })).toEqual([]);
    expect(
      buildAncestorScopedLocators({
        fingerprint: fp({ ancestorSummary: 'div.wrapper > span.icon > svg' }),
        node: node(),
      }),
    ).toEqual([]);
  });

  it('caps the number of emitted entries', () => {
    const entries = buildAncestorScopedLocators({
      fingerprint: fp({ ancestorSummary: 'div#a > div#b > button' }),
      node: node({ tag: 'button', ariaLabel: 'Sign in', text: 'Войти' }),
    });
    expect(entries.length).toBeLessThanOrEqual(3);
    // Innermost anchor first.
    expect(entries[0].value.startsWith('#b ')).toBe(true);
  });

  it('escapes CSS metacharacters in anchors and children', () => {
    const entries = buildAncestorScopedLocators({
      fingerprint: fp({ ancestorSummary: 'div#app:main > svg' }),
      node: node({ ariaLabel: 'say "hi"' }),
    });
    expect(entries[0].value).toBe('#app\\:main svg[aria-label="say \\"hi\\""]');
  });
});
