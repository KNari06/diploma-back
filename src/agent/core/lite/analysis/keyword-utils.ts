/**
 * Shared keyword/error utilities — extracted from
 * `hybrid-semantic-weight.ts` so the rest of the LiteEngine
 * (`progress-evaluator.ts`, `lite-engine.ts checkElementRelevance`)
 * can keep using token-based goal matching and error detection after
 * the legacy weighted calculator is deleted.
 *
 * Design notes:
 *   - All functions are pure / synchronous / no I/O.
 *   - `matchesKeyword` does token-boundary matching with light EN/RU
 *     stemming so "catalog" does not falsely match "log".
 *   - `isErrorElement` reads role + text-bearing fields; no dependency
 *     on weights or category enrichment.
 *   - Bytes-for-bytes the previous implementations — no behaviour
 *     changes from the move.
 */

import { ERROR_KEYWORDS } from '@/config/testing/semantic-keywords';
import type { LiteElement } from '../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// TEXT NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize text for matching:
 * - lowercase
 * - ё → е (Russian)
 * - split camelCase and kebab-case
 * - normalize separators
 */
function normalizeText(text: string): string {
  if (!text) return '';

  return text
    .toLowerCase()
    // Russian: ё → е
    .replace(/ё/g, 'е')
    // Split camelCase: "signIn" → "sign In"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Split Cyrillic camelCase: "войтиВ" → "войти В"
    .replace(/([а-яё])([А-ЯЁ])/g, '$1 $2')
    // Normalize separators (kebab, snake, dots) to spaces
    .replace(/[-_.]+/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize text into words.
 */
function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  // Match English and Russian words (4+ chars for meaningful words, but keep all for matching)
  return normalized.split(/\s+/).filter(t => t.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// LIGHT STEMMING (EN + RU)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Light English stemming (conservative — only common suffixes).
 * Reduces "signing" → "sign", "logged" → "log", "submits" → "submit".
 */
function stemEnglish(word: string): string {
  if (word.length < 4) return word;

  // Skip if contains non-ASCII (not English)
  if (!/^[a-z]+$/.test(word)) return word;

  // Order matters: longer suffixes first
  const suffixes = [
    { suffix: 'ying', minLen: 5, replace: 'y' },   // dying → dy (but we skip short)
    { suffix: 'ing', minLen: 5, replace: '' },     // signing → sign, logging → logg (note: not perfect)
    { suffix: 'ied', minLen: 5, replace: 'y' },    // applied → apply
    { suffix: 'ies', minLen: 5, replace: 'y' },    // applies → apply
    { suffix: 'ed', minLen: 4, replace: '' },      // logged → logg, saved → sav
    { suffix: 'es', minLen: 4, replace: '' },      // deletes → delet
    { suffix: 's', minLen: 4, replace: '' },       // submits → submit
  ];

  for (const { suffix, minLen, replace } of suffixes) {
    if (word.length >= minLen && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length) + replace;
      // Only return if stem is at least 3 chars
      if (stem.length >= 3) return stem;
    }
  }

  return word;
}

/**
 * Light Russian stemming (very conservative — common verb/noun endings).
 * Reduces "войдите" → "войд", "вошёл" → "вош".
 */
function stemRussian(word: string): string {
  if (word.length < 4) return word;

  // Skip if contains non-Cyrillic
  if (!/^[а-яё]+$/.test(word)) return word;

  // Common Russian endings (very conservative to avoid over-stripping)
  const endings = [
    'ться', 'ться', 'ите', 'ешь', 'ёшь', 'ать', 'ять', 'еть',
    'уть', 'оть', 'ил', 'ла', 'ло', 'ли', 'ый', 'ий', 'ой',
    'ая', 'яя', 'ое', 'ее', 'ие', 'ые',
  ];

  for (const ending of endings) {
    if (word.length > ending.length + 2 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }

  return word;
}

/**
 * Apply light stemming based on language detection.
 */
function stem(word: string): string {
  if (/^[a-z]+$/.test(word)) {
    return stemEnglish(word);
  }
  if (/^[а-яё]+$/.test(word)) {
    return stemRussian(word);
  }
  return word; // Mixed or unknown
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if text contains a keyword using token/boundary matching.
 * Prevents false positives like "catalog" matching "log".
 *
 * @param text Text to search in
 * @param keyword Keyword to find
 * @param useStemming Whether to use light stemming
 * @returns True if keyword matches
 */
export function matchesKeyword(text: string, keyword: string, useStemming = true): boolean {
  const textTokens = tokenize(text);
  const keywordTokens = tokenize(keyword);

  if (keywordTokens.length === 0) return false;

  // Apply stemming if enabled
  const processedTextTokens = useStemming
    ? textTokens.map(t => stem(t))
    : textTokens;
  const processedKeywordTokens = useStemming
    ? keywordTokens.map(t => stem(t))
    : keywordTokens;

  // Single word keyword: exact token match
  if (processedKeywordTokens.length === 1) {
    const kw = processedKeywordTokens[0];
    return processedTextTokens.some(t => t === kw);
  }

  // Multi-word keyword (e.g. "sign in"): token sequence match
  // Find first token, then check if remaining tokens follow
  const firstKw = processedKeywordTokens[0];
  for (let i = 0; i < processedTextTokens.length; i++) {
    if (processedTextTokens[i] === firstKw) {
      let matches = true;
      for (let j = 1; j < processedKeywordTokens.length; j++) {
        if (processedTextTokens[i + j] !== processedKeywordTokens[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }

  return false;
}

/**
 * Check if text matches any keyword in a list.
 */
function matchesAnyKeyword(
  text: string,
  keywords: readonly string[],
  useStemming = true
): boolean {
  for (const kw of keywords) {
    if (matchesKeyword(text, kw, useStemming)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect error / alert / warning elements.
 *
 * Used by:
 *   - progress-evaluator decorative-bulk gate (an added error element
 *     means the bulk is NOT decorative — keeps `'Minor Change'`)
 *   - progress-evaluator summary (lists error names in `⚠️ Errors`
 *     section of WHAT CHANGED prompt section)
 *
 * Read-only on the element: `role`, `htmlId`, `htmlName`, `name`,
 * `context`. ARIA `role="alert"` short-circuits to true.
 */
export function isErrorElement(el: LiteElement): boolean {
  // Check role first (most reliable - ARIA takes precedence)
  if (el.role === 'alert') return true;

  // Combine all text signals
  const textToCheck = [
    el.htmlId || '',
    el.htmlName || '',
    el.name || '',
    el.context || '',
  ].join(' ');

  // Use token matching for error keywords
  return matchesAnyKeyword(textToCheck, ERROR_KEYWORDS, false); // No stemming for errors
}
