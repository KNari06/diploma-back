import { AnnouncementService } from '@/services/announcements/announcement.service';
import { CreateAnnouncementData, UpdateAnnouncementData } from '@/types/announcements.types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * GET /api/v1/announcements/active
 * Get the latest active, non-dismissed announcement for the authenticated user
 */
export const getActiveAnnouncements = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const announcements = await AnnouncementService.getActiveForUser(userId);

    res.json({
      success: true,
      announcements,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error getting active', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, error: 'Failed to get announcements' });
  }
};

/**
 * POST /api/v1/announcements/:id/dismiss
 * Dismiss an announcement for the authenticated user
 */
export const dismissAnnouncement = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ success: false, error: 'Announcement ID is required' });
      return;
    }

    await AnnouncementService.dismiss(id, userId);

    res.json({
      success: true,
      message: 'Announcement dismissed',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error dismissing', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
      announcementId: req.params.id,
    });
    res.status(500).json({ success: false, error: 'Failed to dismiss announcement' });
  }
};

// ── Admin endpoints ──

/**
 * GET /api/v1/announcements/admin
 */
export const listAllAnnouncements = async (_req: Request, res: Response): Promise<void> => {
  try {
    const announcements = await AnnouncementService.listAll();
    res.json({ success: true, announcements, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error listing', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to list announcements' });
  }
};

/**
 * GET /api/v1/announcements/admin/:id
 */
export const getAnnouncementById = async (req: Request, res: Response): Promise<void> => {
  try {
    const announcement = await AnnouncementService.getById(req.params.id);
    if (!announcement) {
      res.status(404).json({ success: false, error: 'Announcement not found' });
      return;
    }
    res.json({ success: true, announcement, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error getting by id', {
      error: error instanceof Error ? error.message : String(error),
      id: req.params.id,
    });
    res.status(500).json({ success: false, error: 'Failed to get announcement' });
  }
};

/**
 * POST /api/v1/announcements/admin
 */
export const createAnnouncement = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const body = req.body as CreateAnnouncementData;
    if (!body.title || !body.description) {
      res.status(400).json({ success: false, error: 'Title and description are required' });
      return;
    }

    const announcement = await AnnouncementService.create(body, adminId);
    res.status(201).json({ success: true, announcement, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error creating', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to create announcement' });
  }
};

/**
 * PUT /api/v1/announcements/admin/:id
 */
export const updateAnnouncement = async (req: Request, res: Response): Promise<void> => {
  try {
    const announcement = await AnnouncementService.update(req.params.id, req.body as UpdateAnnouncementData);
    res.json({ success: true, announcement, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error updating', {
      error: error instanceof Error ? error.message : String(error),
      id: req.params.id,
    });
    res.status(500).json({ success: false, error: 'Failed to update announcement' });
  }
};

/**
 * DELETE /api/v1/announcements/admin/:id
 */
export const deleteAnnouncement = async (req: Request, res: Response): Promise<void> => {
  try {
    await AnnouncementService.delete(req.params.id);
    res.json({ success: true, message: 'Announcement deleted', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('[ANNOUNCEMENTS_API] Error deleting', {
      error: error instanceof Error ? error.message : String(error),
      id: req.params.id,
    });
    res.status(500).json({ success: false, error: 'Failed to delete announcement' });
  }
};
