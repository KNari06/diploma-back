import { Request, Response } from 'express';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { handlePlatformTest } from '@/api/chat/ai_test/handler';
import { handleApiTest } from '@/api/chat/api_test/handler';
import { handleClarificationRequest } from '@/api/chat/shared/clarification';
import { checkWorkspace } from '@/api/chat/shared/validation';
import { getOrCreateWorkspaceChat, normalizeUrl } from '@/api/chat/shared/utils';
import {
  generateOAuthState,
  buildJiraAuthUrl,
  exchangeCodeForToken,
  getAccessibleResources,
  saveJiraToken,
  getJiraToken,
  ensureValidToken,
  getJiraProjects,
  getJiraBoards,
  getBoardConfiguration,
  getJiraStatuses,
  getProjectStatuses,
  getBoardIssues,
  searchJiraIssues,
  createJiraIssue,
  transitionJiraIssue,
  updateJiraIssueFields,
} from '@/services/api/jira.service';
import { supabaseAdmin } from '@/db/supabase';
import { JiraQaOrchestratorService } from '@/services/integrations/jira-qa-orchestrator.service';
import type { JiraIssueListItem } from '@/types';
import { randomUUID } from 'crypto';

// In-memory store for OAuth states (in production, use Redis)
const oauthStates = new Map<string, { userId?: string; expiresAt: number }>();

// Clean up expired states every hour
setInterval(() => {
  try {
    const now = Date.now();
    for (const [state, data] of oauthStates.entries()) {
      if (data.expiresAt < now) {
        oauthStates.delete(state);
      }
    }
  } catch (error) {
    logger.error('Error cleaning up OAuth states', { error });
  }
}, 60 * 60 * 1000);

/**
 * Create Jira OAuth URL and store state for callback (used by integrations controller so SPA redirect works without hitting auth-protected /jira/authorize).
 */
export function createJiraOAuthUrl(userId: string): string {
  const state = generateOAuthState();
  oauthStates.set(state, {
    userId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return buildJiraAuthUrl(state);
}

/**
 * Start Jira OAuth flow
 * GET /api/jira/auth/start
 */
export const startJiraAuth = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id; // From auth middleware

    const state = generateOAuthState();
    const authUrl = buildJiraAuthUrl(state);

    // Store state with expiration (10 minutes)
    oauthStates.set(state, {
      userId,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    logger.info('Jira OAuth started', { userId, state });

    res.redirect(authUrl);
  } catch (error) {
    logger.error('Jira OAuth start error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start OAuth flow',
    });
  }
};

/**
 * Get OAuth URL for Jira connect (for SPA: fetch with Bearer, then redirect)
 * GET /api/v1/jira/connect/url
 */
export const getConnectUrl = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const state = generateOAuthState();
    const authUrl = buildJiraAuthUrl(state);
    oauthStates.set(state, {
      userId,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    logger.info('Jira OAuth URL issued', { userId, state });
    res.json({ success: true, url: authUrl });
  } catch (error) {
    logger.error('Jira connect URL error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get connect URL',
    });
  }
};

/**
 * Handle Jira OAuth callback
 * GET /api/v1/jira/callback
 */
