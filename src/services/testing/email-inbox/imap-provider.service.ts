/**
 * IMAP Email Provider — V12
 *
 * Implements EmailProvider using ImapFlow (imap.gmail.com).
 * Per-call connection pattern: connect → operate → disconnect.
 * Avoids stale connections and stays within Gmail's 15 concurrent connection limit.
 *
 * Plus-addressing: inbox+suffix@qait.dev → all arrive in inbox@qait.dev mailbox.
 */

import { ImapFlow } from 'imapflow';
import { logger } from '@/utils/core/logger';
import type { EmailProvider, EmailSearchOptions, EmailMessage, ImapConfig } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// IMAP PROVIDER
// ═══════════════════════════════════════════════════════════════════════════

export class ImapProvider implements EmailProvider {
  private config: ImapConfig;

  constructor(config: ImapConfig) {
    this.config = config;
  }

  /**
   * Create ImapFlow client from config.
   * Each call creates a fresh connection to avoid stale/idle issues.
   */
  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.user,
        pass: this.config.password,
      },
      logger: false, // Suppress ImapFlow internal logging (we use our own logger)
      greetingTimeout: 10_000,  // 10s to establish connection
      socketTimeout: 30_000,    // 30s for socket operations
    });
  }

  /**
   * Search for emails matching the given criteria.
   * Connects to IMAP, searches by recipient TO header + optional filters, fetches bodies, disconnects.
   */
  async searchEmails(options: EmailSearchOptions): Promise<EmailMessage[]> {
    const client = this.createClient();
    const results: EmailMessage[] = [];

    try {
      await client.connect();

      // Open INBOX in read-only mode for searching
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Build IMAP search query
        const searchQuery: Record<string, any> = {
          to: options.recipient,
        };

        if (options.since) {
          searchQuery.since = options.since;
        }

        // Search for matching messages
        const uids: number[] = [];
        // ImapFlow search returns a list of sequence numbers or UIDs
        for await (const msg of client.fetch(
          {
            to: options.recipient,
            ...(options.since ? { since: options.since } : {}),
          },
          {
            uid: true,
            envelope: true,
            source: true,
          },
          { uid: true }
        )) {
          // Apply additional filters (subject, from)
          const envelope = msg.envelope;
          if (!envelope) continue;

          const fromAddress = envelope.from?.[0]?.address || '';
          const subject = envelope.subject || '';
          const toAddresses = (envelope.to || []).map((a: any) => a.address?.toLowerCase() || '');

          // Verify recipient matches (case-insensitive)
          if (!toAddresses.some((addr: string) => addr === options.recipient.toLowerCase())) {
            continue;
          }

          // Apply optional subject filter (substring, case-insensitive)
          if (options.subject && !subject.toLowerCase().includes(options.subject.toLowerCase())) {
            continue;
          }

          // Apply optional from filter (exact match, case-insensitive)
          if (options.from && fromAddress.toLowerCase() !== options.from.toLowerCase()) {
            continue;
          }

          // Parse email body from raw source
          const source = msg.source?.toString('utf-8') || '';
          const { textBody, htmlBody } = this.parseEmailBody(source);

          results.push({
            uid: String(msg.uid),
            from: fromAddress,
            to: options.recipient,
            subject,
            date: envelope.date ? new Date(envelope.date) : new Date(),
            textBody,
            htmlBody,
          });
        }

        logger.info('[IMAP_PROVIDER] Search completed', {
          recipient: options.recipient,
          found: results.length,
          subject: options.subject,
          from: options.from,
        });
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('[IMAP_PROVIDER] Search failed', {
        error: error instanceof Error ? error.message : String(error),
        recipient: options.recipient,
      });
      throw error;
    } finally {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
    }

    return results;
  }

  /**
   * Delete emails by UID.
   * Connects, flags as deleted, expunges, disconnects.
   */
  async deleteEmails(uids: string[]): Promise<void> {
    if (uids.length === 0) return;

    const client = this.createClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Convert string UIDs to number range for ImapFlow
        const uidNumbers = uids.map(Number).filter(n => !isNaN(n));
        if (uidNumbers.length === 0) return;

        // Mark as deleted and expunge
        await client.messageDelete(uidNumbers.join(','), { uid: true });

        logger.info('[IMAP_PROVIDER] Deleted emails', { count: uidNumbers.length });
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('[IMAP_PROVIDER] Delete failed', {
        error: error instanceof Error ? error.message : String(error),
        uids,
      });
      throw error;
    } finally {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
    }
  }

  /**
   * Parse email body from raw MIME source.
   * Extracts plain text and HTML parts.
   * Simple parser — handles common single-part and multipart/alternative messages.
   */
  private parseEmailBody(source: string): { textBody: string; htmlBody: string } {
    let textBody = '';
    let htmlBody = '';

    // Check for multipart
    const boundaryMatch = source.match(/boundary="?([^"\r\n;]+)"?/i);

    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = source.split(`--${boundary}`);

      for (const part of parts) {
        const contentTypeMatch = part.match(/Content-Type:\s*([^;\r\n]+)/i);
        if (!contentTypeMatch) continue;

        const contentType = contentTypeMatch[1].trim().toLowerCase();
        // Get body after double newline (headers end)
        const bodyStart = part.indexOf('\r\n\r\n');
        if (bodyStart === -1) continue;

        let body = part.substring(bodyStart + 4);
        // Remove trailing boundary markers
        body = body.replace(/--\s*$/, '').trim();

        // Handle transfer encoding
        const encodingMatch = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
        const encoding = encodingMatch?.[1]?.toLowerCase();

        if (encoding === 'base64') {
          try {
            body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
          } catch {
            // Keep raw body on decode failure
          }
        } else if (encoding === 'quoted-printable') {
          body = this.decodeQuotedPrintable(body);
        }

        if (contentType.includes('text/plain') && !textBody) {
          textBody = body;
        } else if (contentType.includes('text/html') && !htmlBody) {
          htmlBody = body;
        }
      }
    } else {
      // Single-part email
      const bodyStart = source.indexOf('\r\n\r\n');
      if (bodyStart !== -1) {
        const body = source.substring(bodyStart + 4);
        const contentTypeMatch = source.match(/Content-Type:\s*([^;\r\n]+)/i);
        const contentType = contentTypeMatch?.[1]?.trim().toLowerCase() || 'text/plain';

        if (contentType.includes('text/html')) {
          htmlBody = body;
        } else {
          textBody = body;
        }
      }
    }

    return { textBody, htmlBody };
  }

  /**
   * Decode quoted-printable encoding.
   */
  private decodeQuotedPrintable(input: string): string {
    return input
      .replace(/=\r?\n/g, '') // Soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create ImapProvider from environment variables.
 * Returns null if IMAP is not configured.
 */
export function createImapProvider(): ImapProvider | null {
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (!user || !password) {
    logger.warn('[IMAP_PROVIDER] IMAP_USER or IMAP_PASSWORD not configured — email inbox disabled');
    return null;
  }

  return new ImapProvider({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT) || 993,
    user,
    password,
    secure: true,
  });
}
