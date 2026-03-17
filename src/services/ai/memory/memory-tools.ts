import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { WorkspaceMemoryService, type MemoryCategory } from './workspace-memory.service';
import { logger } from '@/utils/core/logger';
import type { SkillResult } from '@/services/skills/types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MEMORY TOOLS (OpenAI Function Calling)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three memory tools for the agent to use during conversations:
 * 1. remember_fact - Save a fact to workspace memory
 * 2. search_memory - Search workspace memory semantically
 * 3. forget_fact - Remove a memory by key
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Memory tool definitions for OpenAI function calling
 */
export const MEMORY_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save an important fact, preference, or context to workspace memory for future conversations. Use this when the user shares important information that should be remembered.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Unique key for this memory (e.g., "jira_default_project", "preferred_browser"). Use lowercase with underscores.',
          },
          content: {
            type: 'string',
            description: 'The content to remember (e.g., "User prefers Chrome browser for testing").',
          },
          category: {
            type: 'string',
            enum: ['fact', 'preference', 'test_pattern', 'integration_context'],
            description: 'Category: fact (general info), preference (user settings), test_pattern (common scenarios), integration_context (Jira/GitHub context).',
          },
        },
        required: ['key', 'content', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search workspace memory for relevant information using semantic search. Use this to recall past conversations or context.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query to search for (e.g., "What is the default Jira project?")',
          },
          category: {
            type: 'string',
            enum: ['fact', 'preference', 'test_pattern', 'integration_context'],
            description: 'Optional category filter to narrow search.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Remove a memory from workspace storage. Use this when information becomes outdated or user asks to forget something.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The key of the memory to forget (e.g., "jira_default_project").',
          },
        },
        required: ['key'],
      },
    },
  },
];

/**
 * Execute a memory tool function
 */
export async function executeMemoryTool(
  toolName: string,
  args: Record<string, any>,
  workspaceId: string,
  userId: string
): Promise<SkillResult> {
  logger.info('[MEMORY_TOOLS] Executing tool', {
    toolName,
    workspaceId,
    userId,
    args: JSON.stringify(args),
  });

  try {
    switch (toolName) {
      case 'remember_fact':
        return await rememberFact(args, workspaceId, userId);

      case 'search_memory':
        return await searchMemory(args, workspaceId);

      case 'forget_fact':
        return await forgetFact(args, workspaceId);

      default:
        logger.error('[MEMORY_TOOLS] Unknown tool', { toolName });
        return {
          success: false,
          message: `Unknown memory tool: ${toolName}`,
          displayToUser: false,
        };
    }
  } catch (error) {
    logger.error('[MEMORY_TOOLS] Tool execution error', {
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * remember_fact implementation
 */
async function rememberFact(
  args: Record<string, any>,
  workspaceId: string,
  userId: string
): Promise<SkillResult> {
  const { key, content, category } = args;

  // Validate inputs
  if (!key || !content || !category) {
    return {
      success: false,
      message: 'Missing required parameters: key, content, category',
      displayToUser: false,
    };
  }

  try {
    const memory = await WorkspaceMemoryService.writeMemory(
      workspaceId,
      userId,
      key,
      content,
      category as MemoryCategory,
      'agent_written',
      {},
      1.0
    );

    logger.info('[MEMORY_TOOLS] Fact remembered', {
      memoryId: memory.id,
      key,
      category,
    });

    return {
      success: true,
      data: { memoryId: memory.id, key, category },
      message: `I've remembered this: [${category}] ${key}`,
      displayToUser: false, // Don't clutter user view
    };
  } catch (error) {
    logger.error('[MEMORY_TOOLS] Failed to remember fact', {
      error: error instanceof Error ? error.message : String(error),
      key,
    });

    return {
      success: false,
      message: `Failed to remember: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * search_memory implementation
 */
async function searchMemory(
  args: Record<string, any>,
  workspaceId: string
): Promise<SkillResult> {
  const { query, category } = args;

  // Validate inputs
  if (!query) {
    return {
      success: false,
      message: 'Missing required parameter: query',
      displayToUser: false,
    };
  }

  try {
    const results = await WorkspaceMemoryService.searchMemory(
      workspaceId,
      query,
      category as MemoryCategory | undefined,
      5, // Match count
      0.5 // Threshold
    );

    logger.info('[MEMORY_TOOLS] Memory search completed', {
      query,
      resultsCount: results.length,
    });

    if (results.length === 0) {
      return {
        success: true,
        data: { results: [] },
        message: 'No relevant memories found.',
        displayToUser: false,
      };
    }

    // Format results for AI
    const formatted = results.map(r => ({
      key: r.key,
      content: r.content,
      category: r.category,
      similarity: r.similarity,
      created_at: r.created_at,
    }));

    const resultText = formatted
      .map(r => `[${r.category}] ${r.key}: ${r.content} (similarity: ${r.similarity.toFixed(2)})`)
      .join('\n');

    return {
      success: true,
      data: { results: formatted },
      message: `Found ${results.length} relevant memories:\n${resultText}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[MEMORY_TOOLS] Failed to search memory', {
      error: error instanceof Error ? error.message : String(error),
      query,
    });

    return {
      success: false,
      message: `Failed to search memory: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * forget_fact implementation
 */
async function forgetFact(
  args: Record<string, any>,
  workspaceId: string
): Promise<SkillResult> {
  const { key } = args;

  // Validate inputs
  if (!key) {
    return {
      success: false,
      message: 'Missing required parameter: key',
      displayToUser: false,
    };
  }

  try {
    const deleted = await WorkspaceMemoryService.deleteMemory(workspaceId, key);

    logger.info('[MEMORY_TOOLS] Fact forgotten', { key, deleted });

    return {
      success: true,
      data: { key, deleted },
      message: deleted ? `I've forgotten: ${key}` : `Memory not found: ${key}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[MEMORY_TOOLS] Failed to forget fact', {
      error: error instanceof Error ? error.message : String(error),
      key,
    });

    return {
      success: false,
      message: `Failed to forget: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}