export const handleJiraCallback = async (req: Request, res: Response): Promise<void> => {
  try {
    const { code, state, error } = req.query;

    const frontendUrl = (env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const redirectError = (message: string) =>
      res.redirect(`${frontendUrl}/integrations?provider=jira&status=error&message=${encodeURIComponent(message)}`);

    if (error) {
      logger.error('Jira OAuth error', { error });
      redirectError(`OAuth error: ${error}`);
      return;
    }

    if (!code || !state) {
      redirectError('Missing code or state parameter');
      return;
    }

    // Validate state
    const stateData = oauthStates.get(state as string);
    if (!stateData || stateData.expiresAt < Date.now()) {
      redirectError('Invalid or expired state parameter');
      return;
    }

    const userId = stateData.userId;
    if (!userId) {
      redirectError('User ID not found in state');
      return;
    }

    // Clean up state
    oauthStates.delete(state as string);

    // Exchange code for token
    const tokenData = await exchangeCodeForToken(code as string);

    // Get accessible resources (cloud IDs)
    const resources = await getAccessibleResources(tokenData.access_token);

    if (resources.length === 0) {
      redirectError('No accessible Jira resources found');
      return;
    }

    // Save token for each accessible resource
    // Use Promise.allSettled to handle individual failures gracefully
    const saveResults = await Promise.allSettled(
      resources.map((resource) =>
        saveJiraToken(userId, tokenData, resource.id, resource.url)
      )
    );

    const savedTokens = saveResults
      .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
      .map(result => result.value);

    // Log failed saves but don't fail the whole operation
    const failedSaves = saveResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failedSaves.length > 0) {
      logger.warn('Some Jira tokens failed to save', {
        userId,
        failedCount: failedSaves.length,
        totalCount: resources.length,
      });
    }

    logger.info('Jira OAuth callback completed', {
      userId,
      resourcesCount: resources.length,
    });

    res.redirect(`${frontendUrl}/integrations?provider=jira&status=success`);
  } catch (err) {
    logger.error('Jira OAuth callback error:', err);
    const frontendUrl = (env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const message = err instanceof Error ? err.message : 'Failed to process OAuth callback';
    res.redirect(`${frontendUrl}/integrations?provider=jira&status=error&message=${encodeURIComponent(message)}`);
  }
};

/**
 * Get Jira projects
 * GET /api/jira/projects
 */
export const getProjects = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id; // From auth middleware
    const cloudId = req.query.cloudId as string;

    // Get token from database
    const tokenData = await getJiraToken(userId, cloudId);

    if (!tokenData) {
      res.status(401).json({
        success: false,
        error: 'Jira not connected. Please authorize first at /api/jira/auth/start',
      });
      return;
    }

    // Ensure token is valid (refresh if needed)
    const accessToken = await ensureValidToken(tokenData);

    // Use cloud_id from token or from query
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required. Please specify cloudId query param.',
      });
      return;
    }

    // Get projects
    const projects = await getJiraProjects(accessToken, cloudIdToUse);

    res.json({
      success: true,
      data: projects,
      count: projects.length,
    });
  } catch (error) {
    logger.error('Get Jira projects error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get projects',
    });
  }
};

const JIRA_PROJECT_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Get Jira boards
 * GET /api/v1/jira/boards
 */
export const getBoards = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const cloudId = (req.query.cloudId as string)?.trim() || undefined;

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({
        success: false,
        error: 'Jira not connected',
      });
      return;
    }

    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required. Specify cloudId query param or connect Jira.',
      });
      return;
    }

    const boards = await getJiraBoards(accessToken, cloudIdToUse);

    res.json({
      success: true,
      data: boards,
    });
  } catch (error) {
    logger.error('Get Jira boards error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to get Jira boards';
    const status = msg.includes('404') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: msg,
    });
  }
};

/**
 * Get board configuration (columns with status names)
 * GET /api/v1/jira/board-configuration?boardId=X&cloudId=Y
 */
export const getBoardConfigurationHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const boardId = (req.query.boardId as string)?.trim();
    const cloudId = (req.query.cloudId as string)?.trim() || undefined;

    if (!boardId) {
      res.status(400).json({
        success: false,
        error: 'boardId is required',
      });
      return;
    }

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({
        success: false,
        error: 'Jira not connected',
      });
      return;
    }

    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required',
      });
      return;
    }

    const [config, statusMap] = await Promise.all([
      getBoardConfiguration(accessToken, cloudIdToUse, boardId),
      getJiraStatuses(accessToken, cloudIdToUse),
    ]);

    const columns = (config.columns || []).map((col) => {
      const statusNames = (col.statuses || [])
        .map((s) => statusMap[s.id] ?? s.id)
        .filter(Boolean);
      return {
        name: col.name ?? '',
        statusNames: statusNames.length > 0 ? statusNames : [col.name ?? ''],
      };
    });

    res.json({
      success: true,
      data: { columns },
    });
  } catch (error) {
    logger.error('Get board configuration error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to get board configuration';
    const status = msg.includes('404') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: msg,
    });
  }
};

/**
 * Get Jira issues (for Bugs tab)
 * GET /api/v1/jira/issues
 * With boardId: Agile API GET /rest/agile/1.0/board/{boardId}/issue
 * With spaceKey: GET /rest/agile/1.0/board?projectKeyOrId={spaceKey} → board/{boardId}/issue
 * Without boardId/spaceKey: JQL search by projectKey
 */
