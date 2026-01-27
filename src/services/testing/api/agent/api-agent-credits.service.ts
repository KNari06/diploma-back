/**
 * API Agent Credits Service
 * Handles fixed-per-level billing + incremental AI-usage billing
 */

import { logger } from '@/utils/core/logger';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TOKENS_PER_CREDIT } from '@/services/core/token-calculator.service';
import type { ApiAgentLevel, ApiAgentSummary } from './api-agent.types';
import { getBaselineCredits } from './api-agent-policy';

// ═══════════════════════════════════════════════════════════════════════════
// CREDIT CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Approximate USD cost per credit (for metadata) */
const USD_PER_CREDIT = 0.0289; // Based on $28.9 / 1000 credits

/** Model used for AI calls in agent */
const DEFAULT_MODEL = 'gpt-4o-mini';

// ═══════════════════════════════════════════════════════════════════════════
// CREDITS SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ApiAgentCreditsService {
  /**
   * Deduct baseline credits for a level (before execution)
   * Returns true if successful, false if insufficient credits
   */
  static async deductBaselineCredits(
    userId: string,
    level: ApiAgentLevel,
    testId: string,
    description: string
  ): Promise<{ success: boolean; credits: number; error?: string }> {
    const credits = getBaselineCredits(level);
    const costUSD = credits * USD_PER_CREDIT;

    try {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: 'api',
        credits,
        costUSD,
        testId,
        description,
      });

      if (result.success) {
        logger.info('[API_AGENT_CREDITS] Baseline credits deducted', {
          userId: userId.substring(0, 8) + '...',
          level,
          credits,
          newBalance: result.newBalance,
        });
      } else {
        logger.warn('[API_AGENT_CREDITS] Failed to deduct baseline credits', {
          userId: userId.substring(0, 8) + '...',
          level,
          credits,
          error: result.error,
        });
      }

      return {
        success: result.success,
        credits,
        error: result.error,
      };
    } catch (error) {
      logger.error('[API_AGENT_CREDITS] Error deducting baseline credits', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
        level,
      });

      return {
        success: false,
        credits: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Deduct incremental credits based on AI token usage (after execution)
   * Only charges if tokens exceed what was already covered by baseline
   */
  static async deductIncrementalCredits(
    userId: string,
    summary: ApiAgentSummary
  ): Promise<{ success: boolean; credits: number; error?: string }> {
    const tokensUsed = summary.aiTokensUsed;

    if (tokensUsed <= 0) {
      return { success: true, credits: 0 };
    }

    // Baseline already covers some tokens, only charge excess
    const baselineCredits = getBaselineCredits(summary.level);
    const baselineTokens = baselineCredits * TOKENS_PER_CREDIT;

    // Only charge if actual usage exceeds baseline allocation
    if (tokensUsed <= baselineTokens) {
      logger.debug('[API_AGENT_CREDITS] Token usage within baseline, no incremental charge', {
        tokensUsed,
        baselineTokens,
      });
      return { success: true, credits: 0 };
    }

    // Calculate excess tokens and convert to credits
    const excessTokens = tokensUsed - baselineTokens;
    const incrementalCredits = Math.ceil(excessTokens / TOKENS_PER_CREDIT);

    if (incrementalCredits <= 0) {
      return { success: true, credits: 0 };
    }

    const costUSD = incrementalCredits * USD_PER_CREDIT;

    try {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: 'api',
        credits: incrementalCredits,
        costUSD,
        testId: summary.testId,
        description: `API Agent (${summary.level.toUpperCase()}) AI usage: ${tokensUsed} tokens`,
        tokens: {
          inputTokens: Math.floor(tokensUsed * 0.7), // Estimate 70% input
          outputTokens: Math.floor(tokensUsed * 0.3), // Estimate 30% output
          model: DEFAULT_MODEL,
        },
      });

      if (result.success) {
        logger.info('[API_AGENT_CREDITS] Incremental credits deducted', {
          userId: userId.substring(0, 8) + '...',
          level: summary.level,
          tokensUsed,
          incrementalCredits,
          newBalance: result.newBalance,
        });
      } else {
        // Log but don't fail - baseline was already charged
        logger.warn('[API_AGENT_CREDITS] Failed to deduct incremental credits', {
          userId: userId.substring(0, 8) + '...',
          incrementalCredits,
          error: result.error,
        });
      }

      return {
        success: result.success,
        credits: incrementalCredits,
        error: result.error,
      };
    } catch (error) {
      // Log but don't fail - baseline was already charged
      logger.warn('[API_AGENT_CREDITS] Error deducting incremental credits', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
      });

      return {
        success: false,
        credits: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Calculate total credits that will be/were charged for a run
   */
  static calculateTotalCredits(
    level: ApiAgentLevel,
    aiTokensUsed: number
  ): { baseline: number; incremental: number; total: number } {
    const baseline = getBaselineCredits(level);
    const baselineTokens = baseline * TOKENS_PER_CREDIT;

    let incremental = 0;
    if (aiTokensUsed > baselineTokens) {
      const excessTokens = aiTokensUsed - baselineTokens;
      incremental = Math.ceil(excessTokens / TOKENS_PER_CREDIT);
    }

    return {
      baseline,
      incremental,
      total: baseline + incremental,
    };
  }

  /**
   * Estimate credits for a level (for UI preview)
   */
  static estimateCredits(level: ApiAgentLevel): {
    baseline: number;
    estimatedMax: number;
  } {
    const baseline = getBaselineCredits(level);

    // Estimate max based on typical AI token usage per level
    const estimatedTokens: Record<ApiAgentLevel, number> = {
      // With always-AI planning, LIGHT now uses more tokens than the old rule-based bootstrap.
      light: 7000,
      medium: 15000,
      hard: 30000,
    };

    const maxTokens = estimatedTokens[level];
    const maxCredits = Math.ceil(maxTokens / TOKENS_PER_CREDIT);

    return {
      baseline,
      estimatedMax: Math.max(baseline, maxCredits),
    };
  }
}
