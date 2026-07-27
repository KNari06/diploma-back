import { Request, Response } from 'express';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { handlePlatformTest } from '@/api/chat/ai_test/handler';
import { handleApiTest } from '@/api/chat/api_test/handler';
import { handleClarificationRequest } from '@/api/chat/shared/clarification';
import { checkWorkspace } from '@/api/chat/shared/validation';
import { getOrCreateWorkspaceChat, normalizeUrl } from '@/api/chat/shared/utils';
import { extractFirstUrl } from '@/utils/parsing/url-scope';
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
  addJiraComment,
} from '@/services/api/jira.service';
// Barrel import — registers every TaskTrackerProvider as a side effect.
import { TrackerRegistry } from '@/services/integrations/tracker';
import { supabaseAdmin } from '@/db/supabase';
import { JiraQaOrchestratorService, type JiraQaAnalysisResult } from '@/services/integrations/jira-qa-orchestrator.service';
import { HandoffService } from '@/services/testing/analysis/handoff.service';
import { JiraWebhookService } from '@/services/integrations/jira-webhook-jira.service';
import { suggestQaStatuses } from '@/services/integrations/qa-status-heuristic';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import type { JiraIssueListItem } from '@/types';
import { randomUUID, randomBytes } from 'crypto';

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
    const message = error instanceof Error ? error.message : 'Failed to get projects';
    const isConfigError = /not configured|must be configured|not set/i.test(message);
    const isAuthError = /expired|reconnect|refresh/i.test(message);
    logger.error('Get Jira projects error:', error);
    res.status(isConfigError ? 503 : isAuthError ? 401 : 500).json({
      success: false,
      error: isConfigError ? 'Jira integration not configured on server' : message,
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

    void WorkspaceAuditService.logForUser({
      actorUserId: userId,
      eventType: AUDIT_EVENTS.JIRA_ISSUE_CREATED,
      targetType: 'jira_issue',
      targetId: created.key,
      metadata: {
        project_key: String(projectKey).trim(),
        summary: String(summary).trim(),
        issue_type: issueType ? String(issueType) : 'Bug',
        priority: priority ? String(priority) : 'Medium',
      },
      ...getAuditContext(req),
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

    const changedFields = Object.entries({ summary, description, priority })
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    void WorkspaceAuditService.logForUser({
      actorUserId: userId,
      eventType: AUDIT_EVENTS.JIRA_ISSUE_UPDATED,
      targetType: 'jira_issue',
      targetId: String(issueKey).trim(),
      metadata: { changed_fields: changedFields },
      ...getAuditContext(req),
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

    void WorkspaceAuditService.logForUser({
      actorUserId: userId,
      eventType: AUDIT_EVENTS.JIRA_ISSUE_STATUS_CHANGED,
      targetType: 'jira_issue',
      targetId: String(issueKey).trim(),
      metadata: { new_status: String(status).trim() },
      ...getAuditContext(req),
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

    void WorkspaceAuditService.logForUser({
      actorUserId: userId,
      eventType: AUDIT_EVENTS.JIRA_DISCONNECTED,
      targetType: 'jira_connection',
      metadata: { cloud_id: cloudId },
      ...getAuditContext(req),
    });
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
  /** Status to transition source issue to when test PASSES (e.g. "Done", "Verified") */
  doneStatusName?: string;
  /** Status to transition source issue to when test FAILS / has bugs (e.g. "In Progress", "Reopened") */
  failStatusName?: string;
  /**
   * Hybrid autonomy: when true, a READY ticket does NOT auto-run — the agent
   * posts the handoff + branch options and waits for a human to pick a branch.
   * Default false (fully autonomous).
   */
  requireApprovalBeforeRun?: boolean;
  /**
   * Auto-trigger statuses: when a ticket transitions INTO any of these Jira
   * statuses, a webhook makes the agent auto-ASSESS it (never auto-runs). Each
   * team picks from THEIR real board statuses, so names differ per team. Matched
   * by stable status `id` (survives renames); `name` is kept for display + as a
   * fallback match. Auto-assessment is active only when this is non-empty AND
   * webhookSecret is set.
   */
  qaTriggerStatuses?: Array<{ id: string; name: string }>;
  /**
   * @deprecated Legacy single trigger-column NAME. Still read for back-compat
   * (treated as one name-only entry) but new configs use qaTriggerStatuses.
   */
  qaColumnName?: string;
  /**
   * Per-project shared secret for verifying the Jira webhook (HMAC). Generated
   * on demand; registered in the Jira webhook config alongside the URL.
   */
  webhookSecret?: string;
}

/**
 * Read the effective trigger statuses from a stored jira settings blob,
 * normalizing the new array shape and folding in the legacy `qaColumnName`
 * (name-only, id unknown → empty id, matched by name fallback). De-duped.
 */
function normalizeTriggerStatuses(jira: any): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const push = (id: unknown, name: unknown) => {
    const n = typeof name === 'string' ? name.trim() : '';
    const i = typeof id === 'string' ? id.trim() : '';
    if (!n && !i) return;
    const key = i || n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: i, name: n });
  };
  if (Array.isArray(jira?.qaTriggerStatuses)) {
    for (const s of jira.qaTriggerStatuses) push(s?.id, s?.name);
  }
  if (typeof jira?.qaColumnName === 'string' && jira.qaColumnName.trim()) {
    push('', jira.qaColumnName); // legacy name-only entry
  }
  return out;
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
      doneStatusName: jira.doneStatusName || undefined,
      failStatusName: jira.failStatusName || undefined,
      requireApprovalBeforeRun: jira.requireApprovalBeforeRun === true,
      qaTriggerStatuses: normalizeTriggerStatuses(jira),
      webhookSecret: jira.webhookSecret || undefined,
    };

    // The URL to register in Jira's webhook config (System → WebHooks).
    const base = (env.BACKEND_URL || `http://localhost:${env.PORT}`).replace(/\/api\/?$/, '').replace(/\/+$/, '');
    const webhookUrl = `${base}/api/${env.API_VERSION}/jira/webhook`;

    res.json({ success: true, data: settings, projectId: resolvedId, webhookUrl });
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
    const { projectId, workspaceId, syncOnCreate, autoSyncIssues, projectKey, reworkStatusName, doneStatusName, failStatusName, requireApprovalBeforeRun, qaTriggerStatuses, generateWebhookSecret } = req.body;

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
    if (doneStatusName !== undefined) updates.doneStatusName = doneStatusName ? String(doneStatusName).trim() : undefined;
    if (failStatusName !== undefined) updates.failStatusName = failStatusName ? String(failStatusName).trim() : undefined;
    if (typeof requireApprovalBeforeRun === 'boolean') updates.requireApprovalBeforeRun = requireApprovalBeforeRun;
    if (qaTriggerStatuses !== undefined) {
      // Sanitize to [{id,name}] (both strings, at least one non-empty), cap 20.
      const clean = Array.isArray(qaTriggerStatuses)
        ? qaTriggerStatuses
            .map((s: any) => ({ id: typeof s?.id === 'string' ? s.id.trim() : '', name: typeof s?.name === 'string' ? s.name.trim() : '' }))
            .filter((s: { id: string; name: string }) => s.id || s.name)
            .slice(0, 20)
        : [];
      updates.qaTriggerStatuses = clean;
      // New config supersedes the legacy single-name field.
      updates.qaColumnName = undefined;
    }
    // Secret is generated server-side (never accepted from the client). Client
    // sends generateWebhookSecret:true to (re)issue it.
    if (generateWebhookSecret === true) updates.webhookSecret = randomBytes(24).toString('hex');

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
 * List a Jira project's statuses as [{id,name}] — powers the trigger-status
 * picker in settings (so teams choose from their REAL columns, matched by id).
 * GET /api/v1/jira/statuses?projectKey=...&cloudId=...
 */
export const getJiraStatusesForPicker = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const projectKey = (req.query.projectKey as string)?.trim();
    const cloudId = (req.query.cloudId as string)?.trim() || undefined;

    if (!projectKey || !JIRA_PROJECT_KEY_REGEX.test(projectKey)) {
      res.status(400).json({ success: false, error: 'Valid projectKey is required' });
      return;
    }

    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData) {
      res.status(403).json({ success: false, error: 'Jira not connected' });
      return;
    }
    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    if (!cloudIdToUse) {
      res.status(400).json({ success: false, error: 'Cloud ID is required' });
      return;
    }

    // Resolved through the tracker registry, not jira.service directly, so this
    // endpoint is provider-agnostic the moment a second tracker registers.
    const statuses = await TrackerRegistry.get('jira').listStatuses(
      { accessToken, externalId: cloudIdToUse },
      projectKey,
    );
    // Pre-select QA-like statuses so the picker feels smart; the user confirms.
    const suggestedIds = suggestQaStatuses(statuses).map((s) => s.id);
    res.json({ success: true, data: statuses, suggestedIds });
  } catch (error) {
    logger.error('Get Jira statuses error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to get statuses' });
  }
};