export const getIssues = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const boardId = (req.query.boardId as string)?.trim() || undefined;
    const spaceKey = (req.query.spaceKey as string)?.trim() || undefined;
    const projectKey = (req.query.projectKey as string)?.trim() || undefined;
    const cloudId = (req.query.cloudId as string)?.trim() || undefined;
    const issueType = (req.query.issueType as string)?.trim() || undefined;
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const issueTypeJql = issueType
      ? issueType
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => `"${t}"`)
          .join(', ')
      : null;

    if (projectKey && !JIRA_PROJECT_KEY_REGEX.test(projectKey)) {
      res.status(400).json({
        success: false,
        error: 'Invalid projectKey. Use alphanumeric, optionally with - or _.',
      });
      return;
    }
    if (spaceKey && !JIRA_PROJECT_KEY_REGEX.test(spaceKey)) {
      res.status(400).json({
        success: false,
        error: 'Invalid spaceKey. Use alphanumeric, optionally with - or _.',
      });
      return;
    }

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({
        success: false,
        error: 'Jira not connected',
      });
      return;
    }

    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required. Specify cloudId query param or connect Jira.',
      });
      return;
    }

    let issues: JiraIssueListItem[];
    let total: number;

    const boardJql = issueTypeJql ? `issuetype in (${issueTypeJql})` : undefined;

    const isIssuetypeNotFoundError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('issuetype') && msg.includes('does not exist');
    };

    const fetchWithIssuetypeFallback = async (useJql: boolean) => {
      const jqlToUse = useJql ? boardJql : undefined;
      if (boardId) {
        return getBoardIssues(accessToken, cloudIdToUse, boardId, offset, limit, jqlToUse);
      }
      if (spaceKey) {
        const boards = await getJiraBoards(accessToken, cloudIdToUse, spaceKey);
        if (boards.length === 0) {
          res.status(404).json({
            success: false,
            error: `No board found for space/project ${spaceKey}`,
          });
          throw new Error('NO_BOARD'); // signal to stop, response already sent
        }
        return getBoardIssues(accessToken, cloudIdToUse, boards[0].id, offset, limit, jqlToUse);
      }
      const jqlParts: string[] = [];
      if (projectKey) jqlParts.push(`project = ${projectKey}`);
      else jqlParts.push('project is not empty');
      if (useJql && issueTypeJql) jqlParts.push(`AND issuetype in (${issueTypeJql})`);
      jqlParts.push('ORDER BY updated DESC');
      return searchJiraIssues(accessToken, cloudIdToUse, jqlParts.join(' '), offset, limit);
    };

    try {
      const result = await fetchWithIssuetypeFallback(!!boardJql);
      issues = result.issues;
      total = result.total;
    } catch (err) {
      if (boardJql && isIssuetypeNotFoundError(err)) {
        logger.warn('Jira issuetype filter invalid, retrying without filter', { issueType });
        const result = await fetchWithIssuetypeFallback(false);
        issues = result.issues;
        total = result.total;
      } else {
        throw err;
      }
    }

    // Build columns: include ALL columns (including empty) for frontend to display
    const issueStatusNames = [...new Set(issues.map((i) => i.status?.name).filter(Boolean))] as string[];
    let columns: { name: string; statusNames: string[] }[] = [];

    const effectiveBoardId = boardId ?? (spaceKey ? (await getJiraBoards(accessToken, cloudIdToUse, spaceKey))[0]?.id : undefined);
    const projectKeyForStatuses = projectKey || spaceKey || issues[0]?.project?.key;

    if (effectiveBoardId) {
      try {
        const [config, statusMap] = await Promise.all([
          getBoardConfiguration(accessToken, cloudIdToUse, effectiveBoardId),
          getJiraStatuses(accessToken, cloudIdToUse),
        ]);
        columns = (config.columns || []).map((col) => {
          const statusNames = (col.statuses || [])
            .map((s) => statusMap[s.id] ?? s.id)
            .filter(Boolean);
          return {
            name: col.name ?? '',
            statusNames: statusNames.length > 0 ? statusNames : [col.name ?? ''],
          };
        });
      } catch {
        // Board config requires admin scope; fallback to project statuses
      }
    }

    // If no columns from board config (401/empty), use project statuses so empty columns appear
    if (columns.length === 0 && projectKeyForStatuses) {
      const projectStatusNames = await getProjectStatuses(accessToken, cloudIdToUse, projectKeyForStatuses);
      for (const name of projectStatusNames) {
        columns.push({ name, statusNames: [name] });
      }
    }

    const statusNamesInColumns = new Set(columns.flatMap((c) => c.statusNames));
    for (const name of issueStatusNames) {
      if (name && !statusNamesInColumns.has(name)) {
        columns.push({ name, statusNames: [name] });
        statusNamesInColumns.add(name);
      }
    }

    res.json({
      success: true,
      data: issues,
      columns,
      total,
      limit,
      offset,
      timestamp: new Date().toISOString().replace(/\.\d{3}/, '') + 'Z',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'NO_BOARD') return; // response already sent
    logger.error('Get Jira issues error:', error);
    const status = msg.includes('404') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: msg,
    });
  }
};

