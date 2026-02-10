import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import {
  JiraTokenResponse,
  JiraAccessibleResource,
  JiraTokenData,
  JiraProject,
  JiraBoard,
  JiraIssueListItem,
  JiraSearchResult,
} from '@/types';
import * as crypto from 'crypto';

const JIRA_AUTH_URL = 'https://auth.atlassian.com';
const JIRA_API_URL = 'https://api.atlassian.com';

/**
 * Generate random state for OAuth security
 */
export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Build OAuth authorization URL
 * @param state - Random state for security
 * @returns Authorization URL
 */
export function buildJiraAuthUrl(state: string): string {
  const clientId = env.JIRA_CLIENT_ID;
  const callbackUrl = env.JIRA_CALLBACK_URL || `http://localhost:${env.PORT}/api/v1/jira/callback`;

  if (!clientId) {
    throw new Error('JIRA_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: 'read:jira-user read:jira-work write:jira-work read:board-scope:jira-software read:project:jira read:issue-details:jira offline_access',
    redirect_uri: callbackUrl,
    response_type: 'code',
    prompt: 'consent',
    state,
  });

  return `${JIRA_AUTH_URL}/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 * @param code - Authorization code from callback
 * @returns Token response
 */
export async function exchangeCodeForToken(
  code: string
): Promise<JiraTokenResponse> {
  const clientId = env.JIRA_CLIENT_ID;
  const clientSecret = env.JIRA_CLIENT_SECRET;
  const callbackUrl = env.JIRA_CALLBACK_URL || `http://localhost:${env.PORT}/api/v1/jira/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('JIRA_CLIENT_ID and JIRA_CLIENT_SECRET must be configured');
  }

  try {
    const response = await fetch(`${JIRA_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Jira token exchange failed', { status: response.status, error: errorText });
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as JiraTokenResponse;
    logger.info('Jira token exchanged successfully');
    return tokenData;
  } catch (error) {
    logger.error('Jira token exchange error', error);
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 * @param refreshToken - Refresh token
 * @returns New token response
 */
export async function refreshJiraToken(refreshToken: string): Promise<JiraTokenResponse> {
  const clientId = env.JIRA_CLIENT_ID;
  const clientSecret = env.JIRA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('JIRA_CLIENT_ID and JIRA_CLIENT_SECRET must be configured');
  }

  try {
    const response = await fetch(`${JIRA_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Jira token refresh failed', { status: response.status, error: errorText });
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as JiraTokenResponse;
    logger.info('Jira token refreshed successfully');
    return tokenData;
  } catch (error) {
    logger.error('Jira token refresh error', error);
    throw error;
  }
}

/**
 * Get accessible Jira resources (cloud IDs)
 * @param accessToken - Access token
 * @returns List of accessible resources
 */
export async function getAccessibleResources(
  accessToken: string
): Promise<JiraAccessibleResource[]> {
  try {
    const response = await fetch(`${JIRA_API_URL}/oauth/token/accessible-resources`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to get accessible resources', { status: response.status, error: errorText });
      throw new Error(`Failed to get accessible resources: ${response.status} ${errorText}`);
    }

    const resources = await response.json() as JiraAccessibleResource[];
    return resources;
  } catch (error) {
    logger.error('Error getting accessible resources', error);
    throw error;
  }
}

/**
 * Save Jira token to database
 * Now saves to integration_tokens table using IntegrationTokenService
 * @param userId - User ID
 * @param tokenData - Token response from OAuth
 * @param cloudId - Jira cloud ID (maps to external_id)
 * @param siteUrl - Jira site URL (maps to external_url)
 * @returns Saved token data
 */
export async function saveJiraToken(
  userId: string,
  tokenData: JiraTokenResponse,
  cloudId: string,
  siteUrl?: string
): Promise<JiraTokenData> {
  try {
    if (!cloudId) {
      throw new Error('cloud_id is required to save Jira token');
    }

    // Import IntegrationTokenService dynamically to avoid circular dependencies
    const { IntegrationTokenService } = await import('./integration-token.service');

    const expiresIn = tokenData.expires_in;

    // Save to integration_tokens using the centralized service
    const savedToken = await IntegrationTokenService.saveToken(
      userId,
      undefined, // workspace_id - Jira doesn't use workspace scoping yet
      'jira',
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: expiresIn,
        scope: tokenData.scope,
        token_type: tokenData.token_type,
        external_id: cloudId,
        external_url: siteUrl,
        metadata: {}, // Empty metadata for now
      }
    );

    logger.info('[JIRA] Token saved to integration_tokens', { userId, cloudId });

    // Return in JiraTokenData format for backward compatibility
    return {
      id: savedToken.id,
      user_id: savedToken.user_id,
      access_token: savedToken.access_token,
      refresh_token: savedToken.refresh_token,
      expires_at: savedToken.expires_at,
      scope: savedToken.scope,
      cloud_id: savedToken.external_id || cloudId,
      site_url: savedToken.external_url,
      token_type: savedToken.token_type,
      created_at: savedToken.created_at,
      updated_at: savedToken.updated_at,
    } as JiraTokenData;
  } catch (error) {
    logger.error('Failed to save Jira token', error);
    throw error;
  }
}

