import crypto from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { QueueManager } from '@/config/infrastructure/queues';
import { GitIntegrationService, GitProvider, type GitIntegrationRow } from './git-integration.service';

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
        // Determine the trigger reason based on the PR action
        if (action === 'closed' && merged) {
          if (!allowedBranches.has(String(baseRef))) return { trigger: false, reason: 'branch_not_allowed', branch: baseRef };
          return { trigger: true, reason: 'pr_merged', branch: baseRef };
        }
        if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
          if (!allowedBranches.has(String(baseRef))) return { trigger: false, reason: 'branch_not_allowed', branch: baseRef };
          return { trigger: true, reason: 'pr_opened', branch: baseRef };
        }
        return { trigger: false, reason: 'pr_action_ignored' };
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
      const action = payload?.object_attributes?.action;
      const targetBranch = payload?.object_attributes?.target_branch;
      if (state === 'merged') {
        if (!allowedBranches.has(String(targetBranch))) {
          return { trigger: false, reason: 'branch_not_allowed', branch: targetBranch };
        }
        return { trigger: true, reason: 'mr_merged', branch: targetBranch };
      }
      if (action === 'open' || action === 'reopen' || action === 'update') {
        if (!allowedBranches.has(String(targetBranch))) {
          return { trigger: false, reason: 'branch_not_allowed', branch: targetBranch };
        }
        return { trigger: true, reason: 'mr_opened', branch: targetBranch };
      }
      return { trigger: false, reason: 'mr_action_ignored' };
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

    // Find all integrations for this repo (multiple accounts/projects can have the same repo)
    let integrations = await GitIntegrationService.findAllByProviderAndRepositoryUrl(provider, repositoryUrlRaw);

    // If none, try to create one from a matching regression plan (same repo URL in gitTriggers)
    if (integrations.length === 0) {
      const created = await this.tryCreateIntegrationFromMatchingPlan(provider, repositoryUrlRaw);
      if (created) integrations = [created];
    }

    const firstIntegration = integrations.length > 0 ? integrations[0] : null;

    // Validate signature/token — GitHub/GitLab send ONE signature per request (tied to the
    // single webhook secret configured at the repo/project level). When multiple integrations
    // share the same repo, try each integration's secret until one matches. This handles the
    // edge case where integrations in different workspaces have different secrets.
    if (signature && integrations.some((i) => i.webhook_secret)) {
      let verified = false;
      for (const integration of integrations) {
        if (!integration.webhook_secret) continue;
        if (provider === 'github') {
          if (this.verifyGitHubSignature(rawBody, signature, integration.webhook_secret)) {
            verified = true;
            break;
          }
        } else {
          if (this.verifyGitLabToken(signature, integration.webhook_secret)) {
            verified = true;
            break;
          }
        }
      }
      if (!verified) {
        throw new Error(`Invalid ${provider === 'github' ? 'GitHub webhook signature' : 'GitLab webhook token'}`);
      }
    }

    // Persist delivery once (integration_id = first for audit/duplicate detection)
    const repositoryUrlNormalized = firstIntegration?.repository_url || this.normalizeRepositoryUrl(repositoryUrlRaw, provider);

    const persisted = await this.persistDelivery({
      provider,
      deliveryId,
      eventType,
      repositoryUrl: repositoryUrlNormalized,
      integrationId: firstIntegration?.id || null,
      payload,
      signature,
    });

    if (persisted.isDuplicate) {
      return { queued: false, ignored: true, reason: 'duplicate_delivery' };
    }

    if (integrations.length === 0) {
      const normalizedForLog = this.normalizeRepositoryUrl(repositoryUrlRaw, provider);
      logger.warn('[GIT_WEBHOOK] No git integration found for repo', {
        provider,
        repositoryUrl: repositoryUrlRaw,
        repositoryUrlNormalized: normalizedForLog,
        deliveryId,
        hint: 'Create integration via POST /api/v1/git-integrations or scripts/create-git-integration.ts; repository_url in DB must match normalized URL.',
      });
      await this.updateDeliveryStatus(provider, deliveryId, { status: 'ignored', error: 'integration_not_found' });
      return { queued: false, ignored: true, reason: 'integration_not_found' };
    }

    // Enqueue one job per integration so every account/project with this repo gets runs
    for (const integration of integrations) {
      await QueueManager.addGitWebhookJob({ provider, deliveryId, integrationId: integration.id });
    }
    await this.updateDeliveryStatus(provider, deliveryId, { status: 'queued' });

    return { queued: true, ignored: false };
  }

  /** Normalize repo URL for matching (trim, strip trailing slash and .git). */
  private static normalizeRepoUrlForMatch(url: string): string {
    const t = (url || '').trim().replace(/\/+$/, '');
    return t.endsWith('.git') ? t.slice(0, -4) : t;
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
    params: { status: 'received' | 'queued' | 'processed' | 'ignored' | 'failed'; error?: string; regressionRunId?: string }
  ): Promise<void> {
    const { status, error, regressionRunId } = params;

    const update: any = { status };
    if (status === 'processed' || status === 'failed' || status === 'ignored') {
      update.processed_at = new Date().toISOString();
    }
    if (error) update.error = error;
    if (regressionRunId) update.regression_run_id = regressionRunId;

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

  /**
   * When no git_integrations row exists, find a regression plan with matching gitTriggers.repositoryUrl
   * and create the integration so the webhook can be processed (e.g. different env where integration was not created).
   */
  private static async tryCreateIntegrationFromMatchingPlan(
    provider: GitProvider,
    repositoryUrlRaw: string
  ): Promise<GitIntegrationRow | null> {
    const targetNormalized = this.normalizeRepoUrlForMatch(repositoryUrlRaw);
    if (!targetNormalized) return null;

    const { data: plans, error } = await supabaseAdmin
      .from('regression_plans')
      .select('id, project_id, user_id, automation_config')
      .not('automation_config', 'is', null);

    if (error || !plans?.length) return null;

    for (const plan of plans) {
      const gt = (plan.automation_config as any)?.gitTriggers;
      if (!gt?.enabled) continue;
      const planUrl = (gt.repositoryUrl || '').trim();
      if (!planUrl || this.normalizeRepoUrlForMatch(planUrl) !== targetNormalized) continue;

      try {
        const created = await GitIntegrationService.createIntegration({
          projectId: plan.project_id,
          userId: plan.user_id,
          provider,
          repositoryUrl: repositoryUrlRaw,
          webhookSecret: '',
          events: ['push', 'pull_request', 'release'],
        });
        const { error: updateErr } = await supabaseAdmin
          .from('git_integrations')
          .update({ plan_id: plan.id })
          .eq('id', created.id);
        if (!updateErr) {
          logger.info('[GIT_WEBHOOK] Auto-created git integration from matching plan', {
            integrationId: created.id,
            planId: plan.id,
            repositoryUrl: created.repository_url,
          });
          return { ...created, plan_id: plan.id } as GitIntegrationRow;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isDuplicate = /duplicate|unique constraint/i.test(msg);
        if (isDuplicate) {
          const existing = await GitIntegrationService.findByProjectAndRepositoryUrl(
            plan.project_id,
            repositoryUrlRaw
          );
          if (existing) {
            await supabaseAdmin
              .from('git_integrations')
              .update({ plan_id: plan.id })
              .eq('id', existing.id);
            logger.info('[GIT_WEBHOOK] Using existing git integration and linked plan', {
              integrationId: existing.id,
              planId: plan.id,
            });
            return { ...existing, plan_id: plan.id } as GitIntegrationRow;
          }
        }
        logger.warn('[GIT_WEBHOOK] Auto-create integration failed', { planId: plan.id, error: msg });
      }
      return null;
    }
    return null;
  }
}

