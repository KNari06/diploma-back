/**
 * Unit tests for cdp-snapshot.service internal helpers (Etap 2 Task 2.7).
 *
 * Scope:
 *   - Pure functions only (no Page / CDP mock)
 *   - Symmetry contract: each helper either matches existing
 *     snapshot-collector.ts logic byte-for-byte (tests assert that)
 *     OR is genuinely new (privacy/sensitive flag derivation,
 *     attribute-based framework detection without runtime probing)
 *
 * What these tests DO NOT cover:
 *   - End-to-end `CdpSnapshotService.collect` (that's the next test
 *     file — needs Page/CDP mocks)
 *   - Runtime evaluate phase 4 logic (lives in browser context, can
 *     only be verified via integration test with real Chromium)
 *   - Modal detection Layer 1 (covered by integration tests since it
 *     requires DS bundle shape)
 */

import { __internalsForTesting } from '../cdp-snapshot.service';
import type { LiteElement } from '@/agent/core/lite/lite-types';

const {
  decodeAttributes,
  decodeStylesForLayoutIdx,
  decodeBoundsForLayoutIdx,
  isInteractiveNode,
  parseTriState,
  parseAriaChecked,
  parseFloatOrUndefined,
  parseTabIndex,
  tagToImplicitLandmarkRole,
  computeIsSensitiveInput,
  detectAttributeBasedFramework,
} = __internalsForTesting;

// ─────────────────────────────────────────────────────────────────
// String table helper — used across all DS-decode tests below.
// Keeps the strings array close to the indexes for readability.
// ─────────────────────────────────────────────────────────────────
function makeStringTable(strings: string[]) {
  return (idx: number | undefined): string => {
    if (typeof idx !== 'number' || idx < 0 || idx >= strings.length) return '';
    return String(strings[idx] ?? '');
  };
}

describe('decodeAttributes', () => {
  it('decodes flat [nameIdx, valueIdx, ...] array into Map', () => {
    const getStr = makeStringTable(['', 'id', 'submit', 'class', 'btn primary']);
    const result = decodeAttributes([1, 2, 3, 4], getStr);
    expect(result.get('id')).toBe('submit');
    expect(result.get('class')).toBe('btn primary');
    expect(result.size).toBe(2);
  });

  it('lowercases attribute names so consumers can lookup case-insensitively', () => {
    // Browsers normalize HTML attribute names to lowercase, but DS
    // could theoretically expose them otherwise (XHTML, custom names).
    // We force lowercase for predictable lookup.
    const getStr = makeStringTable(['', 'DATA-Test-ID', 'val']);
    const result = decodeAttributes([1, 2], getStr);
    expect(result.get('data-test-id')).toBe('val');
    expect(result.get('DATA-Test-ID')).toBeUndefined();
  });

  it('returns empty map for non-array input', () => {
    const getStr = makeStringTable([]);
    expect(decodeAttributes(undefined, getStr).size).toBe(0);
    expect(decodeAttributes(null, getStr).size).toBe(0);
    expect(decodeAttributes('not-array', getStr).size).toBe(0);
  });

  it('skips entries with empty/missing name (string idx out of range)', () => {
    // Out-of-range string index → getStr returns '' → empty name → skip.
    const getStr = makeStringTable(['', 'val']);
    const result = decodeAttributes([999, 1], getStr); // 999 is OOB
    expect(result.size).toBe(0);
  });

  it('handles odd-length arrays by ignoring the trailing orphan', () => {
    // Defensive: real DS shouldn't emit odd-length but we shouldn't crash.
    const getStr = makeStringTable(['', 'id', 'submit', 'orphan']);
    const result = decodeAttributes([1, 2, 3], getStr);
    expect(result.get('id')).toBe('submit');
    expect(result.size).toBe(1);
  });
});

