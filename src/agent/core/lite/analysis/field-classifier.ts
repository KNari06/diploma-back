/**
 * Field Classifier
 * Shared classifier for identifying credential fields using 3-level hierarchy:
 * - Level 1 (high confidence): Technical semantics (type, autocomplete, inputmode)
 * - Level 2 (medium confidence): Accessibility hints (aria-label, placeholder, name, id)
 * - Level 3 (low confidence): Fallback dictionary from config
 *
 * Uses tokenization + boundary-aware matching to avoid false-positives:
 * - Short patterns (<=4 chars) require exact token match
 * - Long patterns use regex with word boundaries
 *
 * Used by:
 * - LiteEngine for secure credential injection
 * - LiteGraphAdapter for smart redaction
 * - LiteTraceWriter for log masking
 */

import {
  CREDENTIAL_FALLBACK_PATTERNS,
  LEVEL1_AUTOCOMPLETE_MAP,
  LEVEL1_INPUTMODE_MAP,
  LEVEL1_TYPE_MAP,
  type CredentialKind,
} from '@/config/testing/credential-field-patterns';
import type { LiteElement } from '../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN COMPILER (cached, runs once per process)
// ═══════════════════════════════════════════════════════════════════════════

/** Threshold: patterns <= this length require exact token match */
const SHORT_PATTERN_THRESHOLD = 4;

/** Maximum allowed pattern length (ReDoS defense) */
const MAX_PATTERN_LENGTH = 50;

/** Maximum input text length for regex matching (ReDoS defense) */
const MAX_INPUT_LENGTH_FOR_REGEX = 200;

/** Compiled patterns for each credential kind */
interface CompiledPatterns {
  /** Short patterns that require exact token match */
  exactTokens: Set<string>;
  /** Long patterns compiled as boundary-aware regexes */
  boundaryRegexes: RegExp[];
}

/** Cache of compiled patterns per credential kind */
const compiledPatternsCache: Record<CredentialKind, CompiledPatterns> = {} as any;

/**
 * Compile patterns for a credential kind (cached)
 * Short patterns go into exactTokens set, long patterns become boundary regexes
 *
 * FIX: Added MAX_PATTERN_LENGTH guard to prevent ReDoS from unexpectedly long patterns.
 * Patterns come from our config (not user input), but defense-in-depth is important.
 */
function getCompiledPatterns(kind: CredentialKind): CompiledPatterns {
  if (compiledPatternsCache[kind]) {
    return compiledPatternsCache[kind];
  }

  const patterns = CREDENTIAL_FALLBACK_PATTERNS[kind];
  const exactTokens = new Set<string>();
  const boundaryRegexes: RegExp[] = [];

  for (const pattern of patterns) {
    // ReDoS defense: skip excessively long patterns
    if (pattern.length > MAX_PATTERN_LENGTH) {
      continue;
    }

    if (pattern.length <= SHORT_PATTERN_THRESHOLD) {
      // Short pattern: require exact token match
      exactTokens.add(pattern.toLowerCase());
    } else {
      // Long pattern: use boundary-aware regex
      // Matches pattern at word boundaries (start/end or non-alphanumeric)
      // Supports Latin and Cyrillic characters
      try {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Boundary class covers Latin + Cyrillic incl. Kazakh-specific letters
        // (ә ғ қ ң ө ұ ү һ і) — `[а-яёА-ЯЁ]` alone would treat a Kazakh letter
        // as a boundary and mis-match credential fields labelled in Kazakh.
        const NON_WORD = '[^a-zа-яёәғқңөұүһіA-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9]';
        const regex = new RegExp(
          `(?:^|${NON_WORD})${escaped}(?:$|${NON_WORD})`,
          'i'
        );
        boundaryRegexes.push(regex);
      } catch {
        // Invalid regex from pattern — skip silently
      }
    }
  }

  compiledPatternsCache[kind] = { exactTokens, boundaryRegexes };
  return compiledPatternsCache[kind];
}

// ═══════════════════════════════════════════════════════════════════════════
// TOKENIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tokenize a string by splitting on common separators
 * Converts: "user_notes", "user-name", "userName" -> ["user", "notes"] / ["user", "name"]
 *
 * @param text - Raw text to tokenize
 * @returns Array of lowercase tokens
 */
