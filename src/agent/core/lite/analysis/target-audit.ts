/**
 * TargetAudit (L4 Guard - Manus Style)
 *
 * Validates AI-chosen element ref before execution.
 * If element doesn't match goal keywords, triggers audit with top candidates.
 *
 * Purpose: Prevent drift from user goal on busy pages with many similar elements.
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { AICommand } from '../lite-types';
import { FunnelPhase } from './funnel-analyzer';
import type { ExpandedGoal } from './goal-expander';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface RankedCandidate {
  ref: string;
  name: string;
  tag: string;
  score: number;
  breakdown: {
    heuristic: number;
    funnelMultiplier: number;
    zIndexBoost: number;
    goalRelevance: number;
  };
}

export interface AuditResult {
  /** Whether original ref is correct */
  isCorrect: boolean;
  /** Corrected ref if original was wrong */
  correctedRef?: string;
  /** Reason for correction */
  reason: string;
  /** Confidence in decision (0-1) */
  confidence: number;
}

interface AIAuditResponse {
  isCorrect: boolean;
  correctedRef?: string;
  reason: string;
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// TARGET AUDIT SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class TargetAudit {
  private static readonly TIMEOUT_MS = 1500;

  /**
   * Audit AI-chosen ref against top candidates.
   * Called when ref doesn't match goal keywords.
   *
   * @param command AI command with proposed ref
   * @param candidates Top ranked candidate elements
   * @param expandedGoal Expanded goal from GoalExpander
   * @param funnelPhase Current funnel phase
   * @param options.scoringMode Default 'deweighted' (Stage 2). Bucket
   *   scores 0/1/2/3 → score legend in the prompt explains the scale.
   *   'legacy' kept for backward compatibility with non-Lite callers
   *   (composite float scores 0..15).
   * @returns Audit result with potential correction
   */
  static async audit(
    command: AICommand,
    candidates: RankedCandidate[],
    expandedGoal: ExpandedGoal,
    funnelPhase: FunnelPhase,
    options: { scoringMode?: 'legacy' | 'deweighted' } = {},
  ): Promise<AuditResult> {
    const startTime = Date.now();
    const scoringMode = options.scoringMode ?? 'deweighted';

    logger.info('[TARGET_AUDIT] Starting L4 audit', {
      proposedRef: command.ref?.slice(0, 20),
      action: command.action,
      candidateCount: candidates.length,
      funnelPhase,
      scoringMode,
    });

    try {
      const response = await Promise.race([
        this.callAuditAI(command, candidates, expandedGoal, funnelPhase, scoringMode),
        this.timeout(this.TIMEOUT_MS),
      ]);

      const latency = Date.now() - startTime;

      if (!response) {
        logger.warn('[TARGET_AUDIT] AI timeout, trusting original', { latency });
        return {
          isCorrect: true,
          reason: 'Audit timeout, trusting original',
          confidence: 0.5,
        };
      }

      logger.info('[TARGET_AUDIT] Audit completed', {
        isCorrect: response.isCorrect,
        correctedRef: response.correctedRef?.slice(0, 20),
        reason: response.reason?.slice(0, 50),
        confidence: response.confidence,
        latency,
      });

      return response;
    } catch (error) {
      logger.error('[TARGET_AUDIT] Audit failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        isCorrect: true,
        reason: 'Audit error, trusting original',
        confidence: 0.5,
      };
    }
  }

  /**
   * Call AI to validate ref choice
   */
  private static async callAuditAI(
    command: AICommand,
    candidates: RankedCandidate[],
    expandedGoal: ExpandedGoal,
    funnelPhase: FunnelPhase,
    scoringMode: 'legacy' | 'deweighted' = 'legacy',
  ): Promise<AIAuditResponse | null> {
    // Find proposed element in candidates
    const proposedCandidate = candidates.find(c => c.ref === command.ref);

    const systemPrompt = `You are a Target Validation Guard for an autonomous web agent.
Your task is to verify that the AI chose the CORRECT element for the user's goal.
If the chosen element is wrong, select the best alternative from the candidates.
Return ONLY a JSON object.`;

    // Audit H2: legacy scores ranged 0.05–~15 (composite). Deweighted
    // scores are 0/1/2/3 (4 buckets). The LLM has no way to know
    // `3.00` means "strongest candidate" in deweighted mode unless we
    // tell it. Choose legend by mode so the prompt explains itself.
    const scoreLegend = scoringMode === 'deweighted'
      ? '(scoring: 3=visible+goal-relevant, 2=visible only, 1=goal-relevant but covered, 0=neither — higher is better, ALL candidates may share the same bucket)'
      : '(scoring: composite of heuristic × funnel × z-index × goal-relevance — typical range 0.05–15, higher is better)';

    const userPrompt = `USER GOAL: "${expandedGoal.original}"
ACTION: ${command.action}
FUNNEL PHASE: ${funnelPhase}
GOAL KEYWORDS: ${[...expandedGoal.allKeywords].slice(0, 10).join(', ')}
NEGATIVE KEYWORDS: ${[...expandedGoal.negativeKeywords].slice(0, 5).join(', ')}

PROPOSED ELEMENT:
- ref: "${command.ref}"
- name: "${proposedCandidate?.name || 'unknown'}"
- tag: ${proposedCandidate?.tag || 'unknown'}
- score: ${proposedCandidate?.score?.toFixed(2) || 'N/A'}

TOP CANDIDATES sorted by score ${scoreLegend}:
${candidates.map((c, i) =>
  `${i + 1}. ref="${c.ref}" name="${c.name}" tag=${c.tag} score=${c.score.toFixed(2)}`
).join('\n')}

TASK: Is the proposed element the best choice for the user's goal?
- If YES: return { "isCorrect": true, "reason": "explanation", "confidence": 0.0-1.0 }
- If NO: return { "isCorrect": false, "correctedRef": "better_ref", "reason": "explanation", "confidence": 0.0-1.0 }

RULES:
- Prefer elements that match goal keywords
- Avoid elements matching negative keywords
- Consider funnel phase (${funnelPhase}): prioritize phase-appropriate actions
- Higher score candidates are more likely correct
- If unsure, trust the original (isCorrect: true)`;

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_TASK_MODELS.targetAudit,
          temperature: 0,
          response_format: { type: 'json_object' },
          // 250 tokens covers JSON output for up to 10 candidates plus
          // a short reason. Was 200 (sized for 5). The output schema
          // is fixed-size (isCorrect / correctedRef / reason / confidence)
          // — the +50 is purely for `reason` headroom when the model
          // describes a specific candidate among 10 instead of 5.
          max_tokens: 250,
        }
      );

      const parsed = JSON.parse(response.content) as AIAuditResponse;

      // Validate correctedRef exists in candidates
      if (parsed.correctedRef && !candidates.some(c => c.ref === parsed.correctedRef)) {
        logger.warn('[TARGET_AUDIT] AI suggested invalid ref, ignoring', {
          suggested: parsed.correctedRef,
        });
        return {
          isCorrect: true,
          reason: 'AI suggested invalid ref',
          confidence: 0.5,
        };
      }

      return parsed;
    } catch (error) {
      logger.error('[TARGET_AUDIT] AI call failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Timeout helper
   */
  private static timeout(ms: number): Promise<null> {
    return new Promise(resolve => setTimeout(() => resolve(null), ms));
  }
}
