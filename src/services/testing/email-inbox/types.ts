/**
 * Email Inbox Types — V12
 *
 * Provider abstraction for future migration (IMAP → Gmail API).
 * Used by wait_for_email IntentStep action type.
 */

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL PROVIDER ABSTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Abstract email provider interface.
 * Current implementation: ImapProvider (imap.gmail.com)
 * Future: GmailApiProvider (Gmail API + Pub/Sub)
 */
export interface EmailProvider {
  /** Search for emails matching the given criteria */
  searchEmails(options: EmailSearchOptions): Promise<EmailMessage[]>;
  /** Delete emails by UID */
  deleteEmails(uids: string[]): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH & MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface EmailSearchOptions {
  /** Full recipient address including suffix, e.g. inbox+testrun-abc@qait.dev */
  recipient: string;
  /** Optional subject substring filter */
  subject?: string;
  /** Optional sender address filter */
  from?: string;
  /** Only return emails received after this date (default: 5 minutes ago) */
  since?: Date;
}

export interface EmailMessage {
  /** Unique identifier (IMAP UID or Gmail message ID) */
  uid: string;
  /** Sender email address */
  from: string;
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject: string;
  /** Reception timestamp */
  date: Date;
  /** Plain text body (may be empty if HTML-only) */
  textBody: string;
  /** Raw HTML body (may be empty if text-only) */
  htmlBody: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL FILTER (for IntentStep integration)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Email filter configuration for wait_for_email step.
 * Stored in IntentStep.options.emailFilter
 */
export interface EmailFilter {
  /** Subject substring to match (case-insensitive) */
  subject?: string;
  /** Sender email address to match */
  from?: string;
  /** AI extraction prompt, e.g. "Extract the 6-digit OTP code" */
  extractPrompt: string;
  /** Variable name to store extracted value — accessible as {{email.<variable>}} */
  extractVariable: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACTION RESULT
// ═══════════════════════════════════════════════════════════════════════════

export interface EmailExtractionResult {
  /** Extracted value (OTP code, verification URL, etc.) */
  value: string;
  /** AI confidence score (0.0 - 1.0) */
  confidence: number;
  /** AI reasoning for the extraction */
  reasoning?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// WAIT FOR EMAIL OPTIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface WaitForEmailOptions {
  /** Full recipient address, e.g. inbox+testrun-abc@qait.dev */
  recipient: string;
  /** Email matching filters */
  filter?: {
    subject?: string;
    from?: string;
  };
  /** AI extraction prompt */
  extractPrompt: string;
  /** Variable name for extracted value */
  extractVariable: string;
  /** Timeout in milliseconds (default: 60_000, max: 180_000) */
  timeoutMs?: number;
  /** Polling interval in milliseconds (default: 3_000) */
  pollIntervalMs?: number;
  /** Abort signal for cancellation support */
  abortSignal?: AbortSignal;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAP CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}
