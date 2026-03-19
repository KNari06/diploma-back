/**
 * Email Inbox Service — V12 (Facade)
 *
 * High-level facade for email inbox functionality:
 * - Address generation (plus-addressing)
 * - Wait for email with polling + AI extraction
 * - Cleanup
 *
 * Used by wait_for_email IntentStep handler in preview-step-apply.service.ts
 */

import { logger } from '@/utils/core/logger';
import { createImapProvider } from './imap-provider.service';
import { EmailExtractService } from './email-extract.service';
import type { EmailProvider, WaitForEmailOptions, EmailExtractionResult, EmailMessage } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Default polling interval (ms) */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Default timeout for waiting for email (ms) */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Maximum allowed timeout (ms) */
const MAX_TIMEOUT_MS = 180_000;

/** Email address prefix for test inboxes */
const INBOX_PREFIX = 'inbox';

/** Domain for test email addresses */
const INBOX_DOMAIN = process.env.IMAP_USER?.split('@')[1] || 'qait.dev';

/** Full user part of the catch-all account */
const INBOX_USER = process.env.IMAP_USER?.split('@')[0] || 'inbox';

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class EmailInboxService {
  private static provider: EmailProvider | null = null;

  /**
   * Get or create the email provider (lazy singleton).
   * Returns null if IMAP is not configured.
   */
  private static getProvider(): EmailProvider | null {
    if (!this.provider) {
      this.provider = createImapProvider();
    }
    return this.provider;
  }

  /**
   * Check if email inbox is configured and available.
   */
  static isConfigured(): boolean {
    return !!process.env.IMAP_USER && !!process.env.IMAP_PASSWORD;
  }

  /**
   * Generate a unique inbox address for a test run.
   * Uses plus-addressing: inbox+testrun-{id}@qait.dev
   *
   * @param testRunId - Unique identifier for the test run (session ID, UUID, etc.)
   * @returns Full email address, e.g. inbox+testrun-abc123@qait.dev
   */
  static generateAddress(testRunId: string): string {
    // Sanitize testRunId: only allow alphanumeric, hyphens, underscores
    const safeId = testRunId.replace(/[^a-zA-Z0-9_-]/g, '');
    return `${INBOX_USER}+testrun-${safeId}@${INBOX_DOMAIN}`;
  }

  /**
   * Wait for an email matching the criteria, then extract data via AI.
   *
   * Polling loop:
   * 1. Search IMAP for emails TO the recipient address
   * 2. Apply optional subject/from filters
   * 3. On match → AI extraction → return result
   * 4. On no match → wait pollIntervalMs → retry
   * 5. On timeout → throw error
   *
   * @returns Extracted data (OTP, link, etc.) with confidence
   * @throws Error if timeout or IMAP not configured
   */
  static async waitForEmail(options: WaitForEmailOptions): Promise<EmailExtractionResult> {
    const provider = this.getProvider();
    if (!provider) {
      throw new Error('Email inbox not configured. Set IMAP_USER and IMAP_PASSWORD environment variables.');
    }

    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startTime = Date.now();
    // Search for emails received after now minus 2 minutes (safety window for email delivery delay)
    const sinceDate = new Date(startTime - 2 * 60 * 1000);

    logger.info('[EMAIL_INBOX] Starting wait for email', {
      recipient: options.recipient,
      subject: options.filter?.subject,
      from: options.filter?.from,
      extractPrompt: options.extractPrompt,
      timeoutMs,
      pollIntervalMs,
    });

    let attempts = 0;

    while (Date.now() - startTime < timeoutMs) {
      // Check abort signal
      if (options.abortSignal?.aborted) {
        throw new Error('Email wait cancelled');
      }

      attempts++;

      try {
        const emails = await provider.searchEmails({
          recipient: options.recipient,
          subject: options.filter?.subject,
          from: options.filter?.from,
          since: sinceDate,
        });

        if (emails.length > 0) {
          // Take the most recent matching email
          const email = emails[emails.length - 1];

          logger.info('[EMAIL_INBOX] Email found, extracting data', {
            recipient: options.recipient,
            emailSubject: email.subject,
            emailFrom: email.from,
            attempt: attempts,
            elapsedMs: Date.now() - startTime,
          });

          // Extract data via AI
          const body = email.textBody || email.htmlBody || '';
          const result = await EmailExtractService.extract(body, options.extractPrompt);

          // Cleanup: delete matched email(s) immediately
          try {
            const uidsToDelete = emails.map(e => e.uid);
            await provider.deleteEmails(uidsToDelete);
          } catch (cleanupError) {
            // Non-fatal: log and continue
            logger.warn('[EMAIL_INBOX] Email cleanup failed (non-fatal)', {
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          }

          logger.info('[EMAIL_INBOX] Extraction complete', {
            recipient: options.recipient,
            extractVariable: options.extractVariable,
            valueLength: result.value.length,
            confidence: result.confidence,
            attempts,
            totalMs: Date.now() - startTime,
          });

          return result;
        }
      } catch (searchError) {
        // Log but continue polling — transient IMAP errors shouldn't abort the wait
        logger.warn('[EMAIL_INBOX] Search attempt failed, retrying', {
          error: searchError instanceof Error ? searchError.message : String(searchError),
          attempt: attempts,
          recipient: options.recipient,
        });
      }

      // Wait before next poll
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollIntervalMs);

        // Support cancellation during sleep
        if (options.abortSignal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('Email wait cancelled'));
          };
          options.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    // Timeout reached
    const elapsed = Date.now() - startTime;
    logger.warn('[EMAIL_INBOX] Timeout waiting for email', {
      recipient: options.recipient,
      timeoutMs,
      attempts,
      elapsedMs: elapsed,
    });

    throw new Error(
      `Email not received within ${Math.round(timeoutMs / 1000)}s ` +
      `(checked ${attempts} times). Recipient: ${options.recipient}`
    );
  }

  /**
   * Cleanup all emails for a test run.
   * Called in finally block of runStepsOnPreview() or after test completion.
   *
   * @param recipient - Full inbox address to clean up
   */
  static async cleanupEmails(recipient: string): Promise<void> {
    const provider = this.getProvider();
    if (!provider) return;

    try {
      const emails = await provider.searchEmails({
        recipient,
        since: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      });

      if (emails.length > 0) {
        await provider.deleteEmails(emails.map(e => e.uid));
        logger.info('[EMAIL_INBOX] Cleanup completed', {
          recipient,
          deletedCount: emails.length,
        });
      }
    } catch (error) {
      // Non-fatal cleanup error
      logger.warn('[EMAIL_INBOX] Cleanup failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
        recipient,
      });
    }
  }

  /**
   * List emails for a given address (for debugging / API endpoint).
   *
   * @param recipient - Full inbox address
   * @param since - Only return emails after this date
   * @returns Array of email messages
   */
  static async listEmails(recipient: string, since?: Date): Promise<EmailMessage[]> {
    const provider = this.getProvider();
    if (!provider) {
      throw new Error('Email inbox not configured. Set IMAP_USER and IMAP_PASSWORD environment variables.');
    }

    return provider.searchEmails({
      recipient,
      since: since ?? new Date(Date.now() - 60 * 60 * 1000), // Default: last 1 hour
    });
  }
}
