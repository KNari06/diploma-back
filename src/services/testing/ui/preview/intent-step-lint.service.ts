/**
 * Intent Step Lint Service V4
 * Embeddings-based linting for step editor (primary) with rule-based fallback
 * Resolves intent steps to candidate elements using multilingual semantic matching
 */

import {
    EDITOR_RESOLVER_SYSTEM_PROMPT,
    buildEditorResolverUserPrompt,
    parseEditorResolverResponse,
    type EditorResolverCandidate,
    type ResolverResponse,
} from '@/ai/prompts/editor-resolver-prompts';
import { logger } from '@/utils/core/logger';
import {
    invalidateEmbeddingCache,
    prefetchEmbeddings,
    resolveWithEmbeddings,
    sanitizeIntent,
} from './embeddings-resolver.service';
import { getPreviewSessionService } from './preview-session.service';
import type {
    IntentStep,
    InteractiveNode,
    LintCandidate,
    LintResult,
    LintStatus,
} from './preview.types';

// Re-export for external use
export { invalidateEmbeddingCache, prefetchEmbeddings };

// Scoring weights (V2: higher weights for labels, hierarchy bonus)
const WEIGHTS = {
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
  fill: ['input', 'textarea'],
  click: ['button', 'a', 'input', 'div', 'span'],
  select: ['select'],
  hover: ['button', 'a', 'div', 'span', 'img'],
  scroll: ['div', 'section', 'main', 'body'],
  press: ['input', 'textarea', 'button'],
  wait: [],
  assert: [],
  navigate: [],
  // V2: State-aware action types
  check: ['input'],
  uncheck: ['input'],
  toggle: ['input', 'button', 'div', 'span'],
  open: ['button', 'div', 'select', 'summary'],
  close: ['button', 'div', 'summary'],
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
 * Check if text contains keywords from intent
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some(kw => normalized.includes(normalizeText(kw)));
}

/**
 * Extract keywords from intent description
 */
function extractKeywords(description: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or',
    'enter', 'fill', 'type', 'click', 'press', 'select', 'input', 'field',
    'button', 'link', 'into', 'please', 'should', 'want', 'need',
  ]);

  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

/**
 * Score a candidate element against an intent step (V2)
 * Includes state-awareness, better label scoring, and hierarchy disambiguation
 */
