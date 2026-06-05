/**
 * Semantic matching helpers for element resolution — PURE, side-effect-free,
 * language-agnostic token logic extracted from element-resolver.service.ts
 * (2026-06) so the hot resolver file shrinks and this logic is unit-testable
 * in isolation (no Playwright, no LLM, no resolver state).
 *
 * What lives here:
 *   - getEffectiveLabel       — node → WAI-ARIA accessible-name cascade
 *   - cyrFold / semanticTokens — Cyrillic-fold + tokenizer
 *   - isSpecificInputType      — dynamic generic-type blacklist
 *   - nodeIdentityTokens       — technical-identity tokens (type/name/ac/testId/id)
 *   - hasTokenOverlap          — exact-or-substring token overlap
 *   - evaluateHonestyGuard     — semantic-floor hallucination guard
 *
 * Design rule (universality): NEVER hardcode natural-language word lists here.
 * Token sets are either inverted (generic-blacklist for input types — any
 * current/future specific type qualifies) or closed W3C-spec values
 * (autocomplete) — both language-agnostic. The only Cyrillic content is the
 * glyph-fold table (transliteration, not vocabulary).
 */

import type { InteractiveNode } from './preview.types';

/**
 * Effective accessible label for a node — WAI-ARIA accessible-name cascade with
 * product-specific identity fallbacks for descriptor-poor targets.
 *
 * Order, most-specific → most-general:
 *   labelText → ariaLabel → title → alt → text → placeholder → iconLabel →
 *   svgIcon → childTestId → dataValue → dataRowKey → customElementTag → ''.
 *
 * Returns '' when ALL fields are missing (genuinely unidentifiable node — a
 * detection problem, not something this helper can fix).
 */
export function getEffectiveLabel(node: InteractiveNode | undefined | null): string {
  if (!node) return '';
  return (
    node.labelText            // includes aria-labelledby + native <label>
    || node.ariaLabel
    || node.title             // WAI-ARIA accessible name source
    || node.alt               // <img>/<area>/<input type=image> accessible name
    || node.text              // visible textContent
    || node.placeholder       // input fallback
    || node.iconLabel         // svg <title>/data-lucide/sprite/FA class
    || node.svgIcon           // Angular Material registry name
    || node.childTestId       // lifted single-icon-child data-testid
    || node.dataValue         // <option value>/<li data-value> semantic key
    || node.dataRowKey        // AntD/RainbowKit table row identity
    || node.customElementTag  // <app-X>/<my-button> semantic wrapper
    || ''
  ).toString();
}

/**
 * Cyrillic→Latin glyph fold (М↔M, А↔A, Т↔T, …) so "MAT-SMART" and "МАТ-SMART"
 * tokenize identically. Single source of truth for both guard call sites.
 */
export function cyrFold(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    switch (code) {
      case 0x0410: case 0x0430: out += 'a'; break;
      case 0x0412: case 0x0432: out += 'b'; break;
      case 0x0415: case 0x0435: out += 'e'; break;
      case 0x041A: case 0x043A: out += 'k'; break;
      case 0x041C: case 0x043C: out += 'm'; break;
      case 0x041D: case 0x043D: out += 'h'; break;
      case 0x041E: case 0x043E: out += 'o'; break;
      case 0x0420: case 0x0440: out += 'p'; break;
      case 0x0421: case 0x0441: out += 'c'; break;
      case 0x0422: case 0x0442: out += 't'; break;
      case 0x0425: case 0x0445: out += 'x'; break;
      case 0x0423: case 0x0443: out += 'y'; break;
      default: out += ch;
    }
  }
  return out;
}

/** Tokenize: cyr-fold, split on non-alphanumerics, keep ≥3-char tokens. */
export function semanticTokens(s: string): Set<string> {
  return new Set(cyrFold(s.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3));
}

