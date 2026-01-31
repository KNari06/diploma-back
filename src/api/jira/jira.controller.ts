import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
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
  getBoardIssues,
  searchJiraIssues,
  createJiraIssue,
  transitionJiraIssue,
  updateJiraIssueFields,
} from '@/services/api/jira.service';
import { supabaseAdmin } from '@/db/supabase';
import type { JiraIssueListItem } from '@/types';

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

    if (error) {
      logger.error('Jira OAuth error', { error });
      res.status(400).json({
        success: false,
        error: `OAuth error: ${error}`,
      });
      return;
    }

    if (!code || !state) {
      res.status(400).json({
        success: false,
        error: 'Missing code or state parameter',
      });
      return;
    }

    // Validate state
    const stateData = oauthStates.get(state as string);
    if (!stateData || stateData.expiresAt < Date.now()) {
      res.status(400).json({
        success: false,
        error: 'Invalid or expired state parameter',
      });
      return;
    }

    const userId = stateData.userId;
    if (!userId) {
      res.status(400).json({
        success: false,
        error: 'User ID not found in state',
      });
      return;
    }

    // Clean up state
    oauthStates.delete(state as string);

    // Exchange code for token
    const tokenData = await exchangeCodeForToken(code as string);

    // Get accessible resources (cloud IDs)
    const resources = await getAccessibleResources(tokenData.access_token);

    if (resources.length === 0) {
      res.status(400).json({
        success: false,
        error: 'No accessible Jira resources found',
      });
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

    // Redirect to success page or return JSON
    res.json({
      success: true,
      message: 'Jira authorization successful',
      resources: resources.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
      })),
      tokensSaved: savedTokens.length,
    });
  } catch (error) {
    logger.error('Jira OAuth callback error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process OAuth callback',
    });
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

    // Build columns: board config + any status from issues not in config (auto-add missing columns)
    const issueStatusNames = [...new Set(issues.map((i) => i.status?.name).filter(Boolean))] as string[];
    let columns: { name: string; statusNames: string[] }[] = [];

    const effectiveBoardId = boardId ?? (spaceKey ? (await getJiraBoards(accessToken, cloudIdToUse, spaceKey))[0]?.id : undefined);
    if (effectiveBoardId) {
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
    const { projectId, workspaceId, syncOnCreate, autoSyncIssues, projectKey } = req.body;

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
      .select('id, settings')
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

    res.json({ success: true, data: updates });
  } catch (error) {
    logger.error('Update Jira settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to update Jira settings' });
  }
};
