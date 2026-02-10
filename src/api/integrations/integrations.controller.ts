import { Request, Response } from 'express';
import { IntegrationTokenService, type IntegrationProvider } from '@/services/api/integration-token.service';
import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTEGRATIONS CONTROLLER (OAuth Flows)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unified OAuth flows for all integration providers.
 * Routes:
 * - GET /api/v1/integrations - List connected integrations
 * - GET /api/v1/integrations/:provider/authorize - Start OAuth flow
 * - GET /api/v1/integrations/:provider/callback - OAuth callback
 * - DELETE /api/v1/integrations/:provider - Disconnect integration
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * List all connected integrations for user
 */
export async function listIntegrations(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const workspaceId = req.query.workspace_id as string | undefined;

    logger.info('[INTEGRATIONS] Listing integrations', { userId, workspaceId });

    const integrations = await IntegrationTokenService.listConnectedIntegrations(
      userId,
      workspaceId
    );

    // Remove sensitive fields before sending to client
    const sanitized = integrations.map((integration) => ({
      id: integration.id,
      provider: integration.provider,
      external_id: integration.external_id,
      external_url: integration.external_url,
      enabled: integration.enabled,
      created_at: integration.created_at,
      updated_at: integration.updated_at,
      // Don't send access_token, refresh_token
    }));

    res.json({
      success: true,
      integrations: sanitized,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] List integrations error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to list integrations',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Start OAuth authorization flow
 */
export async function startAuthorization(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const provider = req.params.provider as IntegrationProvider;
    const workspaceId = req.query.workspace_id as string | undefined;

    logger.info('[INTEGRATIONS] Starting authorization', { userId, provider, workspaceId });

    // Validate provider
    const validProviders: IntegrationProvider[] = ['jira', 'github', 'gitlab', 'notion', 'trello', 'slack', 'telegram'];
    if (!validProviders.includes(provider)) {
      res.status(400).json({
        success: false,
        error: 'Invalid provider',
        message: `Provider must be one of: ${validProviders.join(', ')}`,
      });
      return;
    }

    // Generate OAuth URL based on provider
    let authUrl: string;

    switch (provider) {
      case 'github':
        authUrl = buildGitHubAuthUrl(userId, workspaceId);
        break;

      case 'notion':
        authUrl = buildNotionAuthUrl(userId, workspaceId);
        break;

      case 'jira':
        // Jira OAuth is already implemented in jira.service.ts
        // Redirect to existing Jira route
        res.redirect(`/api/${env.API_VERSION}/jira/authorize`);
        return;

      default:
        res.status(501).json({
          success: false,
          error: 'Not implemented',
          message: `OAuth flow for ${provider} is not yet implemented`,
        });
        return;
    }

    // Redirect to OAuth authorization URL
    res.redirect(authUrl);
  } catch (error) {
    logger.error('[INTEGRATIONS] Start authorization error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to start authorization',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * OAuth callback handler
 */
export async function handleCallback(req: Request, res: Response): Promise<void> {
  try {
    const provider = req.params.provider as IntegrationProvider;
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code) {
      res.status(400).json({
        success: false,
        error: 'Missing code',
        message: 'Authorization code not provided',
      });
      return;
    }

    logger.info('[INTEGRATIONS] Handling OAuth callback', { provider });

    // Decode state to get userId and workspaceId
    const { userId, workspaceId } = decodeState(state);

    // Exchange code for token based on provider
    switch (provider) {
      case 'github':
        await handleGitHubCallback(userId, workspaceId, code);
        break;

      case 'notion':
        await handleNotionCallback(userId, workspaceId, code);
        break;

      case 'jira':
        // Jira callback is already handled in jira.controller.ts
        res.redirect(`/api/${env.API_VERSION}/jira/callback?code=${code}&state=${state}`);
        return;

      default:
        res.status(501).json({
          success: false,
          error: 'Not implemented',
          message: `OAuth callback for ${provider} is not yet implemented`,
        });
        return;
    }

    // Redirect to frontend success page
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/integrations?provider=${provider}&status=success`);
  } catch (error) {
    logger.error('[INTEGRATIONS] OAuth callback error', {
      error: error instanceof Error ? error.message : String(error),
    });

    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/integrations?status=error&message=${encodeURIComponent('Failed to connect integration')}`);
  }
}

/**
 * Disconnect integration
 */
export async function disconnectIntegration(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const provider = req.params.provider as IntegrationProvider;
    const externalId = req.query.external_id as string | undefined;

    logger.info('[INTEGRATIONS] Disconnecting integration', { userId, provider, externalId });

    await IntegrationTokenService.deleteToken(userId, provider, externalId);

    res.json({
      success: true,
      message: `${provider} integration disconnected successfully`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] Disconnect integration error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to disconnect integration',
      timestamp: new Date().toISOString(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build GitHub OAuth URL
 */
function buildGitHubAuthUrl(userId: string, workspaceId?: string): string {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error('GITHUB_CLIENT_ID not configured');
  }

  const callbackUrl = `${env.BACKEND_URL || `http://localhost:${env.PORT}`}/api/${env.API_VERSION}/integrations/github/callback`;
  const state = encodeState(userId, workspaceId);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: 'repo,read:user',
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Build Notion OAuth URL
 */
function buildNotionAuthUrl(userId: string, workspaceId?: string): string {
  const clientId = env.NOTION_CLIENT_ID;
  if (!clientId) {
    throw new Error('NOTION_CLIENT_ID not configured');
  }

  const callbackUrl = `${env.BACKEND_URL || `http://localhost:${env.PORT}`}/api/${env.API_VERSION}/integrations/notion/callback`;
  const state = encodeState(userId, workspaceId);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    owner: 'user',
    state,
  });

  return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
}

/**
 * Handle GitHub callback
 */
async function handleGitHubCallback(userId: string, workspaceId: string | undefined, code: string): Promise<void> {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GitHub OAuth credentials not configured');
  }

  // Exchange code for token
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const tokenData = await response.json() as {
    access_token: string;
    scope: string;
    token_type: string;
  };

  // Get user info for external_id
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  const userData = await userResponse.json() as {
    login: string;
    html_url: string;
    name: string | null;
  };

  // Save token
  await IntegrationTokenService.saveToken(userId, workspaceId, 'github', {
    access_token: tokenData.access_token,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    external_id: userData.login,
    external_url: userData.html_url,
    metadata: { username: userData.login, name: userData.name },
  });
}

/**
 * Handle Notion callback
 */
async function handleNotionCallback(userId: string, workspaceId: string | undefined, code: string): Promise<void> {
  const clientId = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Notion OAuth credentials not configured');
  }

  const callbackUrl = `${env.BACKEND_URL || `http://localhost:${env.PORT}`}/api/${env.API_VERSION}/integrations/notion/callback`;

  // Exchange code for token
  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Notion token exchange failed: ${response.status}`);
  }

  const tokenData = await response.json() as {
    access_token: string;
    token_type: string;
    workspace_id: string;
    workspace_icon: string;
    workspace_name: string;
    bot_id: string;
  };

  // Save token
  await IntegrationTokenService.saveToken(userId, workspaceId, 'notion', {
    access_token: tokenData.access_token,
    token_type: tokenData.token_type,
    external_id: tokenData.workspace_id,
    external_url: tokenData.workspace_icon,
    metadata: {
      workspace_name: tokenData.workspace_name,
      bot_id: tokenData.bot_id,
    },
  });
}

/**
 * Encode state parameter
 */
function encodeState(userId: string, workspaceId?: string): string {
  const state = { userId, workspaceId };
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

/**
 * Decode state parameter
 */
function decodeState(state: string): { userId: string; workspaceId?: string } {
  const decoded = Buffer.from(state, 'base64').toString('utf-8');
  return JSON.parse(decoded);
}

/**
 * Setup Telegram bot integration
 * POST /api/v1/integrations/telegram/setup
 */
export async function setupTelegram(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const workspaceId = (req.query.workspace_id as string) || undefined;
    const { bot_token, chat_id, description } = req.body;

    // Validate required fields
    if (!bot_token || typeof bot_token !== 'string') {
      res.status(400).json({
        success: false,
        error: 'bot_token is required and must be a string',
      });
      return;
    }

    // Validate bot token format (basic check - should start with digits)
    if (!/^\d+:[\w-]+$/.test(bot_token)) {
      res.status(400).json({
        success: false,
        error: 'Invalid bot token format. Bot tokens should be in format: <bot_id>:<token_string>',
      });
      return;
    }

    // Validate bot token by calling Telegram's getMe API
    const { getMe } = await import('@/services/api/telegram.service');
    let botInfo;

    try {
      botInfo = await getMe(bot_token);
    } catch (error) {
      logger.error('[INTEGRATIONS] Telegram getMe failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        success: false,
        error: 'Invalid bot token. Please verify the token from @BotFather.',
      });
      return;
    }

    // Verify it's actually a bot
    if (!botInfo.is_bot) {
      res.status(400).json({
        success: false,
        error: 'The provided token is not for a bot account.',
      });
      return;
    }

    // Validate chat_id if provided
    if (chat_id !== undefined && chat_id !== null && chat_id !== '') {
      if (typeof chat_id !== 'string' && typeof chat_id !== 'number') {
        res.status(400).json({
          success: false,
          error: 'chat_id must be a string or number',
        });
        return;
      }
    }

    // Save token to integration_tokens table
    const savedToken = await IntegrationTokenService.saveToken(
      userId,
      workspaceId,
      'telegram',
      {
        access_token: bot_token,
        token_type: 'Bot',
        external_id: chat_id ? String(chat_id) : botInfo.username,
        external_url: `https://t.me/${botInfo.username}`,
        metadata: {
          bot_id: botInfo.id,
          bot_username: botInfo.username,
          bot_name: botInfo.first_name,
          description: description || undefined,
        },
      }
    );

    logger.info('[INTEGRATIONS] Telegram bot configured', {
      userId,
      botUsername: botInfo.username,
      botId: botInfo.id,
      workspaceId,
    });

    // Return sanitized response (no access_token)
    res.json({
      success: true,
      data: {
        id: savedToken.id,
        provider: 'telegram',
        bot_username: botInfo.username,
        bot_name: botInfo.first_name,
        bot_id: botInfo.id,
        chat_id: chat_id || null,
        external_url: savedToken.external_url,
        enabled: savedToken.enabled,
        created_at: savedToken.created_at,
        updated_at: savedToken.updated_at,
      },
      message: 'Telegram bot configured successfully',
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] Telegram setup error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to setup Telegram bot',
    });
  }
}