/**
 * Create Jira issue (from Bugs board)
 * POST /api/v1/jira/issues
 */
export const createIssue = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { projectKey, summary, description, issueType, priority } = req.body;
    const cloudId = (req.body.cloudId as string)?.trim() || (req.query.cloudId as string)?.trim();

    if (!projectKey || !summary) {
      res.status(400).json({
        success: false,
        error: 'projectKey and summary are required',
      });
      return;
    }

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({
        success: false,
        error: 'Jira not connected',
      });
      return;
    }

    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required',
      });
      return;
    }

    const created = await createJiraIssue({
      accessToken,
      cloudId: cloudIdToUse,
      projectKey: String(projectKey).trim(),
      summary: String(summary).trim(),
      description: description ? String(description) : undefined,
      issueType: issueType ? String(issueType) : 'Bug',
      priority: priority ? String(priority) : 'Medium',
    });

    res.status(201).json({
      success: true,
      data: {
        key: created.key,
        id: created.id,
        summary: req.body.summary,
        self: created.self,
      },
    });
  } catch (error) {
    logger.error('Create Jira issue error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create Jira issue',
    });
  }
};

/**
 * Update Jira issue fields (summary, description, priority)
 * PUT /api/v1/jira/issues
 */
export const updateIssue = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { issueKey, summary, description, priority, cloudId: bodyCloudId } = req.body;
    const cloudId = (bodyCloudId as string)?.trim() || (req.query.cloudId as string)?.trim();

    if (!issueKey) {
      res.status(400).json({
        success: false,
        error: 'issueKey is required',
      });
      return;
    }

    if (summary === undefined && description === undefined && priority === undefined) {
      res.status(400).json({
        success: false,
        error: 'At least one of summary, description, or priority is required',
      });
      return;
    }

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({
        success: false,
        error: 'Jira not connected',
      });
      return;
    }

    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required',
      });
      return;
    }

    await updateJiraIssueFields({
      accessToken,
      cloudId: cloudIdToUse,
      issueKey: String(issueKey).trim(),
      summary: summary !== undefined ? String(summary) : undefined,
      description: description !== undefined ? String(description) : undefined,
      priority: priority !== undefined ? String(priority) : undefined,
    });

    res.json({
      success: true,
      message: 'Issue updated',
    });
  } catch (error) {
    logger.error('Update Jira issue error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update Jira issue',
    });
  }
};

/**
 * Update Jira issue status (PATCH)
 * PATCH /api/v1/jira/issues
 */
export const updateIssueStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { issueKey, status } = req.body;
    const cloudId = (req.body.cloudId as string)?.trim() || (req.query.cloudId as string)?.trim();

    if (!issueKey || !status) {
      res.status(400).json({
        success: false,
        error: 'issueKey and status are required',
      });
      return;
    }

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({
        success: false,
        error: 'Jira not connected',
      });
      return;
    }

    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({
        success: false,
        error: 'Cloud ID is required',
      });
      return;
    }

    await transitionJiraIssue(accessToken, cloudIdToUse, String(issueKey).trim(), String(status).trim());

    res.json({
      success: true,
      message: 'Issue status updated',
    });
  } catch (error) {
    logger.error('Update Jira issue status error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update issue status',
    });
  }
};

