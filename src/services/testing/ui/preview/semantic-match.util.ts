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

// LEGACY fallback list of generic UI tokens (English). The LIVE resolver path
// no longer consults this — it passes a page-FREQUENCY predicate
// (`buildGenericTokenPredicate`) so "generic" = "recurs across many controls on
// THIS page", which is language-agnostic and self-adapting. This static set is
// kept ONLY for the no-frequency-context call path (single-node callers / unit
// tests): without a page to measure against, we fall back to this list so
// `nodeIdentityTokens(node)` still drops obvious scaffolding tokens. Do NOT add
// to this list to fix a resolution bug — tune the frequency predicate instead.
const GENERIC_IDENTITY_TOKENS = new Set([
  'button', 'btn', 'input', 'field', 'element', 'control', 'icon',
  'modal', 'dialog', 'panel', 'container', 'wrapper', 'root', 'item',
  'submit', 'cancel', 'close', 'next', 'back', 'prev', 'open', 'toggle',
  'link', 'menu', 'list', 'row', 'cell', 'col', 'box', 'group', 'form',
  'label', 'text', 'value', 'data', 'test', 'qa', 'auto',
]);

// Frequency-filter constants (replace the static list on the live path).
// A token is "generic" when it recurs across many controls on the page:
//   ≥ max(GENERIC_FLOOR, ceil(N * GENERIC_FRACTION))   where N = node count.
// The fraction adapts to page size; the floor stops sparse candidate sets
// (e.g. a 6-field login form where "login" legitimately appears on 2 nodes)
// from false-positiving. Both are structural numbers, NOT a word list.
const GENERIC_FRACTION = 0.25;
const GENERIC_FLOOR = 4;

/**
 * Tokenize a node's IDENTIFIER fields (name/testId/stable-id) the same way the
 * identity channel does — pure, reused for both the frequency map and the
 * per-node token extraction so they can never diverge. Excludes type/role/
 * autocomplete (those are spec channels, not free-form identifiers).
 */
function nodeIdentifierTokens(node: InteractiveNode | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!node) return out;
  const eat = (raw: string | undefined) => {
    if (!raw) return;
    for (const part of splitIdentifier(raw)) {
      if (part.length >= 3) out.add(part);
    }
  };
  eat(node.name);
  eat(node.testIdAttr);
  if (node.id && !node.isDynamicId) eat(node.id);
  return out;
}

/**
 * Build a token → distinct-node-count map across a page's candidate nodes.
 * "Distinct node count" (a token on the same node many times counts once) =
 * document frequency: how many CONTROLS carry the token.
 */
export function buildIdentityTokenFrequency(nodes: InteractiveNode[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const node of nodes) {
    for (const token of nodeIdentifierTokens(node)) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }
  }
  return freq;
}

/**
 * Build the live-path generic predicate from a frequency map + node count.
 * A token is generic when it recurs on many controls (see constants above).
 */
export function buildGenericTokenPredicate(
  freq: Map<string, number>,
  nodeCount: number,
): (token: string) => boolean {
  const threshold = Math.max(GENERIC_FLOOR, Math.ceil(nodeCount * GENERIC_FRACTION));
  return (token: string) => (freq.get(token) || 0) >= threshold;
}

// W3C ARIA roles that carry input/widget SEMANTICS worth matching an intent
// against (language-agnostic, author-set). Deliberately EXCLUDES the generic
// container/navigation roles — especially `button` and `link` — because the
// English word "button"/"link" frequently appears in intents ("delete button")
// and matching it against role=button would let ANY button satisfy ANY
// button-mentioning intent (a hallucination hole). Only specific widget roles
// that genuinely disambiguate are included.
const SEMANTIC_IDENTITY_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'tab', 'slider', 'switch', 'spinbutton',
]);

/**
 * Is `node` a form-submit primary — the kind of button a generic "proceed"
 * intent targets? True for `type=submit` (input or button) and for a bare
 * `<button>` with no explicit non-button role and an undefined/submit type
 * (HTML defaults a button inside a form to type=submit).
 */
function isSubmitPrimary(node: InteractiveNode | undefined | null): boolean {
  if (!node) return false;
  const type = (node.type || node.inputType || '').toLowerCase();
  if (type === 'submit') return true;
  const tag = (node.tag || '').toLowerCase();
  const role = (node.role || '').toLowerCase();
  // Bare <button> (implicit submit). Exclude explicit type=button/reset and
  // any non-button ARIA role (e.g. role=tab on a styled button).
  if (tag === 'button' && (type === '' || type === 'submit') && (role === '' || role === 'button')) {
    return true;
  }
  return false;
}

