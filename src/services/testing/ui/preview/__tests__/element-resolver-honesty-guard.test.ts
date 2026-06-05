import type { InteractiveNode } from '../preview.types';
import {
  evaluateHonestyGuard,
  nodeIdentityTokens,
  semanticTokens,
  hasTokenOverlap,
} from '../element-resolver.service';
import { isSoleSubmitButton } from '../semantic-match.util';

function node(partial: Partial<InteractiveNode>): InteractiveNode {
  return { tag: 'input', ...partial } as InteractiveNode;
}

const pass = (r: ReturnType<typeof evaluateHonestyGuard>) => expect(r).toBeNull();
const reject = (r: ReturnType<typeof evaluateHonestyGuard>) => {
  expect(r).not.toBeNull();
  expect(r?.kind).toBe('semanticFloor');
};

describe('semanticTokens', () => {
  it('cyr-folds and keeps ≥3-char tokens', () => {
    expect(semanticTokens('Пароль')).toEqual(new Set(['пapoль'.toLowerCase()]));
    expect(semanticTokens('a bb ccc dddd')).toEqual(new Set(['ccc', 'dddd']));
  });
});

describe('nodeIdentityTokens — filtering', () => {
  it('includes a SPECIFIC input type (password) but not generic text/button', () => {
    expect(nodeIdentityTokens(node({ type: 'password' })).has('password')).toBe(true);
    expect(nodeIdentityTokens(node({ type: 'text' })).has('text')).toBe(false);
    expect(nodeIdentityTokens(node({ tag: 'button', type: 'button' })).has('button')).toBe(false);
    expect(nodeIdentityTokens(node({ type: 'submit' })).has('submit')).toBe(false);
  });

  it('reads inputType as a fallback for type', () => {
    expect(nodeIdentityTokens(node({ inputType: 'email' })).has('email')).toBe(true);
  });

  it('includes name but drops generic UI tokens from it', () => {
    expect(nodeIdentityTokens(node({ name: 'password' })).has('password')).toBe(true);
    // "submitButton" → {submit, button} both generic → dropped
    expect(nodeIdentityTokens(node({ name: 'submitButton' })).size).toBe(0);
    expect(nodeIdentityTokens(node({ name: 'userEmail' })).has('email')).toBe(true);
  });

  it('only keeps meaningful autocomplete tokens, drops on/off', () => {
    // current-password is honoured ONLY when the type agrees (real password
    // field). On a typeless/text node it is treated as autofill-suppression
    // noise and dropped — see the documentolog folder_search case.
    expect(nodeIdentityTokens(node({ type: 'password', autocomplete: 'current-password' })).has('password')).toBe(true);
    expect(nodeIdentityTokens(node({ autocomplete: 'current-password' })).has('password')).toBe(false); // no type → noise
    expect(nodeIdentityTokens(node({ autocomplete: 'off' })).size).toBe(0);
    expect(nodeIdentityTokens(node({ autocomplete: 'on' })).size).toBe(0);
    // Non-credential meaningful tokens are still kept regardless of type.
    expect(nodeIdentityTokens(node({ type: 'tel', autocomplete: 'tel' })).has('tel')).toBe(true);
  });

  it('strips generic tokens from testId', () => {
    // "passwordField" → {password, field} → field dropped, password kept
    expect(nodeIdentityTokens(node({ testIdAttr: 'passwordField' })).has('password')).toBe(true);
    expect(nodeIdentityTokens(node({ testIdAttr: 'passwordField' })).has('field')).toBe(false);
    // "submitButton" → all generic → empty
    expect(nodeIdentityTokens(node({ testIdAttr: 'submitButton' })).size).toBe(0);
  });

  it('ignores dynamic ids, keeps stable ones', () => {
    expect(nodeIdentityTokens(node({ id: ':r3:', isDynamicId: true }).id ? node({ id: ':r3:', isDynamicId: true }) : node({})).size).toBe(0);
    expect(nodeIdentityTokens(node({ id: 'loginPassword', isDynamicId: false })).has('password')).toBe(true);
  });
});

describe('evaluateHonestyGuard — the doculite cross-language fix', () => {
  // The actual field: <input type=password name=password
  //   autocomplete=current-password data-qa-test-id=passwordField
  //   placeholder="Пароль">
  const passwordField = node({
    type: 'password',
    inputType: 'password',
    name: 'password',
    autocomplete: 'current-password',
    testIdAttr: 'passwordField',
    placeholder: 'Пароль',
  });

  it('ACCEPTS English "password" on a Cyrillic-labelled password field', () => {
    pass(evaluateHonestyGuard({ intentText: 'password', chosenNode: passwordField, mode: 'apply' }));
  });

  it('ACCEPTS "password field"', () => {
    pass(evaluateHonestyGuard({ intentText: 'password field', chosenNode: passwordField, mode: 'apply' }));
  });

  it('ACCEPTS Cyrillic "Пароль" (label path, unchanged behaviour)', () => {
    pass(evaluateHonestyGuard({ intentText: 'Пароль', chosenNode: passwordField, mode: 'apply' }));
  });
});

