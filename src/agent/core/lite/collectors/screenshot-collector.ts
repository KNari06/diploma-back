/**
 * ScreenshotCollector
 * Captures before/after screenshots and A11y dumps on errors
 * Black Box Strategy for debugging
 */

import type { Page } from 'playwright';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '@/utils/core/logger';
import type { LiteSnapshot } from '../lite-types';

export class ScreenshotCollector {
  private testId: string;
  private screenshotsDir: string;
  private screenshots: Array<{ name: string; path: string; timestamp: number }> = [];

  constructor(testId: string) {
    this.testId = testId;
    this.screenshotsDir = path.join(process.cwd(), 'errors', testId);
  }

  /**
   * Capture screenshot BEFORE action
   *
   * @param page - Playwright page
   * @param iteration - Current iteration number
   * @returns Path to screenshot file
   */
  async captureBefore(page: Page, iteration: number): Promise<string> {
    return this.capture(page, `${iteration}_before`);
  }

  /**
   * Capture screenshot AFTER action
   *
   * @param page - Playwright page
   * @param iteration - Current iteration number
   * @returns Path to screenshot file
   */
  async captureAfter(page: Page, iteration: number): Promise<string> {
    return this.capture(page, `${iteration}_after`);
  }

  /**
   * Capture on error with A11y tree dump
   *
   * @param page - Playwright page
   * @param iteration - Current iteration number
   * @param snapshot - Current snapshot with accessibility tree
   * @param error - Error message
   * @returns Paths to screenshot and tree dump
   */
  async captureError(
    page: Page,
    iteration: number,
    snapshot: LiteSnapshot,
    error: string
  ): Promise<{ screenshot: string; treeDump: string }> {
    try {
      await fs.mkdir(this.screenshotsDir, { recursive: true });

      // Screenshot
      const screenshotPath = await this.capture(page, `${iteration}_error`);

      // A11y tree dump with error context
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
        screenshotPath,
        treeDumpPath,
      });

      return { screenshot: screenshotPath, treeDump: treeDumpPath };
    } catch (err) {
      logger.error('[SCREENSHOT_COLLECTOR] Failed to capture error artifacts', {
        testId: this.testId,
        iteration,
        error: err instanceof Error ? err.message : String(err),
      });

      // Return empty paths on error - don't break the test
      return { screenshot: '', treeDump: '' };
    }
  }

  /**
   * Internal: Capture screenshot
   *
   * @param page - Playwright page
   * @param name - Screenshot name
   * @returns Path to screenshot file
   */
  private async capture(page: Page, name: string): Promise<string> {
    try {
      await fs.mkdir(this.screenshotsDir, { recursive: true });

      const filepath = path.join(this.screenshotsDir, `${name}.png`);

      // Capture screenshot (not full page for speed)
      await page.screenshot({
        path: filepath,
        fullPage: false,
        timeout: 5000
      });

      this.screenshots.push({
        name,
        path: filepath,
        timestamp: Date.now()
      });

      logger.debug('[SCREENSHOT_COLLECTOR] Captured screenshot', {
        name,
        path: filepath,
      });

      return filepath;
    } catch (error) {
      logger.error('[SCREENSHOT_COLLECTOR] Failed to capture screenshot', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return empty path on error - don't break the test
      return '';
    }
  }

  /**
   * Get all captured screenshots
   *
   * @returns Array of screenshot metadata
   */
  getAll(): Array<{ name: string; path: string; timestamp: number }> {
    return [...this.screenshots];
  }

  /**
   * Get screenshots directory path
   */
  getDirectory(): string {
    return this.screenshotsDir;
  }

  /**
   * Clear screenshots list (doesn't delete files)
   */
  clear(): void {
    this.screenshots = [];
  }
}
