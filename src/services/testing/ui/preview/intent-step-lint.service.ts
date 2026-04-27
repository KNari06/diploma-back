/**
 * Intent Step Lint Service
 * LLM-based linting for step editor (primary) with rule-based fallback
 * Resolves intent steps to candidate elements using LLM semantic matching
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { cacheMetrics } from '@/utils/core/cache-metrics';
import { extractKeywordsSync } from '@/utils/text-processing/ai-keyword-extractor';
import {
    resolveElement,
    sanitizeIntent,
} from './element-resolver.service';
import { EditorTraceService } from './editor-trace.service';
import { evaluateEvidenceShortcut } from './evidence-shortcut.utils';
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
      if (['navigate', 'wait', 'wait_for', 'ai_check', 'scroll', 'switch_tab'].includes(stepDraft.type)) {
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

      // Check for ambiguous candidates (multiple high scorers)
      const topCandidates = scoredCandidates.filter(
        c => (topScore - c.score) / topScore <= CONFIDENCE.AMBIGUOUS_THRESHOLD
      );

      const isAmbiguous = topCandidates.length > 1;
      const needsAiFallback = isAmbiguous || confidence < CONFIDENCE.AI_FALLBACK_THRESHOLD;

      // Build result (V2: prefer labelText for label display)
      const candidateResults: LintCandidate[] = topCandidates.slice(0, 5).map(c => ({
        ref: c.node.ref,
        label: c.node.labelText || c.node.ariaLabel || c.node.text || c.node.placeholder || `<${c.node.tag}>`,
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
  }): Promise<LintResult> {
    const { previewSessionId, stepDraft, userId, includeAlternatives = false, forceFreshSnapshot = false } = params;

    logger.debug('[INTENT_LINT] Linting step with LLM resolver', {
      previewSessionId,
      stepType: stepDraft.type,
      description: stepDraft.description.slice(0, 50),
      includeAlternatives,
    });

    // Non-targeting actions don't need element resolution
    if (['navigate', 'wait', 'wait_for', 'ai_check', 'scroll', 'switch_tab'].includes(stepDraft.type)) {
      return {
        status: 'resolved',
        message: `Action "${stepDraft.type}" does not require element targeting`,
        confidence: 1,
        candidates: [],
        highlight: [],
      };
    }

    // Get snapshot. Throttle is bypassed when the caller signals user intent
    // (Find button, debounced lint, apply) — the 500ms cache may be stale if a
    // modal/dropdown just appeared or the user interacted with the page since
    // the last interval tick. fullPage: include below-viewport elements.
    const sessionService = getPreviewSessionService();
    const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
      includeDomNodes: true,
      fullPage: true,
      force: forceFreshSnapshot,
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
              label: cachedNode.labelText || cachedNode.ariaLabel || cachedNode.text || cachedNode.placeholder || `<${cachedNode.tag}>`,
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
      return this.lintStepWithRuleBasedFallback(params, { url: snapshot.url, domNodes });
    }

    // Step 2.5: V2 - Handle semantic-zero with explicit AI fallback
    // When we found elements but none semantically match the description
    if (resolverResult.needsAiFallback && (resolverResult as any).aiFallbackReason === 'semantic_zero') {
      logger.info('[INTENT_LINT_V5] Semantic-zero detected, triggering AI fallback', {
        previewSessionId,
        topSimilarity: resolverResult.topSimilarity,
      });

      // Generate a helpful clarification message using AI
      const clarifyResult = await this.generateClarificationQuestion({
        userIntent: sanitizeIntent(stepDraft),
        actionType: stepDraft.type,
        pageUrl: snapshot.url,
        candidates: resolverResult.candidates.slice(0, 5), // Use top candidates for context
        domNodes,
        isSemanticZero: true, // V2: Flag for semantic-zero specific messaging
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
          includeAlternatives: true,
        });
        candidatesForLLM = withCandidates.candidates;
      }

      // Generate clarification message using LLM
      const clarifyResult = await this.generateClarificationQuestion({
        userIntent: sanitizeIntent(stepDraft),
        actionType: stepDraft.type,
        pageUrl: snapshot.url,
        candidates: candidatesForLLM,
        domNodes,
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
   */
  private static async lintStepWithRuleBasedFallback(
    params: {
      previewSessionId: string;
      stepDraft: IntentStep;
      pageRef?: string;
      userId: string;
    },
    snapshot: { url: string; domNodes: InteractiveNode[] }
  ): Promise<LintResult> {
    const { previewSessionId, stepDraft } = params;

    // Rule-based scoring (degraded path)
    const ruleResult = await this.lintStep(params);

    // If high confidence resolved, return immediately
    if (ruleResult.status === 'resolved' && ruleResult.confidence >= 0.7) {
      return {
        ...ruleResult,
        degradedMode: true,
        degradedReason: 'llm_unavailable',
      };
    }

    // If there are no candidates, nothing to clarify
    if (ruleResult.candidates.length === 0) {
      return {
        ...ruleResult,
        degradedMode: true,
        degradedReason: 'llm_unavailable',
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
        degradedReason: 'llm_unavailable',
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
          degradedReason: 'llm_unavailable',
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

    const clarifyResult = await this.generateClarificationQuestion({
      userIntent: sanitizeIntent(stepDraft),
      actionType: stepDraft.type,
      pageUrl: snapshot.url,
      candidates: validCandidates,
      domNodes: snapshot.domNodes,
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
      degradedReason: 'llm_unavailable',
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
   * V5: Generate LLM clarification question for ambiguous or semantic-zero cases
   * V2 update: Added isSemanticZero flag for different messaging approach
   */
  private static async generateClarificationQuestion(params: {
    userIntent: string;
    actionType: string;
    pageUrl: string;
    candidates: LintCandidate[];
    domNodes: InteractiveNode[];
    /** V2: Flag indicating semantic-zero scenario (no good matches found) */
    isSemanticZero?: boolean;
  }): Promise<{
    question?: string;
    interpretation?: string;
    examples?: string[];
  }> {
    try {
      const { getChatCompletionWithMessages } = await import('@/services/ai/core/openai.service');

      // Build candidate descriptions for context
      const candidateList = params.candidates.slice(0, 3).map((c, i) => {
        const node = params.domNodes.find(n => n.ref === c.ref);
        const details: string[] = [];
        if (node?.labelText) details.push(`label="${node.labelText}"`);
        if (node?.ariaLabel) details.push(`aria="${node.ariaLabel}"`);
        if (node?.placeholder) details.push(`placeholder="${node.placeholder}"`);
        if (node?.autocomplete) details.push(`autocomplete="${node.autocomplete}"`);
        if (node?.containerTitles?.length) details.push(`in section "${node.containerTitles[0]}"`);
        return `${i + 1}. <${node?.tag || 'element'}> ${details.join(', ')}`;
      }).join('\n');

      // V2: Different prompt for semantic-zero vs multiple matches
      const scenarioContext = params.isSemanticZero
        ? `The user wrote "${params.userIntent}" for a ${params.actionType} action, but NONE of the elements on the page seem to match this description. The elements below are the closest we found, but similarity is very low.`
        : `The user wrote "${params.userIntent}" for a ${params.actionType} action, but it matches multiple elements.`;

      const prompt = `You are helping a user write a clearer element description for UI testing.
${scenarioContext}

MATCHING ELEMENTS:
${candidateList}

Generate a helpful message and 2-3 example descriptions that would uniquely identify ONE element.

Use these patterns in examples:
- Exact text in quotes: 'Submit' button, 'Email' input
- Role mentions: the password input, the login button
- Position hints: above the "Sign Up" link, inside the "Login" form
- Label references: the 'Username' field, input with placeholder 'Enter email'

Respond in the SAME LANGUAGE as the user's original intent.

Reply with JSON:
{
  "message": "Brief helpful message explaining the issue (1 sentence)",
  "examples": ["example 1", "example 2"],
  "interpretation": "What the user wants to do"
}`;

      const result = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          max_tokens: 200,
          temperature: 0.2,
          model: AI_TASK_MODELS.intentLint,
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(result.content);
      return {
        question: parsed.message,
        interpretation: parsed.interpretation,
        examples: parsed.examples,
      };
    } catch (error) {
      logger.warn('[INTENT_LINT_V5] Clarification message generation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback to a generic message
      return {
        question: 'Multiple elements match your description. Try using exact text in quotes or specify the element\'s position.',
        examples: ["the 'Submit' button", "password input below the username field"],
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

