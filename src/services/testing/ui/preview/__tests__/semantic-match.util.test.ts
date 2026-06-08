import type { InteractiveNode } from '../preview.types';
import {
  getEffectiveLabel,
  cyrFold,
  semanticTokens,
  isSpecificInputType,
  nodeIdentityTokens,
  hasTokenOverlap,
  evaluateHonestyGuard,
} from '../semantic-match.util';

const node = (p: Partial<InteractiveNode>): InteractiveNode => ({ tag: 'input', ...p } as InteractiveNode);

describe('cyrFold + semanticTokens', () => {
  it('transliterates Cyrillic glyphs so EN/RU tokenize alike', () => {
    expect(cyrFold('Пароль'.toLowerCase())).toBe('пapoль'.toLowerCase());
    expect(semanticTokens('Пароль')).toEqual(new Set(['пapoль'.toLowerCase()]));
  });
  it('keeps only ≥3-char tokens, splits on non-alphanumerics', () => {
    expect(semanticTokens('a bb ccc dddd-eee')).toEqual(new Set(['ccc', 'dddd', 'eee']));
  });
});

describe('isSpecificInputType — dynamic generic blacklist', () => {
  it('treats known specific types as specific', () => {
    for (const t of ['password', 'email', 'tel', 'checkbox', 'date', 'color']) {
      expect(isSpecificInputType(t)).toBe(true);
    }
  });
  it('treats generic types as NOT specific', () => {
    for (const t of ['text', 'button', 'submit', 'reset', 'image', 'hidden', '']) {
      expect(isSpecificInputType(t)).toBe(false);
    }
    expect(isSpecificInputType(undefined)).toBe(false);
  });
  it('auto-qualifies a NEW/unknown specific type (the point of the inversion)', () => {
    // A future HTML type the code has never seen still counts as specific —
    // no whitelist to update.
    expect(isSpecificInputType('passkey')).toBe(true);
    expect(isSpecificInputType('one-time-code')).toBe(true);
  });
});

describe('nodeIdentityTokens — filtered technical identity', () => {
  it('extracts password identity from type/name/testId, folds glyphs', () => {
    const n = node({ type: 'password', name: 'password', testIdAttr: 'passwordField' });
    expect(nodeIdentityTokens(n).has('password')).toBe(true);
    expect(nodeIdentityTokens(n).has('field')).toBe(false); // generic dropped
  });
  it('drops a credential autocomplete that contradicts a non-password type', () => {
    // documentolog folder_search: type=text + autocomplete=new-password → noise
    const search = node({ type: 'text', name: 'folder_search', autocomplete: 'new-password' });
    const t = nodeIdentityTokens(search);
    expect(t.has('password')).toBe(false);
    expect(t.has('search')).toBe(true); // legit from name
  });
  it('honours autocomplete on a matching type', () => {
    expect(nodeIdentityTokens(node({ type: 'password', autocomplete: 'current-password' })).has('password')).toBe(true);
  });
  it('returns empty for null / generic-only nodes', () => {
    expect(nodeIdentityTokens(null).size).toBe(0);
    expect(nodeIdentityTokens(node({ type: 'text', name: 'submitButton' })).size).toBe(0);
  });
});

describe('getEffectiveLabel', () => {
  it('follows the accessible-name cascade', () => {
    expect(getEffectiveLabel(node({ ariaLabel: 'Close', text: 'x' }))).toBe('Close');
    expect(getEffectiveLabel(node({ placeholder: 'Пароль' }))).toBe('Пароль');
    expect(getEffectiveLabel(node({}))).toBe('');
    expect(getEffectiveLabel(null)).toBe('');
  });
});

describe('hasTokenOverlap', () => {
  it('matches exact and ≥3-char substring, both directions', () => {
    expect(hasTokenOverlap(new Set(['password']), new Set(['password']))).toBe(true);
    expect(hasTokenOverlap(new Set(['pass']), new Set(['password']))).toBe(true);
    expect(hasTokenOverlap(new Set(['password']), new Set(['email']))).toBe(false);
    expect(hasTokenOverlap(new Set(['password']), new Set())).toBe(false);
  });
});

