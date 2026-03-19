/**
 * ═══════════════════════════════════════════════════════════════════════════
 * KNOWLEDGE BASE SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Allows the AI agent to actively search the project's Knowledge Base
 * when automatic (passive) KB injection didn't return relevant results,
 * or when the user asks a more specific follow-up question.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import { searchKB } from '@/services/kb/kb.service';
import { logger } from '@/utils/core/logger';

const KB_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'kb_search',
      description:
        'Search the project Knowledge Base for specific information. Use when the user asks about their product, project documentation, requirements, specs, or any domain-specific question. The KB contains documents the user has uploaded (PDF, DOCX, TXT, MD). Use a focused, specific query — not the full user message. If the initial automatic KB context was insufficient, call this with a more targeted query.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'A focused search query to find relevant documentation. Be specific — use key terms from the user\'s question. Example: "authentication flow" instead of "tell me about auth".',
          },
        },
        required: ['query'],
      },
    },
  },
];

async function handleSearch(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const { query } = args;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return {
      success: false,
      message: 'A search query is required.',
      displayToUser: true,
    };
  }

  try {
    const results = await searchKB(query, context.projectId, {
      matchThreshold: 0.4,
      matchCount: 5,
    });

    if (results.chunks.length === 0) {
      return {
        success: true,
        data: { chunks: [], sources: [] },
        message:
          'No relevant documentation found in the Knowledge Base for this query. The user may need to upload relevant documents first.',
        displayToUser: true,
      };
    }

    // Format chunks with source attribution
    const formattedChunks = results.chunks.map((chunk) => ({
      content: chunk.content,
      source: chunk.source_file || chunk.file_name || 'unknown',
      similarity: chunk.similarity ? Math.round(chunk.similarity * 100) / 100 : undefined,
    }));

    const allSources = [...results.sources.project, ...results.sources.global];

    logger.info('[KB_SKILL] Search completed', {
      query: query.substring(0, 50),
      resultsCount: formattedChunks.length,
      sources: allSources,
    });

    return {
      success: true,
      data: {
        chunks: formattedChunks,
        sources: allSources,
      },
      message: `Found ${formattedChunks.length} relevant document sections from: ${allSources.join(', ') || 'Knowledge Base'}.`,
      displayToUser: false, // AI should synthesize the answer, not show raw results
    };
  } catch (error) {
    logger.error('[KB_SKILL] Search failed', {
      error: error instanceof Error ? error.message : String(error),
      query: query.substring(0, 50),
    });
    return {
      success: false,
      message: 'Knowledge Base search failed. Please try again.',
      displayToUser: true,
    };
  }
}

export const KBSkill: SkillDefinition = {
  id: 'kb',
  name: 'Knowledge Base',
  provider: 'kb',
  description:
    'Search project documentation uploaded by the user (PDF, DOCX, TXT, MD). Use when the user asks about their product, project requirements, specs, or domain-specific questions.',

  tools: KB_TOOLS,

  // Always available — search works even with no documents (returns empty)
  isAvailable: async () => true,

  execute: async (toolName, args, context) => {
    if (toolName === 'kb_search') {
      return handleSearch(args, context);
    }

    return {
      success: false,
      message: `Unknown KB tool: ${toolName}`,
      displayToUser: false,
    };
  },
};

export default KBSkill;