function tokenize(text: string): string[] {
  // Replace separators with spaces, handle camelCase
  const normalized = text
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .replace(/([а-яёәғқңөұүһі])([А-ЯЁӘҒҚҢӨҰҮҺІ])/g, '$1 $2') // Cyrillic camelCase (ru + kk)
    .replace(/[_.:/\s-]+/g, ' ') // separators -> space (hyphen at end to avoid escaping)
    .toLowerCase()
    .trim();

  if (!normalized) return [];

  return normalized.split(/\s+/).filter(t => t.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN MATCHING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if text matches any pattern for the given kind
 * Uses hybrid approach:
 * - Short patterns: exact token match (prevents false-positives like user_notes -> user)
 * - Long patterns: boundary-aware regex match
 *
 * @param text - Raw text (will be tokenized/normalized internally)
 * @param kind - Credential kind to check against
 * @returns True if text matches any pattern for this kind
 */
function matchesPattern(text: string, kind: CredentialKind): boolean {
  const { exactTokens, boundaryRegexes } = getCompiledPatterns(kind);
  const tokens = tokenize(text);

  // Check exact token matches first (fast path for short patterns)
  for (const token of tokens) {
    if (exactTokens.has(token)) {
      return true;
    }
  }

  // Check boundary regexes for long patterns
  // FIX: Truncate input to prevent ReDoS on unexpectedly long attribute values
  const normalized = text.length > MAX_INPUT_LENGTH_FOR_REGEX
    ? text.slice(0, MAX_INPUT_LENGTH_FOR_REGEX).toLowerCase()
    : text.toLowerCase();
  for (const regex of boundaryRegexes) {
    if (regex.test(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if any text signal matches a credential pattern
 * Returns the matched kind or null
 */
function findMatchingKind(signals: Array<{ source: string; value: string }>): CredentialKind | null {
  // Check each credential kind in priority order
  // Password first (most critical), then email, phone, username
  const kinds: CredentialKind[] = ['password', 'email', 'phone', 'username'];

  for (const signal of signals) {
    for (const kind of kinds) {
      if (matchesPattern(signal.value, kind)) {
        return kind;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classification result with confidence level and reasoning
 */
export interface FieldClassification {
  /** Detected credential kind, null if not a credential field */
  kind: CredentialKind | null;
  /** Confidence level based on classification hierarchy */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Reasons explaining classification decision (for debugging) */
  reasons: string[];
}

/**
 * Classify a field element to determine if it's a credential field
 * Uses 3-level hierarchy: technical semantics > accessibility > fallback dictionary
 *
 * @param el - LiteElement from snapshot (with autocomplete/inputmode/htmlName/htmlId)
 * @returns Classification result with kind, confidence, and reasons
 */
export function classifyField(el: LiteElement): FieldClassification {
  const reasons: string[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // LEVEL 1: Technical semantics (highest confidence)
  // ═══════════════════════════════════════════════════════════════════════════

  // Check type attribute (most reliable for password/email/tel)
  if (el.type) {
    const typeKind = LEVEL1_TYPE_MAP[el.type.toLowerCase()];
    if (typeKind) {
      reasons.push(`type="${el.type}"`);
      return { kind: typeKind, confidence: 'high', reasons };
    }
  }

  // Check autocomplete attribute (very reliable)
  if (el.autocomplete) {
    const autoKind = LEVEL1_AUTOCOMPLETE_MAP[el.autocomplete.toLowerCase()];
    if (autoKind) {
      reasons.push(`autocomplete="${el.autocomplete}"`);
      return { kind: autoKind, confidence: 'high', reasons };
    }
  }

  // Check inputmode attribute (reliable for phone/email)
  if (el.inputmode) {
    const inputmodeKind = LEVEL1_INPUTMODE_MAP[el.inputmode.toLowerCase()];
    if (inputmodeKind) {
      reasons.push(`inputmode="${el.inputmode}"`);
      return { kind: inputmodeKind, confidence: 'high', reasons };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEVEL 2: Accessibility hints (medium confidence)
  // ═══════════════════════════════════════════════════════════════════════════

  // Collect all text signals to check
  const textSignals: Array<{ source: string; value: string }> = [];

  if (el.name) textSignals.push({ source: 'aria-label', value: el.name });
  if (el.placeholder) textSignals.push({ source: 'placeholder', value: el.placeholder });
  if (el.htmlName) textSignals.push({ source: 'name', value: el.htmlName });
  if (el.htmlId) textSignals.push({ source: 'id', value: el.htmlId });

  // Check text signals against fallback patterns (used for Level 2 and 3)
  const matchedKind = findMatchingKind(textSignals);

  if (matchedKind) {
    // Level 2: Match found in aria-label or placeholder (accessibility hints)
    const accessibilityMatch = textSignals.find(
      (s) => (s.source === 'aria-label' || s.source === 'placeholder') &&
             matchesPattern(s.value, matchedKind)
    );

    if (accessibilityMatch) {
      reasons.push(`${accessibilityMatch.source}="${accessibilityMatch.value}" matches ${matchedKind}`);
      return { kind: matchedKind, confidence: 'medium', reasons };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LEVEL 3: Fallback dictionary (low confidence)
    // ═══════════════════════════════════════════════════════════════════════════

    // Match found in name or id attributes (less reliable)
    const fallbackMatch = textSignals.find(
      (s) => (s.source === 'name' || s.source === 'id') &&
             matchesPattern(s.value, matchedKind)
    );

    if (fallbackMatch) {
      reasons.push(`${fallbackMatch.source}="${fallbackMatch.value}" matches ${matchedKind} (fallback)`);
      return { kind: matchedKind, confidence: 'low', reasons };
    }
  }

  // No credential field detected
  return { kind: null, confidence: 'none', reasons: ['no credential signals detected'] };
}

/**
 * Quick check: is this element a credential field? (any kind, any confidence)
 * Useful for simple redaction decisions
 */
export function isCredentialField(el: LiteElement): boolean {
  return classifyField(el).kind !== null;
}

/**
 * Quick check: is this element a sensitive field that should be redacted?
 * Returns true if classified as credential OR if isSensitive hint is validated
 *
 * @param el - LiteElement to check
 * @param isSensitiveHint - Optional AI hint (validated: only honored if classifier has medium/high confidence)
 */
export function shouldRedactField(el: LiteElement, isSensitiveHint?: boolean): boolean {
  const classification = classifyField(el);

  // Always redact if classified as any credential type
  if (classification.kind !== null) {
    return true;
  }

  // Honor AI isSensitive hint only if we have medium/high confidence
  // This prevents AI from forcing redaction on non-credential fields
  // Note: if kind is null but confidence is medium/high, something detected a signal
  if (isSensitiveHint && (classification.confidence === 'medium' || classification.confidence === 'high')) {
    return true;
  }

  return false;
}
