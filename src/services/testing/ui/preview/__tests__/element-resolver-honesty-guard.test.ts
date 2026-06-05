import type { InteractiveNode } from '../preview.types';
import {
  evaluateHonestyGuard,
  nodeIdentityTokens,
  semanticTokens,
  hasTokenOverlap,
} from '../element-resolver.service';
import {
  isSoleSubmitButton,
  buildIdentityTokenFrequency,
  buildGenericTokenPredicate,
  type HonestySemanticDeps,
} from '../semantic-match.util';

function node(partial: Partial<InteractiveNode>): InteractiveNode {
  return { tag: 'input', ...partial } as InteractiveNode;
}

// The guard is async (L2/L3 layers). Helpers await the verdict so call sites
// stay `await pass(evaluateHonestyGuard({...}))`.
const pass = async (r: ReturnType<typeof evaluateHonestyGuard>) => expect(await r).toBeNull();
const reject = async (r: ReturnType<typeof evaluateHonestyGuard>) => {
  const v = await r;
  expect(v).not.toBeNull();
  expect(v?.kind).toBe('semanticFloor');
};

describe('semanticTokens', () => {
  it('cyr-folds and keeps ≥3-char tokens', async () => {
    expect(semanticTokens('Пароль')).toEqual(new Set(['пapoль'.toLowerCase()]));
    expect(semanticTokens('a bb ccc dddd')).toEqual(new Set(['ccc', 'dddd']));
  });
});

