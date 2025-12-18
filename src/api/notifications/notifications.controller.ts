import { NotificationService } from '@/services/notifications/notification.service';
import { MarkAsReadRequest, NotificationFilters } from '@/types/notifications.types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * GET /api/v1/notifications
 * Get user notifications
 */
export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    // Parse query parameters
    const type = req.query.type as string | undefined;
    const category = req.query.category as string | undefined;
    const isReadParam = req.query.is_read as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const offsetParam = req.query.offset as string | undefined;

    // Validate and parse filters
    const filters: NotificationFilters = {};

    if (type) {
      if (!['personal', 'general', 'system', 'all'].includes(type)) {
        res.status(400).json({
          success: false,
          error: 'Invalid type',
          message: 'Type must be one of: personal, general, system, all',
        });
        return;
      }
      filters.type = type as any;
    }

    if (category) {
      if (!['test', 'discount', 'billing', 'system', 'feature', 'announcement'].includes(category)) {
        res.status(400).json({
          success: false,
          error: 'Invalid category',
          message: 'Category must be one of: test, discount, billing, system, feature, announcement',
        });
        return;
      }
      filters.category = category as any;
    }

    if (isReadParam !== undefined) {
      if (isReadParam !== 'true' && isReadParam !== 'false') {
        res.status(400).json({
          success: false,
          error: 'Invalid is_read',
          message: 'is_read must be "true" or "false"',
        });
        return;
      }
      filters.isRead = isReadParam === 'true';
    }

    if (limitParam) {
      const limit = parseInt(limitParam, 10);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'Invalid limit',
          message: 'Limit must be a number between 1 and 100',
        });
        return;
      }
      filters.limit = limit;
    }

    if (offsetParam) {
      const offset = parseInt(offsetParam, 10);
      if (isNaN(offset) || offset < 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid offset',
          message: 'Offset must be a non-negative number',
        });
        return;
      }
      filters.offset = offset;
    }

    logger.info('[NOTIFICATIONS_API] Getting notifications', {
      userId,
      filters,
    });

    // Get notifications
    const { notifications, total } = await NotificationService.getUserNotifications(
      userId,
      filters
    );

    // Get unread count
    const unreadCount = await NotificationService.getUnreadCount(userId);

    res.json({
      success: true,
      notifications,
      pagination: {
        total,
        limit: filters.limit || 50,
        offset: filters.offset || 0,
        has_more: (filters.offset || 0) + notifications.length < total,
      },
      unread_count: unreadCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[NOTIFICATIONS_API] Error getting notifications', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
    });

    if (res.headersSent) {
      logger.warn('[NOTIFICATIONS_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get notifications',
      message: 'An error occurred while fetching notifications',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/notifications/read
 * Mark notifications as read
 */
export const markNotificationsAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    const body = req.body as MarkAsReadRequest;
    const { notification_ids, mark_all_as_read, type } = body;

    // Validate request
    if (mark_all_as_read) {
      // Mark all as read
      if (type && !['personal', 'general', 'system', 'all'].includes(type)) {
        res.status(400).json({
          success: false,
          error: 'Invalid type',
          message: 'Type must be one of: personal, general, system, all',
        });
        return;
      }

      logger.info('[NOTIFICATIONS_API] Marking all notifications as read', {
        userId,
        type: type || 'all',
      });

      const markedCount = await NotificationService.markAllAsRead(
        userId,
        type as any
      );

      res.json({
        success: true,
        marked_count: markedCount,
        message: `Marked ${markedCount} notification(s) as read`,
        timestamp: new Date().toISOString(),
      });
    } else if (notification_ids && Array.isArray(notification_ids)) {
      // Mark specific notifications as read
      if (notification_ids.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid request',
          message: 'notification_ids array cannot be empty',
        });
        return;
      }

      // Validate notification IDs
      const invalidIds = notification_ids.filter(
        (id) => typeof id !== 'string' || id.trim().length === 0
      );

      if (invalidIds.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid notification IDs',
          message: 'All notification IDs must be non-empty strings',
        });
        return;
      }

      logger.info('[NOTIFICATIONS_API] Marking notifications as read', {
        userId,
        count: notification_ids.length,
      });

      const markedCount = await NotificationService.markAsRead(userId, notification_ids);

      res.json({
        success: true,
        marked_count: markedCount,
        message: `Marked ${markedCount} notification(s) as read`,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Either notification_ids array or mark_all_as_read must be provided',
      });
      return;
    }
  } catch (error) {
    logger.error('[NOTIFICATIONS_API] Error marking notifications as read', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
    });

    if (res.headersSent) {
      logger.warn('[NOTIFICATIONS_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to mark notifications as read',
      message: 'An error occurred while marking notifications as read',
      timestamp: new Date().toISOString(),
    });
  }
};
