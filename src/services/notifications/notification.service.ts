import { supabaseAdmin } from '@/db/supabase';
import {
  CreateNotificationData,
  Notification,
  NotificationFilters,
  UnreadCount,
} from '@/types/notifications.types';
import { logger } from '@/utils/logger';

/**
 * Service for managing user notifications
 */
export class NotificationService {
  /**
   * Get user notifications with filters
   */
  static async getUserNotifications(
    userId: string,
    filters: NotificationFilters = {}
  ): Promise<{ notifications: Notification[]; total: number }> {
    try {
      const {
        type = 'all',
        category,
        isRead,
        limit = 50,
        offset = 0,
      } = filters;

      // Validate limit
      const validLimit = Math.min(Math.max(1, limit), 100);
      const validOffset = Math.max(0, offset);

      // Build query for personal notifications
      let personalQuery = supabaseAdmin
        .from('notifications')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .eq('type', 'personal')
        .order('created_at', { ascending: false });

      // Build query for general/system notifications
      let generalQuery = supabaseAdmin
        .from('notifications')
        .select('*', { count: 'exact' })
        .is('user_id', null)
        .in('type', ['general', 'system'])
        .order('created_at', { ascending: false });

      // Apply filters
      if (category) {
        personalQuery = personalQuery.eq('category', category);
        generalQuery = generalQuery.eq('category', category);
      }

      if (isRead !== undefined) {
        personalQuery = personalQuery.eq('is_read', isRead);
        generalQuery = generalQuery.eq('is_read', isRead);
      }

      // Execute queries based on type filter
      let personalData: any[] = [];
      let personalCount = 0;
      let generalData: any[] = [];
      let generalCount = 0;

      if (type === 'all' || type === 'personal') {
        const { data, error, count } = await personalQuery
          .range(validOffset, validOffset + validLimit - 1);

        if (error) {
          logger.error('[NOTIFICATIONS] Error fetching personal notifications', {
            error: error.message,
            userId,
          });
          throw error;
        }

        personalData = data || [];
        personalCount = count || 0;
      }

      if (type === 'all' || type === 'general' || type === 'system') {
        const { data, error, count } = await generalQuery
          .range(validOffset, validOffset + validLimit - 1);

        if (error) {
          logger.error('[NOTIFICATIONS] Error fetching general notifications', {
            error: error.message,
            userId,
          });
          throw error;
        }

        generalData = data || [];
        generalCount = count || 0;
      }

      // Combine and sort by created_at
      const allNotifications = [...personalData, ...generalData].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // Apply limit after combining (for 'all' type)
      const limitedNotifications = type === 'all'
        ? allNotifications.slice(0, validLimit)
        : allNotifications;

      // Transform to Notification interface
      const notifications: Notification[] = limitedNotifications.map((n) => ({
        id: n.id,
        userId: n.user_id,
        type: n.type,
        category: n.category,
        title: n.title,
        message: n.message,
        metadata: n.metadata || {},
        actionUrl: n.action_url,
        actionLabel: n.action_label,
        isRead: n.is_read,
        readAt: n.read_at,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      }));

      const total = type === 'all'
        ? personalCount + generalCount
        : type === 'personal'
        ? personalCount
        : generalCount;

      logger.debug('[NOTIFICATIONS] Fetched notifications', {
        userId,
        count: notifications.length,
        total,
        filters,
      });

      return { notifications, total };
    } catch (error) {
      logger.error('[NOTIFICATIONS] Error getting user notifications', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        filters,
      });
      throw error;
    }
  }

  /**
   * Mark notifications as read
   */
  static async markAsRead(
    userId: string,
    notificationIds: string[]
  ): Promise<number> {
    try {
      if (!notificationIds || notificationIds.length === 0) {
        return 0;
      }

      // Validate notification IDs belong to user or are general
      const { data: notifications, error: fetchError } = await supabaseAdmin
        .from('notifications')
        .select('id, user_id, type')
        .in('id', notificationIds);

      if (fetchError) {
        logger.error('[NOTIFICATIONS] Error fetching notifications for mark as read', {
          error: fetchError.message,
          userId,
        });
        throw fetchError;
      }

      // Filter valid notifications (user's personal or general/system)
      const validIds = (notifications || [])
        .filter(
          (n) =>
            (n.user_id === userId && n.type === 'personal') ||
            (n.user_id === null && ['general', 'system'].includes(n.type))
        )
        .map((n) => n.id);

      if (validIds.length === 0) {
        logger.warn('[NOTIFICATIONS] No valid notifications to mark as read', {
          userId,
          requestedIds: notificationIds,
        });
        return 0;
      }

      // Update notifications
      const { data, error } = await supabaseAdmin
        .from('notifications')
        .update({
          is_read: true,
          read_at: new Date().toISOString(),
        })
        .in('id', validIds)
        .select('id');

      if (error) {
        logger.error('[NOTIFICATIONS] Error marking notifications as read', {
          error: error.message,
          userId,
        });
        throw error;
      }

      const markedCount = data?.length || 0;

      logger.info('[NOTIFICATIONS] Marked notifications as read', {
        userId,
        markedCount,
        requestedCount: notificationIds.length,
      });

      return markedCount;
    } catch (error) {
      logger.error('[NOTIFICATIONS] Error marking notifications as read', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Mark all notifications as read
   */
  static async markAllAsRead(
    userId: string,
    type: 'personal' | 'general' | 'system' | 'all' = 'all'
  ): Promise<number> {
    try {
      const updateData: any = {
        is_read: true,
        read_at: new Date().toISOString(),
      };

      // Build conditions
      if (type === 'personal') {
        // First get count
        const { count: unreadCount } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('type', 'personal')
          .eq('is_read', false);

        // Then update
        const { error } = await supabaseAdmin
          .from('notifications')
          .update(updateData)
          .eq('user_id', userId)
          .eq('type', 'personal')
          .eq('is_read', false);

        if (error) {
          logger.error('[NOTIFICATIONS] Error marking personal notifications as read', {
            error: error.message,
            userId,
          });
          throw error;
        }

        const markedCount = unreadCount || 0;
        logger.info('[NOTIFICATIONS] Marked all personal notifications as read', {
          userId,
          markedCount,
        });
        return markedCount;
      } else if (type === 'general') {
        // First get count
        const { count: unreadCount } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .is('user_id', null)
          .eq('type', 'general')
          .eq('is_read', false);

        // Then update
        const { error } = await supabaseAdmin
          .from('notifications')
          .update(updateData)
          .is('user_id', null)
          .eq('type', 'general')
          .eq('is_read', false);

        if (error) {
          logger.error('[NOTIFICATIONS] Error marking general notifications as read', {
            error: error.message,
            userId,
          });
          throw error;
        }

        const markedCount = unreadCount || 0;
        logger.info('[NOTIFICATIONS] Marked all general notifications as read', {
          userId,
          markedCount,
        });
        return markedCount;
      } else if (type === 'system') {
        // First get count
        const { count: unreadCount } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .is('user_id', null)
          .eq('type', 'system')
          .eq('is_read', false);

        // Then update
        const { error } = await supabaseAdmin
          .from('notifications')
          .update(updateData)
          .is('user_id', null)
          .eq('type', 'system')
          .eq('is_read', false);

        if (error) {
          logger.error('[NOTIFICATIONS] Error marking system notifications as read', {
            error: error.message,
            userId,
          });
          throw error;
        }

        const markedCount = unreadCount || 0;
        logger.info('[NOTIFICATIONS] Marked all system notifications as read', {
          userId,
          markedCount,
        });
        return markedCount;
      } else {
        // All: personal + general + system
        // First get counts
        const [personalCountResult, generalCountResult] = await Promise.all([
          supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('type', 'personal')
            .eq('is_read', false),
          supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .is('user_id', null)
            .in('type', ['general', 'system'])
            .eq('is_read', false),
        ]);

        if (personalCountResult.error) {
          logger.error('[NOTIFICATIONS] Error getting personal count', {
            error: personalCountResult.error.message,
            userId,
          });
          throw personalCountResult.error;
        }

        if (generalCountResult.error) {
          logger.error('[NOTIFICATIONS] Error getting general count', {
            error: generalCountResult.error.message,
            userId,
          });
          throw generalCountResult.error;
        }

        // Then update both
        const [personalUpdateResult, generalUpdateResult] = await Promise.all([
          supabaseAdmin
            .from('notifications')
            .update(updateData)
            .eq('user_id', userId)
            .eq('type', 'personal')
            .eq('is_read', false),
          supabaseAdmin
            .from('notifications')
            .update(updateData)
            .is('user_id', null)
            .in('type', ['general', 'system'])
            .eq('is_read', false),
        ]);

        if (personalUpdateResult.error) {
          logger.error('[NOTIFICATIONS] Error marking personal notifications as read', {
            error: personalUpdateResult.error.message,
            userId,
          });
          throw personalUpdateResult.error;
        }

        if (generalUpdateResult.error) {
          logger.error('[NOTIFICATIONS] Error marking general notifications as read', {
            error: generalUpdateResult.error.message,
            userId,
          });
          throw generalUpdateResult.error;
        }

        const markedCount = (personalCountResult.count || 0) + (generalCountResult.count || 0);

        logger.info('[NOTIFICATIONS] Marked all notifications as read', {
          userId,
          type: 'all',
          markedCount,
        });

        return markedCount;
      }
    } catch (error) {
      logger.error('[NOTIFICATIONS] Error marking all notifications as read', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        type,
      });
      throw error;
    }
  }

  /**
   * Get unread count by type
   */
  static async getUnreadCount(userId: string): Promise<UnreadCount> {
    try {
      // Personal unread count
      const { count: personalCount, error: personalError } = await supabaseAdmin
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', 'personal')
        .eq('is_read', false);

      if (personalError) {
        logger.error('[NOTIFICATIONS] Error getting personal unread count', {
          error: personalError.message,
          userId,
        });
        throw personalError;
      }

      // General unread count
      const { count: generalCount, error: generalError } = await supabaseAdmin
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .is('user_id', null)
        .eq('type', 'general')
        .eq('is_read', false);

      if (generalError) {
        logger.error('[NOTIFICATIONS] Error getting general unread count', {
          error: generalError.message,
          userId,
        });
        throw generalError;
      }

      // System unread count
      const { count: systemCount, error: systemError } = await supabaseAdmin
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .is('user_id', null)
        .eq('type', 'system')
        .eq('is_read', false);

      if (systemError) {
        logger.error('[NOTIFICATIONS] Error getting system unread count', {
          error: systemError.message,
          userId,
        });
        throw systemError;
      }

      const unreadCount: UnreadCount = {
        personal: personalCount || 0,
        general: generalCount || 0,
        system: systemCount || 0,
        total: (personalCount || 0) + (generalCount || 0) + (systemCount || 0),
      };

      return unreadCount;
    } catch (error) {
      logger.error('[NOTIFICATIONS] Error getting unread count', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Create notification (internal use)
   */
  static async createNotification(
    data: CreateNotificationData
  ): Promise<Notification> {
    try {
      const {
        userId = null,
        type,
        category,
        title,
        message,
        metadata = {},
        actionUrl,
        actionLabel,
      } = data;

      // Validate
      if (!title || !message) {
        throw new Error('Title and message are required');
      }

      // Validate user_id for personal notifications
      if (type === 'personal' && !userId) {
        throw new Error('userId is required for personal notifications');
      }

      // Validate user_id is null for general/system
      if ((type === 'general' || type === 'system') && userId !== null) {
        throw new Error('userId must be null for general/system notifications');
      }

      const { data: notification, error } = await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: userId,
          type,
          category,
          title,
          message,
          metadata,
          action_url: actionUrl || null,
          action_label: actionLabel || null,
          is_read: false,
        })
        .select()
        .single();

      if (error) {
        logger.error('[NOTIFICATIONS] Error creating notification', {
          error: error.message,
          data,
        });
        throw error;
      }

      const result: Notification = {
        id: notification.id,
        userId: notification.user_id,
        type: notification.type,
        category: notification.category,
        title: notification.title,
        message: notification.message,
        metadata: notification.metadata || {},
        actionUrl: notification.action_url,
        actionLabel: notification.action_label,
        isRead: notification.is_read,
        readAt: notification.read_at,
        createdAt: notification.created_at,
        updatedAt: notification.updated_at,
      };

      logger.info('[NOTIFICATIONS] Created notification', {
        id: result.id,
        type,
        category,
        userId: userId || 'general',
      });

      return result;
    } catch (error) {
      logger.error('[NOTIFICATIONS] Error creating notification', {
        error: error instanceof Error ? error.message : String(error),
        data,
      });
      throw error;
    }
  }
}