// An input `type` is a useful intent-disambiguating signal UNLESS it's one of
// the GENERIC types that appear on almost every form and carry no meaning of
// their own. We blacklist the generic set (small, closed, stable in the HTML
// spec) rather than whitelist the specific ones — so ANY current OR FUTURE
// specific type (`password`, `email`, a new `passkey`, …) qualifies
// automatically, with no spec-snapshot list to maintain. Fully dynamic.
const GENERIC_INPUT_TYPES = new Set([
  'text', 'button', 'submit', 'reset', 'image', 'hidden', '',
]);
export function isSpecificInputType(type: string | undefined): boolean {
  if (!type) return false;
  return !GENERIC_INPUT_TYPES.has(type.toLowerCase());
}

// W3C-spec autocomplete TOKENS worth matching against intent (the attribute is
// spec-defined and language-agnostic). Junk values ("on"/"off") and layout-only
// values are excluded.
const MEANINGFUL_AUTOCOMPLETE_TOKENS = new Set([
  'password', 'email', 'username', 'tel', 'url', 'search',
  'current', 'new', 'name', 'organization', 'address',
  'phone', 'country', 'postal', 'credit', 'card',
  'otp', 'webauthn', 'nickname', 'given', 'family',
]);

// Generic UI tokens that show up in testIds/ids/names across unrelated controls
// (submitButton, closeModal, …). Matching on them would let intent "submit"
// grab a random element whose testId merely contains "submit". Dropped from
// identity tokens.
const GENERIC_IDENTITY_TOKENS = new Set([
  'button', 'btn', 'input', 'field', 'element', 'control', 'icon',
  'modal', 'dialog', 'panel', 'container', 'wrapper', 'root', 'item',
  'submit', 'cancel', 'close', 'next', 'back', 'prev', 'open', 'toggle',
  'link', 'menu', 'list', 'row', 'cell', 'col', 'box', 'group', 'form',
  'label', 'text', 'value', 'data', 'test', 'qa', 'auto',
]);

/** camelCase / snake / kebab → lowercase word parts. */
function splitIdentifier(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map(t => t.toLowerCase())
    .filter(Boolean);
}

/**
 * Build the set of TECHNICAL-identity tokens for a node — the signals the LLM
 * already sees in the candidate line (type, name, autocomplete, testId, id) but
 * that the visible-label-only semantic floor ignored. This is what lets an
 * English intent ("password") match a Cyrillic-labelled field whose
 * `type=password / name=password / autocomplete=current-password` makes the
 * meaning unambiguous.
 *
 * Heavily filtered (generic types, junk autocomplete, generic UI tokens are
 * dropped) so it adds REAL disambiguating tokens without re-opening the
 * hallucination hole.
 */
export function nodeIdentityTokens(node: InteractiveNode | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!node) return out;
  const add = (raw: string | undefined, opts: { dropGeneric?: boolean } = {}) => {
    if (!raw) return;
    for (const part of splitIdentifier(raw)) {
      if (part.length < 3) continue;
      if (opts.dropGeneric && GENERIC_IDENTITY_TOKENS.has(part)) continue;
      out.add(part);
    }
  };

  // type / inputType — only when specific (not a generic text/button type).
  const typeVal = (node.type || node.inputType || '').toLowerCase();
  const typeIsSpecific = isSpecificInputType(typeVal);
  if (typeIsSpecific) out.add(typeVal);

  // name — strong, author-chosen identity. Drop generic UI tokens.
  add(node.name, { dropGeneric: true });

  // autocomplete — only meaningful tokens, AND only when it does NOT CONTRADICT
  // the field's type. Real client pages put anti-autofill
  // `autocomplete="new-password"` on plain text SEARCH boxes (documentolog
  // `folder_search`, type=text); trusting that would mint a bogus `password`
  // identity token for a search field. Rule: a password/email autocomplete
  // token is only honoured when the element's type agrees.
  if (node.autocomplete) {
    const contradicts = (token: string): boolean => {
      if (token === 'password' && typeVal && typeVal !== 'password') return true;
      if (token === 'email' && typeVal && typeVal !== 'email') return true;
      if ((token === 'password' || token === 'email') && (!typeVal || typeVal === 'text')) return true;
      return false;
    };
    for (const part of splitIdentifier(node.autocomplete)) {
      if (part.length < 3) continue;
      if (!MEANINGFUL_AUTOCOMPLETE_TOKENS.has(part)) continue;
      if (contradicts(part)) continue;
      out.add(part);
    }
  }

  // testId — author-chosen, but strip generic UI scaffolding tokens.
  add(node.testIdAttr, { dropGeneric: true });

  // id — only stable ids (framework-generated ones are noise); drop generic.
  if (node.id && !node.isDynamicId) add(node.id, { dropGeneric: true });

  return new Set(Array.from(out).map(t => cyrFold(t)));
}

