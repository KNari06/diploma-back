/**
 * AI Cost Manager Service
 * ✅ FIX 9: Budget control and adaptive mode switching
 * Tracks AI costs per test and switches to cheaper models when budget exceeded
 */

import { logger } from '@/utils/core/logger';

// ═══════════════════════════════════════════════════════════════════════════
// PRICING (as of Nov 2024)
// ═══════════════════════════════════════════════════════════════════════════

export const AI_PRICING = {
  'gpt-4o': {
    input: 0.0025 / 1000,  // $0.0025 per 1K input tokens
    output: 0.01 / 1000,    // $0.01 per 1K output tokens
  },
  'gpt-4o-mini': {
    input: 0.00015 / 1000, // $0.00015 per 1K input tokens
    output: 0.0006 / 1000,  // $0.0006 per 1K output tokens
  },
  'gpt-4o-vision': {
    input: 0.0025 / 1000,  // Same as gpt-4o
    output: 0.01 / 1000,
    imageBase: 0.00425,     // Base cost per image
    imagePerTile: 0.00085,  // Cost per 512x512 tile
  },
} as const;

export type AIModel = keyof typeof AI_PRICING;

// ═══════════════════════════════════════════════════════════════════════════
// BUDGET CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export interface BudgetConfig {
  maxCostPerTest: number;      // Maximum cost per test (USD)
  warningThreshold: number;     // Warning at X% of budget (0-1)
  adaptiveMode: boolean;        // Enable adaptive mode switching
  fallbackModel: AIModel;       // Model to switch to when budget exceeded
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxCostPerTest: 1.0,          // $1 per test
  warningThreshold: 0.7,        // Warning at 70%
  adaptiveMode: true,           // Enable adaptive mode
  fallbackModel: 'gpt-4o-mini', // Fallback to mini
};

// ═══════════════════════════════════════════════════════════════════════════
// COST MANAGER
// ═══════════════════════════════════════════════════════════════════════════

export class AICostManager {
  private testId: string;
  private budget: BudgetConfig;
  private totalCost: number = 0;
  private operationCosts: Array<{
    operation: string;
    model: AIModel;
    cost: number;
    timestamp: number;
  }> = [];
  private isAdaptiveModeActive: boolean = false;
  private warningEmitted: boolean = false;