/**
 * Get Jira token for user
 * Dual-read pattern: checks integration_tokens first, falls back to jira_tokens
 * @param userId - User ID
 * @param cloudId - Optional cloud ID filter (maps to external_id in integration_tokens)
 * @returns Token data or null
 */
export async function getJiraToken(
  userId: string,
  cloudId?: string
): Promise<JiraTokenData | null> {
  try {
    // Try new integration_tokens table first
    let query = supabaseAdmin
      .from('integration_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'jira')
      .eq('enabled', true);

    if (cloudId) {
      query = query.eq('external_id', cloudId);
    }

    const { data: newData, error: newError } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (newError) {
      logger.error('Failed to query integration_tokens for Jira', newError);
      // Don't throw, fall through to legacy table
    }

    if (newData) {
      logger.debug('[JIRA] Token retrieved from integration_tokens', { userId, cloudId });
      // Map integration_tokens fields to JiraTokenData format
      return {
        id: newData.id,
        user_id: newData.user_id,
        access_token: newData.access_token,
        refresh_token: newData.refresh_token,
        expires_at: newData.expires_at,
        scope: newData.scope,
        cloud_id: newData.external_id || '',
        site_url: newData.external_url,
        token_type: newData.token_type,
        created_at: newData.created_at,
        updated_at: newData.updated_at,
      } as JiraTokenData;
    }

    // Fallback to legacy jira_tokens table
    let legacyQuery = supabaseAdmin
      .from('jira_tokens')
      .select('*')
      .eq('user_id', userId);

    if (cloudId) {
      legacyQuery = legacyQuery.eq('cloud_id', cloudId);
    }

    const { data: legacyData, error: legacyError } = await legacyQuery
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (legacyError) throw legacyError;

    if (legacyData) {
      logger.debug('[JIRA] Token retrieved from jira_tokens (legacy)', { userId, cloudId });
    }

    return legacyData as JiraTokenData | null;
  } catch (error) {
    logger.error('Failed to get Jira token', error);
    throw error;
  }
}

/**
 * Check if token is expired and refresh if needed
 * @param tokenData - Token data from database
 * @returns Valid access token
 */
export async function ensureValidToken(tokenData: JiraTokenData): Promise<string> {
  // Check if token is expired or expires soon (within 5 minutes)
  const now = new Date();
  const currentExpiresAt = tokenData.expires_at ? new Date(tokenData.expires_at) : null;

  if (currentExpiresAt && currentExpiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    // Token expired or expiring soon, refresh it
    if (!tokenData.refresh_token) {
      throw new Error('Token expired and no refresh token available');
    }

    logger.info('Refreshing expired Jira token', { userId: tokenData.user_id });
    const newTokenData = await refreshJiraToken(tokenData.refresh_token);

    // Update token in database - try integration_tokens first, fallback to jira_tokens
    const newExpiresAt = newTokenData.expires_in
      ? new Date(Date.now() + newTokenData.expires_in * 1000)
      : undefined;

    // Import IntegrationTokenService
    const { IntegrationTokenService } = await import('./integration-token.service');

    // Try to find token in integration_tokens first
    const { data: integrationToken } = await supabaseAdmin
      .from('integration_tokens')
      .select('id')
      .eq('user_id', tokenData.user_id)
      .eq('provider', 'jira')
      .eq('external_id', tokenData.cloud_id)
      .maybeSingle();

    if (integrationToken) {
      // Update in integration_tokens using centralized service
      await IntegrationTokenService.refreshToken(
        integrationToken.id,
        newTokenData.access_token,
        newTokenData.refresh_token || tokenData.refresh_token,
        newTokenData.expires_in
      );
      logger.info('[JIRA] Refreshed token updated in integration_tokens', {
        userId: tokenData.user_id,
        cloudId: tokenData.cloud_id,
      });
    } else {
      // Fallback to jira_tokens (legacy)
      const { error } = await supabaseAdmin
        .from('jira_tokens')
        .update({
          access_token: newTokenData.access_token,
          refresh_token: newTokenData.refresh_token || tokenData.refresh_token,
          expires_at: newExpiresAt?.toISOString(),
          scope: newTokenData.scope,
          updated_at: new Date().toISOString(),
        })
        .eq('id', tokenData.id);

      if (error) {
        logger.error('Failed to update refreshed token in jira_tokens', error);
        throw error;
      }
      logger.info('[JIRA] Refreshed token updated in jira_tokens (legacy)', {
        userId: tokenData.user_id,
        cloudId: tokenData.cloud_id,
      });
    }

    return newTokenData.access_token;
  }

  return tokenData.access_token;
}

/**
 * Get Jira projects
 * @param accessToken - Access token
 * @param cloudId - Jira cloud ID
 * @returns List of projects
 */
export async function getJiraProjects(
  accessToken: string,
  cloudId: string
): Promise<JiraProject[]> {
  try {
    const response = await fetch(
      `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/project/search`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to get Jira projects', { status: response.status, error: errorText });
      throw new Error(`Failed to get projects: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { values?: JiraProject[] };
    return data.values || [];
  } catch (error) {
    logger.error('Error getting Jira projects', error);
    throw error;
  }
}

/**
 * Get Jira boards (Agile API: GET /rest/agile/1.0/board)
 * @param accessToken - Access token
 * @param cloudId - Jira cloud ID
 * @param projectKeyOrId - Optional project key or ID to filter boards
 * @returns List of boards { id, name, type }
 */
export async function getJiraBoards(
  accessToken: string,
  cloudId: string,
  projectKeyOrId?: string
): Promise<JiraBoard[]> {
  try {
    const params = new URLSearchParams({ maxResults: '50', startAt: '0' });
    if (projectKeyOrId) {
      params.set('projectKeyOrId', projectKeyOrId);
    }
    const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/agile/1.0/board?${params.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to get Jira boards', { status: response.status, error: errorText });
      throw new Error(`Failed to get boards: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { values?: Array<{ id: number; name: string; type: string }> };
    const values = data.values || [];
    return values.map((b) => ({
      id: b.id,
      name: b.name ?? '',
      type: b.type ?? 'scrum',
    }));
  } catch (error) {
    logger.error('Error getting Jira boards', error);
    throw error;
  }
}

/** Board configuration column from Agile API */
interface BoardConfigColumn {
  name: string;
  statuses?: Array<{ id: string }>;
}

/** Status from Jira REST API */
interface JiraStatus {
  id: string;
  name: string;
}

/**
 * Get board configuration (Agile API: GET /rest/agile/1.0/board/{boardId}/configuration)
 */
export async function getBoardConfiguration(
  accessToken: string,
  cloudId: string,
  boardId: number | string
): Promise<{ columns: BoardConfigColumn[] }> {
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/configuration`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Failed to get board configuration', { status: response.status, error: errorText });
    throw new Error(`Failed to get board configuration: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    columnConfig?: { columns?: BoardConfigColumn[] };
  };
  const columns = data.columnConfig?.columns || [];
  return { columns };
}

/**
 * Get all workflow status names for a project (GET /rest/api/3/project/{projectIdOrKey}/statuses).
 * Returns unique status names in order - used as column list when board config is unavailable.
 */
export async function getProjectStatuses(
  accessToken: string,
  cloudId: string,
  projectKeyOrId: string
): Promise<string[]> {
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/project/${encodeURIComponent(projectKeyOrId)}/statuses`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.warn('Failed to get project statuses', { status: response.status, error: errorText });
    return [];
  }

  const data = (await response.json()) as Array<{ statuses?: Array<{ id: string; name: string }> }>;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of data || []) {
    for (const s of item.statuses || []) {
      const name = s?.name?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }
  return ordered;
}

/**
 * Get all Jira statuses (GET /rest/api/3/status) for id → name mapping
 */
export async function getJiraStatuses(
  accessToken: string,
  cloudId: string
): Promise<Record<string, string>> {
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/status`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Failed to get Jira statuses', { status: response.status, error: errorText });
    throw new Error(`Failed to get Jira statuses: ${response.status} ${errorText}`);
  }

  const statuses = (await response.json()) as JiraStatus[];
  const map: Record<string, string> = {};
  for (const s of statuses || []) {
    if (s?.id) {
      map[s.id] = s.name ?? s.id;
    }
  }
  return map;
}

/**
 * Get issues for a board (Agile API: GET /rest/agile/1.0/board/{boardId}/issue)
 * @param accessToken - Access token
 * @param cloudId - Jira cloud ID
 * @param boardId - Board ID
 * @param startAt - Pagination offset
 * @param maxResults - Page size
 * @param jql - Optional JQL filter (e.g. issuetype in (Bug, Task))
 */
export async function getBoardIssues(
  accessToken: string,
  cloudId: string,
  boardId: number | string,
  startAt: number,
  maxResults: number,
  jql?: string
): Promise<JiraSearchResult> {
  const fields = [
    'summary',
    'description',
    'status',
    'priority',
    'issuetype',
    'reporter',
    'assignee',
    'created',
    'updated',
    'labels',
    'project',
  ].join(',');
  const params = new URLSearchParams({
    startAt: String(startAt),
    maxResults: String(maxResults),
    fields,
  });
  if (jql) {
    params.set('jql', jql);
  }
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/issue?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Jira board issues failed', { status: response.status, error: errorText });
    throw new Error(`Jira board issues failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    total?: number;
    issues?: JiraSearchIssueRaw[];
  };
  const rawIssues = data.issues || [];
  const total = typeof data.total === 'number' ? data.total : 0;

  const issues: JiraIssueListItem[] = rawIssues.map((issue) => {
    const f = issue.fields || {};
    const status = f.status;
    const priority = f.priority;
    const issuetype = f.issuetype;
    const reporter = f.reporter;
    const assignee = f.assignee;
    const project = f.project;

    return {
      id: issue.id,
      key: issue.key,
      summary: typeof f.summary === 'string' ? f.summary : '',
      description: mapDescription(f.description),
      status: {
        id: status?.id ?? '',
        name: status?.name ?? 'Unknown',
        statusCategory: status?.statusCategory,
      },
      priority: priority
        ? { id: priority.id ?? '', name: priority.name ?? 'Unknown' }
        : null,
      issuetype: {
        id: issuetype?.id ?? '',
        name: issuetype?.name ?? 'Unknown',
      },
      reporter: reporter
        ? {
            accountId: reporter.accountId ?? '',
            displayName: reporter.displayName ?? '',
            emailAddress: reporter.emailAddress,
          }
        : null,
      assignee: assignee
        ? {
            accountId: assignee.accountId ?? '',
            displayName: assignee.displayName ?? '',
            emailAddress: assignee.emailAddress,
          }
        : null,
      created: typeof f.created === 'string' ? f.created : '',
      updated: typeof f.updated === 'string' ? f.updated : '',
      labels: Array.isArray(f.labels) ? f.labels : [],
      project: {
        id: project?.id ?? '',
        key: project?.key ?? '',
        name: project?.name ?? '',
      },
    };
  });

  return { issues, total };
}

/** Raw Jira search API issue shape */
interface JiraSearchIssueRaw {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: string | unknown;
    status?: { id?: string; name?: string; statusCategory?: Record<string, unknown> };
    priority?: { id?: string; name?: string } | null;
    issuetype?: { id?: string; name?: string };
    reporter?: { accountId?: string; displayName?: string; emailAddress?: string } | null;
    assignee?: { accountId?: string; displayName?: string; emailAddress?: string } | null;
    created?: string;
    updated?: string;
    labels?: string[];
    project?: { id?: string; key?: string; name?: string };
  };
}

function mapDescription(v: string | unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return '';
}

/**
 * Search Jira issues (REST API v3 search/jql - replaces deprecated /search)
 * @see https://developer.atlassian.com/changelog/#CHANGE-2046
 */
export async function searchJiraIssues(
  accessToken: string,
  cloudId: string,
  jql: string,
  startAt: number,
  maxResults: number
): Promise<JiraSearchResult> {
  const fetchSize = Math.min(startAt + maxResults, 100);
  const fields = [
    'summary',
    'description',
    'status',
    'priority',
    'issuetype',
    'reporter',
    'assignee',
    'created',
    'updated',
    'labels',
    'project',
  ].join(',');
  const params = new URLSearchParams({
    jql,
    maxResults: String(fetchSize),
    fields,
  });
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/search/jql?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Jira search failed', { status: response.status, error: errorText });
    throw new Error(`Jira search failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    issues?: JiraSearchIssueRaw[];
    isLast?: boolean;
    nextPageToken?: string;
  };
  const allRaw = data.issues || [];
  const rawIssues = allRaw.slice(startAt, startAt + maxResults);

  let total: number;
  if (data.isLast) {
    total = startAt + allRaw.length;
  } else {
    const countRes = await fetch(
      `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/search/approximate-count`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ jql }),
      }
    );
    total = countRes.ok
      ? ((await countRes.json()) as { count?: number }).count ?? startAt + allRaw.length
      : startAt + allRaw.length;
  }

  const issues: JiraIssueListItem[] = rawIssues.map((issue) => {
    const f = issue.fields || {};
    const status = f.status;
    const priority = f.priority;
    const issuetype = f.issuetype;
    const reporter = f.reporter;
    const assignee = f.assignee;
    const project = f.project;

    return {
      id: issue.id,
      key: issue.key,
      summary: typeof f.summary === 'string' ? f.summary : '',
      description: mapDescription(f.description),
      status: {
        id: status?.id ?? '',
        name: status?.name ?? 'Unknown',
        statusCategory: status?.statusCategory,
      },
      priority: priority
        ? { id: priority.id ?? '', name: priority.name ?? 'Unknown' }
        : null,
      issuetype: {
        id: issuetype?.id ?? '',
        name: issuetype?.name ?? 'Unknown',
      },
      reporter: reporter
        ? {
            accountId: reporter.accountId ?? '',
            displayName: reporter.displayName ?? '',
            emailAddress: reporter.emailAddress,
          }
        : null,
      assignee: assignee
        ? {
            accountId: assignee.accountId ?? '',
            displayName: assignee.displayName ?? '',
            emailAddress: assignee.emailAddress,
          }
        : null,
      created: typeof f.created === 'string' ? f.created : '',
      updated: typeof f.updated === 'string' ? f.updated : '',
      labels: Array.isArray(f.labels) ? f.labels : [],
      project: {
        id: project?.id ?? '',
        key: project?.key ?? '',
        name: project?.name ?? '',
      },
    };
  });

  return { issues, total };
}