describe('evaluateHonestyGuard — true positives MUST still reject', () => {
  // The Email input that the LLM hallucinated as the password field.
  const emailField = node({
    type: 'text',
    inputType: 'text',
    name: 'email',
    autocomplete: 'email',
    testIdAttr: 'inputEmailField',
    placeholder: 'Email',
  });

  it('REJECTS "password" pointing at the Email input', () => {
    // intent {password} vs label {email} + identity {email} → no overlap.
    reject(evaluateHonestyGuard({ intentText: 'password', chosenNode: emailField, mode: 'apply' }));
  });

  it('REJECTS "password field" pointing at the Email input', () => {
    reject(evaluateHonestyGuard({ intentText: 'password field', chosenNode: emailField, mode: 'apply' }));
  });

  it('REJECTS Cyrillic "пароль" pointing at the Email input', () => {
    reject(evaluateHonestyGuard({ intentText: 'пароль', chosenNode: emailField, mode: 'apply' }));
  });

  it('REJECTS the classic "Панорама 360" vs "Заказать звонок" hallucination', () => {
    const wrong = node({ tag: 'a', text: 'Заказать звонок', name: 'callback_link' });
    reject(evaluateHonestyGuard({ intentText: 'Панорама 360', chosenNode: wrong, mode: 'apply' }));
  });

  it('REJECTS a wrong button whose only identity is generic UI tokens', () => {
    // intent "delete" vs a button testid "submitButton" (generic) + text "Save"
    const wrong = node({ tag: 'button', text: 'Save', testIdAttr: 'submitButton', type: 'submit' });
    reject(evaluateHonestyGuard({ intentText: 'delete account', chosenNode: wrong, mode: 'apply' }));
  });
});

describe('evaluateHonestyGuard — guard bypasses', () => {
  const wrong = node({ tag: 'a', text: 'Заказать звонок' });

  it('bypasses in heal mode', () => {
    pass(evaluateHonestyGuard({ intentText: 'Панорама 360', chosenNode: wrong, mode: 'heal' }));
  });

  it('bypasses for <3-char intents', () => {
    pass(evaluateHonestyGuard({ intentText: 'ok', chosenNode: wrong, mode: 'apply' }));
  });

  it('passes when chosen has no label tokens at all (icon-only ›)', () => {
    pass(evaluateHonestyGuard({ intentText: 'next page', chosenNode: node({ tag: 'button', text: '›' }), mode: 'apply' }));
  });
});

