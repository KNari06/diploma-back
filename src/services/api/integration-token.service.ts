import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTEGRATION TOKEN SERVICE (Unified OAuth Token Management)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Centralized service for managing OAuth tokens across all integration providers.
 * Supports: Jira, GitHub, GitLab, Notion, Trello, Slack
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type IntegrationProvider = 'jira' | 'github' | 'gitlab' | 'notion' | 'trello' | 'slack' | 'telegram';

export interface IntegrationToken {
  id: string;
  user_id: string;
  workspace_id?: string;
  provider: IntegrationProvider;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
  token_type: string;
  external_id?: string;
  external_url?: string;
  metadata?: Record<string, any>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  external_id?: string;
  external_url?: string;
  metadata?: Record<string, any>;
}

export class IntegrationTokenService {
  /**
   * Get valid token for user and provider.
   * When workspaceId is provided, scopes lookup to that workspace.
   * Returns null if no token exists.
   */
  static async getToken(
    userId: string,
    provider: IntegrationProvider,
    externalId?: string,
    workspaceId?: string
  ): Promise<IntegrationToken | null> {
    try {
      logger.debug('[INTEGRATION_TOKEN] Getting token', {
        userId,
        provider,
        externalId,
        workspaceId,
      });

      let query = supabaseAdmin
        .from('integration_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('provider', provider)
        .eq('enabled', true);

      if (externalId) {
        query = query.eq('external_id', externalId);
      }

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('[INTEGRATION_TOKEN] Failed to get token', {
          error: error.message,
          userId,
          provider,
        });
        throw error;
      }

      if (!data) {
        logger.debug('[INTEGRATION_TOKEN] No token found', { userId, provider });
        return null;
      }

      // Check if token is expired
      if (data.expires_at) {
        const expiresAt = new Date(data.expires_at);
        const now = new Date();
        if (expiresAt < now) {
          logger.warn('[INTEGRATION_TOKEN] Token expired', {
            userId,
            provider,
            expiresAt: data.expires_at,
          });
          // Token expired - caller should refresh
          return data as IntegrationToken;
        }
      }

      return data as IntegrationToken;
    } catch (error) {
      logger.error('[INTEGRATION_TOKEN] Get token error', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        provider,
      });
      throw error;
    }
  }

  /**
   * Save or update token
   */
  static async saveToken(
    userId: string,
    workspaceId: string | undefined,
    provider: IntegrationProvider,
    tokenData: TokenData
  ): Promise<IntegrationToken> {
    try {
      logger.info('[INTEGRATION_TOKEN] Saving token', {
        userId,
        workspaceId,
        provider,
        externalId: tokenData.external_id,
      });

      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : undefined;

      const record: Partial<IntegrationToken> = {
        user_id: userId,
        workspace_id: workspaceId,
        provider,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        scope: tokenData.scope,
        token_type: tokenData.token_type || 'Bearer',
        external_id: tokenData.external_id,
        external_url: tokenData.external_url,
        metadata: tokenData.metadata || {},
        enabled: true,
      };

      let data: any;
      let error: any;

      if (workspaceId) {
        // Workspace-scoped: find-then-insert/update to work with partial unique index
        const { data: existing } = await supabaseAdmin
          .from('integration_tokens')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .eq('provider', provider)
          .eq('external_id', tokenData.external_id ?? '')
          .limit(1)
          .maybeSingle();

        if (existing) {
          const result = await supabaseAdmin
            .from('integration_tokens')
            .update(record)
            .eq('id', existing.id)
            .select()
            .single();
          data = result.data;
          error = result.error;
        } else {
          const result = await supabaseAdmin
            .from('integration_tokens')
            .insert(record)
            .select()
            .single();
          data = result.data;
          error = result.error;
        }
      } else {
        // Legacy: upsert by user_id + provider + external_id
        const result = await supabaseAdmin
          .from('integration_tokens')
          .upsert(record, {
            onConflict: 'user_id,provider,external_id',
          })
          .select()
          .single();
        data = result.data;
        error = result.error;
      }

      if (error) {
        logger.error('[INTEGRATION_TOKEN] Failed to save token', {
          error: error.message,
          userId,
          provider,
        });
        throw error;
      }

      logger.info('[INTEGRATION_TOKEN] Token saved', {
        tokenId: data.id,
        userId,
        provider,
      });

      return data as IntegrationToken;
    } catch (error) {
      logger.error('[INTEGRATION_TOKEN] Save token error', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        provider,
      });
      throw error;
    }
  }

  /**
   * Refresh token (provider-specific logic should be implemented by caller)
   * This method just updates the token in the database
   */
  static async refreshToken(
    tokenId: string,
    newAccessToken: string,
    newRefreshToken?: string,
    expiresIn?: number
  ): Promise<IntegrationToken> {
    try {
      logger.info('[INTEGRATION_TOKEN] Refreshing token', { tokenId });

      const expiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined;

      const updates: Partial<IntegrationToken> = {
        access_token: newAccessToken,
        expires_at: expiresAt,
      };

      if (newRefreshToken) {
        updates.refresh_token = newRefreshToken;
      }

      const { data, error } = await supabaseAdmin
        .from('integration_tokens')
        .update(updates)
        .eq('id', tokenId)
        .select()
        .single();

      if (error) {
        logger.error('[INTEGRATION_TOKEN] Failed to refresh token', {
          error: error.message,
          tokenId,
        });
        throw error;
      }

      logger.info('[INTEGRATION_TOKEN] Token refreshed', { tokenId });

      return data as IntegrationToken;
    } catch (error) {
      logger.error('[INTEGRATION_TOKEN] Refresh token error', {
        error: error instanceof Error ? error.message : String(error),
        tokenId,
      });
      throw error;
    }
  }

  /**
   * Delete token (revoke access).
   * When workspaceId is provided, only deletes tokens scoped to that workspace.
   */
  static async deleteToken(
    userId: string,
    provider: IntegrationProvider,
    externalId?: string,
    workspaceId?: string
  ): Promise<boolean> {
    try {
      logger.info('[INTEGRATION_TOKEN] Deleting token', {
        userId,
        provider,
        externalId,
        workspaceId,
      });

      let query = supabaseAdmin
        .from('integration_tokens')
        .delete()
        .eq('user_id', userId)
        .eq('provider', provider);

      if (externalId) {
        query = query.eq('external_id', externalId);
      }

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { error } = await query;

      if (error) {
        logger.error('[INTEGRATION_TOKEN] Failed to delete token', {
          error: error.message,
          userId,
          provider,
        });
        throw error;
      }

      logger.info('[INTEGRATION_TOKEN] Token deleted', { userId, provider });

      return true;
    } catch (error) {
      logger.error('[INTEGRATION_TOKEN] Delete token error', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        provider,
      });
      throw error;
    }
  }

  /**
   * List all connected integrations for user
   */
  static async listConnectedIntegrations(
    userId: string,
    workspaceId?: string
  ): Promise<IntegrationToken[]> {
    try {
      logger.debug('[INTEGRATION_TOKEN] Listing connected integrations', {
        userId,
        workspaceId,
      });

      let query = supabaseAdmin
        .from('integration_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('enabled', true);

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) {
        logger.error('[INTEGRATION_TOKEN] Failed to list integrations', {
          error: error.message,
          userId,
        });
        throw error;
      }

      return (data || []) as IntegrationToken[];
    } catch (error) {
      logger.error('[INTEGRATION_TOKEN] List integrations error', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Disable token (soft delete - keeps record but marks as disabled).
   * When workspaceId is provided, only disables tokens scoped to that workspace.
   */
  static async disableToken(
    userId: string,
    provider: IntegrationProvider,
    externalId?: string,
    workspaceId?: string
  ): Promise<boolean> {
    try {
      logger.info('[INTEGRATION_TOKEN] Disabling token', {
        userId,
        provider,
        externalId,
        workspaceId,
      });

      let query = supabaseAdmin
        .from('integration_tokens')
        .update({ enabled: false })
        .eq('user_id', userId)
        .eq('provider', provider);

      if (externalId) {
        query = query.eq('external_id', externalId);
      }

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { error } = await query;

      if (error) {
        logger.error('[INTEGRATION_TOKEN] Failed to disable token', {
          error: error.message,
          userId,
          provider,
        });
        throw error;
      }

      logger.info('[INTEGRATION_TOKEN] Token disabled', { userId, provider });

      return true;
    } catch (error) {
      logger.error('[INTEGRATION_TOKEN] Disable token error', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        provider,
      });
      throw error;
    }
  }
}