/** Convert plain text to Atlassian Document Format */
function plainTextToADF(text: string): { type: 'doc'; version: number; content: unknown[] } {
  const lines = (text || '').split('\n').filter(Boolean);
  const content = lines.length > 0
    ? lines.map((line) => ({
        type: 'paragraph' as const,
        content: [{ type: 'text' as const, text: line }],
      }))
    : [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: '' }] }];
  return { type: 'doc', version: 1, content };
}

export interface CreateJiraIssueParams {
  accessToken: string;
  cloudId: string;
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string;
  priority?: string;
}

export interface CreatedJiraIssue {
  id: string;
  key: string;
  self: string;
}

/**
 * Create Jira issue (POST /rest/api/3/issue)
 */
export async function createJiraIssue(params: CreateJiraIssueParams): Promise<CreatedJiraIssue> {
  const { accessToken, cloudId, projectKey, summary, description, issueType = 'Bug', priority = 'Medium' } = params;
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/issue`;
  const body: Record<string, unknown> = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueType },
      priority: { name: priority },
    },
  };
  if (description) {
    (body.fields as Record<string, unknown>).description = plainTextToADF(description);
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Jira create issue failed', { status: response.status, error: errorText });
    throw new Error(`Jira create issue failed: ${response.status} ${errorText}`);
  }
  return (await response.json()) as CreatedJiraIssue;
}

/**
 * Transition Jira issue to new status (GET transitions, then POST)
 */
export async function transitionJiraIssue(
  accessToken: string,
  cloudId: string,
  issueKey: string,
  statusName: string
): Promise<void> {
  const transitionsUrl = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
  const transitionsRes = await fetch(transitionsUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!transitionsRes.ok) {
    const errorText = await transitionsRes.text();
    logger.error('Jira get transitions failed', { status: transitionsRes.status, error: errorText });
    throw new Error(`Jira get transitions failed: ${transitionsRes.status} ${errorText}`);
  }
  const transitionsData = (await transitionsRes.json()) as { transitions?: Array<{ id: string; name: string; to?: { name: string } }> };
  const transitions = transitionsData.transitions || [];
  const match = transitions.find(
    (t) =>
      t.to?.name?.toLowerCase() === statusName.toLowerCase() ||
      t.name?.toLowerCase() === statusName.toLowerCase()
  );
  if (!match) {
    const available = transitions.map((t) => t.to?.name || t.name).filter(Boolean).join(', ');
    throw new Error(`No transition to status "${statusName}". Available: ${available || 'none'}`);
  }
  const postRes = await fetch(transitionsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  if (!postRes.ok) {
    const errorText = await postRes.text();
    logger.error('Jira transition failed', { status: postRes.status, error: errorText });
    throw new Error(`Jira transition failed: ${postRes.status} ${errorText}`);
  }
}

export interface UpdateJiraIssueParams {
  accessToken: string;
  cloudId: string;
  issueKey: string;
  summary?: string;
  description?: string;
  priority?: string;
}

/**
 * Update Jira issue fields (PUT /rest/api/3/issue/{issueKey})
 * Only updates fields that are provided.
 */
export async function updateJiraIssueFields(params: UpdateJiraIssueParams): Promise<void> {
  const { accessToken, cloudId, issueKey, summary, description, priority } = params;
  const fields: Record<string, unknown> = {};
  if (summary !== undefined) fields.summary = summary;
  if (description !== undefined) fields.description = plainTextToADF(description);
  if (priority !== undefined) fields.priority = { name: priority };

  if (Object.keys(fields).length === 0) {
    return;
  }

  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Jira update issue failed', { status: response.status, error: errorText });
    throw new Error(`Jira update issue failed: ${response.status} ${errorText}`);
  }
}

/**
 * Get single Jira issue by key (GET /rest/api/3/issue/{issueKey})
 */
export async function getJiraIssue(
  accessToken: string,
  cloudId: string,
  issueKey: string
): Promise<JiraIssueListItem> {
  const fields = [
    'summary',
    'description',
    'status',
    'priority',
    'issuetype',
    'reporter',
    'assignee',
    'created',
    'updated',
    'labels',
    'project',
  ].join(',');
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Jira get issue failed', { status: response.status, error: errorText, issueKey });
    throw new Error(`Jira get issue failed: ${response.status} ${errorText}`);
  }
  const raw = (await response.json()) as { key: string; id: string; fields?: Record<string, unknown> };
  const f = raw.fields || {};
  const status = f.status as { id?: string; name?: string; statusCategory?: Record<string, unknown> } | undefined;
  const project = f.project as { id?: string; key?: string; name?: string } | undefined;
  const desc = f.description;
  let description: string | null = null;
  if (typeof desc === 'string') description = desc;
  else if (desc && typeof desc === 'object' && 'content' in (desc as any))
    description = extractPlainTextFromADF(desc as { content?: unknown[] });

  return {
    id: raw.id,
    key: raw.key,
    summary: (f.summary as string) ?? '',
    description,
    status: {
      id: status?.id ?? '',
      name: status?.name ?? 'Unknown',
      statusCategory: status?.statusCategory,
    },
    priority: (f.priority as { id: string; name: string }) ?? null,
    issuetype: (f.issuetype as { id: string; name: string }) ?? { id: '', name: 'Unknown' },
    reporter: (f.reporter as JiraIssueListItem['reporter']) ?? null,
    assignee: (f.assignee as JiraIssueListItem['assignee']) ?? null,
    created: (f.created as string) ?? '',
    updated: (f.updated as string) ?? '',
    labels: Array.isArray(f.labels) ? f.labels : [],
    project: {
      id: project?.id ?? '',
      key: project?.key ?? '',
      name: project?.name ?? '',
    },
  };
}

function extractPlainTextFromADF(adf: { content?: unknown[] }): string {
  if (!adf.content || !Array.isArray(adf.content)) return '';
  const parts: string[] = [];
  for (const node of adf.content) {
    const n = node as { type?: string; content?: unknown[]; text?: string };
    if (n.type === 'paragraph' && Array.isArray(n.content)) {
      for (const c of n.content) {
        const t = c as { type?: string; text?: string };
        if (t.text) parts.push(t.text);
      }
    } else if (n.type === 'text' && n.text) parts.push(n.text);
  }
  return parts.join(' ');
}

/**
 * Add comment to Jira issue (plain text → ADF)
 */
export async function addJiraComment(
  accessToken: string,
  cloudId: string,
  issueKey: string,
  bodyPlain: string
): Promise<void> {
  const body = plainTextToADF(bodyPlain);
  const url = `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Jira add comment failed', { status: response.status, error: errorText, issueKey });
    throw new Error(`Jira add comment failed: ${response.status} ${errorText}`);
  }
}
