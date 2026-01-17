import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface CreateReportData {
  title: string;
  category: 'bug' | 'ui' | 'feature' | 'other';
  details: string;
  workspace_name?: string;
  view?: string;
}

export interface UserReport {
  id: string;
  user_id: string;
  title: string;
  category: 'bug' | 'ui' | 'feature' | 'other';
  details: string;
  workspace_name?: string | null;
  view?: string | null;
  status: 'pending' | 'in_progress' | 'resolved' | 'closed';
  created_at: string;
  updated_at: string;
}

/**
 * Service for managing user reports
 */
export class UserReportService {
  /**
   * Create a new user report
   */
  static async createReport(
    userId: string,
    reportData: CreateReportData
  ): Promise<UserReport> {
    try {
      // Validate userId
      if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid user ID: must be a non-empty string');
      }

      // Validate reportData
      if (!reportData.title || reportData.title.trim().length === 0) {
        throw new Error('Report title is required');
      }

      if (reportData.title.length > 200) {
        throw new Error('Report title must be 200 characters or less');
      }

      if (!reportData.details || reportData.details.trim().length === 0) {
        throw new Error('Report details are required');
      }

      if (reportData.details.length > 500) {
        throw new Error('Report details must be 500 characters or less');
      }

      if (!['bug', 'ui', 'feature', 'other'].includes(reportData.category)) {
        throw new Error('Invalid category');
      }

      logger.info('[USER_REPORT] Creating user report', {
        userId,
        category: reportData.category,
        title: reportData.title.substring(0, 50), // Log first 50 chars
      });

      const { data, error } = await supabaseAdmin
        .from('user_reports')
        .insert({
          user_id: userId,
          title: reportData.title,
          category: reportData.category,
          details: reportData.details,
          workspace_name: reportData.workspace_name || null,
          view: reportData.view || null,
          status: 'pending',
        })
        .select()
        .single();

      if (error) {
        logger.error('[USER_REPORT] Failed to create report', {
          error: error.message,
          code: error.code,
          userId,
        });
        throw new Error(`Failed to create report: ${error.message}`);
      }

      if (!data) {
        logger.error('[USER_REPORT] Report insert returned no data', { userId });
        throw new Error('Failed to create report: no data returned');
      }

      logger.info('[USER_REPORT] Report created successfully', {
        reportId: data.id,
        userId,
      });

      return data as UserReport;
    } catch (error) {
      logger.error('[USER_REPORT] Error creating report', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Get user reports with pagination
   */
  static async getUserReports(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ reports: UserReport[]; total: number }> {
    try {
      // Validate userId
      if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid user ID: must be a non-empty string');
      }

      // Validate and sanitize limit/offset
      const validLimit = Math.min(Math.max(1, limit), 100);
      const validOffset = Math.max(0, offset);

      logger.debug('[USER_REPORT] Getting user reports', {
        userId,
        limit: validLimit,
        offset: validOffset,
      });

      // Get total count
      const { count, error: countError } = await supabaseAdmin
        .from('user_reports')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (countError) {
        logger.error('[USER_REPORT] Error getting report count', {
          error: countError.message,
          userId,
        });
        throw new Error(`Failed to get report count: ${countError.message}`);
      }

      // Get reports
      const { data, error } = await supabaseAdmin
        .from('user_reports')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(validOffset, validOffset + validLimit - 1);

      if (error) {
        logger.error('[USER_REPORT] Error getting user reports', {
          error: error.message,
          userId,
        });
        throw new Error(`Failed to get reports: ${error.message}`);
      }

      return {
        reports: (data as UserReport[]) || [],
        total: count || 0,
      };
    } catch (error) {
      logger.error('[USER_REPORT] Error getting user reports', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Get a specific report by ID
   */
  static async getReportById(
    reportId: string,
    userId: string
  ): Promise<UserReport | null> {
    try {
      // Validate inputs
      if (!reportId || typeof reportId !== 'string') {
        throw new Error('Invalid report ID: must be a non-empty string');
      }

      if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid user ID: must be a non-empty string');
      }

      logger.debug('[USER_REPORT] Getting report by ID', { reportId, userId });

      const { data, error } = await supabaseAdmin
        .from('user_reports')
        .select('*')
        .eq('id', reportId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[USER_REPORT] Error getting report by ID', {
          error: error.message,
          reportId,
          userId,
        });
        throw new Error(`Failed to get report: ${error.message}`);
      }

      return data as UserReport | null;
    } catch (error) {
      logger.error('[USER_REPORT] Error getting report by ID', {
        error: error instanceof Error ? error.message : String(error),
        reportId,
        userId,
      });
      throw error;
    }
  }

  /**
   * Get admin emails for notification
   */
  static async getAdminEmails(): Promise<string[]> {
    try {
      logger.debug('[USER_REPORT] Getting admin emails');

      const { data, error } = await supabaseAdmin
        .from('users')
        .select('email')
        .eq('role', 'admin');

      if (error) {
        logger.error('[USER_REPORT] Error getting admin emails', {
          error: error.message,
        });
        return [];
      }

      if (!data || data.length === 0) {
        logger.warn('[USER_REPORT] No admin users found');
        return [];
      }

      const emails = data
        .map((user) => user.email)
        .filter((email): email is string => typeof email === 'string' && email.length > 0);

      logger.debug('[USER_REPORT] Found admin emails', { count: emails.length });

      return emails;
    } catch (error) {
      logger.error('[USER_REPORT] Error getting admin emails', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