/**
 * True when `chosen` is a submit primary AND it is the ONLY submit primary in
 * `siblings`. "Sole submit" is the structural signal that lets a generic
 * proceed intent resolve to it without ambiguity — on a page with two submit
 * buttons we cannot tell which one a language-mismatched intent means, so we
 * decline (fall back to the other guard layers).
 */
export function isSoleSubmitButton(
  chosen: InteractiveNode | undefined | null,
  siblings: InteractiveNode[],
): boolean {
  if (!isSubmitPrimary(chosen)) return false;
  let count = 0;
  for (const n of siblings) {
    if (isSubmitPrimary(n)) {
      count++;
      if (count > 1) return false;
    }
  }
  return count === 1;
}

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
export function nodeIdentityTokens(
  node: InteractiveNode | undefined | null,
  opts?: { isGeneric?: (token: string) => boolean },
): Set<string> {
  const out = new Set<string>();
  if (!node) return out;
  // Live path: caller passes a page-frequency predicate. No-context path
  // (single-node callers / unit tests): fall back to the static legacy list.
  const isGeneric = opts?.isGeneric ?? ((t: string) => GENERIC_IDENTITY_TOKENS.has(t));
  const add = (raw: string | undefined, o: { dropGeneric?: boolean } = {}) => {
    if (!raw) return;
    for (const part of splitIdentifier(raw)) {
      if (part.length < 3) continue;
      if (o.dropGeneric && isGeneric(part)) continue;
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

  // role — ONLY specific input/widget-semantic W3C roles (textbox, combobox,
  // checkbox, …). These are English, author-set, and disambiguate across
  // languages. `button`/`link`/`menuitem` are deliberately excluded (see
  // SEMANTIC_IDENTITY_ROLES) so a "button"/"link" word in the intent can't
  // blanket-match every button/link on the page.
  {
    const role = (node.role || '').toLowerCase();
    if (SEMANTIC_IDENTITY_ROLES.has(role)) out.add(role);
  }

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
 * Logic (cheap → expensive, first match wins):
 *   - heal mode + <3-char intent → bypass (permissive; fingerprint is truth).
 *   - label-less chosen (icon-only) → pass (recall guard — never reject blind).
 *   - LEXICAL: intent overlaps the visible label OR the node's technical
 *     identity (cross-language hatch: English "password" vs "Пароль" via
 *     type=password / role=textbox).
 *   - STRUCTURAL (pure, zero word lists → any-language): a click intent whose
 *     chosen node is the page's SOLE submit button AND that matched no OTHER
 *     candidate (by label or identity) → accept. On a one-submit form, a click
 *     intent matching nothing more specific can only mean "proceed", whatever
 *     language it's written in ("signin"/"войти"/"connexion"/"登录"). The
 *     "no better candidate" gate makes a specific intent decline IF a better
 *     match exists on the page.
 *   - else reject (confident-but-unrelated hallucination).
 *
 *   - L2 SEMANTIC (optional, injected): when lexical+structural fail, an
 *     embedding-cosine accept (intent ↔ label ≥ τ_embed) catches localized
 *     synonyms/links the token paths can't reach (войти↔signin, выход↔logout).
 *   - L3 LLM-JUDGE (optional, injected, flag-gated): only in the ambiguous band
 *     (τ_judge_low ≤ sim < τ_embed) a cheap yes/no arbitrates. Outside the band
 *     no judge runs (below → reject; above → already accepted at L2).
 *
 * L2/L3 are dependency-INJECTED (embed/cosine/ask closures) so this module
 * stays pure — no network import. Both fail-OPEN: a thrown closure degrades to
 * the pre-L2 verdict and NEVER blocks resolve. Omitting `semantic`/`judge`
 * disables L2/L3 (legacy behavior — unit tests rely on this).
 *
 * `action` / `siblingNodes` / `identityFreq` are optional for backward compat.
 */
const TAU_EMBED = 0.62;       // cosine ≥ this → accept (cross-language paraphrase)
const TAU_JUDGE_LOW = 0.45;   // [low, embed) → ambiguous band → judge; below → reject

export interface HonestySemanticDeps {
  embed: (text: string) => Promise<number[]>;       // throws → caught, fail-open
  cosine: (a: number[], b: number[]) => number;
}
export interface HonestyJudgeDeps {
  // returns true=accept, false=reject, null=inconclusive (→ band default reject)
  ask: (intent: string, label: string) => Promise<boolean | null>;
}

export async function evaluateHonestyGuard(args: {
  intentText: string;
  chosenNode: InteractiveNode | undefined | null;
  mode: 'apply' | 'heal';
  action?: string;
  siblingNodes?: InteractiveNode[];
  identityFreq?: (token: string) => boolean;
  semantic?: HonestySemanticDeps;
  judge?: HonestyJudgeDeps;
}): Promise<{ kind: 'semanticFloor'; reason: string } | null> {
  const { intentText, chosenNode, mode, action, siblingNodes, identityFreq, semantic, judge } = args;
  const idOpts = identityFreq ? { isGeneric: identityFreq } : undefined;

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

  // L1 LEXICAL — match against the visible label first (the common path).
  if (hasTokenOverlap(intentTokens, chosenTokens)) return null;

  // L1 LEXICAL — cross-language / technical-identity escape hatch: the visible
  // label may be in a different language than the intent yet the technical
  // identity matches (type=password / role=textbox / name=email / testId).
  if (hasTokenOverlap(intentTokens, nodeIdentityTokens(chosenNode, idOpts))) return null;

  // L0 STRUCTURAL — sole submit, no better candidate. PURE STRUCTURE, zero word
  // lists (any-language intent). A click intent whose chosen node is the page's
  // ONLY submit button is the right target when the intent ALSO failed to match
  // any OTHER candidate (by label or technical identity). The "no better
  // candidate" gate keeps a SPECIFIC intent (e.g. "delete account") from
  // grabbing the submit: if a more-matching element exists, this branch declines.
  if (
    (action === undefined || action === 'click')
    && isSoleSubmitButton(chosenNode, siblingNodes || [])
    && !intentMatchesAnySibling(intentTokens, chosenNode, siblingNodes || [], idOpts)
  ) {
    return null;
  }

  const reject = {
    kind: 'semanticFloor' as const,
    reason: `chosen label "${chosenLabel.slice(0, 50)}" shares no tokens with intent "${intentText.slice(0, 40)}" — likely no real match`,
  };

  // L2 SEMANTIC — embedding cosine intent ↔ label. Fail-OPEN: any closure throw
  // degrades to the lexical reject (never blocks, never newly-accepts blindly).
  let sim: number | null = null;
  if (semantic) {
    try {
      const [iv, lv] = await Promise.all([semantic.embed(intentLower), semantic.embed(chosenLabel)]);
      sim = semantic.cosine(iv, lv);
      if (sim >= TAU_EMBED) return null; // confident semantic match
    } catch {
      sim = null; // fail-open → fall through to reject (or judge if band unknown)
    }
  }

  // L3 LLM-JUDGE — only in the ambiguous band [TAU_JUDGE_LOW, TAU_EMBED). Below
  // the band the embedding is confident the texts are unrelated → reject without
  // a judge call (this is what keeps the judge rare on the hot path). Inconclusive
  // / error → band default = reject.
  if (judge && sim !== null && sim >= TAU_JUDGE_LOW && sim < TAU_EMBED) {
    try {
      const verdict = await judge.ask(intentText, chosenLabel);
      if (verdict === true) return null;
    } catch {
      /* fail-open to reject (band default) */
    }
  }

  return reject;
}

/**
 * True if the intent lexically matches ANY sibling OTHER than `chosen` — by
 * visible label OR technical identity. Used by the sole-submit structural
 * branch: if some other candidate matches the intent, the submit button is NOT
 * the obvious target and the branch must decline. Language-agnostic (token
 * overlap with cyr-fold), no word lists.
 */
function intentMatchesAnySibling(
  intentTokens: Set<string>,
  chosen: InteractiveNode | undefined | null,
  siblings: InteractiveNode[],
  idOpts?: { isGeneric?: (token: string) => boolean },
): boolean {
  for (const sib of siblings) {
    if (sib === chosen) continue;
    const labelTokens = semanticTokens((getEffectiveLabel(sib) || '').trim());
    if (hasTokenOverlap(intentTokens, labelTokens)) return true;
    if (hasTokenOverlap(intentTokens, nodeIdentityTokens(sib, idOpts))) return true;
  }
  return false;
}
