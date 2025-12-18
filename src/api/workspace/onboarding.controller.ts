import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { WorkspaceOnboardingRequest, WorkspaceOnboardingResponse } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_BROWSERS: string[] = ['chrome', 'firefox', 'safari', 'edge'];

/**
 * POST /api/v1/workspaces/onboarding
 * Save onboarding data for workspace
 */
export const saveOnboarding = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const body = req.body as WorkspaceOnboardingRequest;

    // Validate required fields
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: name',
        message: 'Field name is required and must be a non-empty string',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (body.name.length > 255) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: name',
        message: 'Field name is too long (max 255 characters)',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!body.baseUrls || !Array.isArray(body.baseUrls) || body.baseUrls.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: baseUrls',
        message: 'Field baseUrls is required and must be a non-empty array',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate all URLs
    for (const url of body.baseUrls) {
      if (typeof url !== 'string' || url.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: baseUrls',
          message: 'All baseUrls must be non-empty strings',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      try {
        // Add protocol if missing
        const urlToValidate = url.includes('://') ? url : `https://${url}`;
        new URL(urlToValidate);
      } catch {
        res.status(400).json({
          success: false,
          error: 'Invalid field: baseUrls',
          message: `Invalid URL format: ${url}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // Validate environments
    if (!body.environments || typeof body.environments !== 'object' || Array.isArray(body.environments)) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: environments',
        message: 'Field environments is required and must be an object',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate environment URLs if provided
    const envKeys = ['dev', 'predprod', 'prod'];
    for (const key of envKeys) {
      if (body.environments[key as keyof typeof body.environments]) {
        const envUrl = body.environments[key as keyof typeof body.environments];
        if (typeof envUrl !== 'string' || envUrl.trim().length === 0) {
          res.status(400).json({
            success: false,
            error: 'Invalid field: environments',
            message: `Environment ${key} URL must be a non-empty string`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        try {
          const urlToValidate = envUrl.includes('://') ? envUrl : `https://${envUrl}`;
          new URL(urlToValidate);
        } catch {
          res.status(400).json({
            success: false,
            error: 'Invalid field: environments',
            message: `Invalid URL format for ${key}: ${envUrl}`,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }
    }

    // Validate browserType
    if (!body.browserType || !VALID_BROWSERS.includes(body.browserType)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: browserType',
        message: `browserType must be one of: ${VALID_BROWSERS.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[ONBOARDING] Saving onboarding data', {
      userId,
      projectName: body.name,
      baseUrlsCount: body.baseUrls.length,
      browserType: body.browserType,
    });

    // Get or create workspace for user
    const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);

    // Normalize URLs (add https:// if missing)
    const normalizedBaseUrls = body.baseUrls.map(url =>
      url.includes('://') ? url : `https://${url}`
    );

    const normalizedEnvironments: Record<string, string> = {};
    for (const key of envKeys) {
      const envUrl = body.environments[key as keyof typeof body.environments];
      if (envUrl) {
        normalizedEnvironments[key] = envUrl.includes('://') ? envUrl : `https://${envUrl}`;
      }
    }

    // Get existing workspace to preserve existing settings
    const { data: existingWorkspace, error: fetchError } = await supabaseAdmin
      .from('workspaces')
      .select('settings')
      .eq('id', workspace_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchError) {
      logger.error('[ONBOARDING] Error fetching existing workspace', {
        error: fetchError,
        workspaceId: workspace_id,
        userId,
      });
      throw fetchError;
    }

    // Merge existing settings with new onboarding data
    const existingSettings = existingWorkspace?.settings || {};
    const newSettings = {
      ...existingSettings, // Preserve existing settings
      onboarding_completed: true,
      onboarding_completed_at: new Date().toISOString(),
      baseUrls: normalizedBaseUrls,
      environments: normalizedEnvironments,
      browserType: body.browserType,
      defaultBrowser: body.browserType, // For backward compatibility
    };

    // Extract dev and prod URLs for backward compatibility
    const devUrl = normalizedEnvironments.dev || normalizedBaseUrls[0];
    const prodUrl = normalizedEnvironments.prod || normalizedBaseUrls[normalizedBaseUrls.length - 1];

    // Update workspace with onboarding data
    const { data: updatedWorkspace, error: updateError } = await supabaseAdmin
      .from('workspaces')
      .update({
        name: body.name.trim(),
        dev_base_url: devUrl,
        prod_base_url: prodUrl,
        settings: newSettings,
      })
      .eq('id', workspace_id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (updateError) {
      logger.error('[ONBOARDING] Error updating workspace', {
        error: updateError,
        workspaceId: workspace_id,
        userId,
      });
      throw updateError;
    }

    const response: WorkspaceOnboardingResponse = {
      name: updatedWorkspace.name,
      baseUrls: normalizedBaseUrls,
      environments: normalizedEnvironments,
      browserType: body.browserType,
      completed: true,
    };

    res.status(200).json({
      success: true,
      data: response,
      message: 'Onboarding data saved successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ONBOARDING] Error saving onboarding data', { error });

    if (res.headersSent) {
      logger.warn('[ONBOARDING] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save onboarding data',
      message: 'Failed to save onboarding data',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/workspaces/onboarding
 * Get onboarding data if already completed
 */
export const getOnboarding = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get user's workspace (should be only one per user)
    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from('workspaces')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (workspaceError) {
      logger.error('[ONBOARDING] Error getting workspace', {
        error: workspaceError,
        userId,
      });
      throw workspaceError;
    }

    if (!workspace) {
      // No workspace yet, onboarding not completed
      res.json({
        success: true,
        data: {
          completed: false,
        } as WorkspaceOnboardingResponse,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const settings = workspace.settings || {};
    const onboardingCompleted = settings.onboarding_completed === true;

    if (!onboardingCompleted) {
      // Workspace exists but onboarding not completed
      res.json({
        success: true,
        data: {
          completed: false,
        } as WorkspaceOnboardingResponse,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Extract onboarding data from settings
    // Priority: settings.baseUrls > dev_base_url/prod_base_url
    let baseUrls: string[] = [];
    if (settings.baseUrls && Array.isArray(settings.baseUrls) && settings.baseUrls.length > 0) {
      baseUrls = settings.baseUrls;
    } else {
      // Fallback to legacy fields
      if (workspace.dev_base_url) baseUrls.push(workspace.dev_base_url);
      if (workspace.prod_base_url && workspace.prod_base_url !== workspace.dev_base_url) {
        baseUrls.push(workspace.prod_base_url);
      }
    }

    // Priority: settings.environments > dev_base_url/prod_base_url
    let environments: Record<string, string> = {};
    if (settings.environments && typeof settings.environments === 'object') {
      environments = settings.environments;
    } else {
      // Fallback to legacy fields
      if (workspace.dev_base_url) environments.dev = workspace.dev_base_url;
      if (workspace.prod_base_url) environments.prod = workspace.prod_base_url;
    }

    const response: WorkspaceOnboardingResponse = {
      name: workspace.name,
      baseUrls,
      environments,
      browserType: settings.browserType || settings.defaultBrowser || 'chrome',
      completed: true,
    };

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ONBOARDING] Error getting onboarding data', { error });

    if (res.headersSent) {
      logger.warn('[ONBOARDING] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get onboarding data',
      message: 'Failed to get onboarding data',
      timestamp: new Date().toISOString(),
    });
  }
};
