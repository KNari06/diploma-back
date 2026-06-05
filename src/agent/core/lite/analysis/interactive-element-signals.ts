/**
 * Interactive Element Signals
 * ─────────────────────────────────────────────────────────────────────────
 * Language-NEUTRAL predicates for the exploration heuristic fallbacks
 * (Cartographer.domFallbackOutput / SurveyAgent.buildFallbackEntryPoints).
 *
 * The fallbacks fire exactly when the LLM is unavailable (rate-limit degraded
 * or empty result). Matching elements by English words there silently yields
 * ZERO entry points on RU/KK/… sites. These predicates instead rely on
 * standardized, locale-independent signals — input `type`, `role`,
 * `inputmode`, `autocomplete`, form structure — and reuse the shared
 * multilingual field classifier for credential fields.
 *
 * No language conditions live here. Credential text matching (EN/RU/KK/…)
 * comes from credential-field-patterns.ts via classifyField().
 */

import type { LiteElement } from '../lite-types';
import { classifyField } from './field-classifier';

/** A field whose classifier kind is a real credential (password/email/username/phone). */
export function isCredentialInput(el: LiteElement): boolean {
  return classifyField(el).kind !== null;
}

export function isPasswordInput(el: LiteElement): boolean {
  return classifyField(el).kind === 'password';
}

/**
 * Search input — derived from standardized signals only:
 * `type=search`, `role=searchbox`, or `inputmode=search`. No text matching.
 */
export function isSearchInput(el: LiteElement): boolean {
  const type = el.type?.toLowerCase();
  const role = el.role?.toLowerCase();
  const inputmode = el.inputmode?.toLowerCase();
  return type === 'search' || role === 'searchbox' || inputmode === 'search';
}

/** A real editable field (excludes hidden / submit-style inputs). */
export function isEditableField(el: LiteElement): boolean {
  if (!['input', 'textarea', 'select'].includes(el.tag)) return false;
  const type = el.type?.toLowerCase();
  return type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'reset';
}

export function isFileInput(el: LiteElement): boolean {
  return el.tag === 'input' && el.type?.toLowerCase() === 'file';
}

/**
 * Submit control — structural, not textual: an explicit `type=submit`, or
 * `role=button`/`<button>` with no other type that would make it a plain
 * toggle. The caller decides which button is "the" submit (e.g. last in form).
 */
export function isSubmitButton(el: LiteElement): boolean {
  const type = el.type?.toLowerCase();
  if (type === 'submit') return true;
  const isButtonish = el.tag === 'button' || el.role === 'button';
  return isButtonish && (type === undefined || type === '' || type === 'button');
}

/** A clickable button/link element (language-neutral). */
export function isClickable(el: LiteElement): boolean {
  if (el.disabled) return false;
  return (
    el.tag === 'button' ||
    el.role === 'button' ||
    (el.tag === 'a' && (el.role === 'link' || el.role === 'menuitem'))
  );
}

/** Best label available for display, without depending on language. */
export function bestLabel(el: LiteElement): string {
  return (el.name || el.text || el.placeholder || el.htmlName || '').trim();
}
