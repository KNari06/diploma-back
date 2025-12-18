/**
 * Prompt Utilities
 * Helper functions for prompt processing: JSON parsing, token management, PII masking
 */

import { logger } from '@/utils/core/logger';
import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════
// ROBUST JSON PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 1: Robust JSON parsing with fallback extraction
 * Handles cases where LLM returns text + JSON or invalid JSON
 * @param content - Raw LLM response
 * @param schema - Optional Zod schema for validation
 * @param retryPrompt - Optional retry prompt if parsing fails
 * @returns Parsed and validated JSON object
 */
export function parseRobustJSON<T>(
  content: string,
  schema?: z.ZodSchema<T>,
  options: {
    retryPrompt?: string;
    logRawResponse?: boolean;
  } = {}
): T {
  const { logRawResponse = true } = options;

  // Log raw response for debugging (truncated)
  if (logRawResponse) {
    logger.debug('[PROMPT_UTILS] Raw LLM response', {
      preview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
      length: content.length,
    });
  }

  // Try direct parse first
  try {
    const parsed = JSON.parse(content);
    if (schema) {
      const validated = schema.parse(parsed);
      return validated;
    }
    return parsed as T;
  } catch (directError) {
    logger.warn('[PROMPT_UTILS] Direct JSON parse failed, trying extraction', {
      error: directError instanceof Error ? directError.message : String(directError),
    });
  }

  // Try to extract JSON from markdown code blocks
  const jsonBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (schema) {
        const validated = schema.parse(parsed);
        logger.info('[PROMPT_UTILS] Successfully extracted JSON from markdown block');
        return validated;
      }
      logger.info('[PROMPT_UTILS] Successfully extracted JSON from markdown block');
      return parsed as T;
    } catch (blockError) {
      logger.warn('[PROMPT_UTILS] Markdown block extraction failed', {
        error: blockError instanceof Error ? blockError.message : String(blockError),
      });
    }
  }

  // Try to find first { ... } in content
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (schema) {
        const validated = schema.parse(parsed);
        logger.info('[PROMPT_UTILS] Successfully extracted JSON from content');
        return validated;
      }
      logger.info('[PROMPT_UTILS] Successfully extracted JSON from content');
      return parsed as T;
    } catch (matchError) {
      logger.warn('[PROMPT_UTILS] Content extraction failed', {
        error: matchError instanceof Error ? matchError.message : String(matchError),
      });
    }
  }

  // All attempts failed
  const errorMsg = `Failed to parse JSON from LLM response. Content preview: ${content.substring(0, 200)}...`;
  logger.error('[PROMPT_UTILS] JSON parsing failed completely', {
    contentPreview: content.substring(0, 500),
    contentLength: content.length,
  });
  throw new Error(errorMsg);
}

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 2: Truncate string to max characters (token approximation)
 * @param str - String to truncate
 * @param maxChars - Maximum characters (1 token ≈ 4 chars)
 * @returns Truncated string
 */
export function truncateString(str: string, maxChars: number): string {
  if (!str || str.length <= maxChars) return str;
  return str.substring(0, maxChars) + '\n... (truncated)';
}

/**
 * ✅ FIX 2: Truncate object keys to limit context size
 * @param obj - Object to truncate
 * @param maxLength - Maximum length per string value
 * @returns Truncated object
 */
export function truncateObject(obj: any, maxLength: number = 1000): any {
  if (!obj) return obj;
  if (typeof obj === 'string') return truncateString(obj, maxLength);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => truncateObject(item, maxLength));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = truncateString(value, maxLength);
    } else if (typeof value === 'object') {
      result[key] = truncateObject(value, maxLength);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * ✅ FIX 2: Estimate token count (rough approximation)
 * @param text - Text to estimate
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough approximation: 1 token ≈ 4 characters
  // More accurate for English, less for other languages
  return Math.ceil(text.length / 4);
}

/**
 * ✅ FIX 2: Filter elements by priority
 * @param elements - Array of elements with priority field
 * @param maxCount - Maximum number of elements to return
 * @returns Filtered elements (priority order: critical > high > medium > low)
 */
export function filterByPriority<T extends { priority?: string }>(
  elements: T[],
  maxCount: number
): T[] {
  if (!elements || elements.length <= maxCount) return elements;

  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

  const sorted = [...elements].sort((a, b) => {
    const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] ?? priorityOrder.unknown;
    const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] ?? priorityOrder.unknown;
    return aPriority - bPriority;
  });

  return sorted.slice(0, maxCount);
}

// ═══════════════════════════════════════════════════════════════════════════
// PII MASKING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 4: Mask PII (emails, phones, tokens, cards) before sending to LLM
 * @param text - Text to mask
 * @returns Masked text
 */
export function maskPII(text: string): string {
  if (!text) return '';

  let masked = text;

  // Mask emails: test@example.com → [EMAIL]
  masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

  // Mask phone numbers: +1234567890, (123) 456-7890, etc.
  masked = masked.replace(/[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}/g, '[PHONE]');

  // Mask tokens/keys (long alphanumeric strings > 20 chars)
  masked = masked.replace(/[a-zA-Z0-9_-]{32,}/g, '[TOKEN]');

  // Mask credit card numbers (basic pattern)
  masked = masked.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]');

  // Mask API keys (common patterns)
  masked = masked.replace(/\b(sk|pk|api)_[a-zA-Z0-9]{20,}\b/gi, '[API_KEY]');

  // Mask JWT tokens (header.payload.signature)
  masked = masked.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[JWT]');

  return masked;
}

/**
 * ✅ FIX 4: Redact PII from vision context (screenshots + HTML)
 * @param visionContext - Vision analysis context
 * @returns Redacted context
 */
export function redactVisionPII(visionContext: {
  html?: string;
  screenshot?: string; // base64 or URL
  description?: string;
}): typeof visionContext {
  return {
    html: visionContext.html ? maskPII(visionContext.html) : undefined,
    screenshot: visionContext.screenshot, // Keep screenshot as-is (visual PII harder to mask programmatically)
    description: visionContext.description ? maskPII(visionContext.description) : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RETRY LOGIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 1: Build retry prompt for invalid JSON responses
 * @param originalPrompt - Original prompt that failed
 * @param errorMessage - Error message from parsing
 * @returns Retry prompt
 */
export function buildRetryPrompt(originalPrompt: string, errorMessage: string): string {
  return `${originalPrompt}

IMPORTANT: Your previous response was invalid JSON.
Error: ${errorMessage}

Please return ONLY valid JSON now. Do not add any extra text, explanations, or markdown formatting.
Just return the raw JSON object.`;
}
