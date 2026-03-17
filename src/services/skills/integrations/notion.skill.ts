import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getNotionToken,
  getPage,
  listDatabases,
  createPage,
  searchPages,
  updatePage,
  addToDatabase,
} from '@/services/api/notion.service';
import { IntegrationTokenService } from '@/services/api/integration-token.service';
import { env } from '@/config/environment/env';
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
      name: 'notion_status',
      description:
        'Check if Notion is connected for the user. Returns connection status and workspace info. Always available.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notion_connect',
      description:
        'Start Notion OAuth connection. Use when user asks to connect/setup/integrate Notion OR reconnect/re-authorize. ' +
        'Returns an authorization URL — tell the user to open it in their browser to authorize. ' +
        'After authorization, Notion will be connected automatically. Can also be used to refresh an expired connection. Always available.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notion_disconnect',
      description:
        'Disconnect the Notion integration for the user. Requires confirmation. Always available.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after warning user that Notion will be disconnected AND receiving explicit approval.',
          },
        },
        required: ['confirm'],
      },
    },
  },
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
  {
    type: 'function',
    function: {
      name: 'notion_get_page',
      description: 'Get full details of a specific Notion page by ID, including all properties. Use when user wants to read page content.',
      parameters: {
        type: 'object',
        properties: {
          page_id: {
            type: 'string',
            description: 'The Notion page ID to retrieve',
          },
        },
        required: ['page_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notion_list_databases',
      description: 'List all Notion databases accessible to this integration. Use when user asks which databases exist or what database_id to use.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
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
   * Always available — notion_status/connect/disconnect work without a token.
   * Other tools fail gracefully if not connected.
   */
  async isAvailable(_context: SkillContext): Promise<boolean> {
    return true;
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
      // Tools that do not require an existing token
      if (toolName === 'notion_status') {
        return await handleStatus(context);
      }

      if (toolName === 'notion_connect') {
        return await handleConnect();
      }

      if (toolName === 'notion_disconnect') {
        return await handleDisconnect(args, context);
      }

      // All other tools require an existing token
      const tokenData = await getNotionToken(context.userId, context.workspaceId);
      if (!tokenData) {
        return {
          success: false,
          message:
            'Notion is not connected. Call notion_connect immediately — it will generate an OAuth authorization URL for the user to complete the connection.',
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

        case 'notion_get_page':
          return await handleGetPage(accessToken, args);

        case 'notion_list_databases':
          return await handleListDatabases(accessToken);

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
 * Status handler
 */
async function handleStatus(context: SkillContext): Promise<SkillResult> {
  const tokenData = await getNotionToken(context.userId, context.workspaceId);

  if (!tokenData) {
    return {
      success: true,
      data: { connected: false },
      message: 'Notion is not connected. Call notion_connect immediately — it will generate an OAuth authorization URL for the user to complete the connection.',
      displayToUser: true,
    };
  }

  const meta = tokenData.metadata || {};
  return {
    success: true,
    data: {
      connected: true,
      workspaceName: meta.workspace_name || null,
      workspaceId: tokenData.external_id || null,
      connectedAt: tokenData.created_at,
    },
    message: `Notion connected${meta.workspace_name ? `: workspace "${meta.workspace_name}"` : ''}.`,
    displayToUser: true,
  };
}

/**
 * Connect handler — returns Notion OAuth URL
 */
async function handleConnect(): Promise<SkillResult> {
  const clientId = env.NOTION_CLIENT_ID;

  if (!clientId) {
    return {
      success: false,
      message:
        'Notion OAuth is not configured on the server. Contact your admin to set NOTION_CLIENT_ID.',
      displayToUser: true,
    };
  }

  const backendUrl = env.BACKEND_URL || `http://localhost:${env.PORT}`;
  const callbackUrl = `${backendUrl}/api/${env.API_VERSION}/integrations/notion/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    owner: 'user',
  });

  const authUrl = `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;

  return {
    success: true,
    data: { authUrl },
    message:
      `To connect Notion, open this URL in your browser:\n\n${authUrl}\n\n` +
      `Select your workspace and grant access. After completing the flow you will be redirected back and Notion will be connected.`,
    displayToUser: true,
  };
}

/**
 * Disconnect handler
 */
async function handleDisconnect(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Disconnecting Notion requires confirmation. Warn the user that the integration will be removed. Set confirm=true after explicit approval.',
      displayToUser: true,
    };
  }

  const tokenData = await getNotionToken(context.userId, context.workspaceId);
  if (!tokenData) {
    return {
      success: false,
      message: 'Notion is not connected — nothing to disconnect.',
      displayToUser: true,
    };
  }

  try {
    await IntegrationTokenService.deleteToken(context.userId, 'notion', undefined, context.workspaceId);
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to disconnect', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to disconnect Notion. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[NOTION_SKILL] Notion disconnected via chat', { userId: context.userId });

  return {
    success: true,
    data: { disconnected: true },
    message: 'Notion disconnected successfully. You can reconnect anytime using notion_connect.',
    displayToUser: true,
  };
}

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

/**
 * Get page handler
 */
async function handleGetPage(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { page_id } = args;

  if (!page_id) {
    return {
      success: false,
      message: 'Missing required field: page_id',
      displayToUser: false,
    };
  }

  try {
    const page = await getPage(accessToken, page_id);

    logger.info('[NOTION_SKILL] Page retrieved', { pageId: page.id });

    return {
      success: true,
      data: {
        id: page.id,
        url: page.url,
        properties: page.properties,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
      },
      message: `Retrieved Notion page: ${page.url}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to get page', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get page: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * List databases handler
 */
async function handleListDatabases(accessToken: string): Promise<SkillResult> {
  try {
    const databases = await listDatabases(accessToken);

    logger.info('[NOTION_SKILL] Databases listed', { count: databases.length });

    return {
      success: true,
      data: { databases, total: databases.length },
      message:
        databases.length > 0
          ? `Found ${databases.length} Notion database${databases.length !== 1 ? 's' : ''}: ${databases.map((d) => `"${d.title}" (${d.id})`).join(', ')}`
          : 'No databases found. Make sure the Notion integration has access to your databases.',
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[NOTION_SKILL] Failed to list databases', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list databases: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

export default NotionSkill;
