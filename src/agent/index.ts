/**
 * QAIT Playwright Agent Module
 *
 * Self-contained module for browser automation and test execution
 * Runs locally within the backend process (no separate service needed)
 */

export { browserPool } from './browser/browser-pool';
export { ResultCollector } from './browser/result-collector';
export { CommandExecutor } from './execution/command-executor';
export { executePlaywrightTest, executePlaywrightTestWithRetry, getAgentStatus } from './playwright/core/playwright.service';
export { VideoStreamRegistry } from './playwright/artifacts/video-stream-registry';
export { createVideoStreamService, VideoStreamService } from './playwright/artifacts/video-stream.service';
