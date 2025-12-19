import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import {
  JiraTokenResponse,
  JiraAccessibleResource,
  JiraTokenData,
  JiraProject,
} from '@/types';
import * as crypto from 'crypto';

const JIRA_AUTH_URL = 'https://auth.atlassian.com';
const JIRA_API_URL = 'https://api.atlassian.com';

/**
 * Generate random state for OAuth security
 */
export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Build OAuth authorization URL
 * @param state - Random state for security
 * @returns Authorization URL
 */
export function buildJiraAuthUrl(state: string): string {
  const clientId = env.JIRA_CLIENT_ID;
  const callbackUrl = env.JIRA_CALLBACK_URL || `http://localhost:${env.PORT}/api/jira/callback`;

  if (!clientId) {
    throw new Error('JIRA_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: 'read:jira-user read:jira-work write:jira-work offline_access',
    redirect_uri: callbackUrl,
    response_type: 'code',
    prompt: 'consent',
    state,
  });

  return `${JIRA_AUTH_URL}/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 * @param code - Authorization code from callback
 * @returns Token response
 */
export async function exchangeCodeForToken(
  code: string
): Promise<JiraTokenResponse> {
  const clientId = env.JIRA_CLIENT_ID;
  const clientSecret = env.JIRA_CLIENT_SECRET;
  const callbackUrl = env.JIRA_CALLBACK_URL || `http://localhost:${env.PORT}/api/jira/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('JIRA_CLIENT_ID and JIRA_CLIENT_SECRET must be configured');
  }

  try {
    const response = await fetch(`${JIRA_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Jira token exchange failed', { status: response.status, error: errorText });
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as JiraTokenResponse;
    logger.info('Jira token exchanged successfully');
    return tokenData;
  } catch (error) {
    logger.error('Jira token exchange error', error);
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 * @param refreshToken - Refresh token
 * @returns New token response
 */
export async function refreshJiraToken(refreshToken: string): Promise<JiraTokenResponse> {
  const clientId = env.JIRA_CLIENT_ID;
  const clientSecret = env.JIRA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('JIRA_CLIENT_ID and JIRA_CLIENT_SECRET must be configured');
  }

  try {
    const response = await fetch(`${JIRA_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Jira token refresh failed', { status: response.status, error: errorText });
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as JiraTokenResponse;
    logger.info('Jira token refreshed successfully');
    return tokenData;
  } catch (error) {
    logger.error('Jira token refresh error', error);
    throw error;
  }
}

/**
 * Get accessible Jira resources (cloud IDs)
 * @param accessToken - Access token
 * @returns List of accessible resources
 */
export async function getAccessibleResources(
  accessToken: string
): Promise<JiraAccessibleResource[]> {
  try {
    const response = await fetch(`${JIRA_API_URL}/oauth/token/accessible-resources`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to get accessible resources', { status: response.status, error: errorText });
      throw new Error(`Failed to get accessible resources: ${response.status} ${errorText}`);
    }

    const resources = await response.json() as JiraAccessibleResource[];
    return resources;
  } catch (error) {
    logger.error('Error getting accessible resources', error);
    throw error;
  }
}

/**
 * Save Jira token to database
 * @param userId - User ID
 * @param tokenData - Token response from OAuth
 * @param cloudId - Jira cloud ID
 * @param siteUrl - Jira site URL
 * @returns Saved token data
 */
export async function saveJiraToken(
  userId: string,
  tokenData: JiraTokenResponse,
  cloudId: string,
  siteUrl?: string
): Promise<JiraTokenData> {
  try {
    if (!cloudId) {
      throw new Error('cloud_id is required to save Jira token');
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : undefined;

    const tokenRecord: Partial<JiraTokenData> = {
      user_id: userId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt?.toISOString(),
      scope: tokenData.scope,
      cloud_id: cloudId,
      site_url: siteUrl,
      token_type: tokenData.token_type,
    };

    // Check if token already exists for this user and cloud_id
    const { data: existing } = await supabaseAdmin
      .from('jira_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('cloud_id', cloudId)
      .maybeSingle();

    if (existing) {
      // Update existing token
      const { data, error } = await supabaseAdmin
        .from('jira_tokens')
        .update(tokenRecord)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      logger.info('Jira token updated', { userId, cloudId });
      return data as JiraTokenData;
    }

    // Create new token
    const { data, error } = await supabaseAdmin
      .from('jira_tokens')
      .insert(tokenRecord)
      .select()
      .single();

    if (error) throw error;
    logger.info('Jira token saved', { userId, cloudId });
    return data as JiraTokenData;
  } catch (error) {
    logger.error('Failed to save Jira token', error);
    throw error;
  }
}

/**
 * Get Jira token for user
 * @param userId - User ID
 * @param cloudId - Optional cloud ID filter
 * @returns Token data or null
 */
export async function getJiraToken(
  userId: string,
  cloudId?: string
): Promise<JiraTokenData | null> {
  try {
    let query = supabaseAdmin
      .from('jira_tokens')
      .select('*')
      .eq('user_id', userId);

    if (cloudId) {
      query = query.eq('cloud_id', cloudId);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;
    return data as JiraTokenData | null;
  } catch (error) {
    logger.error('Failed to get Jira token', error);
    throw error;
  }
}

/**
 * Check if token is expired and refresh if needed
 * @param tokenData - Token data from database
 * @returns Valid access token
 */
export async function ensureValidToken(tokenData: JiraTokenData): Promise<string> {
  // Check if token is expired or expires soon (within 5 minutes)
  const now = new Date();
  const currentExpiresAt = tokenData.expires_at ? new Date(tokenData.expires_at) : null;

  if (currentExpiresAt && currentExpiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    // Token expired or expiring soon, refresh it
    if (!tokenData.refresh_token) {
      throw new Error('Token expired and no refresh token available');
    }

    logger.info('Refreshing expired Jira token', { userId: tokenData.user_id });
    const newTokenData = await refreshJiraToken(tokenData.refresh_token);

    // Update token in database
    const newExpiresAt = newTokenData.expires_in
      ? new Date(Date.now() + newTokenData.expires_in * 1000)
      : undefined;

    const { error } = await supabaseAdmin
      .from('jira_tokens')
      .update({
        access_token: newTokenData.access_token,
        refresh_token: newTokenData.refresh_token || tokenData.refresh_token,
        expires_at: newExpiresAt?.toISOString(),
        scope: newTokenData.scope,
        updated_at: new Date().toISOString(),
      })
      .eq('id', tokenData.id);

    if (error) {
      logger.error('Failed to update refreshed token', error);
      throw error;
    }

    return newTokenData.access_token;
  }

  return tokenData.access_token;
}

/**
 * Get Jira projects
 * @param accessToken - Access token
 * @param cloudId - Jira cloud ID
 * @returns List of projects
 */
export async function getJiraProjects(
  accessToken: string,
  cloudId: string
): Promise<JiraProject[]> {
  try {
    const response = await fetch(
      `${JIRA_API_URL}/ex/jira/${cloudId}/rest/api/3/project/search`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to get Jira projects', { status: response.status, error: errorText });
      throw new Error(`Failed to get projects: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { values?: JiraProject[] };
    return data.values || [];
  } catch (error) {
    logger.error('Error getting Jira projects', error);
    throw error;
  }
}
