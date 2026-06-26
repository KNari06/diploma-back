import { env } from '@/config/environment/env';
import { GitIntegrationService, GitProvider } from '@/services/integrations/git-integration.service';
import { GitWebhookService } from '@/services/integrations/git-webhook.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new Error('User ID not found - authentication failed');
  }
  return userId;
}

function getWebhookUrl(): string {
  const backendUrl = env.BACKEND_URL || `http://localhost:${env.PORT}`;
  return `${backendUrl}/api/${env.API_VERSION}/git-integrations/webhook`;
}

function sanitizeIntegration(row: any, webhookUrl?: string) {
  const safe = { ...row };
  delete safe.webhook_secret;
  if (webhookUrl !== undefined) (safe as any).webhook_url = webhookUrl;
  return safe;
}

/**
 * POST /api/v1/git-integrations
 */
export async function createIntegration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, provider, repositoryUrl, webhookSecret, events } = req.body;
    const userId = getUserId(req);

    if (!projectId || !provider || !repositoryUrl || !webhookSecret) {
      res.status(400).json({
        success: false,
        error: 'projectId, provider, repositoryUrl, and webhookSecret are required',
      });
      return;
    }

    if (provider !== 'github' && provider !== 'gitlab') {
      res.status(400).json({
        success: false,
        error: 'provider must be "github" or "gitlab"',
      });
      return;
    }

    logger.info('[GIT_INTEGRATION_API] Creating integration', { projectId, provider, userId });

    const integration = await GitIntegrationService.createIntegration({
      projectId,
      userId,
      provider: provider as GitProvider,
      repositoryUrl,
      webhookSecret,
      events,
    });

    const webhookUrl = getWebhookUrl();

    res.json({
      success: true,
      data: sanitizeIntegration(integration, webhookUrl),
      message: 'Git integration created successfully',
      webhookUrl,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[GIT_INTEGRATION_API] Failed to create integration', { error });
    handleControllerError(res, error, 'Failed to create git integration');
  }
}

/**
 * GET /api/v1/git-integrations?projectId=<uuid>
 */
export async function listIntegrations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;
    const userId = getUserId(req);

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const integrations = await GitIntegrationService.listIntegrations(projectId, userId);
    const webhookUrl = getWebhookUrl();

    res.json({
      success: true,
      data: integrations.map((i) => sanitizeIntegration(i, webhookUrl)),
      // Top-level webhookUrl mirrors the create/get responses so clients can
      // show the receiver URL BEFORE any integration exists (the create-plan
      // dialog needs it while the list is still empty).
      webhookUrl,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[GIT_INTEGRATION_API] Failed to list integrations', { error });
    handleControllerError(res, error, 'Failed to list git integrations');
  }
}

/**
 * GET /api/v1/git-integrations/:id
 */
export async function getIntegration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const integration = await GitIntegrationService.getIntegration(id, userId);
    const webhookUrl = getWebhookUrl();

    res.json({
      success: true,
      data: sanitizeIntegration(integration, webhookUrl),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[GIT_INTEGRATION_API] Failed to get integration', { error });
    handleControllerError(res, error, 'Failed to get git integration');
  }
}

/**
 * PUT /api/v1/git-integrations/:id
 */
export async function updateIntegration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { webhookSecret, events, enabled, planId } = req.body;
    const userId = getUserId(req);

    const integration = await GitIntegrationService.updateIntegration({
      integrationId: id,
      userId,
      webhookSecret,
      events,
      enabled,
      planId,
    });

    res.json({
      success: true,
      data: sanitizeIntegration(integration),
      message: 'Git integration updated successfully',
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[GIT_INTEGRATION_API] Failed to update integration', { error });
    handleControllerError(res, error, 'Failed to update git integration');
  }
}

/**
 * DELETE /api/v1/git-integrations/:id
 */
export async function deleteIntegration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await GitIntegrationService.deleteIntegration(id, userId);

    res.json({
      success: true,
      message: 'Git integration deleted successfully',
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[GIT_INTEGRATION_API] Failed to delete integration', { error });
    handleControllerError(res, error, 'Failed to delete git integration');
  }
}

/**
 * POST /api/v1/git-integrations/webhook
 *
 * Public endpoint. Security is provided by signature/token validation.
 * Uses raw body parsing (Buffer) for GitHub signature verification.
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  logger.info('[GIT_WEBHOOK_API] Webhook received', {
    method: req.method,
    path: req.path,
    url: req.originalUrl,
    githubEvent: req.header('x-github-event'),
    gitlabEvent: req.header('x-gitlab-event'),
  });
  try {
    const githubEvent = req.header('x-github-event');
    const gitlabEvent = req.header('x-gitlab-event');

    const provider: GitProvider | null = githubEvent ? 'github' : gitlabEvent ? 'gitlab' : null;
    if (!provider) {
      res.status(400).json({ success: false, error: 'Missing Git provider headers' });
      return;
    }

    const rawBody =
      Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';

    if (!rawBody) {
      res.status(400).json({ success: false, error: 'Empty webhook body' });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid JSON body' });
      return;
    }

    const deliveryId =
      provider === 'github'
        ? req.header('x-github-delivery') || crypto.createHash('sha256').update(rawBody).digest('hex')
        : req.header('x-gitlab-event-uuid') || crypto.createHash('sha256').update(rawBody).digest('hex');

    const signature =
      provider === 'github' ? req.header('x-hub-signature-256') || '' : req.header('x-gitlab-token') || '';

    const eventType =
      provider === 'github'
        ? (githubEvent as any)
        : (() => {
          const ev = String(gitlabEvent || '').toLowerCase();
          if (ev.includes('merge request')) return 'merge_request';
          if (ev.includes('push')) return 'push';
          if (ev.includes('release')) return 'release';
          return 'unknown';
        })();

    const result = await GitWebhookService.receiveAndEnqueue({
      provider,
      deliveryId,
      eventType,
      rawBody,
      payload,
      signature,
    });

    logger.info('[GIT_WEBHOOK_API] Webhook processed', {
      deliveryId,
      provider,
      eventType,
      queued: result.queued,
      ignored: result.ignored,
      reason: result.reason,
    });

    res.status(result.queued ? 202 : 200).json({
      success: true,
      queued: result.queued,
      ignored: result.ignored,
      reason: result.reason,
      timestamp: new Date(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const isAuthError = lower.includes('invalid github webhook signature') ||
      lower.includes('invalid gitlab webhook token') ||
      lower.includes('webhook signature required');

    logger.error('[GIT_WEBHOOK_API] Failed to process webhook', { error: message });

    res.status(isAuthError ? 401 : 500).json({
      success: false,
      error: isAuthError ? 'Invalid webhook signature/token' : 'Webhook processing failed',
      message,
      timestamp: new Date(),
    });
  }
}

function handleControllerError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) {
    logger.warn('[GIT_INTEGRATION_API] Response already sent, cannot send error response');
    return;
  }

  if (error instanceof NotFoundError) {
    res.status(404).json({
      success: false,
      error: 'Resource not found',
      message: error.message,
    });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({
      success: false,
      error: 'Validation error',
      message: error.message,
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
