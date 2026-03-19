/**
 * Email Extraction Service — V12
 *
 * AI-powered extraction of structured data from email bodies.
 * Uses the existing OpenAI/Gemini service with dataExtraction model (fast, cheap).
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import type { EmailExtractionResult } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Max characters to send to AI (controls token budget) */
const MAX_EMAIL_BODY_CHARS = 8000;

const SYSTEM_PROMPT = `You are an email content extraction expert for automated testing.
Extract the requested data from the email body.

Rules:
1. Return ONLY valid JSON: { "value": "extracted string", "confidence": 0.0-1.0, "reasoning": "brief explanation" }
2. For OTP/verification codes: extract ONLY the numeric or alphanumeric code, nothing else
3. For verification links: extract the FULL URL including query parameters
4. For confirmation messages: extract the key confirmation text
5. If the data is not found, return { "value": "", "confidence": 0.0, "reasoning": "Not found: ..." }
6. Strip any HTML formatting from the extracted value
7. Do not invent or guess values — only extract what is explicitly present`;

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class EmailExtractService {
  /**
   * Extract data from email body using AI.
   *
   * @param emailBody - Raw HTML or plain text email body
   * @param extractPrompt - What to extract, e.g. "Extract the 6-digit OTP code"
   * @returns Extracted value with confidence and reasoning
   */
  static async extract(emailBody: string, extractPrompt: string): Promise<EmailExtractionResult> {
    try {
      // Prefer plain text, fall back to stripped HTML
      const cleanBody = stripHtml(emailBody).substring(0, MAX_EMAIL_BODY_CHARS);

      if (!cleanBody.trim()) {
        return {
          value: '',
          confidence: 0,
          reasoning: 'Email body is empty',
        };
      }

      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `EMAIL BODY:\n${cleanBody}\n\nEXTRACTION REQUEST: ${extractPrompt}`,
          },
        ],
        {
          model: AI_TASK_MODELS.dataExtraction,
          temperature: 0.1,
          max_tokens: 256,
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(response.content);

      const result: EmailExtractionResult = {
        value: String(parsed.value || '').trim(),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        reasoning: parsed.reasoning,
      };

      logger.info('[EMAIL_EXTRACT] Extraction complete', {
        extractPrompt,
        valueLength: result.value.length,
        confidence: result.confidence,
        bodyLength: cleanBody.length,
      });

      return result;
    } catch (error) {
      logger.error('[EMAIL_EXTRACT] Extraction failed', {
        error: error instanceof Error ? error.message : String(error),
        extractPrompt,
      });

      return {
        value: '',
        confidence: 0,
        reasoning: `Extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML STRIPPER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strip HTML tags and decode common entities.
 * Lightweight regex-based — no dependency needed for test email bodies.
 */
function stripHtml(html: string): string {
  return html
    // Remove style/script blocks
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Replace <br>, <p>, <div>, <tr> with newlines
    .replace(/<\s*(?:br|p|div|tr)[^>]*>/gi, '\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
