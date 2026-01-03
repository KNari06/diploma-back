/**
 * ModeRouter
 * Decides whether to use Lite or Pro mode for test execution
 */

import { logger } from '@/utils/core/logger';

export interface TestMode {
  mode: 'lite' | 'pro';
  reason: string;
}

export class ModeRouter {
  /**
   * Determine which mode to use for a test
   * Priority: userMode (from frontend) > default 'lite'
   *
   * @param params - Test parameters
   * @returns Selected mode and reason
   */
  static selectMode(params: {
    goal: string;
    url: string;
    userId?: string;
    userMode?: 'lite' | 'pro'; // User-selected mode from frontend
    complexity?: 'simple' | 'medium' | 'complex';
  }): TestMode {
    // Priority 1: Use user-selected mode if provided
    const selectedMode = params.userMode || 'lite';

    logger.info('[MODE_ROUTER] Selected mode', {
      mode: selectedMode,
      hasUserMode: !!params.userMode,
      goal: params.goal.slice(0, 50),
      url: params.url,
    });

    if (selectedMode === 'pro') {
      return {
        mode: 'pro',
        reason: 'Pro mode selected by user',
      };
    }

    return {
      mode: 'lite',
      reason: params.userMode ? 'Lite mode selected by user' : 'Using Lite Engine (default)',
    };

    /* Future implementation when Pro mode is refactored:

    // Use Lite for simple tests
    if (params.complexity === 'simple') {
      return {
        mode: 'lite',
        reason: 'Simple test - using lightweight Lite Engine',
      };
    }

    // Use Pro for complex multi-step workflows
    if (params.complexity === 'complex') {
      return {
        mode: 'pro',
        reason: 'Complex workflow - using advanced Pro Engine',
      };
    }

    // Default to Lite for medium complexity
    return {
      mode: 'lite',
      reason: 'Medium complexity - using Lite Engine',
    };
    */
  }

  /**
   * Check if test should use Lite mode
   *
   * @param params - Test parameters
   * @returns True if should use Lite mode
   */
  static shouldUseLite(params: {
    goal: string;
    url: string;
    userId?: string;
  }): boolean {
    const selection = this.selectMode(params);
    return selection.mode === 'lite';
  }

  /**
   * Check if test should use Pro mode
   *
   * @param params - Test parameters
   * @returns True if should use Pro mode
   */
  static shouldUsePro(params: {
    goal: string;
    url: string;
    userId?: string;
  }): boolean {
    const selection = this.selectMode(params);
    return selection.mode === 'pro';
  }

  /**
   * Get mode description for logging/UI
   *
   * @param mode - Mode name
   * @returns Human-readable description
   */
  static getModeDescription(mode: 'lite' | 'pro'): string {
    switch (mode) {
      case 'lite':
        return 'Lite Engine: Fast, efficient, cost-effective testing with feedback loop';
      case 'pro':
        return 'Pro Engine: Advanced testing with deep analysis (coming soon)';
      default:
        return 'Unknown mode';
    }
  }
}