  constructor(testId: string, budget: Partial<BudgetConfig> = {}) {
    this.testId = testId;
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  /**
   * Record AI operation cost
   * @returns true if operation allowed, false if budget exceeded
   */
  recordOperation(params: {
    operation: string;
    model: AIModel;
    inputTokens: number;
    outputTokens: number;
    imageCount?: number;
  }): { allowed: boolean; cost: number; warning?: string } {
    const { operation, model, inputTokens, outputTokens, imageCount = 0 } = params;

    // Calculate cost
    const cost = this.calculateCost(model, inputTokens, outputTokens, imageCount);

    // Check if operation would exceed budget
    const newTotal = this.totalCost + cost;

    if (newTotal > this.budget.maxCostPerTest) {
      logger.warn('[AI_COST_MANAGER] Budget exceeded', {
        testId: this.testId,
        operation,
        currentCost: this.totalCost,
        operationCost: cost,
        budget: this.budget.maxCostPerTest,
        exceeded: newTotal - this.budget.maxCostPerTest,
      });

      return {
        allowed: false,
        cost,
        warning: `Budget exceeded: $${newTotal.toFixed(4)} > $${this.budget.maxCostPerTest}`,
      };
    }

    // Record operation
    this.totalCost = newTotal;
    this.operationCosts.push({
      operation,
      model,
      cost,
      timestamp: Date.now(),
    });

    // Check for warning threshold
    const percentUsed = newTotal / this.budget.maxCostPerTest;
    if (!this.warningEmitted && percentUsed >= this.budget.warningThreshold) {
      this.warningEmitted = true;
      logger.warn('[AI_COST_MANAGER] Budget warning threshold reached', {
        testId: this.testId,
        percentUsed: `${(percentUsed * 100).toFixed(1)}%`,
        currentCost: this.totalCost,
        budget: this.budget.maxCostPerTest,
      });

      return {
        allowed: true,
        cost,
        warning: `Budget warning: ${(percentUsed * 100).toFixed(1)}% used ($${newTotal.toFixed(4)} / $${this.budget.maxCostPerTest})`,
      };
    }

    // Check if should switch to adaptive mode
    if (this.budget.adaptiveMode && !this.isAdaptiveModeActive && percentUsed >= 0.5) {
      this.isAdaptiveModeActive = true;
      logger.info('[AI_COST_MANAGER] Adaptive mode activated', {
        testId: this.testId,
        percentUsed: `${(percentUsed * 100).toFixed(1)}%`,
        fallbackModel: this.budget.fallbackModel,
      });
    }

    logger.debug('[AI_COST_MANAGER] Operation recorded', {
      testId: this.testId,
      operation,
      model,
      cost: `$${cost.toFixed(6)}`,
      totalCost: `$${this.totalCost.toFixed(4)}`,
      percentUsed: `${(percentUsed * 100).toFixed(1)}%`,
    });

    return { allowed: true, cost };
  }

  /**
   * Calculate cost for AI operation
   */
  private calculateCost(
    model: AIModel,
    inputTokens: number,
    outputTokens: number,
    imageCount: number = 0
  ): number {
    const pricing = AI_PRICING[model];

    let cost = 0;

    // Token costs
    cost += inputTokens * pricing.input;
    cost += outputTokens * pricing.output;

    // Image costs (for vision models)
    if (model === 'gpt-4o-vision' && imageCount > 0) {
      // Estimate tiles (assume 1024x1024 images = 4 tiles)
      const tilesPerImage = 4;
      const visionPricing = AI_PRICING['gpt-4o-vision'];
      cost += imageCount * (visionPricing.imageBase + tilesPerImage * visionPricing.imagePerTile);
    }

    return cost;
  }

  /**
   * Get recommended model based on budget
   * ✅ FIX 9: Adaptive mode - switch to cheaper model when budget low
   */
  getRecommendedModel(preferredModel: AIModel): AIModel {
    if (!this.budget.adaptiveMode) {
      return preferredModel;
    }

    // If adaptive mode active, use fallback model
    if (this.isAdaptiveModeActive) {
      logger.info('[AI_COST_MANAGER] Using fallback model due to adaptive mode', {
        testId: this.testId,
        preferred: preferredModel,
        fallback: this.budget.fallbackModel,
      });
      return this.budget.fallbackModel;
    }

    return preferredModel;
  }

  /**
   * Check if budget allows more operations
   */
  canContinue(): boolean {
    return this.totalCost < this.budget.maxCostPerTest;
  }

  /**
   * Get current cost statistics
   */
  getStats(): {
    totalCost: number;
    budget: number;
    percentUsed: number;
    operationCount: number;
    isAdaptiveModeActive: boolean;
    breakdown: Record<string, number>;
  } {
    const breakdown: Record<string, number> = {};

    for (const op of this.operationCosts) {
      const key = `${op.operation} (${op.model})`;
      breakdown[key] = (breakdown[key] || 0) + op.cost;
    }

    return {
      totalCost: this.totalCost,
      budget: this.budget.maxCostPerTest,
      percentUsed: (this.totalCost / this.budget.maxCostPerTest) * 100,
      operationCount: this.operationCosts.length,
      isAdaptiveModeActive: this.isAdaptiveModeActive,
      breakdown,
    };
  }

  /**
   * Estimate cost for upcoming operation
   */
  estimateCost(params: {
    model: AIModel;
    inputTokens: number;
    outputTokens: number;
    imageCount?: number;
  }): {
    estimatedCost: number;
    wouldExceedBudget: boolean;
    remainingBudget: number;
  } {
    const { model, inputTokens, outputTokens, imageCount = 0 } = params;

    const estimatedCost = this.calculateCost(model, inputTokens, outputTokens, imageCount);
    const remainingBudget = this.budget.maxCostPerTest - this.totalCost;
    const wouldExceedBudget = estimatedCost > remainingBudget;

    return {
      estimatedCost,
      wouldExceedBudget,
      remainingBudget,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL COST MANAGER REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

const costManagers = new Map<string, AICostManager>();

/**
 * Get or create cost manager for test
 */
export function getCostManager(testId: string, budget?: Partial<BudgetConfig>): AICostManager {
  if (!costManagers.has(testId)) {
    costManagers.set(testId, new AICostManager(testId, budget));
  }
  return costManagers.get(testId)!;
}

/**
 * Remove cost manager after test completion
 */
export function removeCostManager(testId: string): void {
  costManagers.delete(testId);
}

/**
 * Get all active cost managers (for monitoring)
 */
export function getAllCostManagers(): Map<string, AICostManager> {
  return new Map(costManagers);
}
