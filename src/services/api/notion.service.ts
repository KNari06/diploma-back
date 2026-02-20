import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTION API SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Notion API client using integration_tokens table.
 * Provides: page creation, search, updates, database operations
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionTokenData {
  id: string;
  user_id: string;
  workspace_id?: string;
  access_token: string;
  external_id?: string; // Notion workspace ID
  external_url?: string;
  metadata?: Record<string, any>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, any>;
}

export interface NotionSearchResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Get Notion token for user
 * Now uses centralized IntegrationTokenService
 */
export async function getNotionToken(userId: string): Promise<NotionTokenData | null> {
  try {
    const { IntegrationTokenService } = await import('./integration-token.service');
    const token = await IntegrationTokenService.getToken(userId, 'notion');

    if (!token) {
      logger.debug('[NOTION_SERVICE] No token found', { userId });
      return null;
    }

    logger.debug('[NOTION_SERVICE] Token retrieved', { userId });
    return token as NotionTokenData;
  } catch (error) {
    logger.error('[NOTION_SERVICE] Get token error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    throw error;
  }
}

/**
 * Create a Notion page
 */
export async function createPage(
  accessToken: string,
  parentId: string,
  title: string,
  content?: string
): Promise<NotionPage> {
  try {
    logger.info('[NOTION_SERVICE] Creating page', { parentId, title });

    // Build page content (blocks)
    const children: any[] = [];

    // Add title block
    if (title) {
      children.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ type: 'text', text: { content: title } }],
        },
      });
    }

    // Add content block if provided
    if (content) {
      // Split content into paragraphs
      const paragraphs = content.split('\n').filter(p => p.trim());
      paragraphs.forEach(paragraph => {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: paragraph } }],
          },
        });
      });
    }

    const response = await fetch(`${NOTION_API_URL}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: {
          title: {
            title: [{ text: { content: title } }],
          },
        },
        children,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[NOTION_SERVICE] Failed to create page', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Notion API error: ${response.status} ${errorText}`);
    }

    const page = (await response.json()) as NotionPage;
    logger.info('[NOTION_SERVICE] Page created', { pageId: page.id });

    return page;
  } catch (error) {
    logger.error('[NOTION_SERVICE] Create page error', {
      error: error instanceof Error ? error.message : String(error),
      parentId,
    });
    throw error;
  }
}

/**
 * Search Notion pages
 */
export async function searchPages(
  accessToken: string,
  query: string,
  pageSize: number = 10
): Promise<NotionSearchResult> {
  try {
    logger.info('[NOTION_SERVICE] Searching pages', { query, pageSize });

    const response = await fetch(`${NOTION_API_URL}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        query,
        page_size: pageSize,
        filter: {
          property: 'object',
          value: 'page',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[NOTION_SERVICE] Failed to search pages', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Notion API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as NotionSearchResult;
    logger.info('[NOTION_SERVICE] Search completed', { resultsCount: result.results.length });

    return result;
  } catch (error) {
    logger.error('[NOTION_SERVICE] Search pages error', {
      error: error instanceof Error ? error.message : String(error),
      query,
    });
    throw error;
  }
}

/**
 * Update a Notion page
 */
export async function updatePage(
  accessToken: string,
  pageId: string,
  properties: Record<string, any>
): Promise<NotionPage> {
  try {
    logger.info('[NOTION_SERVICE] Updating page', { pageId });

    const response = await fetch(`${NOTION_API_URL}/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[NOTION_SERVICE] Failed to update page', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Notion API error: ${response.status} ${errorText}`);
    }

    const page = (await response.json()) as NotionPage;
    logger.info('[NOTION_SERVICE] Page updated', { pageId: page.id });

    return page;
  } catch (error) {
    logger.error('[NOTION_SERVICE] Update page error', {
      error: error instanceof Error ? error.message : String(error),
      pageId,
    });
    throw error;
  }
}

/**
 * Get a single Notion page by ID
 */
export async function getPage(
  accessToken: string,
  pageId: string
): Promise<NotionPage> {
  try {
    logger.info('[NOTION_SERVICE] Getting page', { pageId });

    const response = await fetch(`${NOTION_API_URL}/pages/${encodeURIComponent(pageId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Notion-Version': NOTION_VERSION,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[NOTION_SERVICE] Failed to get page', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Notion API error: ${response.status} ${errorText}`);
    }

    const page = (await response.json()) as NotionPage;
    logger.info('[NOTION_SERVICE] Page retrieved', { pageId: page.id });

    return page;
  } catch (error) {
    logger.error('[NOTION_SERVICE] Get page error', {
      error: error instanceof Error ? error.message : String(error),
      pageId,
    });
    throw error;
  }
}

export interface NotionDatabase {
  id: string;
  url: string;
  title: string;
  created_time: string;
  last_edited_time: string;
}

/**
 * List Notion databases accessible to the integration
 */
export async function listDatabases(
  accessToken: string,
  pageSize: number = 20
): Promise<NotionDatabase[]> {
  try {
    logger.info('[NOTION_SERVICE] Listing databases');

    const response = await fetch(`${NOTION_API_URL}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        filter: { property: 'object', value: 'database' },
        page_size: pageSize,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[NOTION_SERVICE] Failed to list databases', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Notion API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        url: string;
        title?: Array<{ plain_text?: string }>;
        created_time: string;
        last_edited_time: string;
      }>;
    };

    return data.results.map((db) => ({
      id: db.id,
      url: db.url,
      title: db.title?.[0]?.plain_text || 'Untitled',
      created_time: db.created_time,
      last_edited_time: db.last_edited_time,
    }));
  } catch (error) {
    logger.error('[NOTION_SERVICE] List databases error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Add page to database
 */
export async function addToDatabase(
  accessToken: string,
  databaseId: string,
  properties: Record<string, any>
): Promise<NotionPage> {
  try {
    logger.info('[NOTION_SERVICE] Adding to database', { databaseId });

    const response = await fetch(`${NOTION_API_URL}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[NOTION_SERVICE] Failed to add to database', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Notion API error: ${response.status} ${errorText}`);
    }

    const page = (await response.json()) as NotionPage;
    logger.info('[NOTION_SERVICE] Added to database', { pageId: page.id });

    return page;
  } catch (error) {
    logger.error('[NOTION_SERVICE] Add to database error', {
      error: error instanceof Error ? error.message : String(error),
      databaseId,
    });
    throw error;
  }
}
