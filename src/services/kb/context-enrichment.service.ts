import { logger } from '@/utils/logger';
import { searchKB } from '@/services/kb/kb.service';
import {
  findTracesByUrl,
  extractSelectorsFromTraces,
  formatTracesForPrompt
} from '@/services/utils/trace-context.service';
import { IntentParserContext } from '@/ai/prompts/intentParserPrompt';

/**
 * Enrich context for command generation
 * Gathers information from RAG, traces, and other sources
 */
export async function enrichContextForCommands(
  userMessage: string,
  projectId: string,
  url?: string
): Promise<IntentParserContext> {
  const context: IntentParserContext = {};

  try {
    logger.info('Enriching context for command generation', {
      userMessage: userMessage.substring(0, 50),
      projectId,
      url,
    });

    // Phase 1: RAG Search (documentation)
    try {
      const ragResults = await searchKB(userMessage, projectId, {
        matchCount: 3,
        matchThreshold: 0.6, // Lower threshold for better recall
      });

      if (ragResults.chunks && ragResults.chunks.length > 0) {
        context.documentation = ragResults.chunks.map((chunk: any) =>
          `${chunk.title || ''}\n${chunk.content || ''}`
        );

        logger.info('RAG context found', {
          resultCount: context.documentation?.length || 0
        });
      } else {
        logger.info('No RAG context found for query');
      }
    } catch (ragError) {
      logger.warn('Failed to fetch RAG context', ragError);
      // Continue without RAG context
    }

    // Phase 2: Trace Analysis (if URL provided)
    if (url) {
      try {
        const traces = await findTracesByUrl(url, projectId, 5);

        if (traces && traces.length > 0) {
          // Extract selectors from traces
          const selectors = await extractSelectorsFromTraces(traces);
          context.knownSelectors = selectors;

          // Format traces for prompt
          const tracesContext = formatTracesForPrompt(traces, selectors);
          context.tracesContext = tracesContext;

          logger.info('Trace context found', {
            traceCount: traces.length,
            selectorCount: Object.keys(selectors).length,
          });
        } else {
          logger.info('No traces found for URL', { url });
        }
      } catch (traceError) {
        logger.warn('Failed to fetch trace context', traceError);
        // Continue without trace context
      }
    } else {
      logger.info('No URL provided, skipping trace search');
    }

    // Log final context summary
    const summary = {
      hasDocumentation: !!context.documentation && context.documentation.length > 0,
      documentationCount: context.documentation?.length || 0,
      hasSelectors: !!context.knownSelectors && Object.keys(context.knownSelectors).length > 0,
      selectorCount: context.knownSelectors ? Object.keys(context.knownSelectors).length : 0,
      hasTraceContext: !!context.tracesContext,
    };

    logger.info('Context enrichment completed', summary);

    return context;
  } catch (error) {
    logger.error('Error enriching context', error);
    // Return empty context on error - better than failing completely
    return {};
  }
}

/**
 * Extract URL from user message if present
 */
export function extractUrlFromMessage(message: string): string | null {
  // Try to find URL in message
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const match = message.match(urlRegex);

  if (match && match.length > 0) {
    return match[0];
  }

  // Try to find domain-like patterns
  const domainRegex = /([a-z0-9-]+\.)+[a-z]{2,}/gi;
  const domainMatch = message.match(domainRegex);

  if (domainMatch && domainMatch.length > 0) {
    // Add https:// if missing
    return `https://${domainMatch[0]}`;
  }

  return null;
}

/**
 * Validate and clean URL
 */
export function validateAndCleanUrl(url: string): string | null {
  try {
    // Remove trailing slashes and query params for matching
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}
