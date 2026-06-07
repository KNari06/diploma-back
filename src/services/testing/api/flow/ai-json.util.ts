/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI JSON HELPERS (shared across flow services)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Small helpers shared by the dependency-resolver pipeline and the Python
 * import adapter: tolerant JSON extraction from LLM output, and a retry
 * wrapper around the chat-completion client. Kept here so there is exactly one
 * copy (DRY) — both consumers import from this module.
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';

/**
 * Extract JSON from an AI response that may contain reasoning text around it.
 * Gemini 2.5 Flash with thinking mode often returns text before/after JSON,
 * or wraps it in a markdown code block.
 * @returns the parsed object, or null if no JSON could be recovered.
 */
export function extractJson(content: string): any {
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // no-op
  }

  // Try to find JSON object in the content
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1));
    } catch {
      // no-op
    }
  }

  // Try to find JSON inside markdown code block
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // no-op
    }
  }

  return null;
}

/**
 * Call the chat-completion client with bounded retries and backoff.
 * Returns the raw response content (caller is responsible for extractJson).
 * @throws if all attempts fail.
 */
export async function callAiWithRetry(
  messages: Array<{ role: string; content: string }>,
  options: any,
  agentName: string,
  retryCount: number = 1,
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const response = await getChatCompletionWithMessages(messages as any, options);
      return response.content;
    } catch (err: any) {
      lastError = err;
      logger.warn(`[AI_JSON] ${agentName} attempt ${attempt + 1} failed`, {
        error: err.message,
        willRetry: attempt < retryCount,
      });
      if (attempt < retryCount) {
        await new Promise(r => setTimeout(r, 2000)); // 2s backoff
      }
    }
  }

  throw new Error(`${agentName} failed after ${retryCount + 1} attempts: ${lastError?.message}`);
}
