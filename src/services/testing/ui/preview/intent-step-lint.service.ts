/**
 * Intent Step Lint Service
 * LLM-based linting for step editor (primary) with rule-based fallback
 * Resolves intent steps to candidate elements using LLM semantic matching
 */

import { AI_MODELS, AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { cacheMetrics } from '@/utils/core/cache-metrics';
import { extractKeywordsSync } from '@/utils/text-processing/ai-keyword-extractor';
import {
    getEffectiveLabel,
    resolveElement,
    sanitizeIntent,
} from './element-resolver.service';
import { EditorTraceService } from './editor-trace.service';
import { evaluateEvidenceShortcut } from './evidence-shortcut.utils';
import { logIntentResolveLint } from './intent-resolve-audit';
import { collectSecretValues } from '@/utils/interpolation/redact-secrets';
import { normalizeUrlForComparison } from './auto-wait-for.utils';
import { isDynamicId } from './dynamic-id.util';
import { getPreviewSessionService } from './preview-session.service';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import type {
    IntentStep,
    InteractiveNode,
    LintCandidate,
    LintResult,
    LintStatus,
    TargetFingerprint,
} from './preview.types';


// Scoring weights (V2: higher weights for labels, hierarchy bonus)
const WEIGHTS = {
  TESTID_EXACT_MATCH: 150,    // V18: data-testid is the most stable identifier — highest confidence
  LABEL_TEXT_EXACT: 120,      // V2: Higher priority for labelText
  LABEL_EXACT_MATCH: 100,
  ARIA_LABEL_MATCH: 90,
  PLACEHOLDER_MATCH: 85,
  NAME_ATTR_MATCH: 70,
  TEXT_CONTAINS: 50,
  ROLE_MATCH: 30,
  TYPE_MATCH: 40,
  AUTOCOMPLETE_MATCH: 60,
  CONTAINER_HINT_MATCH: 20,
  CONTAINER_TITLE_MATCH: 35,  // V2: Container title disambiguation
  DYNAMIC_ID_PENALTY: -30,
  DISABLED_PENALTY: -50,
  READONLY_PENALTY: -40,      // V2: readonly penalty for fill actions
  NOT_VISIBLE_PENALTY: -100,
  NOT_TOPMOST_PENALTY: -20,   // V2: covered by overlay
  STATE_MISMATCH_PENALTY: -80, // V2: e.g., check action on already checked
};

// Confidence thresholds
const CONFIDENCE = {
  HIGH: 0.8,
  MEDIUM: 0.5,
  LOW: 0.3,
  AMBIGUOUS_THRESHOLD: 0.15, // Max score difference to consider ambiguous
  AI_FALLBACK_THRESHOLD: 0.4, // Below this, trigger AI fallback
  /**
   * V23 (April 2026): Score floor for rule-based scoring.
   *
   * When LLM is degraded and rule-based scoring runs, top candidates routinely
   * land in the 0.03-0.10 confidence band — that means "matched on tag-only,
   * no semantic overlap". Showing 3 such candidates as "did you mean one of
   * these?" misleads users: they look like real suggestions, but they're just
   * the first three <a>/<button> on the page.
   *
   * Below this floor (~15% of max possible score), the right answer is
   * not_found with a clear "no element matches" message — NOT a forced top-3
   * list. Above the floor, the candidates are at least semantically related
   * and showing them helps the user disambiguate.
   *
   * 0.15 chosen empirically: above this requires at least one of
   * label/aria/text/placeholder partial match; below means tag-only.
   */
  RULE_SCORE_FLOOR: 0.15,
};

// Action type to element type mappings (V2: added check/uncheck/toggle/open/close)
const ACTION_TO_ELEMENT_TYPES: Record<string, string[]> = {
  type: ['input', 'textarea', 'div', 'span'],       // div/span for contenteditable (rich text editors)
  fill: ['input', 'textarea', 'div', 'span'],       // div/span for contenteditable
  click: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg', 'summary', 'select', 'option', 'details'],
  select: ['select', 'option', 'button', 'div', 'span', 'input', 'li'],  // li for custom dropdowns
  hover: ['button', 'a', 'div', 'span', 'img', 'li', 'td', 'tr'],
  scroll: ['div', 'section', 'main', 'body'],
  press: ['input', 'textarea', 'button', 'div'],    // div for contenteditable
  wait: [],
  assert: [],
  navigate: [],
  // V2: State-aware action types
  check: ['input', 'label'],                        // label wrapping checkbox
  uncheck: ['input', 'label'],
  toggle: ['input', 'button', 'div', 'span', 'label'],
  open: ['button', 'div', 'select', 'summary', 'details'],
  close: ['button', 'div', 'summary', 'details'],
  // V3: AI-powered assertion
  ai_check: [],
  // V5: URL wait
  wait_for: [],
  // V12: Email inbox (no element target)
  wait_for_email: [],
  // V6: File upload — includes trigger elements (button/label/div) since real file input is often hidden
  upload: ['input', 'button', 'label', 'div', 'span'],
  // V10: Advanced interaction types
  dblclick: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg', 'summary'],
  contextmenu: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg'],
  drag_and_drop: ['div', 'span', 'li', 'img', 'tr', 'td', 'a', 'button'],
};

// V2: Actions that require writable state
const WRITABLE_ACTIONS = new Set(['fill', 'type', 'clear']);

// V2: Actions that require specific state
const STATE_AWARE_ACTIONS: Record<string, { requiredState: string; field: keyof InteractiveNode }> = {
  check: { requiredState: 'unchecked', field: 'checked' },
  uncheck: { requiredState: 'checked', field: 'checked' },
  open: { requiredState: 'closed', field: 'ariaExpanded' },
  close: { requiredState: 'open', field: 'ariaExpanded' },
};

/**
 * Normalize text for comparison
 */
function normalizeText(text: string | undefined): string {
  if (!text) return '';
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Normalize text for "loose" comparison (space-insensitive).
 *
 * Why:
 * - Users often type intents without spaces ("logout"), while UI text may contain spaces ("Log out").
 * - In degraded modes (LLM unavailable), rule-based fallback must still match reliably.
 *
 * We intentionally only remove whitespace here (not all punctuation) to keep behavior predictable.
 */
function normalizeTextLoose(text: string | undefined): string {
  return normalizeText(text).replace(/\s+/g, '');
}

/**
 * Check if text contains keywords from intent
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  const normalizedLoose = normalizeTextLoose(text);
  return keywords.some((kw) => {
    const kwNorm = normalizeText(kw);
    if (kwNorm.length === 0) return false;
    if (normalized.includes(kwNorm)) return true;

    const kwLoose = normalizeTextLoose(kw);
    return kwLoose.length > 0 && normalizedLoose.includes(kwLoose);
  });
}

/**
 * Score a candidate element against an intent step (V2)
 * Includes state-awareness, better label scoring, and hierarchy disambiguation
 * V4: Uses extractKeywordsSync for fallback mode (when LLM unavailable)
 */
function scoreCandidate(node: InteractiveNode, step: IntentStep): { score: number; reasons: string[]; hardReject: boolean } {
  let score = 0;
  const reasons: string[] = [];
  let hardReject = false;
  const keywords = extractKeywordsSync(step.description);
  const hints = step.bindingHints || {};

  // ═══════════════════════════════════════════════════════════════════════════
  // Hard filters (visibility, interactivity)
  // ═══════════════════════════════════════════════════════════════════════════
  if (!node.isVisible) {
    score += WEIGHTS.NOT_VISIBLE_PENALTY;
    reasons.push('Not visible');
  }

  if (node.isDisabled) {
    score += WEIGHTS.DISABLED_PENALTY;
    reasons.push('Disabled');
    hardReject = true; // Can't interact with disabled elements
  }

  // V2: isTopMostAtCenter check (covered by overlay)
  if (node.isTopMostAtCenter === false) {
    score += WEIGHTS.NOT_TOPMOST_PENALTY;
    reasons.push('Covered by overlay');
  }

  // V2: readonly check for writable actions
  if (WRITABLE_ACTIONS.has(step.type) && node.readOnly) {
    score += WEIGHTS.READONLY_PENALTY;
    reasons.push('Readonly field');
    hardReject = true;
  }

  // V2: State-aware action checks (check/uncheck/open/close)
  const stateCheck = STATE_AWARE_ACTIONS[step.type];
  if (stateCheck) {
    const currentState = node[stateCheck.field];
    const isCorrectState =
      (stateCheck.requiredState === 'unchecked' && currentState === false) ||
      (stateCheck.requiredState === 'checked' && currentState === true) ||
      (stateCheck.requiredState === 'closed' && currentState === false) ||
      (stateCheck.requiredState === 'open' && currentState === true);

    if (currentState !== undefined && !isCorrectState) {
      score += WEIGHTS.STATE_MISMATCH_PENALTY;
      reasons.push(`Already ${currentState ? 'checked/open' : 'unchecked/closed'}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V18: data-testid scoring — highest priority, stable identifier
  // ═══════════════════════════════════════════════════════════════════════════
  if (hints.testId && node.testIdAttr && hints.testId === node.testIdAttr) {
    score += WEIGHTS.TESTID_EXACT_MATCH;
    reasons.push('TestId exact match');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Label scoring (labelText > ariaLabel > text)
  // ═══════════════════════════════════════════════════════════════════════════
  if (hints.label) {
    const labelNorm = normalizeText(hints.label);
    const labelLoose = normalizeTextLoose(hints.label);

    // Priority 1: labelText exact match (highest)
    if (normalizeText(node.labelText) === labelNorm || normalizeTextLoose(node.labelText) === labelLoose) {
      score += WEIGHTS.LABEL_TEXT_EXACT;
      reasons.push('LabelText exact match');
    }
    // Priority 2: ariaLabel exact match
    else if (normalizeText(node.ariaLabel) === labelNorm || normalizeTextLoose(node.ariaLabel) === labelLoose) {
      score += WEIGHTS.LABEL_EXACT_MATCH;
      reasons.push('AriaLabel exact match');
    }
    // Priority 3: text exact match
    else if (normalizeText(node.text) === labelNorm || normalizeTextLoose(node.text) === labelLoose) {
      score += WEIGHTS.ARIA_LABEL_MATCH;
      reasons.push('Text exact match');
    }
    // Partial matches
    else if (containsKeywords(node.labelText || '', [hints.label])) {
      score += WEIGHTS.ARIA_LABEL_MATCH;
      reasons.push('LabelText partial match');
    } else if (containsKeywords(node.ariaLabel || '', [hints.label])) {
      score += WEIGHTS.ARIA_LABEL_MATCH * 0.9;
      reasons.push('AriaLabel partial match');
    } else if (containsKeywords(node.text || '', [hints.label])) {
      score += WEIGHTS.ARIA_LABEL_MATCH * 0.7;
      reasons.push('Text partial match');
    }
  }

  // V2: LabelText keyword matching (if no explicit hint)
  if (!hints.label && node.labelText && keywords.length > 0) {
    const matchCount = keywords.filter(kw => normalizeText(node.labelText).includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.LABEL_TEXT_EXACT * (matchCount / keywords.length) * 0.7;
      reasons.push(`LabelText matches ${matchCount} keywords`);
    }
  }

  // ARIA label match with keywords
  if (node.ariaLabel && keywords.length > 0) {
    const matchCount = keywords.filter(kw => normalizeText(node.ariaLabel).includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.ARIA_LABEL_MATCH * (matchCount / keywords.length);
      reasons.push(`AriaLabel matches ${matchCount} keywords`);
    }
  }

  // V23: title attribute keyword match — same scoring tier as aria-label
  // because per WAI-ARIA spec `title` IS an accessible name source. Without
  // this, intents matching `<a title="Папкалар">` (Angular routerLink icon
  // menus) score 0 from rule-based path even though title carries identity.
  if (node.title && keywords.length > 0) {
    const matchCount = keywords.filter(kw => normalizeText(node.title).includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.ARIA_LABEL_MATCH * (matchCount / keywords.length);
      reasons.push(`Title matches ${matchCount} keywords`);
    }
  }
  // V23: <img alt> match — accessible name for image targets. Same tier.
  const altAttr = (node as any).alt as string | undefined;
  if (altAttr && keywords.length > 0) {
    const matchCount = keywords.filter(kw => normalizeText(altAttr).includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.ARIA_LABEL_MATCH * (matchCount / keywords.length);
      reasons.push(`Alt matches ${matchCount} keywords`);
    }
  }

  // Placeholder match
  if (hints.placeholder) {
    if (normalizeText(node.placeholder) === normalizeText(hints.placeholder)) {
      score += WEIGHTS.PLACEHOLDER_MATCH;
      reasons.push('Placeholder exact match');
    } else if (containsKeywords(node.placeholder || '', [hints.placeholder])) {
      score += WEIGHTS.PLACEHOLDER_MATCH * 0.7;
      reasons.push('Placeholder partial match');
    }
  } else if (node.placeholder && keywords.length > 0) {
    const matchCount = keywords.filter(kw => normalizeText(node.placeholder).includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.PLACEHOLDER_MATCH * (matchCount / keywords.length);
      reasons.push(`Placeholder matches ${matchCount} keywords`);
    }
  }

  // Name attribute match
  if (node.name && keywords.length > 0) {
    const nameNorm = normalizeText(node.name);
    const matchCount = keywords.filter(kw => nameNorm.includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.NAME_ATTR_MATCH * (matchCount / keywords.length);
      reasons.push(`Name attr matches ${matchCount} keywords`);
    }
  }

  // Text content match
  if (node.text && keywords.length > 0) {
    const textNorm = normalizeText(node.text);
    const matchCount = keywords.filter(kw => textNorm.includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.TEXT_CONTAINS * (matchCount / keywords.length);
      reasons.push(`Text matches ${matchCount} keywords`);
    }
  }

  // Role match
  if (hints.role && normalizeText(node.role) === normalizeText(hints.role)) {
    score += WEIGHTS.ROLE_MATCH;
    reasons.push('Role match');
  }

  // Type match (for inputs)
  if (hints.type) {
    const hintType = normalizeText(hints.type);
    const nodeType = normalizeText(node.type || node.inputType);
    if (nodeType === hintType) {
      score += WEIGHTS.TYPE_MATCH;
      reasons.push('Type match');
    }
  }

  // Autocomplete match
  if (hints.autocomplete && node.autocomplete) {
    if (normalizeText(node.autocomplete).includes(normalizeText(hints.autocomplete))) {
      score += WEIGHTS.AUTOCOMPLETE_MATCH;
      reasons.push('Autocomplete match');
    }
  }

  // Smart autocomplete inference from description
  const descLower = step.description.toLowerCase();
  if (!hints.autocomplete) {
    const autocompleteMappings: Record<string, string[]> = {
      'email': ['email', 'почт', 'e-mail'],
      'username': ['username', 'login', 'логин', 'пользовател'],
      'password': ['password', 'пароль', 'current-password', 'new-password'],
      'tel': ['phone', 'телефон', 'mobile', 'мобильн'],
    };

    for (const [autoVal, terms] of Object.entries(autocompleteMappings)) {
      if (terms.some(t => descLower.includes(t))) {
        if (node.autocomplete === autoVal || node.type === autoVal) {
          score += WEIGHTS.AUTOCOMPLETE_MATCH;
          reasons.push(`Inferred autocomplete=${autoVal}`);
          break;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Hierarchy disambiguation (containerRef, containerTitles)
  // ═══════════════════════════════════════════════════════════════════════════
  if (hints.nearText && node.containerTitles && node.containerTitles.length > 0) {
    const nearTextNorm = normalizeText(hints.nearText);
    const containerMatch = node.containerTitles.some(title =>
      normalizeText(title).includes(nearTextNorm) || nearTextNorm.includes(normalizeText(title))
    );
    if (containerMatch) {
      score += WEIGHTS.CONTAINER_TITLE_MATCH;
      reasons.push('Container title matches nearText');
    }
  }

  // Container title keyword match
  if (node.containerTitles && node.containerTitles.length > 0 && keywords.length > 0) {
    const allTitles = node.containerTitles.join(' ');
    const matchCount = keywords.filter(kw => normalizeText(allTitles).includes(kw)).length;
    if (matchCount > 0) {
      score += WEIGHTS.CONTAINER_HINT_MATCH * (matchCount / keywords.length);
      reasons.push(`Container matches ${matchCount} keywords`);
    }
  }

  // Dynamic ID penalty
  if (node.isDynamicId) {
    score += WEIGHTS.DYNAMIC_ID_PENALTY;
    reasons.push('Dynamic ID (unstable)');
  }

  // Element type match for action
  const expectedTags = ACTION_TO_ELEMENT_TYPES[step.type] || [];
  if (expectedTags.length > 0 && expectedTags.includes(node.tag)) {
    score += 10;
    reasons.push('Tag matches action type');
  }

  return { score, reasons, hardReject };
}

// Note: a local `normalizeUrlForComparison` used to live here with a
// different (query-sorting) implementation than the one in
// `auto-wait-for.utils.ts`. It had zero callers in this file — dead code
// kept from a never-completed P2 work item — and its existence risked
// silently diverging the URL-equality contract from the rest of the
// pipeline. Removed; consumers should import from `auto-wait-for.utils`
// so "same URL?" has one answer across the service.

// ─────────────────────────────────────────────────────────────────────────────
// Degraded-mode fingerprint disambiguation (offline scoring)
// ─────────────────────────────────────────────────────────────────────────────
// When the LLM resolver is unavailable, the rule-based fallback often yields
// several candidates with no clean way to pick. If the step carries a recorded
// TargetFingerprint, we can rank candidates against it without any extra page
// roundtrips — the InteractiveNode snapshot is already in memory and exposes
// every field we need for both structural and spatial comparison.
//
// Mirrors the weighting used in compiled-locator-executor.tryLocatorEntry so
// the two paths agree on what "the recorded element" means.

const DEGRADED_FP_WEIGHT = 0.7;
const DEGRADED_BBOX_WEIGHT = 0.3;

/** Continuous bbox proximity score (0..1). Identical decay to executor. */
function bboxProximityScore(
  recorded: { x: number; y: number; width: number; height: number } | undefined,
  candidate: { x: number; y: number; width: number; height: number } | null | undefined,
): number {
  if (!recorded || !candidate) return 0.5;
  if (recorded.width <= 0 || recorded.height <= 0) return 0.5;
  if (candidate.width <= 0 || candidate.height <= 0) return 0.5;
  const dx = (recorded.x + recorded.width / 2) - (candidate.x + candidate.width / 2);
  const dy = (recorded.y + recorded.height / 2) - (candidate.y + candidate.height / 2);
  const dist = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, 1 - dist / 400);
}

/**
 * Score a single candidate against the fingerprint, returning a value in
 * [0, 1] proportional to how many fingerprint attributes match. Skips
 * fields the fingerprint did not record (avoids penalising partial data).
 */
function structuralFingerprintScore(node: InteractiveNode, fp: TargetFingerprint): number {
  let total = 0;
  let matches = 0;
  if (fp.tag) { total++; if (node.tag?.toLowerCase() === fp.tag.toLowerCase()) matches++; }
  if (fp.role) { total++; if (node.role === fp.role) matches++; }
  if (fp.ariaLabel) { total++; if (node.ariaLabel === fp.ariaLabel) matches++; }
  if (fp.placeholder) { total++; if (node.placeholder === fp.placeholder) matches++; }
  if (fp.labelText) { total++; if (node.labelText === fp.labelText) matches++; }
  if (fp.testIdAttr) { total++; if (node.testIdAttr === fp.testIdAttr) matches++; }
  if (fp.containerTitles && fp.containerTitles.length > 0) {
    total++;
    const fpSet = new Set(fp.containerTitles.map((c) => c.toLowerCase()));
    const nodeContainers = (node.containerTitles || []).map((c: string) => c.toLowerCase());
    if (nodeContainers.some((c) => fpSet.has(c))) matches++;
  }
  if (total === 0) return 1;
  return matches / total;
}

/**
 * Rank rule-based LintCandidates against a recorded fingerprint. Used by
 * the degraded path to recover from "multiple candidates, LLM down" cases
 * without forcing the user into a clarification dialog when we already
 * have enough recorded signal to decide.
 */
function rankCandidatesByFingerprint(
  candidates: LintCandidate[],
  domNodes: InteractiveNode[],
  fp: TargetFingerprint,
): Array<{ candidate: LintCandidate; score: number; fp: number; bbox: number }> {
  const refToNode = new Map(domNodes.map((n) => [n.ref, n]));
  return candidates
    .map((c) => {
      const node = refToNode.get(c.ref);
      // No matching node in snapshot — score with bbox only and zero structural.
      const fpScore = node ? structuralFingerprintScore(node, fp) : 0;
      const bScore = bboxProximityScore(fp.boundingBox, c.boundingBox);
      const combined = DEGRADED_FP_WEIGHT * fpScore + DEGRADED_BBOX_WEIGHT * bScore;
      return { candidate: c, score: combined, fp: fpScore, bbox: bScore };
    })
    .sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════════════════
// V23: Clarification scenario classifier
// ═══════════════════════════════════════════════════════════════════════════
//
// Determines WHY lint couldn't resolve a step, so the clarification message
// addresses the actual problem instead of always saying "describe better".
//
// Order matters — earlier scenarios take precedence when multiple apply.
//
// PAGE_MISMATCH        — recorded URL doesn't match current URL (covered by
//                        URL guard upstream; this scenario is the prompt-side
//                        fallback for cases where guard passes but content
//                        diverges, e.g. SPA same-URL).
// AI_DEGRADED          — LLM resolver failed (timeout / circuit breaker /
//                        rate limit / parse). Showing "describe better" lies;
//                        the issue is on our side.
// NO_RECORDED_MATCH    — step has recordedFingerprint with TIER1 tokens
//                        (id/testId/dataValue) but no live candidate carries
//                        any of them. Probably wrong page or DOM rebuilt.
// AMBIGUOUS_RIGHT_PAGE — top score is reasonable but multiple candidates tie.
//                        User actually needs to pick or refine.
// VAGUE_DESC           — top confidence < 0.3 with recorded match present
//                        (one candidate matches recordedFp but description
//                        is too short to be sure). Suggest improving wording.
// GENERIC              — generic intent ("button", "ссылка"), many candidates.
type ClarifyScenario =
  | 'PAGE_MISMATCH'
  | 'AI_DEGRADED'
  | 'NO_RECORDED_MATCH'
  | 'AMBIGUOUS_RIGHT_PAGE'
  | 'VAGUE_DESC'
  | 'GENERIC';

interface ClarifyScenarioInput {
  stepDraft: IntentStep;
  candidates: LintCandidate[];
  topConfidence: number;
  currentUrl: string;
  degradedReason?: string;
  isSemanticZero?: boolean;
}

/**
 * Cyrillic↔Latin glyph fold for visually identical letters. Lets us match
 * "MAT-SMART" (Latin M-A-T) against "МАТ-SMART" (Cyrillic М-А-Т) when the
 * intent and DOM disagree on script. Mirrors the fold used in apply-mode
 * label guard.
 */
function cyrLatFold(s: string): string {
  return (s || '').toLowerCase()
    .replace(/[аА]/g, 'a')
    .replace(/[еЕ]/g, 'e')
    .replace(/[оО]/g, 'o')
    .replace(/[рР]/g, 'p')
    .replace(/[сС]/g, 'c')
    .replace(/[хХ]/g, 'x')
    .replace(/[уУ]/g, 'y')
    .replace(/[мМ]/g, 'm')
    .replace(/[тТ]/g, 't')
    .replace(/[кК]/g, 'k')
    .replace(/[вВ]/g, 'b')
    .replace(/[нН]/g, 'h');
}

/**
 * Tokenize for set-overlap comparison: drop short / numeric / pure-symbol
 * tokens, fold script, dedupe. Compatible with the apply-mode tokenizer.
 */
function clarifyTokenize(s: string): Set<string> {
  return new Set(
    cyrLatFold(s)
      .split(/[\s\W_]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t)),
  );
}

function classifyClarifyScenario(input: ClarifyScenarioInput): ClarifyScenario {
  const { stepDraft, candidates, topConfidence, degradedReason } = input;

  // 1. AI_DEGRADED — anything that came in with a degradedReason from the
  //    upstream resolver. URL_mismatch is excluded because URL guard already
  //    handled it before the rule fallback ever ran.
  if (degradedReason && degradedReason !== 'url_mismatch') {
    return 'AI_DEGRADED';
  }

  // 2. NO_RECORDED_MATCH — recorded TIER1/2 tokens present, none in any candidate.
  const recordedFp = stepDraft.recordedFingerprint || stepDraft.compiled?.targetFingerprint;
  if (recordedFp && candidates.length > 0) {
    const recordedTier1: string[] = [
      recordedFp.elementId,
      recordedFp.testIdAttr,
      (recordedFp as any).childTestId,
      (recordedFp as any).dataValue,
      (recordedFp as any).dataRowKey,
      recordedFp.name,
    ].filter(Boolean) as string[];

    const recordedTextTokens = new Set<string>();
    // V23: parity with live-side liveText — include alt/iconLabel/svgIcon/etc
    // so manually-recorded steps with identity in those fields cross-match too.
    [
      recordedFp.labelText, recordedFp.ariaLabel, recordedFp.text, recordedFp.title,
      (recordedFp as any).alt, (recordedFp as any).iconLabel, (recordedFp as any).svgIcon,
      (recordedFp as any).childTestId, (recordedFp as any).customElementTag,
    ]
      .filter(Boolean)
      .forEach((t) => clarifyTokenize(t!).forEach((tok) => recordedTextTokens.add(tok)));

    if (recordedTier1.length > 0 || recordedTextTokens.size > 0) {
      const anyMatch = candidates.some((c) => {
        const node = c.node;
        if (!node) return false;
        // TIER1 exact id/testId/etc match
        for (const v of recordedTier1) {
          const folded = cyrLatFold(v);
          if (
            cyrLatFold(node.id || '') === folded ||
            cyrLatFold(node.testIdAttr || '') === folded ||
            cyrLatFold((node as any).dataValue || '') === folded ||
            cyrLatFold(node.name || '') === folded
          ) {
            return true;
          }
        }
        // text token overlap
        if (recordedTextTokens.size > 0) {
          // V23: include all identity sources — alt/iconLabel/svgIcon/childTestId/
          // customElementTag — so cross-fingerprint match isn't blocked when
          // identity lives on derived fields (Angular Material `<a title>`,
          // Lucide `<svg data-lucide>`, Vue `<img alt>` etc).
          const liveText = [
            node.labelText, node.ariaLabel, node.text, node.placeholder, node.title,
            (node as any).alt, (node as any).iconLabel, (node as any).svgIcon,
            (node as any).childTestId, (node as any).customElementTag,
          ].filter(Boolean).join(' ');
          const liveTokens = clarifyTokenize(liveText);
          for (const t of recordedTextTokens) {
            if (liveTokens.has(t)) return true;
          }
        }
        return false;
      });
      if (!anyMatch) return 'NO_RECORDED_MATCH';
    }
  }

  // 3. AMBIGUOUS_RIGHT_PAGE — multiple candidates, top confidence ≥ 0.5.
  if (candidates.length >= 2 && topConfidence >= 0.5) {
    return 'AMBIGUOUS_RIGHT_PAGE';
  }

  // 4. VAGUE_DESC — recorded fp present, low top confidence, short intent.
  if (recordedFp && topConfidence < 0.5 && (stepDraft.description || '').trim().length < 25) {
    return 'VAGUE_DESC';
  }

  // 5. GENERIC — fallthrough.
  return 'GENERIC';
}

/**
 * Intent Step Lint Service
 */
export class IntentStepLintService {
  /**
   * Lint a step against the current page context
   */
  static async lintStep(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
  }): Promise<LintResult> {
    const { previewSessionId, stepDraft, userId } = params;

    // Attribute every LLM call made during this lint to the editor user,
    // labelled as 'ai-selector' so it shows up in the AI activity feed.
    return withAIContext(
      {
        workspaceId: '',
        userId,
        operationType: 'lite-test',
        logSource: 'ai-selector',
        logActionType: 'lint-step',
        logEntityType: 'test_execution',
        logEntityId: previewSessionId,
      },
      () => this._lintStepInner(params),
    ) as Promise<LintResult>;
  }

  private static async _lintStepInner(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
  }): Promise<LintResult> {
    const { previewSessionId, stepDraft, userId } = params;

    logger.debug('[INTENT_LINT] Linting step', {
      previewSessionId,
      stepType: stepDraft.type,
      descriptionPreview: sanitizeIntent(stepDraft).slice(0, 80),
    });

    try {
      // Get DOM nodes from preview session (fullPage: include off-viewport elements for replay)
      const sessionService = getPreviewSessionService();
      const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
        includeDomNodes: true,
        fullPage: true,
      });

      if (!snapshot) {
        return {
          status: 'error',
          message: 'Preview session not found or expired',
          confidence: 0,
          candidates: [],
          highlight: [],
        };
      }

      const domNodes = snapshot.domNodes ?? [];

      // Non-targeting actions — page-level steps that don't target a specific DOM element
      if (['navigate', 'wait', 'wait_for', 'ai_check', 'scroll', 'switch_tab', 'close_tab', 'open_tab'].includes(stepDraft.type)) {
        return {
          status: 'resolved',
          message: `Action "${stepDraft.type}" does not require element targeting`,
          confidence: 1,
          candidates: [],
          highlight: [],
        };
      }

      if (domNodes.length === 0) {
        return {
          status: 'not_found',
          message: 'No interactive elements found on page',
          confidence: 0,
          candidates: [],
          highlight: [],
        };
      }

      // Score all candidates (V2: with hardReject filtering)
      const scoredCandidates = domNodes
        .map(node => {
          const { score, reasons, hardReject } = scoreCandidate(node, stepDraft);
          return {
            node,
            score,
            reasons,
            hardReject,
          };
        })
        .filter(c => c.score > 0 && !c.hardReject) // V2: filter out hard rejects
        .sort((a, b) => b.score - a.score);

      if (scoredCandidates.length === 0) {
        // V2: Check if all candidates were hard rejected
        const allRejected = domNodes.some(node => {
          const { hardReject } = scoreCandidate(node, stepDraft);
          return hardReject;
        });

        const message = allRejected
          ? 'All matching elements are disabled, readonly, or in wrong state.'
          : 'No matching elements found. Try adding more specific hints (label, placeholder, or role).';

        return {
          status: 'not_found',
          message,
          confidence: 0,
          candidates: [],
          highlight: [],
          needsAiFallback: true, // V2: Signal that AI fallback may help
        };
      }

      // Calculate confidence and check for ambiguity
      const topScore = scoredCandidates[0].score;
      const maxPossibleScore = WEIGHTS.LABEL_TEXT_EXACT + WEIGHTS.ROLE_MATCH + WEIGHTS.TYPE_MATCH + WEIGHTS.AUTOCOMPLETE_MATCH;
      const confidence = Math.min(topScore / maxPossibleScore, 1);

      // V23: Score floor — if every candidate matched on tag-only (no semantic
      // overlap with intent label/aria/text), surfacing them as suggestions is
      // misleading. The user gets a "did you mean one of these?" panel filled
      // with the first 3 <a>/<button> on the page that have nothing to do with
      // their intent. Better to return not_found with a clear message and let
      // the LLM pipeline / URL guard / sceneSummary explain WHY.
      if (confidence < CONFIDENCE.RULE_SCORE_FLOOR) {
        logger.info('[INTENT_LINT] Rule-based score below floor, returning not_found', {
          previewSessionId,
          topScore,
          confidence: Math.round(confidence * 100) / 100,
          floor: CONFIDENCE.RULE_SCORE_FLOOR,
          candidatesCount: scoredCandidates.length,
        });
        return {
          status: 'not_found',
          message: `Не найдено элемента, подходящего под описание "${stepDraft.description}". Возможно, страница ещё не загрузилась или нужно уточнить описание (текст, роль, расположение).`,
          confidence,
          candidates: [],
          highlight: [],
          needsAiFallback: true,
        };
      }

      // Check for ambiguous candidates (multiple high scorers)
      const topCandidates = scoredCandidates.filter(
        c => (topScore - c.score) / topScore <= CONFIDENCE.AMBIGUOUS_THRESHOLD
      );

      const isAmbiguous = topCandidates.length > 1;
      const needsAiFallback = isAmbiguous || confidence < CONFIDENCE.AI_FALLBACK_THRESHOLD;

      // Build result (V2: prefer labelText for label display)
      const candidateResults: LintCandidate[] = topCandidates.slice(0, 5).map(c => ({
        ref: c.node.ref,
        label: getEffectiveLabel(c.node) || `<${c.node.tag}>`,
        reason: c.reasons.slice(0, 3).join(', '),
        confidence: Math.min(c.score / maxPossibleScore, 1),
        boundingBox: c.node.boundingBox,
        node: c.node, // Include full node for compiled plan generation
      }));

      let status: LintStatus;
      let message: string;

      if (isAmbiguous) {
        status = 'ambiguous';
        message = `Found ${topCandidates.length} matching elements. Please refine your step description or use AI assist.`;
      } else if (confidence >= CONFIDENCE.HIGH) {
        status = 'resolved';
        message = 'Element found with high confidence';
      } else if (confidence >= CONFIDENCE.MEDIUM) {
        status = 'resolved';
        message = 'Element found with moderate confidence';
      } else {
        status = 'ambiguous';
        message = 'Element found but confidence is low. Consider adding more hints or using AI assist.';
      }

      const highlight = candidateResults.map((c, idx) => ({
        ref: c.ref,
        boundingBox: c.boundingBox,
        type: (idx === 0 && !isAmbiguous ? 'success' : 'warning') as 'success' | 'warning' | 'error',
      }));

      return {
        status,
        message,
        confidence,
        candidates: candidateResults,
        highlight,
        needsAiFallback, // V2: Signal for AI fallback
      };
    } catch (error) {
      logger.error('[INTENT_LINT] Linting failed', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId,
      });

      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Linting failed',
        confidence: 0,
        candidates: [],
        highlight: [],
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVIDENCE SHORTCUT VALIDATION (delegates to exported function)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a cached node is compatible with the step action type.
   * Wrapper that delegates to the exported `isEvidenceShortcutNodeCompatible` function.
   */
  private static isEvidenceShortcutNodeCompatible(
    step: IntentStep,
    node: InteractiveNode,
    pageUrl: string
  ): { ok: boolean; reason?: string } {
    return isEvidenceShortcutNodeCompatible(step, node, pageUrl);
  }

  /**
   * Lint step with LLM-based element resolution (PRIMARY)
   *
   * Architecture:
   * 1. Evidence shortcut (if enabled) with action-type validation
   * 2. LLM-based resolver with HardAllowed/SoftAllowed sets
   * 3. Count-based decision: 0→AI rescue, 1→resolved, >1→LLM selection
   * 4. For needs_clarification: generate LLM message (no candidates by default)
   * 5. Candidates only returned when includeAlternatives=true
   */
  static async lintStepWithAI(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
    /** V5: When true, include full candidate list (for "Show alternatives") */
    includeAlternatives?: boolean;
    /**
     * When true, bypass the 500ms snapshot throttle and collect a fresh DOM.
     * Set by user-triggered lint (Find button, debounced lint after typing) and
     * by preview apply, where a stale cached DOM can cause false not_found results
     * (e.g. a modal appeared since the last interval tick).
     * Defaults to false so library consumers keep the historical throttled behavior.
     */
    forceFreshSnapshot?: boolean;
    /**
     * Audit-only context for logs/intent_resolve.log so apply-time pre-lints
     * vs editor lints can be told apart in analysis.
     */
    auditTrigger?: 'find_button' | 'auto_lint' | 'apply_prelint' | 'pick_dry_run' | 'other';
  }): Promise<LintResult> {
    // Diagnostic wrapper: captures intent + LintResult into intent_resolve.log
    // for every lint call. Implementation lives in `_lintStepWithAIImpl`.
    //
    // V26: AI tracking context — every LLM call inside the lint pipeline
    // (resolver, candidate-pruner, vision rescue) reads userId/workspace
    // from the AsyncLocalStorage context. Without this wrap, AI calls are
    // logged as "Skipping AI log (no userId)" and never billed/audited.
    // `lintStep` (rule-only path, line 684) has the same wrap; here we
    // mirror it for the AI-enabled path used by Apply All / preview run.
    const startedAt = Date.now();
    let lastUrl: string | undefined;
    let domNodeCount: number | undefined;
    try {
      const result = await withAIContext(
        {
          workspaceId: '',
          userId: params.userId,
          operationType: 'lite-test',
          logSource: 'ai-selector',
          logActionType: 'lint-step',
          logEntityType: 'test_execution',
          logEntityId: params.previewSessionId,
        },
        () => IntentStepLintService._lintStepWithAIImpl(params, (url, count) => {
          lastUrl = url;
          domNodeCount = count;
        }),
      ) as LintResult;
      // Phase 2.5: pull secret values from the preview session so the
      // audit log redacts them before persisting the intent snapshot.
      // Lazy require to avoid the well-known circular eval between this
      // file and preview-session via editor-trace.
      const auditSecretValues = (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const sessionMod = require('./preview-session.service');
          const session = sessionMod.getPreviewSessionService?.()?.getSession?.(params.previewSessionId);
          return collectSecretValues(session?.contextRunVariables);
        } catch {
          return [];
        }
      })();
      try {
        logIntentResolveLint({
          stepDraft: params.stepDraft,
          result,
          url: lastUrl,
          durationMs: Date.now() - startedAt,
          trigger: params.auditTrigger || 'other',
          domNodeCount,
          secretValues: auditSecretValues,
        });
      } catch { /* never break lint on diagnostics */ }
      return result;
    } catch (err) {
      const auditSecretValuesErr = (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const sessionMod = require('./preview-session.service');
          const session = sessionMod.getPreviewSessionService?.()?.getSession?.(params.previewSessionId);
          return collectSecretValues(session?.contextRunVariables);
        } catch {
          return [];
        }
      })();
      try {
        logIntentResolveLint({
          stepDraft: params.stepDraft,
          result: {
            status: 'error' as LintStatus,
            message: err instanceof Error ? err.message : String(err),
            confidence: 0,
            candidates: [],
            highlight: [],
          },
          url: lastUrl,
          durationMs: Date.now() - startedAt,
          trigger: params.auditTrigger || 'other',
          domNodeCount,
          secretValues: auditSecretValuesErr,
        });
      } catch { /* never break lint on diagnostics */ }
      throw err;
    }
  }

  private static async _lintStepWithAIImpl(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
    includeAlternatives?: boolean;
    forceFreshSnapshot?: boolean;
    auditTrigger?: 'find_button' | 'auto_lint' | 'apply_prelint' | 'pick_dry_run' | 'other';
  }, onContext?: (url: string | undefined, domNodeCount: number) => void): Promise<LintResult> {
    const { previewSessionId, stepDraft, userId, includeAlternatives = false, forceFreshSnapshot = false } = params;

    logger.debug('[INTENT_LINT] Linting step with LLM resolver', {
      previewSessionId,
      stepType: stepDraft.type,
      description: stepDraft.description.slice(0, 50),
      includeAlternatives,
    });

    // Non-targeting actions don't need element resolution
    if (['navigate', 'wait', 'wait_for', 'ai_check', 'scroll', 'switch_tab', 'close_tab', 'open_tab'].includes(stepDraft.type)) {
      return {
        status: 'resolved',
        message: `Action "${stepDraft.type}" does not require element targeting`,
        confidence: 1,
        candidates: [],
        highlight: [],
      };
    }

    // V23: phase timings — snapshot/evidence/resolve. Replay analysis used
    // to think `decisionTrace.llm.latencyMs=19820` meant "LLM was slow", but
    // it actually measured the whole lint pipeline. Snapshot collect on a
    // 59K-DOM page took 17s; the LLM itself was 1.7s. Without per-phase
    // numbers we'd keep blaming the wrong layer. Each phase timer starts
    // right before its work begins; values are passed up through
    // `onContext` and surfaced in `decisionTrace.timing` for diff analysis.
    const lintImplStart = Date.now();

    // Get snapshot. Throttle is bypassed when the caller signals user intent
    // (Find button, debounced lint, apply) — the 500ms cache may be stale if a
    // modal/dropdown just appeared or the user interacted with the page since
    // the last interval tick. fullPage: include below-viewport elements.
    const sessionService = getPreviewSessionService();
    // Forensic JSONL gating: emit only for user-actionable lint paths,
    // not background dry-runs (pick) or auto-lints fired on typing.
    // The Find button and apply pre-lint are the cases where "target
    // missing from candidates" matters for diagnosis. Pick dry-run is
    // fire-and-forget UI hint — writing a forensic file for every hover
    // would flood test_logs/editor/ with noise.
    const forensicEnabled = params.auditTrigger === 'find_button'
      || params.auditTrigger === 'apply_prelint';

    const snapshotStart = Date.now();
    const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
      includeDomNodes: true,
      fullPage: true,
      force: forceFreshSnapshot,
      // Forensic rejection JSONL — see cdp-snapshot.service.ts →
      // writeForensicJsonl. Gated by auditTrigger above.
      forensicRejections: forensicEnabled,
    });
    const snapshotMs = Date.now() - snapshotStart;

    if (!snapshot) {
      return {
        status: 'error',
        message: 'Preview session not found or expired',
        confidence: 0,
        candidates: [],
        highlight: [],
      };
    }

    const domNodes = snapshot.domNodes ?? [];
    try { onContext?.(snapshot.url, domNodes.length); } catch { /* audit-only */ }
    // Log per-phase right when it finishes — independent of return path so
    // huge-page regressions are visible even when the step ultimately passes.
    if (snapshotMs > 1000) {
      // V26: phase timings come straight from snapshot.phaseTimings (added
      // by getSnapshot, sourced from in-page performance.now() markers).
      // Defensive: optional, old callers without the field still log fine.
      logger.warn('[INTENT_LINT_TIMING] snapshot collect was slow', {
        previewSessionId,
        snapshotMs,
        domNodeCount: domNodes.length,
        url: snapshot.url,
        forceFreshSnapshot,
        phaseTimings: (snapshot as any).phaseTimings,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // URL guard (V23): if the step was recorded / previously applied on a URL
    // that doesn't match the current page, short-circuit before LLM and
    // rule-based fallback. Without this guard, lint on the wrong page returns
    // 3 random <a> tags with confidence 0.04 and a misleading "description
    // too vague" message — actually the navigation didn't reach the right
    // page (or the user is editing the step on the landing instead of the
    // page where the element lives).
    //
    // Manual-add steps (no compiled.context.pageUrl AND no evidence.pageUrl)
    // are intentionally skipped — there's no recorded URL to compare against.
    //
    // Uses the same `normalizeUrlForComparison` (origin + pathname, no query
    // / hash / trailing slash) that evidence-shortcut and apply's
    // `compiledUrlStale` check use, so behaviour is consistent across paths.
    //
    // Known limitations (intentional, mirror evidence-shortcut policy):
    //   - SPA same-URL different-content: guard passes (no false positive,
    //     but also no protection — relied on resolver downstream).
    //   - Parametrized paths (/courses/123 vs /courses/456): guard fires.
    //     Acceptable: better a clear "wrong page" message than 3 random links.
    //   - Hash routing: normalizer strips hash. Known limitation, same as
    //     evidence-shortcut.
    // ═══════════════════════════════════════════════════════════════════════════
    const NON_TARGETING_FOR_URL_GUARD = new Set(['navigate', 'wait', 'wait_for', 'ai_check', 'scroll', 'switch_tab', 'close_tab', 'open_tab', 'wait_for_email']);
    if (!NON_TARGETING_FOR_URL_GUARD.has(stepDraft.type)) {
      // Priority order matters. `evidence.pageUrl` is set by the recorder at
      // capture time (the URL the user was actually on when they clicked) and
      // never moves. `compiled.context.pageUrl` is rebuilt every time the
      // compiled plan is rebuilt, and a click that triggers navigation will
      // bake the *destination* URL into the plan if the rebuild happens
      // post-action. We prefer `evidence.pageUrl` as the recorder's truth.
      const recordedUrl = stepDraft.evidence?.pageUrl || stepDraft.compiled?.context?.pageUrl;
      if (recordedUrl) {
        const recordedNorm = normalizeUrlForComparison(recordedUrl);
        const currentNorm = normalizeUrlForComparison(snapshot.url);
        if (recordedNorm && currentNorm && recordedNorm !== currentNorm) {
          // Escape hatch: if the recorder captured a strong identity signal
          // (id / testId / href / name) and that exact element is alive on the
          // current page, the URL mismatch is misleading — recording context
          // got corrupted (e.g. compiled plan rebuilt on the navigation
          // destination) but the element we want is right here. Let the
          // resolver run; identity fast-path will pick it deterministically.
          const fp = stepDraft.recordedFingerprint;
          let identityRescue = false;
          let rescueReason = '';
          if (fp) {
            // Match against the live snapshot only — id/testId/href/name are
            // already exposed on InteractiveNode by the collector. Any single
            // unique match is enough.
            const id = fp.elementId;
            const testId = (fp as any).testIdAttr;
            const href = (fp as any).href;
            const name = (fp as any).name;
            if (id && !isDynamicId(id)) {
              const hits = domNodes.filter(n => (n as any).id === id);
              if (hits.length === 1) { identityRescue = true; rescueReason = 'id'; }
            }
            if (!identityRescue && testId) {
              const hits = domNodes.filter(n => (n as any).testIdAttr === testId);
              if (hits.length === 1) { identityRescue = true; rescueReason = 'testId'; }
            }
            if (!identityRescue && href) {
              const hits = domNodes.filter(n => (n as any).href === href);
              if (hits.length === 1) { identityRescue = true; rescueReason = 'href'; }
            }
            if (!identityRescue && name) {
              const hits = domNodes.filter(n => (n as any).htmlName === name);
              if (hits.length === 1) { identityRescue = true; rescueReason = 'name'; }
            }
          }

          if (identityRescue) {
            logger.info('[INTENT_LINT] URL guard suppressed by identity rescue — element is live on current page despite URL mismatch', {
              previewSessionId,
              stepId: stepDraft.id,
              recordedUrl,
              currentUrl: snapshot.url,
              rescueReason,
            });
            // Fall through into normal resolver path; identity fast-path
            // picks it up deterministically.
          } else {
            logger.info('[INTENT_LINT] URL guard tripped — step recorded on different page', {
              previewSessionId,
              stepId: stepDraft.id,
              recordedUrl,
              currentUrl: snapshot.url,
              recordedNorm,
              currentNorm,
              source: stepDraft.evidence?.pageUrl ? 'evidence' : 'compiled',
            });
            return {
              status: 'not_found',
              message: `Шаг записан для страницы ${recordedNorm}, сейчас открыто ${currentNorm}. Проверьте, что предыдущие шаги привели на нужную страницу — возможно, навигация не сработала.`,
              confidence: 0,
              candidates: [],
              highlight: [],
              // Carry the URL pair for the editor UI / audit log so the user
              // sees exactly which navigation failed instead of a generic
              // "describe better" hint.
              // Reusing degradedReason so existing UI paths surface it.
              degradedMode: false,
              degradedReason: 'url_mismatch' as any,
            } as LintResult;
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5: Evidence shortcut - try lastSuccessRef first (when caching is enabled)
    // V15.7: TTL + URL + semantic checks were extracted to evidence-shortcut.utils.ts
    // so preview and background share the same policy. Preview-specific bits
    // (action-type compat via `isEvidenceShortcutNodeCompatible`, LintResult build,
    // trace emission) stay here.
    // ═══════════════════════════════════════════════════════════════════════════
    const disableCaching = stepDraft.options?.disableCaching === true;

    if (!disableCaching && stepDraft.evidence?.lastSuccessRef) {
      // Best-effort session lookup — null when the session has been torn
      // down between snapshot and shortcut (race window). When null the
      // shortcut gracefully degrades to TTL-only behaviour.
      const sessionCreatedAt = sessionService.getSessionCreatedAt(previewSessionId, params.userId) ?? undefined;
      const shortcut = evaluateEvidenceShortcut({
        evidence: stepDraft.evidence,
        domNodes,
        currentUrl: snapshot.url,
        description: stepDraft.description,
        bindingHints: stepDraft.bindingHints,
        compiledPageUrl: stepDraft.compiled?.context?.pageUrl,
        actionType: stepDraft.type,
        sessionCreatedAt,
      });

      if (!shortcut.ok) {
        // Reason-specific logging preserved for operator diagnostics.
        // Reasons that indicate real drift we want to see in prod → info;
        // internal no-op reasons (no_evidence, no_cached_ref) stay at debug.
        const level = (shortcut.reason === 'ttl_expired'
          || shortcut.reason === 'session_newer_than_evidence'
          || shortcut.reason === 'url_mismatch'
          || shortcut.reason === 'semantic_mismatch'
          || shortcut.reason === 'node_disabled') ? 'info' : 'debug';
        logger[level]('[INTENT_LINT_V5] Evidence shortcut bypass', {
          previewSessionId,
          cachedRef: stepDraft.evidence.lastSuccessRef,
          reason: shortcut.reason,
          ...(shortcut.details || {}),
        });
        // Per-reason counter so the next CACHE_METRICS dump shows which
        // reject path is dominant (ttl_expired vs session_newer vs
        // semantic_mismatch). Helps spot drift after pipeline changes.
        cacheMetrics.inc('evidence-shortcut', shortcut.reason);
        cacheMetrics.inc('evidence-shortcut', 'miss');
        try {
          EditorTraceService.get(previewSessionId)?.writeEvidenceShortcut({
            stepId: stepDraft.id,
            hit: false,
            cachedRef: stepDraft.evidence.lastSuccessRef,
            reason: shortcut.reason,
            detail: shortcut.details,
          });
        } catch { /* non-fatal */ }
      } else {
        const { node: cachedNode, ref: cachedRef } = shortcut;
        // Preview-specific: validate the cached node's tag/role against the action
        // type. This check isn't portable to background (background uses a simpler
        // isVisible !== false heuristic) so it stays here and NOT in the utility.
        const compat = this.isEvidenceShortcutNodeCompatible(stepDraft, cachedNode, snapshot.url);

        if (compat.ok) {
          logger.debug('[INTENT_LINT_V5] Evidence shortcut hit', {
            previewSessionId,
            cachedRef,
            nodeTag: cachedNode.tag,
            nodeRole: cachedNode.role,
            semanticSource: shortcut.semanticSource,
          });
          cacheMetrics.inc('evidence-shortcut', 'hit');

          const evidenceResult: LintResult = {
            status: 'resolved',
            message: 'Element resolved from evidence cache',
            confidence: 0.95,
            candidates: [{
              ref: cachedRef,
              label: getEffectiveLabel(cachedNode) || `<${cachedNode.tag}>`,
              reason: 'Evidence shortcut (lastSuccessRef)',
              confidence: 0.95,
              boundingBox: cachedNode.boundingBox,
              node: cachedNode,
            }],
            highlight: [{
              ref: cachedRef,
              boundingBox: cachedNode.boundingBox,
              type: 'success',
            }],
            cacheHit: true,
          };

          // ── TRACE: evidence shortcut hit ──
          try {
            const trace = EditorTraceService.get(previewSessionId);
            if (trace) {
              trace.writeElementResolution({
                description: stepDraft.description,
                actionType: stepDraft.type,
                pageUrl: snapshot.url,
                result: evidenceResult,
                domNodesTotal: domNodes.length,
                domNodes,
                evidenceShortcut: true,
                evidenceRef: cachedRef,
                latencyMs: 0,
              });
              trace.writeEvidenceShortcut({
                stepId: stepDraft.id,
                hit: true,
                cachedRef,
                reason: 'ok',
              });
            }
          } catch { /* trace logging must never break resolution */ }

          return evidenceResult;
        }

        // Passed shared checks but failed action-type compat — bypass cache.
        logger.debug('[INTENT_LINT_V5] Evidence shortcut bypass - node incompatible with action', {
          previewSessionId,
          cachedRef,
          actionType: stepDraft.type,
          nodeTag: cachedNode.tag,
          nodeRole: cachedNode.role,
          nodeType: cachedNode.type || cachedNode.inputType,
          reason: compat.reason,
        });
        cacheMetrics.inc('evidence-shortcut', 'compat_mismatch');
        cacheMetrics.inc('evidence-shortcut', 'miss');
      }
    }

    // Step 1: Try LLM-based resolver (PRIMARY) with includeAlternatives flag
    // V14: Pass lazy screenshot callback — only captures when vision rescue is needed (0 allowed elements)
    const resolveStartMs = Date.now();
    const resolverResult = await resolveElement({
      previewSessionId,
      stepDraft,
      domNodes,
      pageUrl: snapshot.url,
      viewport: snapshot.viewport,
      includeAlternatives,
      screenshot: async () => {
        try {
          const page = sessionService.getPage(previewSessionId, userId);
          if (!page) return null;
          // Smart screenshot: viewport + 100px above + 200px below current scroll
          // Covers nearby off-screen elements without fullPage cost
          const dims = await page.evaluate(() => ({
            scrollY: (globalThis as any).scrollY || 0,
            viewportH: (globalThis as any).innerHeight || 720,
            pageH: (globalThis as any).document?.documentElement?.scrollHeight || 720,
            viewportW: (globalThis as any).innerWidth || 1280,
          }));
          const clipTop = Math.max(0, dims.scrollY - 100);
          const clipBottom = Math.min(dims.pageH, dims.scrollY + dims.viewportH + 200);
          const buf = await page.screenshot({
            clip: { x: 0, y: clipTop, width: dims.viewportW, height: clipBottom - clipTop },
            type: 'jpeg',
            quality: 70,
          });
          // V15: Return clipPageTop + scrollY so the resolver can map vision bbox
          // (screenshot-space, 0-based from clip origin) back to viewport-space.
          return {
            base64: buf.toString('base64'),
            clipPageTop: clipTop,
            scrollY: dims.scrollY,
          };
        } catch { return null; }
      },
    });
    const resolveLatencyMs = Date.now() - resolveStartMs;

    // V23: attach phase timings to resolverResult so they propagate up into
    // decisionTrace via the LintResult contract. All paths below that
    // ultimately return a LintResult inherit these via spread. Mutating is
    // safe — resolverResult is a local LintResult, not shared.
    const totalMs = Date.now() - lintImplStart;
    resolverResult.phaseTimings = {
      snapshotMs,
      resolveMs: resolveLatencyMs,
      totalMs,
      domNodeCount: domNodes.length,
    };

    // V23: per-phase summary log. Always emitted at debug for every lint;
    // promoted to info when total lint took >2s so slowdowns surface in
    // production logs without flooding under normal load. Phases:
    //   snapshotMs  — DOM collect from page.evaluate
    //   resolveMs   — full resolveElement (incl. LLM, vision, identity,
    //                 evidence, prescore, candidate building)
    //   totalMs     — start of _lintStepWithAIImpl to here
    const lvl = totalMs > 2000 ? 'info' : 'debug';
    logger[lvl]('[INTENT_LINT_TIMING] lint phase breakdown', {
      previewSessionId,
      stepType: stepDraft.type,
      snapshotMs,
      resolveMs: resolveLatencyMs,
      totalMs,
      domNodeCount: domNodes.length,
      resolverPath: resolverResult.resolverPath,
    });

    // ── TRACE: Write full element resolution diagnostic to editor JSONL ──
    try {
      const trace = EditorTraceService.get(previewSessionId);
      if (trace) {
        trace.writeElementResolution({
          description: stepDraft.description,
          actionType: stepDraft.type,
          pageUrl: snapshot.url,
          result: resolverResult,
          domNodesTotal: domNodes.length,
          domNodes,
          ruleTrace: resolverResult._ruleTrace,
          hardAllowedCount: resolverResult._hardAllowedCount,
          softAllowedCount: resolverResult._softAllowedCount,
          // May 2026 — surfaces per-node `candidateText` (the EXACT
          // string the LLM consumed pre-truncation) into the JSONL
          // domSnapshot entries. See preview.types.ts comment.
          candidateTextByRef: resolverResult._candidateTextByRef,
          latencyMs: resolveLatencyMs,
        });
      }
    } catch { /* trace logging must never break resolution */ }

    // Step 2: If LLM resolver failed, fall back to rule-based
    if (resolverResult.degradedMode) {
      logger.warn('[INTENT_LINT] LLM resolver degraded, falling back to rule-based', {
        previewSessionId,
        degradedReason: resolverResult.degradedReason,
      });

      // Use old rule-based + LLM fallback
      return this.lintStepWithRuleBasedFallback(
        params,
        { url: snapshot.url, domNodes },
        resolverResult.degradedReason, // V23: preserve real cause (circuit/timeout/error)
      );
    }

    // Step 2.5: V2 - Handle semantic-zero with explicit AI fallback
    // When we found elements but none semantically match the description
    if (resolverResult.needsAiFallback && (resolverResult as any).aiFallbackReason === 'semantic_zero') {
      logger.info('[INTENT_LINT_V5] Semantic-zero detected, triggering AI fallback', {
        previewSessionId,
        topSimilarity: resolverResult.topSimilarity,
      });

      // V23: classify scenario so the message addresses the actual problem.
      const scenarioSemanticZero = classifyClarifyScenario({
        stepDraft,
        candidates: resolverResult.candidates.slice(0, 5),
        topConfidence: resolverResult.confidence ?? 0,
        currentUrl: snapshot.url,
        degradedReason: undefined, // resolver succeeded, just no semantic match
        isSemanticZero: true,
      });
      const clarifyResult = await this.generateClarificationQuestion({
        userIntent: sanitizeIntent(stepDraft),
        actionType: stepDraft.type,
        pageUrl: snapshot.url,
        candidates: resolverResult.candidates.slice(0, 5),
        domNodes,
        isSemanticZero: true, // legacy compat
        scenario: scenarioSemanticZero,
        stepDraft,
        topConfidence: resolverResult.confidence ?? 0,
      });

      // Build descriptive message
      let message = clarifyResult.question || 
        `I found some elements but none seem to match "${stepDraft.description}". Could you describe the element more specifically?`;
      
      if (clarifyResult.examples && clarifyResult.examples.length > 0) {
        message += `\n\nTry being more specific, like:\n${clarifyResult.examples.map(e => `• "${e}"`).join('\n')}`;
      }

      return {
        ...resolverResult,
        status: 'needs_clarification', // Change to needs_clarification for UI handling
        message,
        clarificationQuestion: clarifyResult.question,
        interpretation: clarifyResult.interpretation,
        needsAiFallback: true,
        aiFallbackReason: 'semantic_zero',
      };
    }

    // Step 3: If needs_clarification, generate LLM clarification message
    if (resolverResult.status === 'needs_clarification') {
      // For clarification, we always need candidates for LLM context (even if not returned to frontend)
      // Temporarily fetch candidates for LLM if not already included
      let candidatesForLLM = resolverResult.candidates;
      if (candidatesForLLM.length === 0) {
        // Re-resolve with includeAlternatives=true just for LLM context
        const withCandidates = await resolveElement({
          previewSessionId,
          stepDraft,
          domNodes,
          pageUrl: snapshot.url,
          viewport: snapshot.viewport,
          includeAlternatives: true,
        });
        candidatesForLLM = withCandidates.candidates;
      }

      // V23: classify scenario.
      const scenarioNeedsClarif = classifyClarifyScenario({
        stepDraft,
        candidates: candidatesForLLM,
        topConfidence: resolverResult.confidence ?? 0,
        currentUrl: snapshot.url,
      });
      const clarifyResult = await this.generateClarificationQuestion({
        userIntent: sanitizeIntent(stepDraft),
        actionType: stepDraft.type,
        pageUrl: snapshot.url,
        candidates: candidatesForLLM,
        domNodes,
        scenario: scenarioNeedsClarif,
        stepDraft,
        topConfidence: resolverResult.confidence ?? 0,
      });

      // Build the message with examples if available
      let message = clarifyResult.question || resolverResult.message;
      if (clarifyResult.examples && clarifyResult.examples.length > 0) {
        message += `\n\nExamples:\n${clarifyResult.examples.map(e => `• "${e}"`).join('\n')}`;
      }

      return {
        ...resolverResult,
        message,
        clarificationQuestion: clarifyResult.question,
        interpretation: clarifyResult.interpretation,
        // candidates and highlight already controlled by includeAlternatives in resolverResult
      };
    }

    // Step 4: Return resolver result as-is
    return resolverResult;
  }

  /**
   * V4: Rule-based fallback (used when LLM resolver fails)
   * IMPORTANT: LLM is allowed ONLY to generate clarification text (never selects refs).
   *
   * V23 (April 2026): Accepts the upstream `resolverDegradedReason` so the
   * actual LLM failure mode (`circuit_breaker_open`, `llm_error`, `timeout`,
   * `rate_limited`) survives into the final LintResult instead of being
   * collapsed to the generic `'llm_unavailable'`. Audit logs and UI can then
   * differentiate "AI временно лежит из-за каскада" vs "одиночный таймаут".
   */
  private static async lintStepWithRuleBasedFallback(
    params: {
      previewSessionId: string;
      stepDraft: IntentStep;
      pageRef?: string;
      userId: string;
    },
    snapshot: { url: string; domNodes: InteractiveNode[]; viewport?: { width: number; height: number } },
    resolverDegradedReason?: string,
  ): Promise<LintResult> {
    const { previewSessionId, stepDraft } = params;
    // Preserve the upstream reason; fall back to the generic label only when
    // upstream didn't supply one (e.g. lint reached this method via paths that
    // don't carry resolverResult).
    const degradedReason = resolverDegradedReason || 'llm_unavailable';

    // Rule-based scoring (degraded path)
    const ruleResult = await this.lintStep(params);

    // If high confidence resolved, return immediately
    if (ruleResult.status === 'resolved' && ruleResult.confidence >= 0.7) {
      return {
        ...ruleResult,
        degradedMode: true,
        degradedReason,
      };
    }

    // If there are no candidates, nothing to clarify
    if (ruleResult.candidates.length === 0) {
      return {
        ...ruleResult,
        degradedMode: true,
        degradedReason,
      };
    }

    // Convert ambiguous/low-confidence into needs_clarification for UI flow
    const validCandidates = ruleResult.candidates
      .filter((c) => c.ref && c.ref.trim().length > 0)
      .slice(0, 3);

    if (validCandidates.length === 0) {
      return {
        status: 'not_found',
        message: 'No interactive elements found on page',
        confidence: 0,
        candidates: [],
        highlight: [],
        degradedMode: true,
        degradedReason,
      };
    }

    // ── Fingerprint-driven recovery in the degraded path ────────────────
    // When the LLM resolver is down (timeout, JSON parse failure, quota)
    // and the rule-based fallback returned several candidates, surfacing a
    // clarification dialog forces the user to babysit a step that we
    // already have enough recorded data to resolve. If the step carries a
    // TargetFingerprint from a previous compile, we can rank the rule-based
    // candidates against it offline (no extra page calls — `LintCandidate`
    // already exposes boundingBox, and we can read structural fields from
    // the in-memory `domNodes` snapshot).
    //
    // This mirrors the multi-match disambiguation logic in
    // compiled-locator-executor.tryLocatorEntry but works on
    // already-resolved DOM data instead of live Playwright locators, so
    // it also helps when the compiled plan was bypassed (e.g. when the
    // recorded plan only contained a weak `text` strategy).
    const recordedFingerprint = stepDraft.compiled?.targetFingerprint;
    if (recordedFingerprint && validCandidates.length > 1) {
      const ranked = rankCandidatesByFingerprint(validCandidates, snapshot.domNodes, recordedFingerprint);
      const winner = ranked[0];
      const runnerUp = ranked[1];
      const clearlyBetter =
        !!winner
        && winner.score >= 0.55
        && (!runnerUp || winner.score - runnerUp.score >= 0.12);
      if (clearlyBetter) {
        logger.info('[INTENT_LINT_V4] Degraded mode: fingerprint resolved ambiguity', {
          previewSessionId,
          stepType: stepDraft.type,
          winnerRef: winner.candidate.ref,
          winnerScore: Math.round(winner.score * 100) / 100,
          winnerFp: Math.round(winner.fp * 100) / 100,
          winnerBbox: Math.round(winner.bbox * 100) / 100,
          runnerUpScore: runnerUp ? Math.round(runnerUp.score * 100) / 100 : null,
        });
        return {
          status: 'resolved',
          message: 'Element resolved via recorded fingerprint (LLM degraded)',
          confidence: winner.score,
          candidates: [winner.candidate],
          highlight: [{
            ref: winner.candidate.ref,
            boundingBox: winner.candidate.boundingBox,
            type: 'success' as const,
          }],
          degradedMode: true,
          degradedReason,
        };
      }
      logger.debug('[INTENT_LINT_V4] Degraded mode: fingerprint did not yield clear winner', {
        previewSessionId,
        topScore: winner ? Math.round(winner.score * 100) / 100 : null,
        runnerUpScore: runnerUp ? Math.round(runnerUp.score * 100) / 100 : null,
      });
    }

    logger.info('[INTENT_LINT_V4] Degraded mode: asking clarification (rule-based candidates)', {
      previewSessionId,
      stepType: stepDraft.type,
      candidateCount: validCandidates.length,
    });

    // V23: classify — degraded path; the upstream degradedReason flows through.
    const scenarioDegraded = classifyClarifyScenario({
      stepDraft,
      candidates: validCandidates,
      topConfidence: ruleResult.confidence ?? 0,
      currentUrl: snapshot.url,
      degradedReason, // real cause: circuit_breaker_open / llm_error / timeout
    });
    const clarifyResult = await this.generateClarificationQuestion({
      userIntent: sanitizeIntent(stepDraft),
      actionType: stepDraft.type,
      pageUrl: snapshot.url,
      candidates: validCandidates,
      domNodes: snapshot.domNodes,
      scenario: scenarioDegraded,
      stepDraft,
      topConfidence: ruleResult.confidence ?? 0,
      degradedReason,
    });

    return {
      status: 'needs_clarification',
      message: clarifyResult.question || ruleResult.message || 'Please select the correct element',
      confidence: 0,
      candidates: validCandidates,
      highlight: validCandidates.map((c) => ({
        ref: c.ref,
        boundingBox: c.boundingBox,
        type: 'warning' as const,
      })),
      interpretation: clarifyResult.interpretation,
      clarificationQuestion: clarifyResult.question,
      needsAiFallback: false,
      degradedMode: true,
      degradedReason,
    };
  }

  /**
   * V5: Generate clarification message with examples using LLM
   * 
   * Generates helpful text that teaches user how to write better descriptions.
   * Uses Momentic-style hints: role/label/quotes/inside/above/below/closest/nth
   * 
   * Does NOT select elements - just helps user refine their description.
   */
  /**
   * V23: Generate context-aware clarification message.
   *
   * The classifier (`classifyClarifyScenario`) decides WHY lint failed; this
   * method translates that into a message + examples for the user. The LLM
   * is asked to produce localized, scenario-appropriate text — but each
   * branch ALSO has a deterministic fallback so when LLM is degraded the
   * user still gets the right WHY (just less polished).
   *
   * Inputs the prompt now sees that v2 didn't:
   *   - recordedFingerprint snapshot (id/testId/labelText/role)
   *   - bindingHints (label/text/role/landmark)
   *   - recordedPageUrl vs currentPageUrl pair
   *   - top candidate confidence (number)
   *   - degradedReason (real cause if AI lay)
   *   - scenario label (PAGE_MISMATCH / AI_DEGRADED / etc.)
   *
   * Output stays the same shape (`question` / `interpretation` / `examples`)
   * so existing callers don't change.
   *
   * V2 backwards-compat: callers that still pass `isSemanticZero=true` are
   * implicitly mapped to scenario='NO_RECORDED_MATCH' if they don't pass
   * `scenario` directly.
   */
  private static async generateClarificationQuestion(params: {
    userIntent: string;
    actionType: string;
    pageUrl: string;
    candidates: LintCandidate[];
    domNodes: InteractiveNode[];
    /** V2 legacy flag — kept for callers that haven't migrated. */
    isSemanticZero?: boolean;
    /** V23 — scenario classified by `classifyClarifyScenario`. */
    scenario?: ClarifyScenario;
    /** V23 — full step for promot context. */
    stepDraft?: IntentStep;
    /** V23 — top candidate confidence after rule scoring. */
    topConfidence?: number;
    /** V23 — degraded cause from upstream resolver, when applicable. */
    degradedReason?: string;
  }): Promise<{
    question?: string;
    interpretation?: string;
    examples?: string[];
  }> {
    // Map legacy isSemanticZero → scenario when caller hasn't explicitly set one.
    const scenario: ClarifyScenario =
      params.scenario ?? (params.isSemanticZero ? 'NO_RECORDED_MATCH' : 'GENERIC');

    const recordedFp = params.stepDraft?.recordedFingerprint
      || params.stepDraft?.compiled?.targetFingerprint;
    const recordedPageUrl = params.stepDraft?.compiled?.context?.pageUrl
      || params.stepDraft?.evidence?.pageUrl;

    // Real visible labels we can offer as examples — never invent.
    const realExamples: string[] = params.candidates
      .slice(0, 3)
      .map((c) => {
        const node = params.domNodes.find((n) => n.ref === c.ref) || c.node;
        return (getEffectiveLabel(node) || c.label || '').trim();
      })
      .filter((x) => x.length > 0 && x.length < 80);

    // ── Deterministic fallback messages per scenario (used when LLM is down
    //    or when a quick local answer is enough). All localized to RU since
    //    the editor is RU-first; the LLM branch tries to match intent language.
    const deterministicMessage = (s: ClarifyScenario): string => {
      switch (s) {
        case 'PAGE_MISMATCH':
          return recordedPageUrl
            ? `Шаг записан для страницы ${recordedPageUrl}, сейчас открыто ${params.pageUrl}. Проверьте, что предыдущие шаги привели на нужную страницу.`
            : 'Похоже, текущая страница отличается от той, на которой записан шаг. Проверьте навигацию.';
        case 'AI_DEGRADED':
          return `AI-резолвер временно недоступен (${params.degradedReason || 'unknown'}). Подождите минуту и повторите, либо выберите элемент вручную из подсказок.`;
        case 'NO_RECORDED_MATCH': {
          // V23: include title in the recorded-label chain — same reason
          // as everywhere else (Angular routerLink etc. carry identity in title).
          const recordedLabel = recordedFp?.labelText || recordedFp?.ariaLabel || recordedFp?.title || (recordedFp as any)?.alt || recordedFp?.text || recordedFp?.elementId;
          return recordedLabel
            ? `На странице нет элемента, похожего на записанный («${recordedLabel}»). Возможно, навигация не дошла до нужной страницы или элемент скрыт.`
            : 'На текущей странице нет элемента, соответствующего записанному. Проверьте навигацию или уточните описание.';
        }
        case 'AMBIGUOUS_RIGHT_PAGE':
          return `Несколько элементов подходят под описание «${params.userIntent}». Уточните: текст в кавычках, роль, или раздел страницы.`;
        case 'VAGUE_DESC':
          return `Описание «${params.userIntent}» слишком общее. Добавьте текст элемента, его роль или ближайший заголовок раздела.`;
        case 'GENERIC':
        default:
          return `Не удалось однозначно определить элемент по описанию «${params.userIntent}». Уточните: текст в кавычках, роль, или ближайший элемент.`;
      }
    };

    // Try LLM for polish + i18n; fall back to deterministic message on any error.
    try {
      const { getChatCompletionWithMessages } = await import('@/services/ai/core/openai.service');

      const candidateList = params.candidates.slice(0, 3).map((c, i) => {
        const node = params.domNodes.find((n) => n.ref === c.ref) || c.node;
        const details: string[] = [];
        if (node?.labelText) details.push(`label="${node.labelText}"`);
        if (node?.ariaLabel) details.push(`aria="${node.ariaLabel}"`);
        if (node?.text && node.text !== node.labelText) details.push(`text="${node.text.slice(0, 40)}"`);
        if (node?.placeholder) details.push(`placeholder="${node.placeholder}"`);
        if (node?.role) details.push(`role="${node.role}"`);
        if (node?.containerTitles?.length) details.push(`in section "${node.containerTitles[0]}"`);
        return `${i + 1}. ref="${c.ref}" <${node?.tag || 'element'}> ${details.join(', ')} (confidence=${c.confidence.toFixed(2)})`;
      }).join('\n');

      const recordedFpText = recordedFp ? [
        recordedFp.elementId ? `id="${recordedFp.elementId}"` : '',
        recordedFp.testIdAttr ? `testId="${recordedFp.testIdAttr}"` : '',
        recordedFp.labelText ? `label="${recordedFp.labelText}"` : '',
        recordedFp.ariaLabel ? `aria="${recordedFp.ariaLabel}"` : '',
        recordedFp.text ? `text="${recordedFp.text.slice(0, 50)}"` : '',
        recordedFp.role ? `role="${recordedFp.role}"` : '',
        recordedFp.tag ? `tag="${recordedFp.tag}"` : '',
      ].filter(Boolean).join(', ') : '';

      // V23: compact scenario directives. Each line: action verb + examples
      // policy (E=examples). Format kept terse on purpose — gemini-flash-lite
      // reads sequentially and tight directives ship better than prose.
      // Smart parts preserved: each scenario's WHY, recorded label hint,
      // anti-blame guard for PAGE_MISMATCH/AI_DEGRADED.
      const recordedLabel = recordedFp?.labelText || recordedFp?.ariaLabel || recordedFp?.title || (recordedFp as any)?.alt || recordedFp?.text || recordedFp?.elementId || '';
      const scenarioDirective: Record<ClarifyScenario, string> = {
        PAGE_MISMATCH: `Wrong page (recorded vs current URL differ). Tell user to check navigation. Don't blame their wording. E=[].`,
        AI_DEGRADED: `AI down (reason=${params.degradedReason || 'unknown'}). Tell user to retry shortly. Candidates shown are rule-based fallback. Don't blame wording. E=[].`,
        NO_RECORDED_MATCH: `Recorded element${recordedLabel ? ` ("${recordedLabel.slice(0, 50)}")` : ''} not present here. Page changed or wrong page. E=[].`,
        AMBIGUOUS_RIGHT_PAGE: `Multiple matches on right page. Ask for disambiguator (exact text/role/section). E=1-3 real labels from candidates.`,
        VAGUE_DESC: `Description too short${recordedLabel ? `; suggest using recorded label "${recordedLabel.slice(0, 40)}"` : ''}. E=1-3 real labels.`,
        GENERIC: `Generic word match. Suggest exact text/role/section. E=1-3 real labels.`,
      };

      // Compose context block — only include lines that have data.
      const ctxLines = [
        `INTENT: "${params.userIntent}" (action=${params.actionType})`,
        `URL: now=${params.pageUrl}${recordedPageUrl ? ` recorded=${recordedPageUrl}` : ''}`,
        recordedFpText ? `RECORDED: ${recordedFpText}` : '',
        `CONFIDENCE: ${params.topConfidence?.toFixed(2) ?? 'n/a'}`,
      ].filter(Boolean).join('\n');

      const prompt = `Output JSON {message, examples, interpretation}. Explain WHY this step couldn't auto-resolve. Don't pick elements.

SCENARIO=${scenario}: ${scenarioDirective[scenario]}

${ctxLines}

CANDIDATES (rule-based, may be unrelated):
${candidateList || '(none)'}

Rules:
- message: in INTENT's language/script (RU→RU, KZ→KZ, EN→EN), one sentence ≤200 chars.
- examples: ONLY strings already in CANDIDATES (label/text/aria/placeholder). Empty [] when scenario says E=[]. Never invent.
- interpretation: one phrase, what user wants to do.`;

      // V23: model fallback chain. Primary is gemini-2.5-flash-lite (fast,
      // predictable, multilingual). If it fails for ANY reason — provider
      // outage, rate limit, parse error, hard 5s timeout — fall back to
      // gpt-5.4-mini so the lint result is always informative. Same prompt;
      // OpenAI service auto-routes by model name prefix.
      //
      // Per-model timeout 5s (clarification is short — a real provider just
      // needs 300-1500ms). Without it, gemini's internal 30s default could
      // mask outages and gpt-5.4-mini's variable CoT could spike to 14s.
      const PRIMARY: string = AI_TASK_MODELS.intentLint;  // gemini-2.5-flash-lite
      const FALLBACK: string = AI_MODELS.fast;            // gpt-5.4-mini
      const PER_MODEL_TIMEOUT_MS = 5_000;

      const callOnce = async (model: string) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PER_MODEL_TIMEOUT_MS);
        try {
          return await getChatCompletionWithMessages(
            [{ role: 'user', content: prompt }],
            {
              max_tokens: 250,
              temperature: 0.2,
              model,
              response_format: { type: 'json_object' },
              abortSignal: ac.signal,
            }
          );
        } finally {
          clearTimeout(timer);
        }
      };

      let result;
      let usedModel = PRIMARY;
      try {
        result = await callOnce(PRIMARY);
      } catch (primaryErr) {
        // Don't retry the same provider on the fallback — when primary is gemini
        // and fallback is also gemini (unlikely but possible env override),
        // the second call would just hit the same outage.
        const sameProvider = PRIMARY.startsWith('gemini-') === FALLBACK.startsWith('gemini-');
        if (sameProvider) {
          throw primaryErr;
        }
        logger.warn('[INTENT_LINT_V23] Primary clarification model failed, retrying with fallback', {
          primary: PRIMARY,
          fallback: FALLBACK,
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
        result = await callOnce(FALLBACK);
        usedModel = FALLBACK;
      }

      logger.debug('[INTENT_LINT_V23] Clarification LLM resolved', {
        scenario,
        usedModel,
        wasFallback: usedModel !== PRIMARY,
      });

      const parsed = JSON.parse(result.content);

      // Validate examples — only keep ones that appear in real candidate text.
      // Stops the LLM from inventing labels even when prompt forbids it.
      const realExampleSet = new Set(realExamples.map((s) => s.toLowerCase()));
      const safeExamples = Array.isArray(parsed.examples)
        ? parsed.examples
            .filter((x: any) => typeof x === 'string')
            .filter((x: string) => {
              if (scenario === 'PAGE_MISMATCH' || scenario === 'AI_DEGRADED' || scenario === 'NO_RECORDED_MATCH') {
                return false; // examples disallowed by scenario contract
              }
              return realExampleSet.has(x.trim().toLowerCase()) || realExamples.some((r) => x.toLowerCase().includes(r.toLowerCase()));
            })
            .slice(0, 3)
        : [];

      return {
        question: typeof parsed.message === 'string' && parsed.message.trim().length > 0
          ? parsed.message
          : deterministicMessage(scenario),
        interpretation: typeof parsed.interpretation === 'string' ? parsed.interpretation : undefined,
        examples: safeExamples,
      };
    } catch (error) {
      logger.warn('[INTENT_LINT_V23] Clarification LLM failed, using deterministic fallback', {
        scenario,
        error: error instanceof Error ? error.message : String(error),
      });
      // Deterministic fallback — message tied to scenario, examples only for
      // the scenarios where they make sense.
      const examplesAllowed = scenario === 'AMBIGUOUS_RIGHT_PAGE'
        || scenario === 'VAGUE_DESC'
        || scenario === 'GENERIC';
      return {
        question: deterministicMessage(scenario),
        examples: examplesAllowed ? realExamples : [],
      };
    }
  }

}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED EVIDENCE SHORTCUT VALIDATION (for testing)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a cached node is compatible with the step action type.
 * Used by evidence shortcut to avoid resolving wrong element types
 * (e.g., preventing `type` action from targeting an `<a>` link).
 *
 * Exported for unit testing. Internal logic used by IntentStepLintService.
 *
 * Validation rules are conservative (fail-closed):
 * - Common: visible, not disabled, interactive for targeting actions
 * - Per action: tag/role/type/readOnly checks
 * - Optional URL guard via bindingHints.urlPattern
 *
 * @param step - The intent step being executed
 * @param node - The cached InteractiveNode from domNodes
 * @param pageUrl - Current page URL for urlPattern matching
 * @returns Object with `ok` boolean and optional `reason` for rejection
 */
export function isEvidenceShortcutNodeCompatible(
  step: IntentStep,
  node: InteractiveNode,
  pageUrl: string
): { ok: boolean; reason?: string } {
  // Evidence shortcut is only meaningful for actions that target a specific element.
  // For non-targeting actions, accept by default.
  if (step.type === 'navigate' || step.type === 'wait' || step.type === 'wait_for' || step.type === 'ai_check' || step.type === 'wait_for_email') {
    return { ok: true };
  }

  // Common checks: must be visible and not disabled
  if (node.isVisible === false) {
    return { ok: false, reason: 'node_not_visible' };
  }
  if (node.isDisabled === true) {
    return { ok: false, reason: 'node_disabled' };
  }

  // For most targeting actions we require an interactive element (fail-closed).
  // NOTE: `assert` is allowed on non-interactive elements (it only waits for visibility).
  if (step.type !== 'assert' && node.isInteractive === false) {
    return { ok: false, reason: 'node_not_interactive' };
  }

  // Optional URL guard: if step has urlPattern, verify it matches current page
  if (step.bindingHints?.urlPattern) {
    try {
      const pattern = new RegExp(step.bindingHints.urlPattern, 'i');
      if (!pattern.test(pageUrl)) {
        return { ok: false, reason: 'url_pattern_mismatch' };
      }
    } catch {
      // Invalid regex - skip check rather than fail
    }
  }

  const tag = node.tag?.toLowerCase();
  const role = node.role?.toLowerCase();
  const inputType = (node.inputType || node.type)?.toLowerCase();

  // Per-action-type validation
  switch (step.type) {
    case 'type': {
      // NOTE: In preview we execute `locator.fill(...)` (or click+pressSequentially for humanLike).
      // Playwright `fill` supports input/textarea/contenteditable. We don't track contenteditable in snapshots,
      // so we keep this conservative: accept only input/textarea.
      const isInputLike = tag === 'input' || tag === 'textarea';

      if (!isInputLike) {
        return { ok: false, reason: `type_action_requires_input_or_textarea (got ${tag}/${role})` };
      }

      // Reject input types that are not fill-eligible
      if (tag === 'input') {
        const disallowed: Record<string, true> = {
          checkbox: true,
          radio: true,
          button: true,
          submit: true,
          reset: true,
          image: true,
          file: true,
          range: true,
          color: true,
        };
        if (inputType && disallowed[inputType]) {
          return { ok: false, reason: `type_action_disallowed_input_type (${inputType})` };
        }
      }

      // Reject readOnly inputs
      if (node.readOnly === true) {
        return { ok: false, reason: 'input_is_readonly' };
      }

      return { ok: true };
    }

    case 'select': {
      // Native <select> always allowed
      if (tag === 'select') {
        return { ok: true };
      }
      // Custom dropdowns with ARIA roles are allowed (click-based execution)
      if (role === 'combobox' || role === 'listbox') {
        return { ok: true };
      }
      // Elements with aria-expanded are dropdown-like triggers
      if (node.ariaExpanded !== undefined) {
        return { ok: true };
      }
      // Common interactive tags that may serve as custom dropdown triggers
      // (many frameworks render dropdowns as <button>/<div>/<span> without ARIA)
      const selectSoftTags = ['button', 'div', 'span', 'input', 'a', 'li'];
      if (selectSoftTags.includes(tag)) {
        return { ok: true };
      }
      return { ok: false, reason: `select_action_requires_dropdown_element (got ${tag}/${role})` };
    }

    case 'check':
    case 'uncheck': {
      // Preview executor uses `locator.check/uncheck(...)` which requires <input type=checkbox|radio>.
      const isNativeCheckable = tag === 'input' && (inputType === 'checkbox' || inputType === 'radio');
      if (!isNativeCheckable) {
        return { ok: false, reason: `check_action_requires_input_checkbox_or_radio (got ${tag}/${role}/${inputType})` };
      }

      return { ok: true };
    }

    case 'open':
    case 'close': {
      // Prefer elements that can expand: ariaExpanded-capable, button, summary, details
      const isExpandable =
        node.ariaExpanded !== undefined ||
        role === 'button' ||
        role === 'menuitem' ||
        tag === 'button' ||
        tag === 'summary' ||
        tag === 'details';

      if (!isExpandable) {
        return { ok: false, reason: `open_close_action_requires_expandable_element (got ${tag}/${role})` };
      }

      return { ok: true };
    }

    case 'click':
    case 'hover':
    case 'toggle':
    case 'press': {
      // These are permissive (interactive check already applied above)
      return { ok: true };
    }

    case 'assert': {
      // Preview executor only waits for visibility.
      return { ok: true };
    }

    case 'upload': {
      // Upload works with either a real file input OR a trigger element (button/label/div)
      // that opens the file dialog. The executor handles the fallback to fileChooser.
      const isFileInput = tag === 'input' && inputType === 'file';
      if (isFileInput) return { ok: true };

      // Allow common trigger elements — executor will find the hidden file input or use fileChooser
      const uploadTriggerTags = ['button', 'label', 'div', 'span', 'a'];
      if (uploadTriggerTags.includes(tag)) return { ok: true };

      return { ok: false, reason: `upload_action_requires_file_input_or_trigger (got ${tag}/${inputType || 'none'})` };
    }

    case 'scroll': {
      // Scroll can target any scrollable container - be permissive
      return { ok: true };
    }

    default: {
      // Unknown action type - be conservative (interactive check already applied above)
      return { ok: true };
    }
  }
}

