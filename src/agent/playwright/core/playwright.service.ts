// Main service file - exports all functions from modular files
import { browserPool } from '../../browser/browser-pool';
import { executePlaywrightTest } from './test-executor';
import { executePlaywrightTestWithRetry } from './test-retry';

/**
 * Execute Playwright test
 */
export { executePlaywrightTest };

/**
 * Execute Playwright test with automatic retry
 */
  export { executePlaywrightTestWithRetry };

/**
 * Get agent status
 */
export async function getAgentStatus(): Promise<{
  available: boolean;
  browserPool: ReturnType<typeof browserPool.getStatus>;
}> {
  return {
    available: true,
    browserPool: browserPool.getStatus(),
  };
}
