import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getNotionToken,
  createPage,
  searchPages,
  updatePage,
  addToDatabase,
} from '@/services/api/notion.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTION SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Notion integration for page and database management.
 * Provides: create page, search, update, add to database
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Notion skill tools
 */
const NOTION_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'notion_create_page',
      description: 'Create a new Notion page. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          parent_id: {
            type: 'string',
            description: 'Parent page ID or database ID where the page will be created',
          },
          title: {
            type: 'string',
            description: 'Page title',
          },
          content: {
            type: 'string',
            description: 'Page content (optional, will be split into paragraphs)',
          },
        },
        required: ['parent_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notion_search',
      description: 'Search Notion pages by query text.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query text',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notion_update_page',
      description: 'Update properties of an existing Notion page. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          page_id: {
            type: 'string',
            description: 'Page ID to update',
          },
          properties: {
            type: 'object',
            description: 'Properties to update (Notion-formatted properties object)',
          },
        },
        required: ['page_id', 'properties'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notion_add_to_database',
      description: 'Add a new entry to a Notion database. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          database_id: {
            type: 'string',
            description: 'Database ID to add entry to',
          },
          properties: {
            type: 'object',
            description: 'Properties for the new database entry (Notion-formatted)',
          },
        },
        required: ['database_id', 'properties'],
      },
    },
  },
];

/**
 * Notion skill definition
 */
export const NotionSkill: SkillDefinition = {
  id: 'notion',
  name: 'Notion',
  provider: 'notion',
  description: 'Create pages, search content, update properties, and manage Notion databases. Connect your Notion workspace to enable.',
  tools: NOTION_TOOLS,

  /**
   * Check if user has connected Notion
   */
  async isAvailable(context: SkillContext): Promise<boolean> {
    try {
      const token = await getNotionToken(context.userId);
      return token !== null;
    } catch (error) {
      logger.error('[NOTION_SKILL] Error checking availability', {
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
      });
      return false;
    }
  },

  /**
   * Execute a Notion tool
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[NOTION_SKILL] Executing tool', {
      toolName,
      args: JSON.stringify(args),
      userId: context.userId,
    });

    try {
      // Get Notion token
      const tokenData = await getNotionToken(context.userId);
      if (!tokenData) {
        return {
          success: false,
          message: 'Notion integration not connected. Please connect your Notion workspace first.',
          displayToUser: true,
        };
      }

      const accessToken = tokenData.access_token;

      // Route to appropriate handler
      switch (toolName) {
        case 'notion_create_page':
          return await handleCreatePage(accessToken, args);

        case 'notion_search':
          return await handleSearch(accessToken, args);

        case 'notion_update_page':
          return await handleUpdatePage(accessToken, args);

        case 'notion_add_to_database':
          return await handleAddToDatabase(accessToken, args);

        default:
          return {
            success: false,
            message: `Unknown Notion tool: ${toolName}`,
            displayToUser: false,
          };
      }
    } catch (error) {
      logger.error('[NOTION_SKILL] Execution error', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }
  },
};

/**
 * Create page handler
 */
async function handleCreatePage(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { parent_id, title, content } = args;

  if (!parent_id || !title) {
    return {
      success: false,
      message: 'Missing required fields: parent_id, title',
      displayToUser: false,
    };
  }

  try {
    const page = await createPage(accessToken, parent_id, title, content);

    logger.info('[NOTION_SKILL] Page created', { pageId: page.id });

    return {
      success: true,
      data: { pageId: page.id, url: page.url },
      message: `✅ Created Notion page: ${title}\n${page.url}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to create page', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to create page: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Search handler
 */
async function handleSearch(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { query } = args;

  if (!query) {
    return {
      success: false,
      message: 'Missing required field: query',
      displayToUser: false,
    };
  }

  try {
    const result = await searchPages(accessToken, query, 10);

    logger.info('[NOTION_SKILL] Search completed', {
      query,
      resultsCount: result.results.length,
    });

    const formatted = result.results.map((page) => ({
      id: page.id,
      url: page.url,
      created: page.created_time,
      lastEdited: page.last_edited_time,
    }));

    return {
      success: true,
      data: { pages: formatted, hasMore: result.has_more },
      message: `Found ${result.results.length} Notion pages for: ${query}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to search', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to search: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Update page handler
 */
async function handleUpdatePage(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { page_id, properties } = args;

  if (!page_id || !properties) {
    return {
      success: false,
      message: 'Missing required fields: page_id, properties',
      displayToUser: false,
    };
  }

  try {
    const page = await updatePage(accessToken, page_id, properties);

    logger.info('[NOTION_SKILL] Page updated', { pageId: page.id });

    return {
      success: true,
      data: { pageId: page.id, url: page.url },
      message: `✅ Updated Notion page\n${page.url}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to update page', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to update page: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Add to database handler
 */
async function handleAddToDatabase(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { database_id, properties } = args;

  if (!database_id || !properties) {
    return {
      success: false,
      message: 'Missing required fields: database_id, properties',
      displayToUser: false,
    };
  }

  try {
    const page = await addToDatabase(accessToken, database_id, properties);

    logger.info('[NOTION_SKILL] Added to database', { pageId: page.id });

    return {
      success: true,
      data: { pageId: page.id, url: page.url },
      message: `✅ Added entry to Notion database\n${page.url}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to add to database', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to add to database: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}
