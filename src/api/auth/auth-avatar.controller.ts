import { supabaseAdmin } from '@/db/supabase';
import { invalidateAuthCacheForUser } from '@/services/auth/auth.service';
import { UserAvatarStorageService } from '@/services/storage/user-avatar-storage.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/auth/avatar
 * Upload user avatar
 */
export const uploadAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const file = req.file;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
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

    if (!file) {
      res.status(400).json({
        success: false,
        error: 'Missing file',
        message: 'No avatar file provided',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[AUTH_AVATAR_API] Uploading avatar', {
      userId,
      fileName: file.originalname,
      size: file.size,
    });

    // Get current user to check for existing avatar
    const { data: userData, error: fetchError } = await supabaseAdmin
      .from('users')
      .select('avatar_url')
      .eq('id', userId)
      .maybeSingle();

    if (fetchError) {
      logger.error('[AUTH_AVATAR_API] Error fetching user', { error: fetchError, userId });
      throw fetchError;
    }

    if (!userData) {
      res.status(404).json({
        success: false,
        error: 'User not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Delete old avatar if exists
    if (userData.avatar_url) {
      await UserAvatarStorageService.deleteOldAvatar(userData.avatar_url);
    }

    // Upload new avatar
    const { publicUrl, fileName, storagePath } =
      await UserAvatarStorageService.uploadAvatar(userId, file);

    // Update user with new avatar URL
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ avatar_url: publicUrl })
      .eq('id', userId);

    if (updateError) {
      logger.error('[AUTH_AVATAR_API] Error updating user', { error: updateError, userId });
      // Cleanup uploaded file since DB update failed
      await UserAvatarStorageService.deleteAvatar(storagePath).catch(cleanupError => {
        logger.warn('[AUTH_AVATAR_API] Failed to cleanup uploaded file after DB error', {
          cleanupError,
          storagePath,
        });
      });
      throw updateError;
    }

    // Invalidate auth cache so next request picks up the new avatar
    await invalidateAuthCacheForUser(userId);

    res.status(200).json({
      success: true,
      data: {
        avatar_url: publicUrl,
        file_name: fileName,
        file_size: file.size,
        uploaded_at: new Date().toISOString(),
      },
      message: 'Avatar uploaded successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AUTH_AVATAR_API] Upload error', { error });

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload avatar',
      message: 'Failed to upload avatar',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * DELETE /api/v1/auth/avatar
 * Delete user avatar
 */
export const deleteAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
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

    logger.info('[AUTH_AVATAR_API] Deleting avatar', { userId });

    // Get current user
    const { data: userData, error: fetchError } = await supabaseAdmin
      .from('users')
      .select('avatar_url')
      .eq('id', userId)
      .maybeSingle();

    if (fetchError) {
      logger.error('[AUTH_AVATAR_API] Error fetching user', { error: fetchError, userId });
      throw fetchError;
    }

    if (!userData) {
      res.status(404).json({
        success: false,
        error: 'User not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!userData.avatar_url) {
      res.status(404).json({
        success: false,
        error: 'No avatar found',
        message: 'This user does not have an avatar',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Delete avatar from storage
    await UserAvatarStorageService.deleteOldAvatar(userData.avatar_url);

    // Clear avatar_url in database
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ avatar_url: null })
      .eq('id', userId);

    if (updateError) {
      logger.error('[AUTH_AVATAR_API] Error updating user', { error: updateError, userId });
      throw updateError;
    }

    // Invalidate auth cache so next request picks up the cleared avatar
    await invalidateAuthCacheForUser(userId);

    res.status(200).json({
      success: true,
      message: 'Avatar deleted successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AUTH_AVATAR_API] Delete error', { error });

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete avatar',
      message: 'Failed to delete avatar',
      timestamp: new Date().toISOString(),
    });
  }
};
