import { supabase } from '@/db/supabase';
import { logger } from '@/utils/logger';

interface MigrationResult {
  success: boolean;
  anonymous_id: string;
  user_id: string;
  migrated: {
    chat_sessions: number;
    chat_messages: number;
    api_environments: number;
    api_endpoints: number;
  };
  migrated_at: string;
}

interface AnonymousDataCheck {
  has_data: boolean;
  counts: {
    sessions: number;
    messages: number;
    environments: number;
  };
}

export class AnonymousMigrationService {
  /**
   * Check if anonymous user has any data to migrate
   */
  static async checkAnonymousData(anonymousId: string): Promise<AnonymousDataCheck> {
    try {
      const { data, error } = await supabase.rpc('check_anonymous_data', {
        p_anonymous_id: anonymousId,
      });

      if (error) {
        logger.error('[ANON_MIGRATION] Error checking anonymous data:', error);
        throw error;
      }

      logger.info('[ANON_MIGRATION] Check result:', { anonymousId, data });
      return data as AnonymousDataCheck;
    } catch (error: any) {
      logger.error('[ANON_MIGRATION] Failed to check anonymous data:', error);
      throw error;
    }
  }

  /**
   * Migrate all anonymous user data to authenticated user
   */
  static async migrateToAuthenticatedUser(
    anonymousId: string,
    userId: string
  ): Promise<MigrationResult> {
    try {
      logger.info('[ANON_MIGRATION] Starting migration:', { anonymousId, userId });

      // First check if there's any data to migrate
      const dataCheck = await this.checkAnonymousData(anonymousId);

      if (!dataCheck.has_data) {
        logger.info('[ANON_MIGRATION] No data to migrate:', { anonymousId });
        return {
          success: true,
          anonymous_id: anonymousId,
          user_id: userId,
          migrated: {
            chat_sessions: 0,
            chat_messages: 0,
            api_environments: 0,
            api_endpoints: 0,
          },
          migrated_at: new Date().toISOString(),
        };
      }

      // Call Supabase function to migrate data
      const { data, error } = await supabase.rpc('migrate_anonymous_to_authenticated', {
        p_anonymous_id: anonymousId,
        p_user_id: userId,
      });

      if (error) {
        logger.error('[ANON_MIGRATION] Migration failed:', error);
        throw error;
      }

      const result = data as MigrationResult;
      logger.info('[ANON_MIGRATION] Migration successful:', result);

      return result;
    } catch (error: any) {
      logger.error('[ANON_MIGRATION] Failed to migrate anonymous data:', error);
      throw error;
    }
  }

  /**
   * Get migrated sessions for a user
   * Useful to show user their previous anonymous chat history
   */
  static async getMigratedSessions(userId: string): Promise<any[]> {
    try {
      const { data, error } = await supabase
        .from('anonymous_chat_sessions')
        .select('*, anonymous_chat_messages(*)')
        .like('anonymous_id', `%_migrated_to_${userId}`)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('[ANON_MIGRATION] Error fetching migrated sessions:', error);
        throw error;
      }

      return data || [];
    } catch (error: any) {
      logger.error('[ANON_MIGRATION] Failed to get migrated sessions:', error);
      return [];
    }
  }

  /**
   * Check if user has migrated data
   */
  static async hasMigratedData(userId: string): Promise<boolean> {
    try {
      const { count, error } = await supabase
        .from('anonymous_chat_sessions')
        .select('id', { count: 'exact', head: true })
        .like('anonymous_id', `%_migrated_to_${userId}`);

      if (error) {
        logger.error('[ANON_MIGRATION] Error checking migrated data:', error);
        return false;
      }

      return (count || 0) > 0;
    } catch (error: any) {
      logger.error('[ANON_MIGRATION] Failed to check migrated data:', error);
      return false;
    }
  }
}