describe('decodeStylesForLayoutIdx', () => {
  it('decodes 10-style slot in REQUESTED_COMPUTED_STYLES order', () => {
    const getStr = makeStringTable([
      '',
      'block', 'visible', '1', 'pointer', 'auto',
      'static', 'auto', 'rgb(255, 0, 0)', 'rgb(0, 0, 0)', '4px',
    ]);
    const layout = {
      styles: [
        // layoutIdx=0: indexes into the string table above
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      ],
    };
    const result = decodeStylesForLayoutIdx(layout, 0, getStr);
    expect(result).toEqual({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      cursor: 'pointer',
      pointerEvents: 'auto',
      position: 'static',
      zIndex: 'auto',
      backgroundColor: 'rgb(255, 0, 0)',
      color: 'rgb(0, 0, 0)',
      borderRadius: '4px',
    });
  });

  it('returns undefined when layout.styles missing', () => {
    const getStr = makeStringTable([]);
    expect(decodeStylesForLayoutIdx({}, 0, getStr)).toBeUndefined();
  });

  it('returns undefined when layoutIdx out of range', () => {
    const getStr = makeStringTable(['', 'block']);
    const layout = { styles: [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]] };
    expect(decodeStylesForLayoutIdx(layout, 5, getStr)).toBeUndefined();
  });
});

