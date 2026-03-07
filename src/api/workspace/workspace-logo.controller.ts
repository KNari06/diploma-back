import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceAccessService, PERMISSIONS } from '@/services/core/workspace-access.service';
import { WorkspaceLogoStorageService } from '@/services/storage/workspace-logo-storage.service';
import { WorkspaceLogoUploadResponse } from '@/types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/workspaces/:id/logo
 * Upload workspace logo
 * Requires: owner or full_access role (WORKSPACE_WRITE permission)
 */
export const uploadWorkspaceLogo = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;
    const file = req.file;

    // Validate authentication
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId presence
    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Workspace ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId format
    if (!UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate file presence
    if (!file) {
      res.status(400).json({
        success: false,
        error: 'Missing file',
        message: 'No logo file provided',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check write permission
    const hasWriteAccess = await WorkspaceAccessService.hasPermission(
      userId,
      workspaceId,
      PERMISSIONS.WORKSPACE_WRITE
    );

    if (!hasWriteAccess) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have permission to modify this workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_LOGO_API] Uploading logo', {
      userId,
      workspaceId,
      fileName: file.originalname,
      size: file.size,
    });

    // Get current workspace to check for existing logo
    const { data: workspace, error: fetchError } = await supabaseAdmin
      .from('workspaces')
      .select('logo_url')
      .eq('id', workspaceId)
      .maybeSingle();

    if (fetchError) {
      logger.error('[WORKSPACE_LOGO_API] Error fetching workspace', {
        error: fetchError,
        workspaceId,
      });
      throw fetchError;
    }

    if (!workspace) {
      res.status(404).json({
        success: false,
        error: 'Workspace not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Delete old logo if exists
    if (workspace.logo_url) {
      await WorkspaceLogoStorageService.deleteOldLogo(workspace.logo_url);
    }

    // Upload new logo
    const { publicUrl, fileName, storagePath } =
      await WorkspaceLogoStorageService.uploadLogo(userId, workspaceId, file);

    // Update workspace with new logo URL
    const { error: updateError } = await supabaseAdmin
      .from('workspaces')
      .update({ logo_url: publicUrl })
      .eq('id', workspaceId);

    if (updateError) {
      logger.error('[WORKSPACE_LOGO_API] Error updating workspace', {
        error: updateError,
        workspaceId,
      });
      // Cleanup uploaded file since DB update failed
      await WorkspaceLogoStorageService.deleteLogo(storagePath).catch(cleanupError => {
        logger.warn('[WORKSPACE_LOGO_API] Failed to cleanup uploaded file after DB error', {
          cleanupError,
          storagePath,
        });
      });
      throw updateError;
    }

    // Invalidate onboarding cache — logo is part of onboarding workspace data
    await cache.del(`qait:cache:onboarding:${userId}`);

    const response: WorkspaceLogoUploadResponse = {
      logo_url: publicUrl,
      file_name: fileName,
      file_size: file.size,
      uploaded_at: new Date().toISOString(),
    };

    res.status(200).json({
      success: true,
      data: response,
      message: 'Logo uploaded successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_LOGO_API] Upload error', { error });

    if (res.headersSent) {
      logger.warn('[WORKSPACE_LOGO_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload logo',
      message: 'Failed to upload logo',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * DELETE /api/v1/workspaces/:id/logo
 * Delete workspace logo
 * Requires: owner or full_access role (WORKSPACE_WRITE permission)
 */
export const deleteWorkspaceLogo = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    // Validate authentication
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId presence
    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Workspace ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId format
    if (!UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check write permission
    const hasWriteAccess = await WorkspaceAccessService.hasPermission(
      userId,
      workspaceId,
      PERMISSIONS.WORKSPACE_WRITE
    );

    if (!hasWriteAccess) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have permission to modify this workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_LOGO_API] Deleting logo', { userId, workspaceId });

    // Get current workspace
    const { data: workspace, error: fetchError } = await supabaseAdmin
      .from('workspaces')
      .select('logo_url')
      .eq('id', workspaceId)
      .maybeSingle();

    if (fetchError) {
      logger.error('[WORKSPACE_LOGO_API] Error fetching workspace', {
        error: fetchError,
        workspaceId,
      });
      throw fetchError;
    }

    if (!workspace) {
      res.status(404).json({
        success: false,
        error: 'Workspace not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspace.logo_url) {
      res.status(404).json({
        success: false,
        error: 'No logo found',
        message: 'This workspace does not have a logo',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Delete logo from storage
    await WorkspaceLogoStorageService.deleteOldLogo(workspace.logo_url);

    // Clear logo_url in database
    const { error: updateError } = await supabaseAdmin
      .from('workspaces')
      .update({ logo_url: null })
      .eq('id', workspaceId);

    if (updateError) {
      logger.error('[WORKSPACE_LOGO_API] Error updating workspace', {
        error: updateError,
        workspaceId,
      });
      throw updateError;
    }

    // Invalidate onboarding cache — logo is part of onboarding workspace data
    await cache.del(`qait:cache:onboarding:${userId}`);

    res.status(200).json({
      success: true,
      message: 'Logo deleted successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_LOGO_API] Delete error', { error });

    if (res.headersSent) {
      logger.warn('[WORKSPACE_LOGO_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete logo',
      message: 'Failed to delete logo',
      timestamp: new Date().toISOString(),
    });
  }
};
