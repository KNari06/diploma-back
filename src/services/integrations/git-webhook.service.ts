import crypto from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { QueueManager } from '@/config/infrastructure/queues';
import { GitIntegrationService, GitProvider } from './git-integration.service';

export type GitWebhookEventType = 'pull_request' | 'merge_request' | 'push' | 'release';

export interface GitWebhookDeliveryMeta {
  provider: GitProvider;
  deliveryId: string;
  eventType: GitWebhookEventType;
  signature?: string;
}

export class GitWebhookService {
  static verifyGitHubSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
    const signature = (signatureHeader || '').trim();
    if (!signature || !secret) return false;

    const signatureHash = signature.replace(/^sha256=/, '');
    const expectedHash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signatureHash, 'hex'), Buffer.from(expectedHash, 'hex'));
    } catch {
      return false;
    }
  }

  static verifyGitLabToken(tokenHeader: string, secret: string): boolean {
    const token = (tokenHeader || '').trim();
    if (!token || !secret) return false;

    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
    } catch {
      return false;
    }
  }

  static extractRepositoryUrl(provider: GitProvider, payload: any): string | null {
    if (provider === 'github') {
      return payload?.repository?.html_url || null;
    }
    return payload?.project?.web_url || null;
  }

  static shouldTrigger(params: {
    provider: GitProvider;
    eventType: GitWebhookEventType;
    payload: any;
    allowedBranches?: string[];
  }): { trigger: boolean; reason: string; branch?: string } {
    const { provider, eventType, payload } = params;

    const allowedBranches = new Set(params.allowedBranches || ['main', 'master']);

    if (provider === 'github') {
      if (eventType === 'pull_request') {
        const action = payload?.action;
        const merged = !!payload?.pull_request?.merged;
        const baseRef = payload?.pull_request?.base?.ref;
        if (action !== 'closed' || !merged) return { trigger: false, reason: 'pr_not_merged' };
        if (!allowedBranches.has(String(baseRef))) return { trigger: false, reason: 'branch_not_allowed', branch: baseRef };
        return { trigger: true, reason: 'pr_merged', branch: baseRef };
      }

      if (eventType === 'push') {
        const ref = String(payload?.ref || '');
        const branch = ref.replace('refs/heads/', '');
        if (!allowedBranches.has(branch)) return { trigger: false, reason: 'branch_not_allowed', branch };
        return { trigger: true, reason: 'push_main', branch };
      }

      if (eventType === 'release') {
        const action = payload?.action;
        if (action !== 'published') return { trigger: false, reason: 'release_not_published' };
        return { trigger: true, reason: 'release_published' };
      }
    }

    // GitLab.com
    if (eventType === 'merge_request') {
      const state = payload?.object_attributes?.state;
      const targetBranch = payload?.object_attributes?.target_branch;
      if (state !== 'merged') return { trigger: false, reason: 'mr_not_merged' };
      if (!allowedBranches.has(String(targetBranch))) {
        return { trigger: false, reason: 'branch_not_allowed', branch: targetBranch };
      }
      return { trigger: true, reason: 'mr_merged', branch: targetBranch };
    }

    if (eventType === 'push') {
      const ref = String(payload?.ref || '');
      const branch = ref.replace('refs/heads/', '');
      if (!allowedBranches.has(branch)) return { trigger: false, reason: 'branch_not_allowed', branch };
      return { trigger: true, reason: 'push_main', branch };
    }

    if (eventType === 'release') {
      // GitLab Release Hook can be create/update/delete; we trigger on create
      const action = payload?.action || payload?.object_attributes?.action;
      if (action && String(action) !== 'create') return { trigger: false, reason: 'release_not_create' };
      return { trigger: true, reason: 'release_create' };
    }

    return { trigger: false, reason: 'event_not_supported' };
  }

  static async receiveAndEnqueue(params: {
    provider: GitProvider;
    deliveryId: string;
    eventType: GitWebhookEventType;
    rawBody: string;
    payload: any;
    signature?: string;
  }): Promise<{ queued: boolean; ignored: boolean; reason?: string }> {
    const { provider, deliveryId, eventType, rawBody, payload, signature } = params;

    const repositoryUrlRaw = this.extractRepositoryUrl(provider, payload);
    if (!repositoryUrlRaw) {
      throw new Error('Repository URL not found in webhook payload');
    }

    const integration = await GitIntegrationService.findByProviderAndRepositoryUrl(provider, repositoryUrlRaw);

    // Persist delivery (even if integration not found) for audit
    const repositoryUrlNormalized = integration?.repository_url || this.normalizeRepositoryUrl(repositoryUrlRaw, provider);

    const persisted = await this.persistDelivery({
      provider,
      deliveryId,
      eventType,
      repositoryUrl: repositoryUrlNormalized,
      integrationId: integration?.id || null,
      payload,
      signature,
    });

    if (persisted.isDuplicate) {
      return { queued: false, ignored: true, reason: 'duplicate_delivery' };
    }

    if (!integration) {
      await this.updateDeliveryStatus(provider, deliveryId, { status: 'ignored', error: 'integration_not_found' });
      return { queued: false, ignored: true, reason: 'integration_not_found' };
    }

    // Validate signature/token
    if (provider === 'github') {
      if (!signature || !this.verifyGitHubSignature(rawBody, signature, integration.webhook_secret)) {
        await this.updateDeliveryStatus(provider, deliveryId, { status: 'failed', error: 'invalid_signature' });
        throw new Error('Invalid GitHub webhook signature');
      }
    } else {
      // For GitLab we store token in `signature` field for audit (header value)
      if (!signature || !this.verifyGitLabToken(signature, integration.webhook_secret)) {
        await this.updateDeliveryStatus(provider, deliveryId, { status: 'failed', error: 'invalid_token' });
        throw new Error('Invalid GitLab webhook token');
      }
    }

    // Enqueue for async processing
    await QueueManager.addGitWebhookJob({ provider, deliveryId });
    await this.updateDeliveryStatus(provider, deliveryId, { status: 'queued' });

    return { queued: true, ignored: false };
  }

  private static normalizeRepositoryUrl(input: string, provider: GitProvider): string {
    const trimmed = (input || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
      return trimmed;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    const base = provider === 'github' ? 'https://github.com/' : 'https://gitlab.com/';
    return (base + trimmed).replace(/\/+$/, '');
  }

  private static async persistDelivery(params: {
    provider: GitProvider;
    deliveryId: string;
    eventType: string;
    repositoryUrl: string;
    integrationId: string | null;
    payload: any;
    signature?: string;
  }): Promise<{ isDuplicate: boolean }> {
    const { provider, deliveryId, eventType, repositoryUrl, integrationId, payload, signature } = params;

    const { error } = await supabaseAdmin
      .from('git_webhook_deliveries')
      .insert({
        provider,
        delivery_id: deliveryId,
        event_type: eventType,
        repository_url: repositoryUrl,
        integration_id: integrationId,
        payload,
        signature: signature || null,
        status: 'received',
      });

    if (error) {
      // Duplicate delivery
      if ((error as any).code === '23505') {
        logger.info('[GIT_WEBHOOK] Duplicate delivery ignored', { provider, deliveryId });
        return { isDuplicate: true };
      }
      logger.error('[GIT_WEBHOOK] Failed to persist delivery', { provider, deliveryId, error: error.message });
      throw new Error(`Failed to persist delivery: ${error.message}`);
    }

    return { isDuplicate: false };
  }

  static async updateDeliveryStatus(
    provider: GitProvider,
    deliveryId: string,
    params: { status: 'received' | 'queued' | 'processed' | 'ignored' | 'failed'; error?: string }
  ): Promise<void> {
    const { status, error } = params;

    const update: any = { status };
    if (status === 'processed' || status === 'failed' || status === 'ignored') {
      update.processed_at = new Date().toISOString();
    }
    if (error) update.error = error;

    const { error: updateError } = await supabaseAdmin
      .from('git_webhook_deliveries')
      .update(update)
      .eq('provider', provider)
      .eq('delivery_id', deliveryId);

    if (updateError) {
      logger.warn('[GIT_WEBHOOK] Failed to update delivery status', {
        provider,
        deliveryId,
        status,
        error: updateError.message,
      });
    }
  }
}