/**
 * Get Jira connection status
 * GET /api/v1/jira/status
 */
export const getConnectionStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { data, error } = await supabaseAdmin
      .from('jira_tokens')
      .select('cloud_id, site_url')
      .eq('user_id', userId);
    if (error) {
      logger.error('Failed to get Jira connection status', error);
      res.status(500).json({ success: false, error: 'Failed to get Jira connection status' });
      return;
    }
    const connections = (data || []).map((c) => ({
      cloud_id: c.cloud_id,
      cloudId: c.cloud_id,
      site_url: c.site_url,
    }));
    res.json({
      success: true,
      connections,
      connected: connections.length > 0,
    });
  } catch (error) {
    logger.error('Get Jira connection status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get Jira connection status' });
  }
};

/**
 * Disconnect Jira account(s)
 * DELETE /api/v1/jira/disconnect
 */
export const disconnectJira = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const cloudId = req.query.cloudId as string | undefined;
    let query = supabaseAdmin.from('jira_tokens').delete().eq('user_id', userId);
    if (cloudId) {
      query = query.eq('cloud_id', cloudId);
    }
    const { error } = await query;
    if (error) {
      logger.error('Failed to disconnect Jira', error);
      res.status(500).json({ success: false, error: 'Failed to disconnect Jira' });
      return;
    }
    res.json({ success: true, message: 'Jira disconnected' });
  } catch (error) {
    logger.error('Disconnect Jira error:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect Jira' });
  }
};

/**
 * Get all Jira connections
 * GET /api/v1/jira/connections
 */
export const getConnections = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { data, error } = await supabaseAdmin
      .from('jira_tokens')
      .select('cloud_id, site_url, created_at')
      .eq('user_id', userId);
    if (error) {
      logger.error('Failed to get Jira connections', error);
      res.status(500).json({ success: false, error: 'Failed to get Jira connections' });
      return;
    }
    res.json({
      success: true,
      connections: data || [],
      count: data ? data.length : 0,
    });
  } catch (error) {
    logger.error('Get Jira connections error:', error);
    res.status(500).json({ success: false, error: 'Failed to get Jira connections' });
  }
};

/** Jira sync settings shape (project.settings.integrations.jira) */
export interface JiraSyncSettings {
  syncOnCreate?: boolean;
  autoSyncIssues?: boolean;
  projectKey?: string;
  /** Status name to move issue to when sending back to rework (e.g. "To Do", "Rework") */
  reworkStatusName?: string;
}

/**
 * Resolve projectId from projectId or workspaceId (uses first project in workspace)
 */
async function resolveProjectId(userId: string, projectId?: string, workspaceId?: string): Promise<string | null> {
  if (projectId?.trim()) {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', projectId.trim())
      .eq('user_id', userId)
      .maybeSingle();
    return data?.id ?? null;
  }
  if (workspaceId?.trim()) {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('workspace_id', workspaceId.trim())
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }
  return null;
}

/**
 * Get Jira sync settings for a project
 * GET /api/v1/jira/settings?projectId=... or ?workspaceId=...
 */
export const getJiraSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const projectId = (req.query.projectId as string)?.trim();
    const workspaceId = (req.query.workspaceId as string)?.trim();

    const resolvedId = await resolveProjectId(userId, projectId, workspaceId);
    if (!resolvedId) {
      res.status(400).json({ success: false, error: 'projectId or workspaceId is required' });
      return;
    }

    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('id, settings')
      .eq('id', resolvedId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const jira = (project.settings as any)?.integrations?.jira || {};
    const settings: JiraSyncSettings = {
      syncOnCreate: jira.syncOnCreate ?? false,
      autoSyncIssues: jira.autoSyncIssues ?? true,
      projectKey: jira.projectKey || undefined,
      reworkStatusName: jira.reworkStatusName || undefined,
    };

    res.json({ success: true, data: settings, projectId: resolvedId });
  } catch (error) {
    logger.error('Get Jira settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to get Jira settings' });
  }
};