describe('evaluateHonestyGuard — adversarial edge cases', () => {
  it('does NOT accept a generic text input just because intent says "text"', () => {
    const textInput = node({ type: 'text', name: 'q' });
    // intent "text field" — type=text is excluded, name "q" <3 chars dropped,
    // label empty → guard passes ONLY because chosen has no tokens, not
    // because of a bogus type match. Confirm identity tokens are empty.
    expect(nodeIdentityTokens(textInput).size).toBe(0);
  });

  it('email intent matches email field via identity', () => {
    const email = node({ type: 'email', name: 'email', placeholder: 'Электронная почта' });
    pass(evaluateHonestyGuard({ intentText: 'email', chosenNode: email, mode: 'apply' }));
  });

  it('does NOT mint a "password" token from anti-autofill autocomplete on a search box', () => {
    // REAL case (documentolog inbox): <input type=text name=folder_search
    //   placeholder="Поиск" autocomplete="new-password"> — the new-password
    //   is autofill suppression, NOT a credential field. Must not produce a
    //   "password" identity token, else intent "password" falsely matches.
    const searchBox = node({
      type: 'text',
      name: 'folder_search',
      placeholder: 'Поиск по документам',
      autocomplete: 'new-password',
    });
    const tokens = nodeIdentityTokens(searchBox);
    expect(tokens.has('password')).toBe(false);
    expect(tokens.has('search')).toBe(true); // from name=folder_search — legit
    // And the guard must REJECT intent "password" pointed at this search box.
    reject(evaluateHonestyGuard({ intentText: 'password', chosenNode: searchBox, mode: 'apply' }));
    // But intent "search" SHOULD still pass (name carries it).
    pass(evaluateHonestyGuard({ intentText: 'search documents', chosenNode: searchBox, mode: 'apply' }));
  });

  it('STILL honours autocomplete=current-password on a real password field', () => {
    // Regression guard: the contradiction filter must not break the genuine case.
    const realPw = node({ type: 'password', autocomplete: 'current-password' });
    expect(nodeIdentityTokens(realPw).has('password')).toBe(true);
  });

  it('hasTokenOverlap respects 3-char substring rule', () => {
    expect(hasTokenOverlap(new Set(['password']), new Set(['password']))).toBe(true);
    expect(hasTokenOverlap(new Set(['pass']), new Set(['password']))).toBe(true); // substring
    expect(hasTokenOverlap(new Set(['password']), new Set(['email']))).toBe(false);
    expect(hasTokenOverlap(new Set(['password']), new Set())).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Structural escape: action-verb → sole submit button (the signin→Войти fix)
// ═══════════════════════════════════════════════════════════════════════════
describe('evaluateHonestyGuard — structural sole-submit escape', () => {
  // The doculite login page: localized "Войти" submit + email/password inputs.
  const loginBtn = node({ tag: 'button', type: 'submit', text: 'Войти' });
  const emailInput = node({ tag: 'input', type: 'text', name: 'email' });
  const passwordInput = node({ tag: 'input', type: 'password', name: 'password' });
  const siblings = [emailInput, passwordInput, loginBtn];

  it('ACCEPTS "signin button" → sole submit button labelled "Войти"', () => {
    pass(evaluateHonestyGuard({
      intentText: 'signin button', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: siblings,
    }));
  });

  it('ACCEPTS proceed-ish intents in ANY language (no word list)', () => {
    // Pure structure: sole submit + no better sibling match → accept,
    // regardless of intent language. No hardcoded verb set.
    for (const intent of ['login', 'continue', 'connexion', 'кіру', '登录确认']) {
      pass(evaluateHonestyGuard({
        intentText: intent, chosenNode: loginBtn, mode: 'apply',
        action: 'click', siblingNodes: siblings,
      }));
    }
  });

  it('ACCEPTS Cyrillic "войти" via the label path (same node, different channel)', () => {
    pass(evaluateHonestyGuard({
      intentText: 'войти', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: siblings,
    }));
  });

  it('DECLINES the sole-submit branch when a sibling matches the intent better', () => {
    // "register" matches the register link → submit is NOT the obvious target.
    const registerLink = node({ tag: 'a', text: 'Register', name: 'register' });
    reject(evaluateHonestyGuard({
      intentText: 'register', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: [...siblings, registerLink],
    }));
  });

  it('REJECTS when there are TWO submit buttons (not sole)', () => {
    const secondSubmit = node({ tag: 'button', type: 'submit', text: 'Регистрация' });
    reject(evaluateHonestyGuard({
      intentText: 'login', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: [...siblings, secondSubmit],
    }));
  });

  it('REJECTS for non-click actions (escape is click-only)', () => {
    reject(evaluateHonestyGuard({
      intentText: 'login', chosenNode: loginBtn, mode: 'apply',
      action: 'type', siblingNodes: siblings,
    }));
  });

  it('backward-compatible: omitting action/siblingNodes never fires the branch', () => {
    // Legacy 3-arg call → no siblings → not sole → falls through to reject.
    reject(evaluateHonestyGuard({ intentText: 'login', chosenNode: loginBtn, mode: 'apply' }));
  });
});

describe('isSoleSubmitButton', () => {
  const btnSubmit = node({ tag: 'button', type: 'submit', text: 'Go' });
  const inputSubmit = node({ tag: 'input', type: 'submit' });
  const bareButton = node({ tag: 'button', text: 'OK' }); // implicit submit
  const typeButton = node({ tag: 'button', type: 'button', text: 'Cancel' });

  it('treats type=submit (button and input) as submit primary; sole → true', () => {
    expect(isSoleSubmitButton(btnSubmit, [btnSubmit, typeButton])).toBe(true);
    expect(isSoleSubmitButton(inputSubmit, [inputSubmit, typeButton])).toBe(true);
  });

  it('treats a bare <button> as implicit submit', () => {
    expect(isSoleSubmitButton(bareButton, [bareButton, typeButton])).toBe(true);
  });

  it('returns false for type=button', () => {
    expect(isSoleSubmitButton(typeButton, [typeButton])).toBe(false);
  });

  it('returns false when two submit primaries exist', () => {
    expect(isSoleSubmitButton(btnSubmit, [btnSubmit, inputSubmit])).toBe(false);
  });
});

describe('nodeIdentityTokens — role channel', () => {
  it('includes specific widget roles (textbox, combobox) but not button/link', () => {
    expect(nodeIdentityTokens(node({ tag: 'div', role: 'textbox' })).has('textbox')).toBe(true);
    expect(nodeIdentityTokens(node({ tag: 'div', role: 'combobox' })).has('combobox')).toBe(true);
    expect(nodeIdentityTokens(node({ tag: 'button', role: 'button' })).has('button')).toBe(false);
    expect(nodeIdentityTokens(node({ tag: 'a', role: 'link' })).has('link')).toBe(false);
  });
});
