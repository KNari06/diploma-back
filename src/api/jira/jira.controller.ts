import { Request, Response } from 'express';
import { logger } from '@/utils/logger';
import {
  generateOAuthState,
  buildJiraAuthUrl,
  exchangeCodeForToken,
  getAccessibleResources,
  saveJiraToken,
  getJiraToken,
  ensureValidToken,
  getJiraProjects,
} from '@/services/jira.service';

// In-memory store for OAuth states (in production, use Redis)
const oauthStates = new Map<string, { userId?: string; expiresAt: number }>();

// Clean up expired states every hour
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of oauthStates.entries()) {
    if (data.expiresAt < now) {
      oauthStates.delete(state);
    }
  }
}, 60 * 60 * 1000);

/**
 * Start Jira OAuth flow
 * GET /api/jira/auth/start
 */
export const startJiraAuth = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.query.userId as string || req.headers['x-user-id'] as string;

    if (!userId) {
      res.status(400).json({
        success: false,
        error: 'User ID is required (userId query param or X-User-ID header)',
      });
      return;
    }

    const state = generateOAuthState();
    const authUrl = buildJiraAuthUrl(state, userId);

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
 * Handle Jira OAuth callback
 * GET /api/jira/callback
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
    const tokenData = await exchangeCodeForToken(code as string, state as string);

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
    const savedTokens = await Promise.all(
      resources.map((resource) =>
        saveJiraToken(userId, tokenData, resource.id, resource.url)
      )
    );

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
    const userId = req.query.userId as string || req.headers['x-user-id'] as string;
    const cloudId = req.query.cloudId as string;

    if (!userId) {
      res.status(400).json({
        success: false,
        error: 'User ID is required (userId query param or X-User-ID header)',
      });
      return;
    }

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