describe('nodeIdentityTokens — filtering', () => {
  it('includes a SPECIFIC input type (password) but not generic text/button', async () => {
    expect(nodeIdentityTokens(node({ type: 'password' })).has('password')).toBe(true);
    expect(nodeIdentityTokens(node({ type: 'text' })).has('text')).toBe(false);
    expect(nodeIdentityTokens(node({ tag: 'button', type: 'button' })).has('button')).toBe(false);
    expect(nodeIdentityTokens(node({ type: 'submit' })).has('submit')).toBe(false);
  });

  it('reads inputType as a fallback for type', async () => {
    expect(nodeIdentityTokens(node({ inputType: 'email' })).has('email')).toBe(true);
  });

  it('includes name but drops generic UI tokens from it', async () => {
    expect(nodeIdentityTokens(node({ name: 'password' })).has('password')).toBe(true);
    // "submitButton" → {submit, button} both generic → dropped
    expect(nodeIdentityTokens(node({ name: 'submitButton' })).size).toBe(0);
    expect(nodeIdentityTokens(node({ name: 'userEmail' })).has('email')).toBe(true);
  });

  it('only keeps meaningful autocomplete tokens, drops on/off', async () => {
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

  it('strips generic tokens from testId', async () => {
    // "passwordField" → {password, field} → field dropped, password kept
    expect(nodeIdentityTokens(node({ testIdAttr: 'passwordField' })).has('password')).toBe(true);
    expect(nodeIdentityTokens(node({ testIdAttr: 'passwordField' })).has('field')).toBe(false);
    // "submitButton" → all generic → empty
    expect(nodeIdentityTokens(node({ testIdAttr: 'submitButton' })).size).toBe(0);
  });

  it('ignores dynamic ids, keeps stable ones', async () => {
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

  it('ACCEPTS English "password" on a Cyrillic-labelled password field', async () => {
    await pass(evaluateHonestyGuard({ intentText: 'password', chosenNode: passwordField, mode: 'apply' }));
  });

  it('ACCEPTS "password field"', async () => {
    await pass(evaluateHonestyGuard({ intentText: 'password field', chosenNode: passwordField, mode: 'apply' }));
  });

  it('ACCEPTS Cyrillic "Пароль" (label path, unchanged behaviour)', async () => {
    await pass(evaluateHonestyGuard({ intentText: 'Пароль', chosenNode: passwordField, mode: 'apply' }));
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

  it('REJECTS "password" pointing at the Email input', async () => {
    // intent {password} vs label {email} + identity {email} → no overlap.
    await reject(evaluateHonestyGuard({ intentText: 'password', chosenNode: emailField, mode: 'apply' }));
  });

  it('REJECTS "password field" pointing at the Email input', async () => {
    await reject(evaluateHonestyGuard({ intentText: 'password field', chosenNode: emailField, mode: 'apply' }));
  });

  it('REJECTS Cyrillic "пароль" pointing at the Email input', async () => {
    await reject(evaluateHonestyGuard({ intentText: 'пароль', chosenNode: emailField, mode: 'apply' }));
  });

  it('REJECTS the classic "Панорама 360" vs "Заказать звонок" hallucination', async () => {
    const wrong = node({ tag: 'a', text: 'Заказать звонок', name: 'callback_link' });
    await reject(evaluateHonestyGuard({ intentText: 'Панорама 360', chosenNode: wrong, mode: 'apply' }));
  });

  it('REJECTS a wrong button whose only identity is generic UI tokens', async () => {
    // intent "delete" vs a button testid "submitButton" (generic) + text "Save"
    const wrong = node({ tag: 'button', text: 'Save', testIdAttr: 'submitButton', type: 'submit' });
    await reject(evaluateHonestyGuard({ intentText: 'delete account', chosenNode: wrong, mode: 'apply' }));
  });
});

describe('evaluateHonestyGuard — guard bypasses', () => {
  const wrong = node({ tag: 'a', text: 'Заказать звонок' });

  it('bypasses in heal mode', async () => {
    await pass(evaluateHonestyGuard({ intentText: 'Панорама 360', chosenNode: wrong, mode: 'heal' }));
  });

  it('bypasses for <3-char intents', async () => {
    await pass(evaluateHonestyGuard({ intentText: 'ok', chosenNode: wrong, mode: 'apply' }));
  });

  it('passes when chosen has no label tokens at all (icon-only ›)', async () => {
    await pass(evaluateHonestyGuard({ intentText: 'next page', chosenNode: node({ tag: 'button', text: '›' }), mode: 'apply' }));
  });
});

describe('evaluateHonestyGuard — adversarial edge cases', () => {
  it('does NOT accept a generic text input just because intent says "text"', async () => {
    const textInput = node({ type: 'text', name: 'q' });
    // intent "text field" — type=text is excluded, name "q" <3 chars dropped,
    // label empty → guard passes ONLY because chosen has no tokens, not
    // because of a bogus type match. Confirm identity tokens are empty.
    expect(nodeIdentityTokens(textInput).size).toBe(0);
  });

  it('email intent matches email field via identity', async () => {
    const email = node({ type: 'email', name: 'email', placeholder: 'Электронная почта' });
    await pass(evaluateHonestyGuard({ intentText: 'email', chosenNode: email, mode: 'apply' }));
  });

  it('does NOT mint a "password" token from anti-autofill autocomplete on a search box', async () => {
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
    await reject(evaluateHonestyGuard({ intentText: 'password', chosenNode: searchBox, mode: 'apply' }));
    // But intent "search" SHOULD still pass (name carries it).
    await pass(evaluateHonestyGuard({ intentText: 'search documents', chosenNode: searchBox, mode: 'apply' }));
  });

  it('STILL honours autocomplete=current-password on a real password field', async () => {
    // Regression guard: the contradiction filter must not break the genuine case.
    const realPw = node({ type: 'password', autocomplete: 'current-password' });
    expect(nodeIdentityTokens(realPw).has('password')).toBe(true);
  });

  it('hasTokenOverlap respects 3-char substring rule', async () => {
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

  it('ACCEPTS "signin button" → sole submit button labelled "Войти"', async () => {
    await pass(evaluateHonestyGuard({
      intentText: 'signin button', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: siblings,
    }));
  });

  it('ACCEPTS proceed-ish intents in ANY language (no word list)', async () => {
    // Pure structure: sole submit + no better sibling match → accept,
    // regardless of intent language. No hardcoded verb set.
    for (const intent of ['login', 'continue', 'connexion', 'кіру', '登录确认']) {
      await pass(evaluateHonestyGuard({
        intentText: intent, chosenNode: loginBtn, mode: 'apply',
        action: 'click', siblingNodes: siblings,
      }));
    }
  });

  it('ACCEPTS Cyrillic "войти" via the label path (same node, different channel)', async () => {
    await pass(evaluateHonestyGuard({
      intentText: 'войти', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: siblings,
    }));
  });

  it('DECLINES the sole-submit branch when a sibling matches the intent better', async () => {
    // "register" matches the register link → submit is NOT the obvious target.
    const registerLink = node({ tag: 'a', text: 'Register', name: 'register' });
    await reject(evaluateHonestyGuard({
      intentText: 'register', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: [...siblings, registerLink],
    }));
  });

  it('REJECTS when there are TWO submit buttons (not sole)', async () => {
    const secondSubmit = node({ tag: 'button', type: 'submit', text: 'Регистрация' });
    await reject(evaluateHonestyGuard({
      intentText: 'login', chosenNode: loginBtn, mode: 'apply',
      action: 'click', siblingNodes: [...siblings, secondSubmit],
    }));
  });

  it('REJECTS for non-click actions (escape is click-only)', async () => {
    await reject(evaluateHonestyGuard({
      intentText: 'login', chosenNode: loginBtn, mode: 'apply',
      action: 'type', siblingNodes: siblings,
    }));
  });

  it('backward-compatible: omitting action/siblingNodes never fires the branch', async () => {
    // Legacy 3-arg call → no siblings → not sole → falls through to reject.
    await reject(evaluateHonestyGuard({ intentText: 'login', chosenNode: loginBtn, mode: 'apply' }));
  });
});

describe('isSoleSubmitButton', () => {
  const btnSubmit = node({ tag: 'button', type: 'submit', text: 'Go' });
  const inputSubmit = node({ tag: 'input', type: 'submit' });
  const bareButton = node({ tag: 'button', text: 'OK' }); // implicit submit
  const typeButton = node({ tag: 'button', type: 'button', text: 'Cancel' });

  it('treats type=submit (button and input) as submit primary; sole → true', async () => {
    expect(isSoleSubmitButton(btnSubmit, [btnSubmit, typeButton])).toBe(true);
    expect(isSoleSubmitButton(inputSubmit, [inputSubmit, typeButton])).toBe(true);
  });

  it('treats a bare <button> as implicit submit', async () => {
    expect(isSoleSubmitButton(bareButton, [bareButton, typeButton])).toBe(true);
  });

  it('returns false for type=button', async () => {
    expect(isSoleSubmitButton(typeButton, [typeButton])).toBe(false);
  });

  it('returns false when two submit primaries exist', async () => {
    expect(isSoleSubmitButton(btnSubmit, [btnSubmit, inputSubmit])).toBe(false);
  });
});

describe('nodeIdentityTokens — role channel', () => {
  it('includes specific widget roles (textbox, combobox) but not button/link', async () => {
    expect(nodeIdentityTokens(node({ tag: 'div', role: 'textbox' })).has('textbox')).toBe(true);
    expect(nodeIdentityTokens(node({ tag: 'div', role: 'combobox' })).has('combobox')).toBe(true);
    expect(nodeIdentityTokens(node({ tag: 'button', role: 'button' })).has('button')).toBe(false);
    expect(nodeIdentityTokens(node({ tag: 'a', role: 'link' })).has('link')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 data-driven generic filter (frequency replaces the static word list)
// ═══════════════════════════════════════════════════════════════════════════
describe('buildIdentityTokenFrequency + buildGenericTokenPredicate', () => {
  it('counts distinct nodes per identifier token', () => {
    const nodes = [
      node({ name: 'submit-form' }),
      node({ name: 'submit-payment' }),
      node({ testIdAttr: 'submit-otp' }),
      node({ name: 'panorama' }),
    ];
    const freq = buildIdentityTokenFrequency(nodes);
    expect(freq.get('submit')).toBe(3);
    expect(freq.get('panorama')).toBe(1);
  });

  it('flags a token recurring across many controls as generic; keeps a rare one', () => {
    // 8 nodes: "submit" recurs on 4 (≥ threshold max(4, ceil(8*0.25)=2)=4) → generic.
    // "panorama" appears on exactly ONE node → kept. Distinct trailing tokens
    // ("aaa".."hhh") keep each node's identifier set unique.
    const tails = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh'];
    const nodes = tails.map((t, i) =>
      node({ name: i < 4 ? `submit-${t}` : i === 4 ? `panorama-${t}` : `widget-${t}` }),
    );
    const isGeneric = buildGenericTokenPredicate(buildIdentityTokenFrequency(nodes), nodes.length);
    expect(isGeneric('submit')).toBe(true);   // freq 4 ≥ 4
    expect(isGeneric('panorama')).toBe(false); // freq 1
  });

  it('FLOOR protects sparse pages: a token on 2 of 6 nodes is NOT generic', () => {
    const nodes = [
      node({ name: 'login-email' }),
      node({ name: 'login-password' }),
      node({ name: 'forgot' }),
      node({ name: 'register' }),
      node({ name: 'help' }),
      node({ name: 'terms' }),
    ];
    const isGeneric = buildGenericTokenPredicate(buildIdentityTokenFrequency(nodes), nodes.length);
    expect(isGeneric('login')).toBe(false); // freq 2 < floor 4
  });

  it('threads the predicate into the guard (frequency-driven identity match)', async () => {
    // "panorama" is a rare, real identifier → identity overlap → accept.
    const target = node({ tag: 'a', text: 'Заказать тур', name: 'panorama-360' });
    const isGeneric = buildGenericTokenPredicate(new Map([['panorama', 1]]), 10);
    await pass(evaluateHonestyGuard({
      intentText: 'panorama', chosenNode: target, mode: 'apply', identityFreq: isGeneric,
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L2 embedding + L3 judge — dependency-injected fakes (NO network)
// ═══════════════════════════════════════════════════════════════════════════
describe('evaluateHonestyGuard — L2 semantic (injected embedding)', () => {
  // A localized link the lexical/structural layers can't bridge.
  const logoutLink = node({ tag: 'a', text: 'Выход' });
  const fakeSemantic = (sim: number): HonestySemanticDeps => ({
    embed: async () => [1, 0, 0],
    cosine: () => sim,
  });

  it('ACCEPTS when cosine ≥ τ_embed (0.62)', async () => {
    await pass(evaluateHonestyGuard({
      intentText: 'logout', chosenNode: logoutLink, mode: 'apply', semantic: fakeSemantic(0.8),
    }));
  });

  it('REJECTS when cosine is clearly low (<0.45) and no judge', async () => {
    await reject(evaluateHonestyGuard({
      intentText: 'logout', chosenNode: logoutLink, mode: 'apply', semantic: fakeSemantic(0.2),
    }));
  });

  it('fails OPEN to reject when embedding throws', async () => {
    const throwing: HonestySemanticDeps = {
      embed: async () => { throw new Error('boom'); },
      cosine: () => 1,
    };
    await reject(evaluateHonestyGuard({
      intentText: 'logout', chosenNode: logoutLink, mode: 'apply', semantic: throwing,
    }));
  });
});

describe('evaluateHonestyGuard — L3 judge (injected, band-gated)', () => {
  const localized = node({ tag: 'button', text: 'Удалить' });
  const semAt = (sim: number): HonestySemanticDeps => ({ embed: async () => [1], cosine: () => sim });

  it('invokes judge only in the band [0.45, 0.62) and accepts on "yes"', async () => {
    const ask = jest.fn(async () => true as boolean | null);
    await pass(evaluateHonestyGuard({
      intentText: 'remove', chosenNode: localized, mode: 'apply',
      semantic: semAt(0.5), judge: { ask },
    }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('rejects on judge "no"', async () => {
    const ask = jest.fn(async () => false as boolean | null);
    await reject(evaluateHonestyGuard({
      intentText: 'remove', chosenNode: localized, mode: 'apply',
      semantic: semAt(0.5), judge: { ask },
    }));
  });

  it('does NOT invoke judge below the band (<0.45) — straight reject', async () => {
    const ask = jest.fn(async () => true as boolean | null);
    await reject(evaluateHonestyGuard({
      intentText: 'remove', chosenNode: localized, mode: 'apply',
      semantic: semAt(0.2), judge: { ask },
    }));
    expect(ask).not.toHaveBeenCalled();
  });

  it('does NOT invoke judge above τ_embed (already accepted at L2)', async () => {
    const ask = jest.fn(async () => false as boolean | null);
    await pass(evaluateHonestyGuard({
      intentText: 'remove', chosenNode: localized, mode: 'apply',
      semantic: semAt(0.9), judge: { ask },
    }));
    expect(ask).not.toHaveBeenCalled();
  });

  it('fails OPEN to reject when judge throws', async () => {
    const ask = jest.fn(async () => { throw new Error('judge down'); });
    await reject(evaluateHonestyGuard({
      intentText: 'remove', chosenNode: localized, mode: 'apply',
      semantic: semAt(0.5), judge: { ask },
    }));
  });
});

describe('evaluateHonestyGuard — L2/L3 gating (must NOT fire on cheap paths)', () => {
  const embed = jest.fn(async () => [1]);
  const ask = jest.fn(async () => true as boolean | null);
  const deps = { semantic: { embed, cosine: () => 0.5 }, judge: { ask } };
  beforeEach(() => { embed.mockClear(); ask.mockClear(); });

  it('lexical accept short-circuits → no embed/judge', async () => {
    await pass(evaluateHonestyGuard({
      intentText: 'login', chosenNode: node({ tag: 'button', text: 'Login' }), mode: 'apply', ...deps,
    }));
    expect(embed).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('heal mode → no embed/judge', async () => {
    await pass(evaluateHonestyGuard({
      intentText: 'logout', chosenNode: node({ tag: 'a', text: 'Выход' }), mode: 'heal', ...deps,
    }));
    expect(embed).not.toHaveBeenCalled();
  });

  it('label-less chosen → no embed/judge', async () => {
    await pass(evaluateHonestyGuard({
      intentText: 'logout', chosenNode: node({ tag: 'button', text: '›' }), mode: 'apply', ...deps,
    }));
    expect(embed).not.toHaveBeenCalled();
  });
});
