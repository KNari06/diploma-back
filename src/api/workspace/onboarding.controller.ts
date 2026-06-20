import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { saveWorkspaceProfile } from '@/services/core/db/self-serve.db';
import { WorkspaceOnboardingRequest, WorkspaceOnboardingResponse } from '@/types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_BROWSERS: string[] = ['chrome', 'firefox', 'safari', 'edge'];
const VALID_PROJECT_TYPES: string[] = ['web', 'mobile'];
const VALID_MOBILE_PLATFORMS: string[] = ['android', 'ios', 'flutter'];

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

    // projectType drives which fields are required. Default 'web' for back-compat.
    const projectType = body.projectType ?? 'web';
    if (!VALID_PROJECT_TYPES.includes(projectType)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: projectType',
        message: `projectType must be one of: ${VALID_PROJECT_TYPES.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const envKeys = ['dev', 'predprod', 'prod'];

    // "Skip for now" — user deferred target config; no web/mobile fields are
    // required. They'll set the URL / app up later from the dashboard.
    const skipped = body.skipped === true;

    if (!skipped && projectType === 'web') {
      // ── WEB: baseUrls + environments + browserType required ──
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
    } else if (!skipped) {
      // ── MOBILE: no baseUrls/browser; mobilePlatform required. The APK/IPA is
      // uploaded separately once the project exists, so it's not in this payload.
      if (!body.mobilePlatform || !VALID_MOBILE_PLATFORMS.includes(body.mobilePlatform)) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: mobilePlatform',
          message: `mobilePlatform must be one of: ${VALID_MOBILE_PLATFORMS.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (
        body.mobilePackageName !== undefined &&
        (typeof body.mobilePackageName !== 'string' || body.mobilePackageName.length > 255)
      ) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: mobilePackageName',
          message: 'Field mobilePackageName must be a string with max 255 characters',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // Validate role (optional)
    const validRoles = ['qaEngineer', 'developer', 'productManager', 'teamLead', 'cto', 'other'];
    if (body.role !== undefined && !validRoles.includes(body.role)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: role',
        message: `Field role must be one of: ${validRoles.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate position (optional, max 255 chars)
    if (body.position !== undefined && (typeof body.position !== 'string' || body.position.length > 255)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: position',
        message: 'Field position must be a string with max 255 characters',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate accountType (optional)
    const validAccountTypes = ['company', 'individual'];
    if (body.accountType !== undefined && !validAccountTypes.includes(body.accountType)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: accountType',
        message: `Field accountType must be one of: ${validAccountTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate companyName (optional, but required when accountType === 'company')
    if (body.accountType === 'company') {
      if (!body.companyName || typeof body.companyName !== 'string' || body.companyName.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Missing required field: companyName',
          message: 'Field companyName is required when accountType is "company"',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (body.companyName.length > 255) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: companyName',
          message: 'Field companyName is too long (max 255 characters)',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // When skipped, no target was configured — treat as neither web nor mobile.
    const isMobile = !skipped && projectType === 'mobile';

    logger.info('[ONBOARDING] Saving onboarding data', {
      userId,
      projectName: body.name,
      projectType,
      baseUrlsCount: body.baseUrls?.length ?? 0,
      browserType: body.browserType,
      mobilePlatform: body.mobilePlatform,
      role: body.role,
      accountType: body.accountType,
    });

    // Get or create workspace for user
    const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);

    // Normalize URLs (add https:// if missing). Web-only — mobile has none.
    const normalizedBaseUrls = (body.baseUrls ?? []).map(url =>
      url.includes('://') ? url : `https://${url}`
    );

    const normalizedEnvironments: Record<string, string> = {};
    for (const key of envKeys) {
      const envUrl = body.environments?.[key as keyof typeof body.environments];
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

    // Merge existing settings with new onboarding data. For mobile we persist
    // platform + package instead of URLs/browser; the APK is uploaded later.
    const existingSettings = existingWorkspace?.settings || {};
    const newSettings = {
      ...existingSettings, // Preserve existing settings
      onboarding_completed: true,
      onboarding_completed_at: new Date().toISOString(),
      projectType,
      onboarding_skipped: skipped,
      baseUrls: normalizedBaseUrls,
      environments: normalizedEnvironments,
      browserType: isMobile ? (existingSettings.browserType ?? 'chrome') : body.browserType,
      defaultBrowser: isMobile ? (existingSettings.defaultBrowser ?? 'chrome') : body.browserType,
      mobilePlatform: isMobile ? body.mobilePlatform : null,
      mobilePackageName: isMobile ? (body.mobilePackageName?.trim() || null) : null,
      // NEW FIELDS
      role: body.role,
      position: body.position || null,
      accountType: body.accountType,
      companyName: body.companyName || null,
    };

    // Extract dev and prod URLs for backward compatibility (web only).
    const devUrl = normalizedEnvironments.dev || normalizedBaseUrls[0] || null;
    const prodUrl = normalizedEnvironments.prod || normalizedBaseUrls[normalizedBaseUrls.length - 1] || null;

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
      workspace_id: workspace_id, // Return workspace_id in response
      name: updatedWorkspace.name,
      projectType,
      skipped,
      baseUrls: normalizedBaseUrls,
      environments: normalizedEnvironments,
      browserType: body.browserType,
      mobilePlatform: isMobile ? body.mobilePlatform : undefined,
      mobilePackageName: isMobile ? (body.mobilePackageName?.trim() || undefined) : undefined,
      completed: true,
      // NEW FIELDS
      role: body.role,
      position: body.position,
      accountType: body.accountType,
      companyName: body.companyName,
      logo_url: updatedWorkspace.logo_url,
    };

    // Invalidate onboarding cache
    const onboardingUserId = req.user?.id;
    if (onboardingUserId) {
      await cache.del(`qait:cache:onboarding:${onboardingUserId}`);
    }

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

    // Check cache first
    const cacheKey = `qait:cache:onboarding:${userId}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.json({ success: true, data: cached, timestamp: new Date().toISOString() });
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
      workspace_id: workspace.id, // Return workspace_id
      name: workspace.name,
      projectType: settings.projectType || 'web',
      baseUrls,
      environments,
      browserType: settings.browserType || settings.defaultBrowser || 'chrome',
      mobilePlatform: settings.mobilePlatform || undefined,
      mobilePackageName: settings.mobilePackageName || undefined,
      completed: true,
      // NEW FIELDS
      role: settings.role,
      position: settings.position,
      accountType: settings.accountType,
      companyName: settings.companyName,
      logo_url: workspace.logo_url,
    };

    // Cache for 24 hours
    await cache.set(cacheKey, response, 86400);

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

/**
 * PUT /api/v1/workspaces/profile
 * Lightweight B2C profile capture (role + goal/source) shown as a one-time
 * modal on the dashboard for self-serve users. Unlike saveOnboarding it does
 * NOT require name/baseUrls and does NOT set onboarding_completed — it only
 * sets profile_completed so the modal stops re-appearing. Stored in
 * workspace.settings via the self-serve db sublayer.
 */
export const saveProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId || !UUID_REGEX.test(userId)) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { role, goal, source } = req.body ?? {};
    const validRoles = ['qaEngineer', 'developer', 'productManager', 'teamLead', 'cto', 'other'];

    if (role !== undefined && !validRoles.includes(role)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: role',
        message: `Field role must be one of: ${validRoles.join(', ')}`,
      });
      return;
    }
    for (const [key, val] of Object.entries({ goal, source })) {
      if (val !== undefined && (typeof val !== 'string' || val.length > 500)) {
        res.status(400).json({
          success: false,
          error: `Invalid field: ${key}`,
          message: `Field ${key} must be a string with max 500 characters`,
        });
        return;
      }
    }

    const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);
    await saveWorkspaceProfile(workspace_id, userId, { role, goal, source });
    await cache.del(`qait:cache:onboarding:${userId}`);

    res.json({ success: true, data: { workspace_id, profile_completed: true } });
  } catch (error) {
    logger.error('[ONBOARDING] Error saving profile', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to save profile' });
  }
};