/**
 * Update Jira sync settings for a project
 * PUT /api/v1/jira/settings
 * Body: { projectId?, workspaceId?, syncOnCreate?, autoSyncIssues?, projectKey? }
 */
export const updateJiraSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { projectId, workspaceId, syncOnCreate, autoSyncIssues, projectKey, reworkStatusName } = req.body;

    const resolvedId = await resolveProjectId(
      userId,
      typeof projectId === 'string' ? projectId.trim() : undefined,
      typeof workspaceId === 'string' ? workspaceId.trim() : undefined
    );
    if (!resolvedId) {
      res.status(400).json({ success: false, error: 'projectId or workspaceId is required' });
      return;
    }

    const { data: project, error: fetchError } = await supabaseAdmin
      .from('projects')
      .select('id, settings, workspace_id')
      .eq('id', resolvedId)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchError || !project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const currentSettings = (project.settings as any) || {};
    const currentIntegrations = currentSettings.integrations || {};
    const currentJira = currentIntegrations.jira || {};

    const updates: JiraSyncSettings = { ...currentJira };
    if (typeof syncOnCreate === 'boolean') updates.syncOnCreate = syncOnCreate;
    if (typeof autoSyncIssues === 'boolean') updates.autoSyncIssues = autoSyncIssues;
    if (projectKey !== undefined) updates.projectKey = projectKey ? String(projectKey).trim() : undefined;
    if (reworkStatusName !== undefined) updates.reworkStatusName = reworkStatusName ? String(reworkStatusName).trim() : undefined;

    const newSettings = {
      ...currentSettings,
      integrations: {
        ...currentIntegrations,
        jira: updates,
      },
    };

    const { error: updateError } = await supabaseAdmin
      .from('projects')
      .update({ settings: newSettings })
      .eq('id', resolvedId)
      .eq('user_id', userId);

    if (updateError) {
      logger.error('Update Jira settings error', { error: updateError, projectId: resolvedId });
      res.status(500).json({ success: false, error: 'Failed to update Jira settings' });
      return;
    }

    // Invalidate projects cache — project settings changed
    if ((project as any).workspace_id) {
      await cache.delByPattern(`qait:cache:projects:ws:${(project as any).workspace_id}:*`);
    }
    await cache.delByPattern(`qait:cache:projects:user:*`);

    res.json({ success: true, data: updates });
  } catch (error) {
    logger.error('Update Jira settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to update Jira settings' });
  }
};

/**
 * Analyze Jira task for QA: run test, send to rework, or prepare manual test case
 * POST /api/v1/jira/qa-analyze
 * Body: { issueKey, projectId, cloudId? }
 */
export const qaAnalyze = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { issueKey, projectId, cloudId } = req.body;

    if (!issueKey || !projectId) {
      res.status(400).json({
        success: false,
        error: 'issueKey and projectId are required',
      });
      return;
    }

    const settings = await JiraQaOrchestratorService.getProjectJiraQaSettings(
      String(projectId).trim(),
      userId
    );

    const result = await JiraQaOrchestratorService.analyzeAndExecute({
      issueKey: String(issueKey).trim(),
      projectId: String(projectId).trim(),
      userId,
      cloudId: cloudId ? String(cloudId).trim() : undefined,
      reworkStatusName: settings.reworkStatusName,
    });

    if (!result.success && result.error) {
      res.status(500).json({
        success: false,
        error: result.error,
        outcome: result.outcome,
      });
      return;
    }

    res.json({
      success: result.success,
      outcome: result.outcome,
      message: result.message,
      testId: result.testId,
      testCaseId: result.testCaseId,
    });
  } catch (error) {
    logger.error('Jira QA analyze error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze Jira task',
    });
  }
};

type JiraTicketType = 'api' | 'web_ui';

function createBackgroundResponse(meta: { sessionId?: string; tag: string }): Response {
  const resLike: any = {
    headersSent: false,
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.headersSent = true;
      logger.info(`[${meta.tag}] Background handler produced HTTP-style response (suppressed)`, {
        sessionId: meta.sessionId,
        statusCode: this.statusCode,
        keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      });
      return this;
    },
  };
  return resLike as Response;
}