function scoreCandidate(node: InteractiveNode, step: IntentStep): { score: number; reasons: string[]; hardReject: boolean } {
  let score = 0;
  const reasons: string[] = [];
  let hardReject = false;
  const keywords = extractKeywords(step.description);
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
  // V2: Label scoring (labelText > ariaLabel > text)
  // ═══════════════════════════════════════════════════════════════════════════
  if (hints.label) {
    const labelNorm = normalizeText(hints.label);

    // Priority 1: labelText exact match (highest)
    if (normalizeText(node.labelText) === labelNorm) {
      score += WEIGHTS.LABEL_TEXT_EXACT;
      reasons.push('LabelText exact match');
    }
    // Priority 2: ariaLabel exact match
    else if (normalizeText(node.ariaLabel) === labelNorm) {
      score += WEIGHTS.LABEL_EXACT_MATCH;
      reasons.push('AriaLabel exact match');
    }
    // Priority 3: text exact match
    else if (normalizeText(node.text) === labelNorm) {
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

    logger.debug('[INTENT_LINT] Linting step', {
      previewSessionId,
      stepType: stepDraft.type,
      descriptionPreview: sanitizeIntent(stepDraft).slice(0, 80),
    });

    try {
      // Get DOM nodes from preview session
      const sessionService = getPreviewSessionService();
      const snapshot = await sessionService.getSnapshot(previewSessionId, userId);

      if (!snapshot) {
        return {
          status: 'error',
          message: 'Preview session not found or expired',
          confidence: 0,
          candidates: [],
          highlight: [],
        };
      }

      const domNodes = snapshot.domNodes;

      // Non-targeting actions (navigate, wait, assert without target)
      if (['navigate', 'wait'].includes(stepDraft.type)) {
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

  /**
   * Get best candidate from lint result
   */
  static getBestCandidate(result: LintResult): LintCandidate | null {
    if (result.candidates.length === 0) return null;
    return result.candidates[0];
  }

  /**
   * V3: Semantic matching with LLM
   * Uses AI to understand user intent and match against candidates
   * Returns ranked candidates with reasoning and clarification needs
   */
  private static async semanticMatchWithLLM(params: {
    userIntent: string;
    actionType: string;
    pageUrl: string;
    candidates: LintCandidate[];
    domNodes: InteractiveNode[];
  }): Promise<{
    response: ResolverResponse | null;
    rankedCandidates: Array<LintCandidate & { llmReason: string; llmConfidence: number }>;
    needsClarification: boolean;
    clarificationQuestion?: string;
    interpretation?: string;
  }> {
    // V3: Filter out candidates without valid ref before sending to LLM
    const validCandidates = params.candidates.filter(c => c.ref && c.ref.trim().length > 0);

    if (validCandidates.length === 0) {
      logger.warn('[INTENT_LINT] No valid candidates with refs for LLM');
      return {
        response: null,
        rankedCandidates: [],
        needsClarification: false,
      };
    }

    // Convert LintCandidate to EditorResolverCandidate with more attributes
    const resolverCandidates: EditorResolverCandidate[] = validCandidates.map(c => {
      // Find corresponding DOM node for more attributes
      const node = params.domNodes.find(n => n.ref === c.ref);
      return {
        ref: c.ref!, // Safe after filter
        label: c.label,
        tag: node?.tag || 'unknown',
        role: node?.role,
        placeholder: node?.placeholder,
        ariaLabel: node?.ariaLabel,
        name: node?.name,
        type: node?.type,
      };
    });

    // Build prompt
    const userPrompt = buildEditorResolverUserPrompt({
      userIntent: params.userIntent,
      actionType: params.actionType,
      pageUrl: params.pageUrl,
      candidates: resolverCandidates,
    });

    try {
      // Call AI service
      const { getChatCompletionWithMessages } = await import('@/services/ai/core/openai.service');
      const aiResult = await getChatCompletionWithMessages(
        [
          { role: 'system', content: EDITOR_RESOLVER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        {
          max_tokens: 400,
          temperature: 0.1,
          model: 'gpt-4o-mini',
        }
      );

      // Parse response (use validCandidates refs)
      const validRefs = validCandidates.map(c => c.ref!);
      const parsed = parseEditorResolverResponse(aiResult.content, validRefs);

      if (!parsed) {
        logger.warn('[INTENT_LINT] Failed to parse LLM response', {
          response: aiResult.content.slice(0, 200),
        });
        return {
          response: null,
          rankedCandidates: [],
          needsClarification: false,
        };
      }

      // Map ranked refs back to LintCandidate with LLM reasoning
      const rankedCandidates = parsed.ranked
        .map(r => {
          const original = validCandidates.find(c => c.ref === r.ref);
          if (!original) return null;
          return {
            ...original,
            llmReason: r.reason,
            llmConfidence: r.confidence,
          };
        })
        .filter((c): c is LintCandidate & { llmReason: string; llmConfidence: number } => c !== null);

      return {
        response: parsed,
        rankedCandidates,
        needsClarification: parsed.needsClarification,
        clarificationQuestion: parsed.clarificationQuestion,
        interpretation: parsed.interpretation,
      };
    } catch (error) {
      logger.error('[INTENT_LINT] LLM semantic matching failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        response: null,
        rankedCandidates: [],
        needsClarification: false,
      };
    }
  }

  /**
   * V4: Lint step with embeddings-based semantic matching (PRIMARY)
   *
   * Pipeline:
   * 1. Try embeddings-based resolver (multilingual, no hardcoded dictionaries)
   * 2. If embeddings failed (degradedMode) → fall back to rule-based + LLM
   * 3. If needs_clarification → generate clarification question with LLM
   * 4. Return result with metrics
   */
  static async lintStepWithAI(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
  }): Promise<LintResult> {
    const { previewSessionId, stepDraft, userId } = params;

    logger.debug('[INTENT_LINT_V4] Linting step with embeddings', {
      previewSessionId,
      stepType: stepDraft.type,
      description: stepDraft.description.slice(0, 50),
    });

    // Non-targeting actions don't need element resolution
    if (['navigate', 'wait'].includes(stepDraft.type)) {
      return {
        status: 'resolved',
        message: `Action "${stepDraft.type}" does not require element targeting`,
        confidence: 1,
        candidates: [],
        highlight: [],
      };
    }

    // Get snapshot
    const sessionService = getPreviewSessionService();
    const snapshot = await sessionService.getSnapshot(previewSessionId, userId);

    if (!snapshot) {
      return {
        status: 'error',
        message: 'Preview session not found or expired',
        confidence: 0,
        candidates: [],
        highlight: [],
      };
    }

    // Step 1: Try embeddings-based resolver (PRIMARY)
    const embeddingsResult = await resolveWithEmbeddings({
      previewSessionId,
      stepDraft,
      domNodes: snapshot.domNodes,
      pageUrl: snapshot.url,
    });

    // Step 2: If embeddings failed, fall back to rule-based + LLM
    if (embeddingsResult.degradedMode) {
      logger.warn('[INTENT_LINT_V4] Embeddings degraded, falling back to rule-based', {
        previewSessionId,
        degradedReason: embeddingsResult.degradedReason,
      });

      // Use old rule-based + LLM fallback
      return this.lintStepWithRuleBasedFallback(params, snapshot);
    }

    // Step 3: If needs_clarification, generate clarification question with LLM
    if (embeddingsResult.status === 'needs_clarification' && embeddingsResult.candidates.length > 0) {
      // Generate clarification question using LLM (text only, not selection)
      const clarifyResult = await this.generateClarificationQuestion({
        userIntent: sanitizeIntent(stepDraft),
        actionType: stepDraft.type,
        pageUrl: snapshot.url,
        candidates: embeddingsResult.candidates,
        domNodes: snapshot.domNodes,
      });

      if (clarifyResult.question) {
        return {
          ...embeddingsResult,
          message: clarifyResult.question,
          clarificationQuestion: clarifyResult.question,
          interpretation: clarifyResult.interpretation,
        };
      }
    }

    // Step 4: Return embeddings result
    return embeddingsResult;
  }

  /**
   * V4: Rule-based fallback (used when embeddings fail)
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
        degradedReason: 'embeddings_unavailable',
      };
    }

    // If there are no candidates, nothing to clarify
    if (ruleResult.candidates.length === 0) {
      return {
        ...ruleResult,
        degradedMode: true,
        degradedReason: 'embeddings_unavailable',
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
        degradedReason: 'embeddings_unavailable',
      };
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
      degradedReason: 'embeddings_unavailable',
    };
  }

  /**
   * V4: Generate clarification question using LLM
   * Only generates text, does NOT select elements (already ranked by embeddings)
   */
  private static async generateClarificationQuestion(params: {
    userIntent: string;
    actionType: string;
    pageUrl: string;
    candidates: LintCandidate[];
    domNodes: InteractiveNode[];
  }): Promise<{
    question?: string;
    interpretation?: string;
  }> {
    try {
      const { getChatCompletionWithMessages } = await import('@/services/ai/core/openai.service');

      // Build candidate descriptions
      const candidateList = params.candidates.slice(0, 3).map((c, i) => {
        const node = params.domNodes.find(n => n.ref === c.ref);
        return `${i + 1}. "${c.label}" (${node?.tag || 'element'})`;
      }).join('\n');

      const prompt = `You are helping a user select the correct UI element for a test step.

USER INTENT: "${params.userIntent}"
ACTION: ${params.actionType}

CANDIDATE ELEMENTS (already ranked by relevance):
${candidateList}

Generate a SHORT clarification question in the SAME LANGUAGE as the user's intent.
The question should help the user choose between these specific elements.

Reply with JSON only:
{"question": "brief question in user's language", "interpretation": "what user wants to do"}`;

      const result = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          max_tokens: 100,
          temperature: 0.1,
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(result.content);
      return {
        question: parsed.question,
        interpretation: parsed.interpretation,
      };
    } catch (error) {
      logger.warn('[INTENT_LINT_V4] Clarification question generation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * V2: AI fallback for ambiguous/not_found cases
   * Uses AI to disambiguate between candidates or find the right element
   * Only called when rule-based resolver fails
   */
  static async lintStepWithAiFallback(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
  }): Promise<LintResult> {
    // First try rule-based
    const ruleResult = await this.lintStep(params);

    // If resolved with good confidence, return as-is
    if (ruleResult.status === 'resolved' && ruleResult.confidence >= CONFIDENCE.MEDIUM) {
      return ruleResult;
    }

    // If no candidates at all, AI can't help
    if (ruleResult.candidates.length === 0) {
      return ruleResult;
    }

    // AI fallback needed
    logger.info('[INTENT_LINT] Triggering AI fallback', {
      previewSessionId: params.previewSessionId,
      stepType: params.stepDraft.type,
      candidateCount: ruleResult.candidates.length,
      ruleConfidence: ruleResult.confidence,
    });

    try {
      // Get snapshot for URL context
      const sessionService = getPreviewSessionService();
      const snapshot = await sessionService.getSnapshot(params.previewSessionId, params.userId);

      if (!snapshot) {
        return ruleResult;
      }

      // Build AI prompt with privacy-safe candidate data
      const candidateData = ruleResult.candidates.slice(0, 5).map(c => ({
        ref: c.ref,
        label: c.label?.slice(0, 50),
        reason: c.reason,
        confidence: c.confidence,
      }));

      const prompt = buildAiResolvePrompt({
        stepDescription: params.stepDraft.description,
        stepType: params.stepDraft.type,
        stepValue: params.stepDraft.value ? '[VALUE]' : undefined, // Redact actual value
        pageUrl: snapshot.url,
        candidates: candidateData,
      });

      // Call AI service (lazy import to avoid circular deps)
      const { getChatCompletionWithMessages } = await import('@/services/ai/core/openai.service');
      const aiResponseResult = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          max_tokens: 150,
          temperature: 0.1, // Low temperature for deterministic output
          model: 'gpt-4o-mini', // Use fast/cheap model for disambiguation
        }
      );
      const aiResponse = aiResponseResult.content;

      // Parse AI response
      const parsed = parseAiResolveResponse(aiResponse, ruleResult.candidates);

      if (parsed.ref) {
        // Update result with AI resolution
        const aiCandidate = ruleResult.candidates.find(c => c.ref === parsed.ref);

        return {
          ...ruleResult,
          status: 'resolved',
          message: `AI resolved: ${parsed.reason || 'Best match found'}`,
          confidence: Math.max(ruleResult.confidence, 0.7), // AI gives at least 0.7 confidence
          candidates: aiCandidate ? [aiCandidate, ...ruleResult.candidates.filter(c => c.ref !== parsed.ref)] : ruleResult.candidates,
          highlight: [{
            ref: parsed.ref,
            boundingBox: aiCandidate?.boundingBox,
            type: 'success',
          }],
          needsAiFallback: false,
          aiResolvedRef: parsed.ref,
          aiReason: parsed.reason,
        };
      }

      // AI couldn't resolve either
      return {
        ...ruleResult,
        message: ruleResult.message + ' AI was unable to disambiguate.',
      };
    } catch (error) {
      logger.error('[INTENT_LINT] AI fallback failed', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId: params.previewSessionId,
      });

      // Return rule-based result on AI failure
      return ruleResult;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI Prompt Helpers (privacy-safe)
// ═══════════════════════════════════════════════════════════════════════════

interface AiResolvePromptParams {
  stepDescription: string;
  stepType: string;
  stepValue?: string;
  pageUrl: string;
  candidates: Array<{
    ref?: string;
    label?: string;
    reason: string;
    confidence: number;
  }>;
}

function buildAiResolvePrompt(params: AiResolvePromptParams): string {
  const candidateList = params.candidates
    .map((c, i) => `${i + 1}. ref="${c.ref}" label="${c.label || 'N/A'}" (${c.reason}, conf=${c.confidence.toFixed(2)})`)
    .join('\n');

  return `You are helping resolve an ambiguous UI element for a test step.

USER INTENT: "${params.stepDescription}"
ACTION TYPE: ${params.stepType}
PAGE URL: ${params.pageUrl}

CANDIDATE ELEMENTS:
${candidateList}

Which element (by ref) best matches the user's intent? Reply with JSON:
{"ref": "eXX", "reason": "brief explanation"}

Only use refs from the list above. If none match well, reply: {"ref": null, "reason": "no match"}`;
}

function parseAiResolveResponse(
  response: string,
  candidates: LintCandidate[]
): { ref: string | undefined; reason: string | undefined } {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      return { ref: undefined, reason: undefined };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const ref = parsed.ref;
    const reason = parsed.reason || undefined;

    // Validate ref exists in candidates
    if (ref && candidates.some(c => c.ref === ref)) {
      return { ref, reason };
    }

    return { ref: undefined, reason: undefined };
  } catch {
    return { ref: undefined, reason: undefined };
  }
}
