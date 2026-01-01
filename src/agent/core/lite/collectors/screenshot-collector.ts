/**
 * ScreenshotCollector
 * Captures before/after screenshots and A11y dumps on errors
 * Black Box Strategy for debugging
 *
 * Screenshots are stored in memory as Buffer for efficient upload to storage
 * Optional: Save to disk for debugging (via LITE_SAVE_SCREENSHOTS_TO_DISK env var)
 */

import type { Page } from 'playwright';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '@/utils/core/logger';
import type { LiteSnapshot } from '../lite-types';

export class ScreenshotCollector {
  private testId: string;
  private screenshotsDir: string;
  private screenshots: Array<{ name: string; buffer: Buffer; timestamp: number }> = [];

  constructor(testId: string) {
    this.testId = testId;
    this.screenshotsDir = path.join(process.cwd(), 'errors', testId);
  }

  /**
   * Capture screenshot BEFORE action
   *
   * @param page - Playwright page
   * @param iteration - Current iteration number
   * @returns Buffer of screenshot
   */
  async captureBefore(page: Page, iteration: number): Promise<Buffer | null> {
    return this.capture(page, `${iteration}_before`);
  }

  /**
   * Capture screenshot AFTER action
   *
   * @param page - Playwright page
   * @param iteration - Current iteration number
   * @returns Buffer of screenshot
   */
  async captureAfter(page: Page, iteration: number): Promise<Buffer | null> {
    return this.capture(page, `${iteration}_after`);
  }

  /**
   * Capture on error with A11y tree dump
   * Tree dump is saved to disk for debugging purposes
   *
   * @param page - Playwright page
   * @param iteration - Current iteration number
   * @param snapshot - Current snapshot with accessibility tree
   * @param error - Error message
   * @returns Buffer of screenshot and path to tree dump file
   */
  async captureError(
    page: Page,
    iteration: number,
    snapshot: LiteSnapshot,
    error: string
  ): Promise<{ screenshotBuffer: Buffer | null; treeDump: string }> {
    try {
      // Screenshot - captured in memory (via capture method)
      const screenshotBuffer = await this.capture(page, `${iteration}_error`);

      // A11y tree dump with error context (always saved to disk for debugging)
      await fs.mkdir(this.screenshotsDir, { recursive: true });
      const treeDumpPath = path.join(this.screenshotsDir, `${iteration}_error_tree.json`);
      const dumpData = {
        testId: this.testId,
        iteration,
        url: snapshot.url,
        title: snapshot.title,
        error,
        elements: snapshot.elements,
        elementCount: snapshot.elements.length,
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
      };

      await fs.writeFile(treeDumpPath, JSON.stringify(dumpData, null, 2), 'utf-8');

      logger.info('[SCREENSHOT_COLLECTOR] Captured error screenshot + tree dump', {
        testId: this.testId,
        iteration,
        screenshotBufferSize: screenshotBuffer ? `${Math.round(screenshotBuffer.length / 1024)}KB` : 'null',
        treeDumpPath,
      });

      return { screenshotBuffer, treeDump: treeDumpPath };
    } catch (err) {
      logger.error('[SCREENSHOT_COLLECTOR] Failed to capture error artifacts', {
        testId: this.testId,
        iteration,
        error: err instanceof Error ? err.message : String(err),
      });

      // Return null/empty on error - don't break the test
      return { screenshotBuffer: null, treeDump: '' };
    }
  }

  /**
   * Internal: Capture screenshot in memory as Buffer
   *
   * @param page - Playwright page
   * @param name - Screenshot name
   * @returns Buffer of screenshot (or null on error)
   */
  private async capture(page: Page, name: string): Promise<Buffer | null> {
    try {
      // Capture screenshot in memory (fullPage for better UX)
      const buffer = await page.screenshot({
        fullPage: true,
        timeout: 5000
      });

      // Optional: Save to disk for debugging (if env variable set)
      if (process.env.LITE_SAVE_SCREENSHOTS_TO_DISK === 'true') {
        try {
          await fs.mkdir(this.screenshotsDir, { recursive: true });
          const filepath = path.join(this.screenshotsDir, `${name}.png`);
          await fs.writeFile(filepath, buffer);
          logger.debug('[SCREENSHOT_COLLECTOR] Saved screenshot to disk for debugging', { filepath });
        } catch (saveError) {
          // Don't fail if file save fails
          logger.debug('[SCREENSHOT_COLLECTOR] Failed to save screenshot to disk', {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
        }
      }

      // Store buffer in memory
      this.screenshots.push({
        name,
        buffer,
        timestamp: Date.now()
      });

      logger.debug('[SCREENSHOT_COLLECTOR] Captured screenshot in memory', {
        name,
        bufferSize: `${Math.round(buffer.length / 1024)}KB`,
      });

      return buffer;
    } catch (error) {
      logger.error('[SCREENSHOT_COLLECTOR] Failed to capture screenshot', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return null on error - don't break the test
      return null;
    }
  }

  /**
   * Get all captured screenshots
   *
   * @returns Array of screenshot metadata with Buffer
   */
  getAll(): Array<{ name: string; buffer: Buffer; timestamp: number }> {
    return [...this.screenshots];
  }

  /**
   * Get screenshots directory path
   */
  getDirectory(): string {
    return this.screenshotsDir;
  }

  /**
   * Clear screenshots list (frees memory)
   */
  clear(): void {
    this.screenshots = [];
  }
}