function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const abs = text.match(/\bhttps?:\/\/[^\s)]+/i);
  if (abs?.[0]) return abs[0].replace(/[),.]+$/g, '');
  const domain = text.match(/\b([a-z0-9.-]+\.[a-z]{2,})(\/[^\s)]*)?/i);
  if (domain?.[0]) return normalizeUrl(domain[0].replace(/[),.]+$/g, ''));
  return null;
}

function inferTicketType(body: any): JiraTicketType {
  const apiTest = body?.apiTest;
  if (!apiTest || typeof apiTest !== 'object' || Array.isArray(apiTest)) return 'web_ui';
  const url = typeof apiTest.url === 'string' ? apiTest.url.trim() : '';
  if (url.length > 0) return 'api';
  return 'web_ui';
}

/**
 * Run Jira ticket through the same flow as POST /api/v1/chat.
 * Intended endpoint: POST /api/v1/jira/intent-test-cases/from-jira
 */
/** Allowed context keys that can be forwarded from the client to handleChat */
const ALLOWED_CONTEXT_KEYS = new Set([
  'projectId',
  'editorMode',
  'previewSessionId',
  'pageContext',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runFromJiraViaChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = (req.body || {}) as any;
    const { projectId, sessionId, conversationId, context, ticket, apiTest, issueKey } = body;

    const summaryRaw = ticket?.summary ?? body?.summary;
    const descriptionRaw = ticket?.description ?? body?.description;

    const summary = typeof summaryRaw === 'string' ? summaryRaw.trim() : '';
    const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : '';

    if (!summary) {
      res.status(400).json({ error: 'Missing required ticket.summary (or title)' });
      return;
    }

    // Resolve and validate projectId
    const resolvedProjectId = typeof projectId === 'string' ? projectId.trim() : (
      typeof context?.projectId === 'string' ? context.projectId.trim() : undefined
    );

    if (resolvedProjectId) {
      if (!UUID_REGEX.test(resolvedProjectId)) {
        res.status(400).json({ error: 'Invalid projectId format' });
        return;
      }

      // Verify the user owns this project
      const { data: project, error: projectError } = await supabaseAdmin
        .from('projects')
        .select('user_id')
        .eq('id', resolvedProjectId)
        .maybeSingle();

      if (projectError || !project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      if (project.user_id !== userId) {
        res.status(403).json({ error: 'Access denied to specified project' });
        return;
      }
    }

    const mergedMessage = [summary, description].filter(Boolean).join('\n\n');
    const resolvedSessionId =
      typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : randomUUID();

    // Hard requirement: frontend has a 30s HTTP timeout.
    // We must ACK quickly and do the heavy work in background.
    // Ticket type is inferred deterministically (no LLM calls here).
    const ticketType: JiraTicketType = inferTicketType(body);

    logger.info('[JIRA_CONTROLLER] Jira from-ticket ticketType:', { ticketType });

    // Build context with whitelisted keys only — prevents arbitrary key injection
    const safeContext: Record<string, any> = {};
    if (typeof context === 'object' && context !== null && !Array.isArray(context)) {
      for (const key of Object.keys(context)) {
        if (ALLOWED_CONTEXT_KEYS.has(key)) {
          safeContext[key] = context[key];
        }
      }
    }

    const nextContext: Record<string, any> = {
      ...safeContext,
      projectId: resolvedProjectId,
      source: 'jira_from_ticket',
      jira: {
        issueKey: typeof issueKey === 'string' ? issueKey.trim() : null,
        testType: ticketType,
      },
    };

    if (ticketType === 'api') {
      // Force API flow so the run is stored via API test path.
      nextContext.action = 'run_api_test';
      if (apiTest && typeof apiTest === 'object' && !Array.isArray(apiTest)) {
        nextContext.apiTest = apiTest;
      }
    }

    // Ensure workspace + chat session exist so WebSocket + history writes work reliably.
    const workspace_id = await checkWorkspace(userId, resolvedSessionId);
    const chatSessionId = await getOrCreateWorkspaceChat(userId, workspace_id, resolvedSessionId);

    logger.info('[JIRA_CONTROLLER] Jira from-ticket accepted (background processing)', {
      userId,
      projectId: resolvedProjectId,
      issueKey: issueKey || null,
      testType: ticketType,
      sessionId: chatSessionId || resolvedSessionId,
      messageLength: mergedMessage.length,
      hasDescription: !!description,
    });

    // Respond immediately (<30s) so frontend doesn't time out.
    res.status(200).json({
      success: true,
      accepted: true,
      sessionId: chatSessionId || resolvedSessionId,
      workspaceId: workspace_id,
      ticketType,
      message: 'Jira ticket accepted. Processing started in background.',
      timestamp: new Date().toISOString(),
    });

    // Continue in background (never touch the real HTTP response again).
    setImmediate(() => {
      (async () => {
        const tag = 'JIRA_FROM_TICKET_BG';
        const bgRes = createBackgroundResponse({ sessionId: chatSessionId || resolvedSessionId, tag });
        const bgReq = {} as Request;

        try {
          if (ticketType === 'api') {
            const api = nextContext?.apiTest || apiTest;
            const apiUrl = typeof api?.url === 'string' ? api.url.trim() : '';
            const apiMethod = typeof api?.method === 'string' ? api.method.trim().toUpperCase() : 'GET';

            const parsedIntent = {
              intent: 'api_test',
              confidence: 1,
              intent_confidence: 1,
              rawText: mergedMessage,
              apiUrl,
              apiMethod,
              apiHeaders: api?.headers,
              apiBody: api?.body,
              agentLevel: api?.level || api?.agentLevel,
              metadata: {
                source: 'jira_from_ticket',
                issueKey: nextContext?.jira?.issueKey || null,
              },
            };

            await handleApiTest(bgReq, bgRes, {
              message: mergedMessage,
              parsedIntent,
              userId,
              workspace_id,
              chatSessionId: chatSessionId || resolvedSessionId,
              conversationId,
              context: nextContext,
            } as any);
            return;
          }

          // platform_test (web UI)
          const urlCandidate =
            (typeof nextContext?.pageContext?.url === 'string' ? nextContext.pageContext.url : '') ||
            extractFirstUrl(mergedMessage) ||
            '';

          const page = urlCandidate ? normalizeUrl(urlCandidate) : null;

          if (!page) {
            const parsedIntent = {
              intent: 'needs_clarification',
              confidence: 0.3,
              rawText: mergedMessage,
              clarificationQuestion:
                'Нужна ссылка на страницу для UI-теста. Пришлите URL (например: https://example.com) или добавьте его в описание тикета.',
              possibleIntents: ['platform_test', 'api_test', 'general_chat'],
              clarificationReason: 'Missing URL for platform_test in Jira ticket context',
              metadata: { source: 'jira_from_ticket' },
            };

            await handleClarificationRequest(bgReq, bgRes, {
              parsedIntent,
              userId,
              chatSessionId: chatSessionId || resolvedSessionId,
            });
            return;
          }

          const parsedIntent = {
            intent: 'platform_test',
            confidence: 1,
            intent_confidence: 1,
            rawText: mergedMessage,
            page,
            scope: 'general',
            target: summary || null,
            metadata: {
              source: 'jira_from_ticket',
              issueKey: nextContext?.jira?.issueKey || null,
            },
          };

          await handlePlatformTest(bgReq, bgRes, {
            message: mergedMessage,
            parsedIntent,
            userId,
            workspace_id,
            chatSessionId: chatSessionId || resolvedSessionId,
            conversationId,
            context: nextContext,
            mode: 'lite',
          } as any);
        } catch (bgError) {
          logger.error('[JIRA_CONTROLLER] Background Jira from-ticket processing failed', {
            error: bgError instanceof Error ? bgError.message : String(bgError),
            stack: bgError instanceof Error ? bgError.stack : undefined,
            userId,
            sessionId: chatSessionId || resolvedSessionId,
            issueKey: nextContext?.jira?.issueKey || null,
          });
        }
      })().catch((unhandled) => {
        logger.error('[JIRA_CONTROLLER] Unhandled background error (from-ticket)', {
          error: unhandled instanceof Error ? unhandled.message : String(unhandled),
          stack: unhandled instanceof Error ? unhandled.stack : undefined,
        });
      });
    });
  } catch (error) {
    logger.error('[JIRA_CONTROLLER] Failed to run Jira from-ticket flow', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to run Jira ticket through chat flow',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
