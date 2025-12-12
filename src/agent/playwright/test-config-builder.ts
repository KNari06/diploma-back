import { TestJobData } from '@/types';
import { DEFAULT_SAFETY_CONFIG } from '../safety-guard';
import { IntelligentTestConfig, TestHint } from '../types/intelligent-testing.types';

/**
 * Build intelligent test configuration
 */
export function buildIntelligentTestConfig(
  testData: TestJobData,
  goal: string,
  hints: TestHint[],
  retryCount: number
): IntelligentTestConfig {
  return {
    mode: 'balanced',
    safety: {
      ...DEFAULT_SAFETY_CONFIG,
      level: 'normal',
    },
    goal,
    startUrl: testData.url,
    browser: testData.browser,
    credentials: testData.options?.credentials,
    userContext: {
      projectId: testData.projectId,
      testId: testData.testId,
      retryCount,
    },
    hints: hints.length > 0 ? hints : undefined,
    waitForSelector: testData.options?.waitForSelector,
    customScripts: testData.options?.customScripts,
    commands: testData.commands, // Keep original commands for reference
  };
}