describe('evaluateHonestyGuard', () => {
  const pwd = node({ type: 'password', name: 'password', testIdAttr: 'passwordField', placeholder: 'Пароль' });
  const email = node({ type: 'text', name: 'email', placeholder: 'Email' });

  it('accepts English "password" on a Cyrillic-labelled password field', async () => {
    expect(await evaluateHonestyGuard({ intentText: 'password', chosenNode: pwd, mode: 'apply' })).toBeNull();
  });
  it('rejects "password" pointed at the Email input', async () => {
    expect(await evaluateHonestyGuard({ intentText: 'password', chosenNode: email, mode: 'apply' })).not.toBeNull();
  });
  it('bypasses in heal mode and for <3-char intents', async () => {
    expect(await evaluateHonestyGuard({ intentText: 'Панорама 360', chosenNode: email, mode: 'heal' })).toBeNull();
    expect(await evaluateHonestyGuard({ intentText: 'ok', chosenNode: email, mode: 'apply' })).toBeNull();
  });
  it('passes label-less elements (recall guard)', async () => {
    expect(await evaluateHonestyGuard({ intentText: 'next page', chosenNode: node({ tag: 'button', text: '›' }), mode: 'apply' })).toBeNull();
  });

  // Actionability gate (documentolog "Sign" incident): a click intent must NOT
  // resolve onto a presentational element just because the word overlaps.
  describe('actionability gate (click/hover vs presentational role)', () => {
    const heroHeading = node({ tag: 'h1', role: 'heading', text: 'Sign', frameworkClickable: 'react' });

    it('rejects a click intent that landed on an <h1 role=heading> "Sign" even though the word matches', async () => {
      const r = await evaluateHonestyGuard({ intentText: "Click the top navigation link labeled 'Sign'", chosenNode: heroHeading, mode: 'apply', action: 'click' });
      expect(r).not.toBeNull();
      expect(r?.kind).toBe('semanticFloor');
    });

    it('also rejects for hover on a presentational heading', async () => {
      expect(await evaluateHonestyGuard({ intentText: 'sign here', chosenNode: heroHeading, mode: 'apply', action: 'hover' })).not.toBeNull();
    });

    it('frameworkClickable alone does NOT rescue a presentational role', async () => {
      const fwOnly = node({ tag: 'div', role: 'generic', text: 'login', frameworkClickable: 'react' });
      expect(await evaluateHonestyGuard({ intentText: 'login', chosenNode: fwOnly, mode: 'apply', action: 'click' })).not.toBeNull();
    });

    it('lets a heading through when it carries a real affordance (href / onclick / focusable)', async () => {
      const linkedHeading = node({ tag: 'h1', role: 'heading', text: 'Sign', href: 'https://x/login' });
      expect(await evaluateHonestyGuard({ intentText: 'sign in', chosenNode: linkedHeading, mode: 'apply', action: 'click' })).toBeNull();
      const focusable = node({ tag: 'div', role: 'generic', text: 'login', tabIndex: 0, hasOnclick: true });
      expect(await evaluateHonestyGuard({ intentText: 'login', chosenNode: focusable, mode: 'apply', action: 'click' })).toBeNull();
    });

    it('does NOT gate non-click/hover actions (e.g. type) on presentational roles', async () => {
      // type intents are handled by the lexical/identity path, not this gate.
      const r = await evaluateHonestyGuard({ intentText: 'sign', chosenNode: heroHeading, mode: 'apply', action: 'type' });
      expect(r).toBeNull(); // "sign" overlaps the label → L1 accepts
    });

    it('does NOT gate genuine interactive roles (link/button) for click', async () => {
      const realLink = node({ tag: 'a', role: 'link', text: 'Sign', href: '/login' });
      expect(await evaluateHonestyGuard({ intentText: 'sign in', chosenNode: realLink, mode: 'apply', action: 'click' })).toBeNull();
    });
  });
});
