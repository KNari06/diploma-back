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
   * @returns Audit result with potential correction
   */
  static async audit(
    command: AICommand,
    candidates: RankedCandidate[],
    expandedGoal: ExpandedGoal,
    funnelPhase: FunnelPhase
  ): Promise<AuditResult> {
    const startTime = Date.now();

    logger.info('[TARGET_AUDIT] Starting L4 audit', {
      proposedRef: command.ref?.slice(0, 20),
      action: command.action,
      candidateCount: candidates.length,
      funnelPhase,
    });

    try {
      const response = await Promise.race([
        this.callAuditAI(command, candidates, expandedGoal, funnelPhase),
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
    funnelPhase: FunnelPhase
  ): Promise<AIAuditResponse | null> {
    // Find proposed element in candidates
    const proposedCandidate = candidates.find(c => c.ref === command.ref);

    const systemPrompt = `You are a Target Validation Guard for an autonomous web agent.
Your task is to verify that the AI chose the CORRECT element for the user's goal.
If the chosen element is wrong, select the best alternative from the candidates.
Return ONLY a JSON object.`;

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

TOP CANDIDATES (sorted by score):
${candidates.slice(0, 5).map((c, i) =>
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
          model: 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: 200,
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