/**
 * Jira webhook receiver — auto-ASSESS a ticket when it enters a project's QA
 * column. Public (no Bearer): Atlassian posts a raw JSON body; the shared secret
 * is passed in the URL (?secret=...). Verifies the secret + column transition,
 * then runs the assessment core (assess-only — NEVER auto-runs a test). Always
 * ACKs 200 fast and does the heavy work in the background; never throws.
 * POST /api/v1/jira/webhook?secret=...
 */
export const handleJiraWebhook = async (req: Request, res: Response): Promise<void> => {
  // Always ACK immediately so Jira doesn't retry/timeout.
  res.status(200).json({ received: true });

  if (!env.JIRA_WEBHOOK_ENABLED) return;

  setImmediate(() => {
    (async () => {
      try {
        // Raw body (express.raw) → JSON.
        let payload: any;
        try {
          const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
          payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          return; // unparseable body → drop silently
        }

        const providedSecret = typeof req.query.secret === 'string' ? req.query.secret : undefined;
        const parsed = JiraWebhookService.parse(payload);
        const trigger = await JiraWebhookService.resolveTrigger(parsed, providedSecret);
        if (!trigger) return; // no match / bad secret / not the trigger column → no-op

        // Cooldown: a Jira transition can fire several webhooks in a burst — only
        // the first assesses this ticket+status within the window (saves LLM calls
        // + avoids duplicate Jira comments).
        const claimed = await JiraWebhookService.claimAssessment(
          trigger.projectId, trigger.issueKey, trigger.matchedStatusId,
        );
        if (!claimed) {
          logger.info('[JIRA_WEBHOOK] Skipped — assessed recently (cooldown)', {
            issueKey: trigger.issueKey, projectId: trigger.projectId,
          });
          return;
        }

        logger.info('[JIRA_WEBHOOK] Auto-assess triggered', {
          issueKey: trigger.issueKey, projectId: trigger.projectId, status: trigger.matchedStatus,
        });

        // Assess-only: readiness + handoff + Jira comment. NO test run.
        const { analysis, issue, related } = await JiraQaOrchestratorService.assessReadiness({
          issueKey: trigger.issueKey,
          projectId: trigger.projectId,
          userId: trigger.userId,
          workspaceId: trigger.workspaceId,
        });

        // Resolve a chat session so the handoff surfaces in chat (best-effort).
        let chatSessionId: string | undefined;
        try {
          const workspace_id = await checkWorkspace(trigger.userId, randomUUID());
          chatSessionId = await getOrCreateWorkspaceChat(trigger.userId, workspace_id, randomUUID());
        } catch { /* chat emit is optional; Jira comment still posts */ }

        await HandoffService.buildAndPersist({
          projectId: trigger.projectId,
          issueKey: trigger.issueKey,
          analysis,
          issue,
          related,
          chatSessionId,
        });

        await postReadinessToJira(trigger.userId, trigger.issueKey, undefined, analysis);
      } catch (err) {
        logger.error('[JIRA_WEBHOOK] Background processing failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })().catch(() => { /* swallow — ACK already sent */ });
  });
};

/**
 * Get the QA handoff artifact for a ticket (structured readiness + status + gaps).
 * GET /api/v1/jira/handoff?issueKey=...&projectId=... (or ?workspaceId=...)
 * Access is checked server-side (owner OR workspace project) so the read is safe
 * regardless of the table's owner-only RLS.
 */
export const getJiraHandoff = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const issueKey = (req.query.issueKey as string)?.trim();
    const projectId = (req.query.projectId as string)?.trim();
    const workspaceId = (req.query.workspaceId as string)?.trim();

    if (!issueKey) {
      res.status(400).json({ success: false, error: 'issueKey is required' });
      return;
    }
    const resolvedId = await resolveProjectId(userId, projectId, workspaceId);
    if (!resolvedId) {
      res.status(400).json({ success: false, error: 'projectId or workspaceId is required' });
      return;
    }

    const handoff = await HandoffService.read(resolvedId, issueKey);
    if (!handoff) {
      res.status(404).json({ success: false, error: 'No handoff found for this issue' });
      return;
    }
    res.json({ success: true, data: handoff, projectId: resolvedId });
  } catch (error) {
    logger.error('Get Jira handoff error:', error);
    res.status(500).json({ success: false, error: 'Failed to get Jira handoff' });
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

    const trimmedProjectId = String(projectId).trim();

    const settings = await JiraQaOrchestratorService.getProjectJiraQaSettings(
      trimmedProjectId,
      userId
    );

    // Resolve workspaceId for context enrichment (non-fatal)
    let workspaceId: string | undefined;
    try {
      const { data: proj } = await supabaseAdmin
        .from('projects')
        .select('workspace_id')
        .eq('id', trimmedProjectId)
        .maybeSingle();
      workspaceId = proj?.workspace_id || undefined;
    } catch (err) {
      logger.warn('[JIRA_QA] Failed to resolve workspaceId', { projectId: trimmedProjectId, err });
    }

    const result = await JiraQaOrchestratorService.analyzeAndExecute({
      issueKey: String(issueKey).trim(),
      projectId: trimmedProjectId,
      userId,
      cloudId: cloudId ? String(cloudId).trim() : undefined,
      reworkStatusName: settings.reworkStatusName,
      workspaceId,
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


function inferTicketType(body: any): JiraTicketType {
  const apiTest = body?.apiTest;
  if (!apiTest || typeof apiTest !== 'object' || Array.isArray(apiTest)) return 'web_ui';
  const url = typeof apiTest.url === 'string' ? apiTest.url.trim() : '';
  if (url.length > 0) return 'api';
  return 'web_ui';
}

/** Human-readable readiness gate message shown in chat when a ticket is not ready. */
function buildReadinessClarification(analysis: JiraQaAnalysisResult): string {
  const r = analysis.readiness;
  const lines: string[] = [];
  lines.push(`This task isn't ready to test yet${r ? ` (readiness ${r.readinessScore}/100)` : ''}.`);
  if (r?.summary) lines.push(r.summary);

  const questions = r?.blockingQuestions?.length ? r.blockingQuestions : (analysis.reworkQuestions || []);
  if (questions.length) {
    lines.push('\nPlease clarify:');
    for (const q of questions) lines.push(`• ${q}`);
  }

  if (r?.coverageGaps?.length) {
    lines.push('\nBefore running, also consider these cases:');
    for (const g of r.coverageGaps) {
      const ref = g.relatedTicket ? ` [${g.relatedTicket}]` : '';
      lines.push(`• (${g.type}) ${g.title}${ref} — ${g.why}`);
    }
  }
  return lines.join('\n');
}

/** Post the readiness assessment (score + forgotten cases) back to the Jira issue. Best-effort. */
async function postReadinessToJira(
  userId: string,
  issueKey: string,
  cloudId: string | undefined,
  analysis: JiraQaAnalysisResult,
): Promise<void> {
  try {
    const r = analysis.readiness;
    if (!r) return;
    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData?.cloud_id) return;
    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;

    const lines: string[] = [
      `[QAI] Readiness: ${r.readinessScore}/100 — ${r.readyToTest ? 'ready to test' : 'NOT ready'}.`,
    ];
    if (r.summary) lines.push(r.summary);
    if (!r.readyToTest && r.blockingQuestions.length) {
      lines.push('\nBlocking questions:');
      r.blockingQuestions.forEach((q) => lines.push(`• ${q}`));
    }
    if (r.coverageGaps.length) {
      lines.push('\nForgotten cases to consider:');
      r.coverageGaps.forEach((g) => {
        const ref = g.relatedTicket ? ` [${g.relatedTicket}]` : '';
        lines.push(`• (${g.type}) ${g.title}${ref}`);
      });
    }
    await addJiraComment(accessToken, cloudIdToUse, issueKey, lines.join('\n'));
  } catch (err) {
    logger.warn('[JIRA_CONTROLLER] Failed to post readiness to Jira (non-fatal)', {
      issueKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    const { projectId, sessionId, conversationId, context, ticket, apiTest, issueKey, cloudId: bodyCloudId } = body;

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
          // ── Readiness gate + handoff (feature-flagged) ──────────────────
          // Before running: assess readiness + forgotten cases, persist a
          // structured handoff, and gate the run.
          //  - not ready (blocked)              → post blocking questions, STOP.
          //  - ready + requireApprovalBeforeRun → post branch options, STOP.
          //  - ready + autonomous               → fall through and run.
          if (env.JIRA_READINESS_ASSESSMENT_ENABLED && issueKey && resolvedProjectId) {
            try {
              const trimmedKey = String(issueKey).trim();
              const cloudIdTrimmed = typeof bodyCloudId === 'string' ? bodyCloudId.trim() : undefined;
              const { analysis, issue: assessedIssue, related } = await JiraQaOrchestratorService.assessReadiness({
                issueKey: trimmedKey,
                projectId: resolvedProjectId,
                userId,
                cloudId: cloudIdTrimmed,
                workspaceId: workspace_id,
              });
              const readiness = analysis.readiness;
              logger.info('[JIRA_CONTROLLER] Readiness assessed', {
                issueKey,
                readyToTest: readiness?.readyToTest,
                score: readiness?.readinessScore,
                gaps: readiness?.coverageGaps?.length ?? 0,
              });

              // Build + persist the structured handoff and emit it to chat.
              const handoff = await HandoffService.buildAndPersist({
                projectId: resolvedProjectId,
                issueKey: trimmedKey,
                cloudId: cloudIdTrimmed,
                analysis,
                issue: assessedIssue,
                related,
                chatSessionId: chatSessionId || resolvedSessionId,
              });

              // Post the assessment (score + forgotten cases) back to Jira, best-effort.
              await postReadinessToJira(userId, trimmedKey, bodyCloudId, analysis);

              // Not ready → clarify + STOP.
              if (handoff.status === 'blocked') {
                await handleClarificationRequest(bgReq, bgRes, {
                  parsedIntent: {
                    intent: 'needs_clarification',
                    confidence: 0.3,
                    rawText: mergedMessage,
                    clarificationQuestion: buildReadinessClarification(analysis),
                    possibleIntents: ['platform_test', 'api_test', 'general_chat'],
                    clarificationReason: 'Jira task not ready to test (readiness gate)',
                    metadata: { source: 'jira_from_ticket', readiness },
                  },
                  userId,
                  chatSessionId: chatSessionId || resolvedSessionId,
                });
                return;
              }

              // Hybrid autonomy: ready but the project requires human approval →
              // post branch options and STOP (don't auto-run).
              const jiraSettings = await JiraQaOrchestratorService.getProjectJiraQaSettings(resolvedProjectId, userId);
              if (jiraSettings.requireApprovalBeforeRun) {
                HandoffService.emitBranchChoice(chatSessionId || resolvedSessionId, handoff);
                logger.info('[JIRA_CONTROLLER] Ready but approval required — awaiting branch choice', { issueKey });
                return;
              }
            } catch (assessErr) {
              // Assessment failure must NOT block the run — degrade to old behaviour.
              logger.warn('[JIRA_CONTROLLER] Readiness assessment failed (non-fatal, proceeding to run)', {
                issueKey,
                error: assessErr instanceof Error ? assessErr.message : String(assessErr),
              });
            }
          }

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
                // Tag the run so post-run feedback (incl. the fix-prompt) reaches
                // the originating Jira issue — see sendJiraFeedback.
                sourceJiraIssueKey: nextContext?.jira?.issueKey || undefined,
                sourceJiraCloudId: typeof bodyCloudId === 'string' ? bodyCloudId.trim() : undefined,
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
              // Tag the run so post-run feedback (incl. the fix-prompt) reaches
              // the originating Jira issue — see sendJiraFeedback.
              sourceJiraIssueKey: nextContext?.jira?.issueKey || undefined,
              sourceJiraCloudId: typeof bodyCloudId === 'string' ? bodyCloudId.trim() : undefined,
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
