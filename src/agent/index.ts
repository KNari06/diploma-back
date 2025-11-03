/**
 * QAI Playwright Agent Module
 *
 * Self-contained module for browser automation and test execution
 * Runs locally within the backend process (no separate service needed)
 */

export { browserPool } from './browser-pool';
export { executePlaywrightTest, executePlaywrightTestWithRetry, getAgentStatus } from './playwright.service';
export { ResultCollector } from './result-collector';
export { CommandExecutor } from './command-executor';
