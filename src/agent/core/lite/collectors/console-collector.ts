/**
 * ConsoleCollector
 * Collects browser console messages and errors
 */

import type { Page, ConsoleMessage } from 'playwright';
import { logger } from '@/utils/core/logger';

interface CollectedConsoleError {
  type: 'error' | 'warning';
  text: string;
  timestamp: number;
  location?: string;
}

export class ConsoleCollector {
  private page: Page;
  private errors: CollectedConsoleError[] = [];
  private readonly MAX_ERRORS = 100; // Limit stored errors to prevent memory issues
  private isCollecting: boolean = false;

  constructor(page: Page) {
    this.page = page;
    this.startCollecting();
  }

  /**
   * Start collecting console messages
   */
  private startCollecting(): void {
    if (this.isCollecting) return;

    this.page.on('console', (msg: ConsoleMessage) => {
      this.handleConsoleMessage(msg);
    });

    this.isCollecting = true;
    logger.debug('[CONSOLE_COLLECTOR] Started collecting console messages');
  }

  /**
   * Handle a console message
   */
  private handleConsoleMessage(msg: ConsoleMessage): void {
    const type = msg.type();

    // Only collect errors and warnings
    if (type !== 'error' && type !== 'warning') {
      return;
    }

    const error: CollectedConsoleError = {
      type: type as 'error' | 'warning',
      text: msg.text(),
      timestamp: Date.now(),
      location: msg.location()?.url,
    };

    this.errors.push(error);

    // Limit array size to prevent memory issues
    if (this.errors.length > this.MAX_ERRORS) {
      this.errors.shift(); // Remove oldest error
    }

    logger.debug('[CONSOLE_COLLECTOR] Collected console error', {
      type,
      text: error.text.slice(0, 100),
    });
  }

  /**
   * Get all errors since a specific timestamp
   *
   * @param since - Timestamp in milliseconds
   * @returns Array of console errors since that time
   */
  getErrorsSince(since: number): string[] {
    return this.errors
      .filter((error) => error.timestamp >= since)
      .map((error) => `[${error.type}] ${error.text}`);
  }

  /**
   * Get all collected errors
   */
  getAllErrors(): CollectedConsoleError[] {
    return [...this.errors];
  }

  /**
   * Get error count
   */
  getErrorCount(): number {
    return this.errors.length;
  }

  /**
   * Clear all collected errors
   */
  clear(): void {
    this.errors = [];
    logger.debug('[CONSOLE_COLLECTOR] Cleared all errors');
  }

  /**
   * Get errors as formatted string
   */
  getFormattedErrors(limit: number = 10): string {
    const recentErrors = this.errors.slice(-limit);
    if (recentErrors.length === 0) {
      return 'No console errors';
    }

    return recentErrors
      .map((error, index) => `${index + 1}. [${error.type}] ${error.text}`)
      .join('\n');
  }
}