/**
 * True if any intent token shares an exact-or-substring (≥3 char, both
 * directions) overlap with any token in `against`. Same matching rule the
 * semantic floor uses for labels.
 */
export function hasTokenOverlap(intentTokens: Set<string>, against: Set<string>): boolean {
  if (intentTokens.size === 0 || against.size === 0) return false;
  for (const i of intentTokens) {
    for (const c of against) {
      if (i === c) return true;
      if (i.length >= 3 && c.length >= 3 && (i.includes(c) || c.includes(i))) return true;
    }
  }
  return false;
}

/**
 * Honesty guard — verify a chosen candidate is semantically compatible with the
 * intent. Rejects the "confident-but-unrelated" hallucination class (e.g.
 * intent "Панорама 360" → chosen "Заказать звонок").
 *
 * Returns:
 *   - null when the guard passes (caller accepts the pick)
 *   - { kind:'semanticFloor', reason } when it fails (caller treats as
 *     not_found and falls through)
 *
 * Logic:
 *   - heal mode + <3-char intent → bypass (permissive; fingerprint is truth).
 *   - label-less chosen (icon-only) → pass (recall guard — never reject blind).
 *   - else reject ONLY when intent overlaps NEITHER the visible label NOR the
 *     node's technical identity (the cross-language escape hatch: English
 *     "password" vs placeholder "Пароль" passes via type=password).
 */
export function evaluateHonestyGuard(args: {
  intentText: string;
  chosenNode: InteractiveNode | undefined | null;
  mode: 'apply' | 'heal';
}): { kind: 'semanticFloor'; reason: string } | null {
  const { intentText, chosenNode, mode } = args;

  if (mode === 'heal') return null;

  const intentLower = (intentText || '').toLowerCase().trim();
  if (intentLower.length < 3) return null;

  const chosenLabel = (getEffectiveLabel(chosenNode) || '').trim();

  const intentTokens = semanticTokens(intentLower);
  if (intentTokens.size === 0) return null;

  const chosenTokens = semanticTokens(chosenLabel);

  // RECALL GUARD: a label-less chosen element (icon-only "›", "✓", bare <svg>)
  // has no visible tokens to judge — pass (rejecting blind is the recall-killer
  // pattern removed elsewhere). Technical identity is an ACCEPT-only signal
  // below — never used to newly REJECT a case the label path would let through.
  if (chosenTokens.size === 0) return null;

  // Match against the visible label first (the common path).
  if (hasTokenOverlap(intentTokens, chosenTokens)) return null;

  // CROSS-LANGUAGE / TECHNICAL-IDENTITY ESCAPE HATCH: the visible label may be
  // in a different language than the intent yet the technical identity matches.
  if (hasTokenOverlap(intentTokens, nodeIdentityTokens(chosenNode))) return null;

  return {
    kind: 'semanticFloor',
    reason: `chosen label "${chosenLabel.slice(0, 50)}" shares no tokens with intent "${intentText.slice(0, 40)}" — likely no real match`,
  };
}