describe('decodeBoundsForLayoutIdx', () => {
  it('extracts [x, y, w, h] tuple', () => {
    const layout = {
      bounds: [
        [10, 20, 100, 50],
        [200, 300, 80, 40],
      ],
    };
    expect(decodeBoundsForLayoutIdx(layout, 0)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(decodeBoundsForLayoutIdx(layout, 1)).toEqual({ x: 200, y: 300, width: 80, height: 40 });
  });

  it('returns undefined for missing bounds entry', () => {
    expect(decodeBoundsForLayoutIdx({}, 0)).toBeUndefined();
    expect(decodeBoundsForLayoutIdx({ bounds: [] }, 0)).toBeUndefined();
  });

  it('returns undefined for malformed bounds (less than 4 numbers)', () => {
    // Defensive — real DS always returns 4. We shouldn't crash if
    // something upstream truncates.
    const layout = { bounds: [[10, 20, 100]] };
    expect(decodeBoundsForLayoutIdx(layout, 0)).toBeUndefined();
  });
});

describe('isInteractiveNode', () => {
  // Tier-1 native interactive tags
  it('keeps native interactive tags + summary structural tag', () => {
    // After May 2026 symmetry fix: <label> and <details> dropped
    // from INTERACTIVE_TAGS (evaluate-path doesn't treat them as
    // interactive — they're structural). <summary> kept because
    // evaluate-path includes it in its selector list.
    const noAttrs = new Map<string, string>();
    expect(isInteractiveNode('button', noAttrs, undefined)).toBe(true);
    expect(isInteractiveNode('a', noAttrs, undefined)).toBe(true);
    expect(isInteractiveNode('input', noAttrs, undefined)).toBe(true);
    expect(isInteractiveNode('select', noAttrs, undefined)).toBe(true);
    expect(isInteractiveNode('textarea', noAttrs, undefined)).toBe(true);
    expect(isInteractiveNode('option', noAttrs, undefined)).toBe(true);
    expect(isInteractiveNode('summary', noAttrs, undefined)).toBe(true);
    // <label> and <details> excluded — they were causing CDP to
    // return ~2 extra elements per form vs evaluate (false positives
    // the LLM resolver could never pick correctly anyway).
    expect(isInteractiveNode('label', noAttrs, undefined)).toBe(false);
    expect(isInteractiveNode('details', noAttrs, undefined)).toBe(false);
  });

  // Tier-1 interactive ARIA roles on non-native tags
  it('keeps div/span when role is interactive', () => {
    expect(isInteractiveNode('div', new Map([['role', 'button']]), undefined)).toBe(true);
    expect(isInteractiveNode('span', new Map([['role', 'link']]), undefined)).toBe(true);
    expect(isInteractiveNode('div', new Map([['role', 'menuitem']]), undefined)).toBe(true);
    expect(isInteractiveNode('div', new Map([['role', 'checkbox']]), undefined)).toBe(true);
  });

  it('lowercases role for matching (some sites emit role="BUTTON")', () => {
    expect(isInteractiveNode('div', new Map([['role', 'BUTTON']]), undefined)).toBe(true);
  });

  // Tier-1 tabindex >= 0
  it('keeps element with explicit tabindex 0 or positive', () => {
    expect(isInteractiveNode('div', new Map([['tabindex', '0']]), undefined)).toBe(true);
    expect(isInteractiveNode('div', new Map([['tabindex', '5']]), undefined)).toBe(true);
  });

  it('skips element with tabindex=-1 (programmatic focus only, not user-tabbable)', () => {
    // tabindex=-1 explicitly means "skip in tab order" — same semantic
    // as the current collector. Otherwise focus-trap divs spam the
    // candidates list.
    expect(isInteractiveNode('div', new Map([['tabindex', '-1']]), undefined)).toBe(false);
  });

  it('skips invalid tabindex (non-numeric) on non-interactive tag', () => {
    expect(isInteractiveNode('div', new Map([['tabindex', 'abc']]), undefined)).toBe(false);
  });

  // Tier-2 cursor:pointer
  it('keeps non-interactive tag with cursor:pointer (framework-bound)', () => {
    const styles = makeStyles({ cursor: 'pointer' });
    expect(isInteractiveNode('div', new Map(), styles)).toBe(true);
  });

  it('skips non-interactive tag without any signal', () => {
    const styles = makeStyles({ cursor: 'auto' });
    expect(isInteractiveNode('div', new Map(), styles)).toBe(false);
    expect(isInteractiveNode('span', new Map(), undefined)).toBe(false);
  });
});

describe('parseTriState', () => {
  it('returns true for "true"', () => {
    expect(parseTriState('true')).toBe(true);
  });
  it('returns false for "false"', () => {
    expect(parseTriState('false')).toBe(false);
  });
  it('returns undefined for missing or invalid value', () => {
    expect(parseTriState(undefined)).toBeUndefined();
    expect(parseTriState('')).toBeUndefined();
    expect(parseTriState('yes')).toBeUndefined();
    expect(parseTriState('1')).toBeUndefined();
  });
});

describe('parseAriaChecked', () => {
  it('handles "mixed" tri-state for indeterminate checkboxes', () => {
    expect(parseAriaChecked('mixed')).toBe('mixed');
    expect(parseAriaChecked('true')).toBe(true);
    expect(parseAriaChecked('false')).toBe(false);
    expect(parseAriaChecked(undefined)).toBeUndefined();
  });
});

describe('parseFloatOrUndefined', () => {
  it('parses numeric strings', () => {
    expect(parseFloatOrUndefined('42')).toBe(42);
    expect(parseFloatOrUndefined('3.14')).toBeCloseTo(3.14);
    expect(parseFloatOrUndefined('-1')).toBe(-1);
  });
  it('returns undefined for empty/missing/non-numeric', () => {
    expect(parseFloatOrUndefined(undefined)).toBeUndefined();
    expect(parseFloatOrUndefined('')).toBeUndefined();
    expect(parseFloatOrUndefined('foo')).toBeUndefined();
  });
});

describe('parseTabIndex', () => {
  it('preserves negative explicit values (tabindex=-1 has its own meaning)', () => {
    expect(parseTabIndex('-1')).toBe(-1);
  });
  it('parses positive zero and positive values', () => {
    expect(parseTabIndex('0')).toBe(0);
    expect(parseTabIndex('3')).toBe(3);
  });
  it('returns undefined for missing or non-numeric', () => {
    expect(parseTabIndex(undefined)).toBeUndefined();
    expect(parseTabIndex('abc')).toBeUndefined();
  });
});

describe('tagToImplicitLandmarkRole', () => {
  // Spec: HTML5 sectioning → ARIA role mapping. Simplified — we don't
  // do the contextual rules (top-level vs nested header), since
  // consumer reads it as a hint.
  it.each([
    ['header', 'banner'],
    ['footer', 'contentinfo'],
    ['nav', 'navigation'],
    ['main', 'main'],
    ['aside', 'complementary'],
    ['form', 'form'],
  ])('maps <%s> to %s', (tag, role) => {
    expect(tagToImplicitLandmarkRole(tag)).toBe(role);
  });

  it('returns undefined for non-landmark tags', () => {
    expect(tagToImplicitLandmarkRole('div')).toBeUndefined();
    expect(tagToImplicitLandmarkRole('article')).toBeUndefined(); // article isn't a landmark
    expect(tagToImplicitLandmarkRole('button')).toBeUndefined();
  });
});

describe('computeIsSensitiveInput', () => {
  // Privacy CRITICAL: any false-negative here means a password value
  // gets `hasValue: true` reported through WS pipe — never raw, but
  // presence-leak. Tests below mirror the existing snapshot-collector
  // logic exactly.

  it('returns false for non-input tags', () => {
    expect(computeIsSensitiveInput(makeElement({ tag: 'div' }))).toBe(false);
    expect(computeIsSensitiveInput(makeElement({ tag: 'button' }))).toBe(false);
  });

  it('returns true for type="password"', () => {
    expect(computeIsSensitiveInput(makeElement({ tag: 'input', type: 'password' }))).toBe(true);
  });

  describe('autocomplete tokens', () => {
    it.each(['password', 'current-password', 'new-password', 'username', 'email', 'tel', 'phone'])(
      'flags input with autocomplete="%s"',
      (token) => {
        expect(computeIsSensitiveInput(makeElement({ tag: 'input', autocomplete: token }))).toBe(true);
      },
    );

    it('handles space-separated multi-token autocomplete', () => {
      // HTML spec: autocomplete is space-separated; "shipping email"
      // means a shipping email. We must catch the email token even
      // when it's not the first.
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', autocomplete: 'shipping email' }))).toBe(true);
    });

    it('does NOT false-positive on substring-only matches', () => {
      // Crucial: "hotel" contains "tel". Token-level match prevents
      // this. Same regression the existing collector documents at
      // line ~1692 ("FIX: Use token-level matching").
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', autocomplete: 'hotel' }))).toBe(false);
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', autocomplete: 'address-level1' }))).toBe(false);
    });

    it('lowercases tokens (spec says case-insensitive)', () => {
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', autocomplete: 'EMAIL' }))).toBe(true);
    });
  });

  describe('name/id regex', () => {
    it.each([
      'password', 'passwd', 'pwd', 'secret', 'credential',
      'user', 'username', 'login', 'email', 'phone', 'tel', 'mobile',
    ])('flags input with name="%s"', (name) => {
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', htmlName: name }))).toBe(true);
    });

    it.each([
      'password', 'login', 'email-input',
    ])('flags input with id="%s"', (id) => {
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', htmlId: id }))).toBe(true);
    });

    it('returns false for innocuous name/id', () => {
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', htmlName: 'comment' }))).toBe(false);
      expect(computeIsSensitiveInput(makeElement({ tag: 'input', htmlId: 'search-box' }))).toBe(false);
    });
  });

  it('combines all signals (any single match → sensitive)', () => {
    // Real form: <input type="text" name="userEmail" autocomplete="email" id="login-form-email">
    // ANY of those signals alone is enough. This test verifies we
    // don't accidentally require all of them.
    expect(computeIsSensitiveInput(makeElement({
      tag: 'input',
      type: 'text',
      htmlName: 'userEmail',
    }))).toBe(true);
  });
});

describe('detectAttributeBasedFramework', () => {
  // 5 attribute-based frameworks. Runtime ones (React/Vue/Angular/
  // Svelte/jQuery) are not testable here — they need browser context.

  describe('Alpine', () => {
    it('detects x-data root marker', () => {
      expect(detectAttributeBasedFramework(new Map([['x-data', '{}']]))).toBe('alpine');
    });
    it('detects x-on:click directive', () => {
      expect(detectAttributeBasedFramework(new Map([['x-on:click', 'foo()']]))).toBe('alpine');
    });
    it('detects @click shorthand', () => {
      expect(detectAttributeBasedFramework(new Map([['@click', 'foo()']]))).toBe('alpine');
    });
  });

  describe('HTMX', () => {
    it.each(['hx-get', 'hx-post', 'hx-put', 'hx-delete', 'hx-patch'])('detects %s', (attr) => {
      expect(detectAttributeBasedFramework(new Map([[attr, '/api']]))).toBe('htmx');
    });
    it('detects data-hx-* prefix variants', () => {
      expect(detectAttributeBasedFramework(new Map([['data-hx-get', '/api']]))).toBe('htmx');
      expect(detectAttributeBasedFramework(new Map([['data-hx-post', '/api']]))).toBe('htmx');
    });
  });

  describe('Stimulus', () => {
    it('detects controller#method action shape', () => {
      expect(detectAttributeBasedFramework(new Map([['data-action', 'click->controller#method']]))).toBe('stimulus');
    });

    it('does not match plain data-action without ->#', () => {
      expect(detectAttributeBasedFramework(new Map([['data-action', 'submit']]))).toBeUndefined();
    });
  });

  describe('Knockout', () => {
    it.each(['click: foo', 'event: bar', 'submit: handler', 'value: prop'])(
      'detects data-bind="%s"',
      (binding) => {
        expect(detectAttributeBasedFramework(new Map([['data-bind', binding]]))).toBe('knockout');
      },
    );
    it('does not match data-bind with unrelated keywords', () => {
      expect(detectAttributeBasedFramework(new Map([['data-bind', 'text: name']]))).toBeUndefined();
    });
  });

  describe('Qwik', () => {
    it('detects on: prefix attribute', () => {
      // Qwik mixed-case `onClick$` survives only as `onclick$` in
      // browser-normalized lowercase. `on:click` and `on$click` both
      // begin with `on` followed by `:` or `$`. Real Qwik also emits
      // `on:click`/`on$click` natively.
      expect(detectAttributeBasedFramework(new Map([['on:click', 'handler']]))).toBe('qwik');
    });
    it('detects on$ prefix attribute', () => {
      expect(detectAttributeBasedFramework(new Map([['on$click', 'handler']]))).toBe('qwik');
    });
    it('does NOT match plain "on" prefix without :/$ separator', () => {
      // `onclick` (no separator) is just inline JS, not Qwik.
      expect(detectAttributeBasedFramework(new Map([['onclick', 'handler()']]))).toBeUndefined();
    });
  });

  describe('priority order', () => {
    // Order in `detectAttributeBasedFramework`: Alpine → HTMX →
    // Stimulus → Knockout → Qwik. First match wins. This mirrors
    // the existing collector — drift would change downstream
    // `frameworkClickable` and break shadow-mode parity.
    it('Alpine wins over HTMX when both attributes present', () => {
      const attrs = new Map<string, string>([
        ['x-data', '{}'],
        ['hx-get', '/api'],
      ]);
      expect(detectAttributeBasedFramework(attrs)).toBe('alpine');
    });

    it('HTMX wins over Stimulus when both', () => {
      const attrs = new Map<string, string>([
        ['hx-get', '/api'],
        ['data-action', 'click->c#m'],
      ]);
      expect(detectAttributeBasedFramework(attrs)).toBe('htmx');
    });
  });

  it('returns undefined when no framework signals', () => {
    expect(detectAttributeBasedFramework(new Map())).toBeUndefined();
    expect(detectAttributeBasedFramework(new Map([['class', 'btn']]))).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Builders for the test fixtures.
// ─────────────────────────────────────────────────────────────────

function makeElement(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e0',
    role: '',
    name: '',
    tag: 'div',
    visible: true,
    ...overrides,
  } as LiteElement;
}

function makeStyles(overrides: Partial<{
  display: string; visibility: string; opacity: string; cursor: string;
  pointerEvents: string; position: string; zIndex: string;
  backgroundColor: string; color: string; borderRadius: string;
}>): {
  display: string; visibility: string; opacity: string; cursor: string;
  pointerEvents: string; position: string; zIndex: string;
  backgroundColor: string; color: string; borderRadius: string;
} {
  return {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    cursor: 'auto',
    pointerEvents: 'auto',
    position: 'static',
    zIndex: 'auto',
    backgroundColor: '',
    color: '',
    borderRadius: '',
    ...overrides,
  };
}
