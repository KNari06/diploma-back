import { buildOverlayResolverHelpers } from '../overlay-resolver-helpers';

/**
 * buildOverlayResolverHelpers() returns a STRING of JavaScript that runs in the
 * live page (via page.evaluate). To unit-test it without a browser we eval the
 * string and call the DOM-independent helpers against tiny fake elements.
 *
 * The tree-walking helpers (findInteractive / promoteToClickableRow /
 * elevateLabelToControl) need window.getComputedStyle, document.querySelector
 * and a real node tree — those require jsdom (not installed here), so they get
 * a presence/drift guard rather than behavioural tests.
 */

// A minimal Element stand-in covering the surface the helpers actually touch.
class FakeElement {
  tagName: string;
  attributes: Array<{ name: string }>;
  private _attrs: Record<string, string>;
  [key: string]: any;

  constructor(tag: string, attrs: Record<string, string> = {}, extra: Record<string, any> = {}) {
    this.tagName = tag.toUpperCase();
    this._attrs = attrs;
    this.attributes = Object.keys(attrs).map((name) => ({ name }));
    Object.assign(this, extra);
  }
  getAttribute(name: string): string | null {
    return name in this._attrs ? this._attrs[name] : null;
  }
  hasAttribute(name: string): boolean {
    return name in this._attrs;
  }
}

type Helpers = {
  safeAttr(el: any, name: string): string;
  looksDynamicId(id: string): boolean;
  describeElement(el: any): string;
  hasClickHandler(el: any): boolean;
  isInteractive(el: any): boolean;
};

const source = buildOverlayResolverHelpers();
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const helpers: Helpers = new Function(
  `${source}\nreturn { safeAttr, looksDynamicId, describeElement, hasClickHandler, isInteractive };`,
)();

const el = (tag: string, attrs?: Record<string, string>, extra?: Record<string, any>) =>
  new FakeElement(tag, attrs, extra);

const originalElement = (global as any).Element;
beforeAll(() => {
  // isInteractive uses `el instanceof Element`; make our fakes pass.
  (global as any).Element = FakeElement;
});
afterAll(() => {
  (global as any).Element = originalElement;
});

describe('buildOverlayResolverHelpers — well-formedness', () => {
  it('produces evaluable JS that defines every documented helper', () => {
    for (const name of [
      'safeAttr',
      'looksDynamicId',
      'describeElement',
      'hasClickHandler',
      'isInteractive',
      'promoteToClickableRow',
      'elevateLabelToControl',
      'findInteractive',
    ]) {
      expect(source).toContain(`function ${name}(`);
    }
  });
});

describe('safeAttr', () => {
  it('returns the attribute value as a string', () => {
    expect(helpers.safeAttr(el('div', { id: 'x' }), 'id')).toBe('x');
  });
  it('returns "" for a missing attribute', () => {
    expect(helpers.safeAttr(el('div'), 'id')).toBe('');
  });
  it('returns "" (never throws) when getAttribute throws', () => {
    const throwing = { getAttribute: () => { throw new Error('boom'); } };
    expect(helpers.safeAttr(throwing, 'id')).toBe('');
  });
});

describe('looksDynamicId', () => {
  it.each([
    ':r3:',
    ':R1a:',
    ':r123',
    '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
    'mui-7',
    'radix-abc',
    'headlessui-xyz',
    'el-id-12',
    'ant-99',
    '_abcdefghijkl',
    'a1b2c3d4e5f6g7h8i9j0',
  ])('flags %p as dynamic', (id) => {
    expect(helpers.looksDynamicId(id)).toBe(true);
  });

  it.each(['', 'submit-button', 'email', 'main-nav', 'login', 'header'])(
    'treats %p as a stable id',
    (id) => {
      expect(helpers.looksDynamicId(id)).toBe(false);
    },
  );
});

describe('describeElement', () => {
  it('prefers data-testid over everything else', () => {
    expect(helpers.describeElement(el('button', { 'data-testid': 'login', id: 'real', name: 'n' })))
      .toBe('button[data-testid="login"]');
  });

  it('uses data-test / data-qa under the testid label', () => {
    expect(helpers.describeElement(el('div', { 'data-qa': 'qa1' }))).toBe('div[data-testid="qa1"]');
  });

  it('uses a non-dynamic id when there is no testid', () => {
    expect(helpers.describeElement(el('div', { id: 'main' }))).toBe('div#main');
  });

  it('skips a dynamic id and falls back to name', () => {
    expect(helpers.describeElement(el('div', { id: ':r3:', name: 'foo' }))).toBe('div[name="foo"]');
  });

  it('falls back to the bare tag when only a dynamic id is present', () => {
    expect(helpers.describeElement(el('div', { id: ':r3:' }))).toBe('div');
  });

  it('caps the label at 120 characters', () => {
    const out = helpers.describeElement(el('div', { 'data-testid': 'x'.repeat(300) }));
    expect(out.length).toBe(120);
  });
});

describe('hasClickHandler', () => {
  it('detects an inline onclick attribute', () => {
    expect(helpers.hasClickHandler(el('div', { onclick: 'doThing()' }))).toBe(true);
  });

  it('treats a non-(-1) tabindex as clickable', () => {
    expect(helpers.hasClickHandler(el('div', { tabindex: '0' }))).toBe(true);
    expect(helpers.hasClickHandler(el('div', { tabindex: '-1' }))).toBe(false);
  });

  it.each([['@click'], ['ng-click'], ['v-on:click'], ['(click)']])(
    'detects the framework click attribute %p',
    (attr) => {
      expect(helpers.hasClickHandler(el('div', { [attr]: 'x' }))).toBe(true);
    },
  );

  it('detects a React onClick prop on the element', () => {
    const node = el('div', {}, { __reactProps$abc: { onClick: () => {} } });
    expect(helpers.hasClickHandler(node)).toBe(true);
  });

  it('returns false for a plain element with no handlers', () => {
    expect(helpers.hasClickHandler(el('div'))).toBe(false);
  });
});

describe('isInteractive', () => {
  it.each(['a', 'button', 'input', 'select', 'textarea', 'summary'])(
    'treats native tag <%s> as interactive',
    (tag) => {
      expect(helpers.isInteractive(el(tag))).toBe(true);
    },
  );

  it.each(['button', 'link', 'checkbox', 'tab', 'switch', 'treeitem'])(
    'treats role="%s" as interactive',
    (role) => {
      expect(helpers.isInteractive(el('div', { role }))).toBe(true);
    },
  );

  it('treats a click handler as interactive', () => {
    expect(helpers.isInteractive(el('div', { onclick: 'x()' }))).toBe(true);
  });

  it('treats contenteditable surfaces as interactive', () => {
    expect(helpers.isInteractive(el('div', { contenteditable: '' }))).toBe(true);
    expect(helpers.isInteractive(el('div', { contenteditable: 'true' }))).toBe(true);
    expect(helpers.isInteractive(el('div', { contenteditable: 'false' }))).toBe(false);
  });

  it('treats draggable="true" as interactive', () => {
    expect(helpers.isInteractive(el('div', { draggable: 'true' }))).toBe(true);
  });

  it('returns false for a plain, non-interactive div', () => {
    expect(helpers.isInteractive(el('div'))).toBe(false);
  });

  it('returns false for a non-Element value', () => {
    expect(helpers.isInteractive({ tagName: 'DIV' })).toBe(false);
  });
});
