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
});
