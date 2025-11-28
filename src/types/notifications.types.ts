/**
 * Notification types and interfaces
 */

export type NotificationType = 'personal' | 'general' | 'system';
export type NotificationCategory = 'test' | 'discount' | 'billing' | 'system' | 'feature' | 'announcement';

/**
 * Notification interface matching database schema
 */
export interface Notification {
  id: string;
  userId: string | null;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  metadata: NotificationMetadata;
  actionUrl?: string | null;
  actionLabel?: string | null;
  isRead: boolean;
  readAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Notification metadata - additional data based on category
 */
export interface NotificationMetadata {
  // Test notifications
  testId?: string;
  testUrl?: string;
  testStatus?: string;
  errorsCount?: number;
  browser?: string;
  resultId?: string;

  // Discount notifications
  discountPercent?: number;
  discountCode?: string;
  validUntil?: string;

  // Billing notifications
  amount?: number;
  currency?: string;
  transactionId?: string;
  creditsAmount?: number;

  // Feature/Announcement notifications
  featureName?: string;
  announcementId?: string;

  // System notifications
  systemEvent?: string;

  // Generic
  [key: string]: any;
}

/**
 * Filters for getting notifications
 */
export interface NotificationFilters {
  type?: NotificationType | 'all';
  category?: NotificationCategory;
  isRead?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Unread count by type
 */
export interface UnreadCount {
  personal: number;
  general: number;
  system: number;
  total: number;
}

/**
 * Create notification data
 */
export interface CreateNotificationData {
  userId?: string | null; // null for general/system notifications
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  metadata?: NotificationMetadata;
  actionUrl?: string;
  actionLabel?: string;
}

/**
 * Mark as read request
 */
export interface MarkAsReadRequest {
  notification_ids?: string[];
  mark_all_as_read?: boolean;
  type?: NotificationType | 'all';
}
