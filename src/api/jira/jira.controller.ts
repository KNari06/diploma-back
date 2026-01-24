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
} from '@/services/api/jira.service';
import { supabaseAdmin } from '@/db/supabase';

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
    res.json({
      success: true,
      connections: data || [],
      connected: !!data && data.length > 0,
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
