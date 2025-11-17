import { IntentParserContext } from '@/ai/prompts/index';
import { searchKB } from '@/services/kb/kb.service';
import {
    extractSelectorsFromTraces,
    findTracesByUrl,
    formatTracesForPrompt
} from '@/services/utils/trace-context.service';
import { logger } from '@/utils/logger';

/**
 * Enrich context for command generation
 * Gathers information from RAG, traces, and other sources
 * @param userMessage - User's message
 * @param projectId - Project ID
 * @param url - Optional URL for trace analysis
 * @returns Enriched context with documentation, selectors, and traces
 */
export async function enrichContextForCommands(
  userMessage: string,
  projectId: string,
  url?: string
): Promise<IntentParserContext> {
  // Validate inputs
  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    logger.warn('[CONTEXT_ENRICHMENT] Invalid userMessage', { userMessage: typeof userMessage });
    return {};
  }

  if (!projectId || typeof projectId !== 'string') {
    logger.warn('[CONTEXT_ENRICHMENT] Invalid projectId', { projectId: typeof projectId });
    return {};
  }

  const context: IntentParserContext = {};

  try {
    logger.info('[CONTEXT_ENRICHMENT] Enriching context for command generation', {
      userMessage: userMessage.substring(0, 50),
      projectId,
      url: url ? url.substring(0, 100) : undefined,
    });

    // Phase 1: RAG Search (documentation)
    try {
      const ragResults = await searchKB(userMessage, projectId, {
        matchCount: 3,
        matchThreshold: 0.6, // Lower threshold for better recall
      });

      if (ragResults.chunks && Array.isArray(ragResults.chunks) && ragResults.chunks.length > 0) {
        context.documentation = ragResults.chunks
          .filter((chunk) => chunk && typeof chunk === 'object' && chunk.content)
          .map((chunk) => {
            // KBChunk has source_file or file_name, but not title
            const title = chunk.source_file || chunk.file_name || '';
            const content = chunk.content || '';
            return title ? `${title}\n${content}` : content;
          })
          .filter((doc) => doc.trim().length > 0); // Filter empty docs

        logger.info('[CONTEXT_ENRICHMENT] RAG context found', {
          resultCount: context.documentation.length,
        });
      } else {
        logger.info('[CONTEXT_ENRICHMENT] No RAG context found for query');
      }
    } catch (ragError) {
      logger.warn('[CONTEXT_ENRICHMENT] Failed to fetch RAG context', {
        error: ragError instanceof Error ? ragError.message : String(ragError),
      });
      // Continue without RAG context
    }

    // Phase 2: Trace Analysis (if URL provided)
    if (url && typeof url === 'string' && url.trim().length > 0) {
      try {
        // Validate URL format
        try {
          new URL(url);
        } catch {
          logger.warn('[CONTEXT_ENRICHMENT] Invalid URL format', { url: url.substring(0, 100) });
          // Continue without trace context
        }

        const traces = await findTracesByUrl(url, projectId, 5);

        if (traces && Array.isArray(traces) && traces.length > 0) {
          // Extract selectors from traces
          const selectors = await extractSelectorsFromTraces(traces);

          if (selectors && typeof selectors === 'object') {
            context.knownSelectors = selectors;

            // Format traces for prompt
            const tracesContext = formatTracesForPrompt(traces, selectors);
            context.tracesContext = tracesContext;

            logger.info('[CONTEXT_ENRICHMENT] Trace context found', {
              traceCount: traces.length,
              selectorCount: Object.keys(selectors).length,
            });
          } else {
            logger.warn('[CONTEXT_ENRICHMENT] Failed to extract selectors from traces');
          }
        } else {
          logger.info('[CONTEXT_ENRICHMENT] No traces found for URL', { url: url.substring(0, 100) });
        }
      } catch (traceError) {
        logger.warn('[CONTEXT_ENRICHMENT] Failed to fetch trace context', {
          error: traceError instanceof Error ? traceError.message : String(traceError),
          url: url.substring(0, 100),
        });
        // Continue without trace context
      }
    } else {
      logger.debug('[CONTEXT_ENRICHMENT] No URL provided, skipping trace search');
    }

    // Log final context summary
    const summary = {
      hasDocumentation: !!context.documentation && context.documentation.length > 0,
      documentationCount: context.documentation?.length || 0,
      hasSelectors: !!context.knownSelectors && Object.keys(context.knownSelectors).length > 0,
      selectorCount: context.knownSelectors ? Object.keys(context.knownSelectors).length : 0,
      hasTraceContext: !!context.tracesContext,
    };

    logger.info('[CONTEXT_ENRICHMENT] Context enrichment completed', summary);

    return context;
  } catch (error) {
    logger.error('[CONTEXT_ENRICHMENT] Error enriching context', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      hasUrl: !!url,
    });
    // Return empty context on error - better than failing completely
    return {};
  }
}

/**
 * Extract URL from user message if present
 * @param message - User message to search for URL
 * @returns Extracted URL or null if not found
 */
export function extractUrlFromMessage(message: string): string | null {
  // Validate input
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return null;
  }

  // Try to find URL in message (http/https)
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const match = message.match(urlRegex);

  if (match && match.length > 0) {
    const url = match[0].replace(/[.,;!?]+$/, ''); // Remove trailing punctuation
    try {
      // Validate URL
      new URL(url);
      return url;
    } catch {
      // Invalid URL, try next method
    }
  }

  // Try to find domain-like patterns (e.g., example.com)
  const domainRegex = /\b([a-z0-9-]+\.)+[a-z]{2,}\b/gi;
  const domainMatch = message.match(domainRegex);

  if (domainMatch && domainMatch.length > 0) {
    const domain = domainMatch[0];
    try {
      // Add https:// if missing and validate
      const url = `https://${domain}`;
      new URL(url);
      return url;
    } catch {
      // Invalid domain
      return null;
    }
  }

  return null;
}

/**
 * Validate and clean URL
 * Removes trailing slashes, query params, and fragments for consistent matching
 * @param url - URL to validate and clean
 * @returns Cleaned URL or null if invalid
 */
export function validateAndCleanUrl(url: string): string | null {
  // Validate input
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return null;
  }

  try {
    // Remove trailing slashes and query params for matching
    const urlObj = new URL(url.trim());
    const cleaned = `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`.replace(/\/$/, '');

    // Validate cleaned URL is not empty
    if (cleaned.length === 0) {
      return null;
    }

    return cleaned;
  } catch {
    logger.debug('[CONTEXT_ENRICHMENT] Invalid URL format', { url: url.substring(0, 100) });
    return null;
  }
}
