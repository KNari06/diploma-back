import { Job } from 'bullmq';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';

import { GitWebhookService } from '@/services/integrations/git-webhook.service';
import { NotificationService } from '@/services/notifications/notification.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { getTelegramToken, sendTelegramNotification } from '@/utils/notifications/telegram-notify';

export class GitWebhookJobHandler {
  static async process(
    job: Job<{
      provider: 'github' | 'gitlab';
      deliveryId: string;
      integrationId?: string;
    }>
  ): Promise<void> {
    const { provider, deliveryId, integrationId: jobIntegrationId } = job.data;

    // Load delivery record (for payload, event_type, etc.)
    const { data: delivery, error: deliveryError } = await supabaseAdmin
      .from('git_webhook_deliveries')
      .select('*')
      .eq('provider', provider)
      .eq('delivery_id', deliveryId)
      .maybeSingle();

    if (deliveryError || !delivery) {
      throw new Error(`Delivery not found: ${provider}:${deliveryId}`);
    }

    // Resolve which integration this job handles
    const integrationId = jobIntegrationId ?? (delivery.integration_id as string | null);

    // Single-integration path: skip if delivery already finalized
    if (!jobIntegrationId && ['processed', 'ignored', 'failed'].includes(delivery.status)) {
      logger.info('[GIT_WEBHOOK_JOB] Delivery already handled', {
        provider,
        deliveryId,
        status: delivery.status,
      });
      return;
    }

    if (!integrationId) {
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'integration_not_found',
      });
      return;
    }

    const { data: integration, error: integrationError } = await supabaseAdmin
      .from('git_integrations')
      .select('*')
      .eq('id', integrationId)
      .maybeSingle();

    if (integrationError || !integration) {
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'integration_deleted',
      });
      return;
    }

    if (!integration.enabled) {
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'integration_disabled',
      });
      return;
    }

    // Map gitlab merge_request → pull_request config event
    const deliveryEventType = String(delivery.event_type || '');
    const configEvent =
      provider === 'gitlab' && deliveryEventType === 'merge_request' ? 'pull_request' : deliveryEventType;

    const allowedEvents = (integration.events || []) as string[];
    if (!allowedEvents.includes(configEvent)) {
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'event_not_enabled',
      });
      return;
    }

    // Find all plans in this project that have this repo as git trigger (so one webhook can run multiple plans)
    const matchingPlans = await getPlansMatchingIntegration(integration, deliveryEventType, delivery.payload, provider);
    if (matchingPlans.length === 0) {
      // Fallback: try to auto-link one plan so next time we have at least one
      const linked = await tryAutoLinkPlanToIntegration(integration);
      if (linked) {
        logger.info('[GIT_WEBHOOK_JOB] Auto-linked plan to integration', {
          integrationId: integration.id,
          planId: linked,
          deliveryId,
        });
      }
      logger.warn('[GIT_WEBHOOK_JOB] No plans match this webhook (repo + branch/trigger), skipping', {
        integrationId: integration.id,
        deliveryId,
      });
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'no_plan_linked',
      });
      return;
    }

    // Resolve project owner for RegressionRunService access checks
    const { data: project, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', integration.project_id)
      .maybeSingle();

    if (projectError || !project?.user_id) {
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'failed',
        error: 'project_not_found',
      });
      throw new Error('Project not found for integration');
    }

    logger.info('[GIT_WEBHOOK_JOB] Triggering regression runs for all matching plans', {
      provider,
      deliveryId,
      planIds: matchingPlans.map((p) => p.planId),
      count: matchingPlans.length,
    });

    try {
      // Phase 5: extract commit SHA from the webhook payload so mobile
      // regressions can install the APK built from *this* commit (or at
      // least the latest on that branch). Branch already comes out of
      // `shouldTrigger()` via `decision.branch`.
      const commitSha = extractCommitShaFromPayload(delivery.payload, provider, deliveryEventType);

      let firstRunId: string | null = null;
      for (const { planId, decision } of matchingPlans) {
        const result = await RegressionRunService.runPlan({
          planId,
          userId: project.user_id,
          trigger: 'webhook',
          triggerContext: {
            branch: decision.branch,
            commitSha,
          },
        });
        if (!firstRunId) firstRunId = result.runId;
        logger.info('[GIT_WEBHOOK_JOB] Plan execution triggered', {
          planId,
          runId: result.runId,
          totalTests: result.totalTests,
          deliveryId,
          branch: decision.branch,
          commitSha,
        });
      }

      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'processed',
        regressionRunId: firstRunId ?? undefined,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'failed',
        error: errorMessage,
      });

      // Check if it's an insufficient credits error
      if (errorMessage.includes('Insufficient credits')) {
        logger.warn('[GIT_WEBHOOK_JOB] Insufficient credits for git-triggered run', {
          userId: project.user_id,
          provider,
          deliveryId,
          error: errorMessage,
        });

        const insufficientCreditsMessage = `Your ${provider} webhook triggered a test run but failed due to insufficient credits. Please add credits to continue.`;

        // Create in-app notification
        try {
          await NotificationService.createNotification({
            userId: project.user_id,
            type: 'personal',
            category: 'billing',
            title: 'Insufficient credits for CI run',
            message: insufficientCreditsMessage,
            metadata: {
              provider,
              deliveryId,
              projectId: integration.project_id,
              branch: matchingPlans[0]?.decision?.branch,
              error: errorMessage,
              dedupeKey: `git-webhook:${deliveryId}:insufficient`,
            },
          });

          logger.info('[GIT_WEBHOOK_JOB] Created insufficient credits notification', {
            userId: project.user_id,
            deliveryId,
          });
        } catch (notifError) {
          logger.error('[GIT_WEBHOOK_JOB] Failed to create insufficient credits notification', {
            error: notifError instanceof Error ? notifError.message : String(notifError),
            userId: project.user_id,
          });
        }

        try {
          const tokenData = await getTelegramToken(project.user_id);
          if (tokenData?.external_id) {
            const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
            await sendTelegramNotification(tokenData, {
              icon: '⚠️',
              title: 'Insufficient credits for CI run',
              fields: [{ label: 'Provider', value: provider }],
              ctaLabel: 'View billing →',
              ctaUrl: `${frontendUrl}/billing`,
            });
          }
        } catch (tgError) {
          logger.warn('[GIT_WEBHOOK_JOB] Failed to send Telegram notification for insufficient credits', {
            error: tgError instanceof Error ? tgError.message : String(tgError),
            userId: project.user_id,
          });
        }
      }
      
      throw error;
    }
  }
}

/** Normalize repo URL for matching (trim, strip trailing slash and .git). */
function normalizeRepoUrlForMatch(url: string): string {
  const t = (url || '').trim().replace(/\/+$/, '');
  return t.endsWith('.git') ? t.slice(0, -4) : t;
}

const EVENT_TO_TRIGGER_MAP: Record<string, string[]> = {
  pull_request: ['merge_to_main', 'pr_opened'],
  merge_request: ['merge_to_main', 'pr_opened'],
  push: ['push_to_branch'],
  release: ['release'],
};

/** Map shouldTrigger() reason → frontend trigger type for precise plan matching. */
const REASON_TO_TRIGGER_TYPE: Record<string, string> = {
  pr_merged: 'merge_to_main',
  mr_merged: 'merge_to_main',
  pr_opened: 'pr_opened',
  mr_opened: 'pr_opened',
  push_main: 'push_to_branch',
  release_published: 'release',
  release_create: 'release',
};

/**
 * Find all regression plans in the integration's project that:
 * - have gitTriggers.repositoryUrl matching the integration's repo,
 * - have git triggers enabled,
 * - have triggerTypes matching the delivery event (if configured),
 * - pass shouldTrigger (branch filter) for this payload.
 * Returns list of { planId, decision } for each plan that should be run.
 */
async function getPlansMatchingIntegration(
  integration: { id: string; project_id: string; repository_url: string },
  deliveryEventType: string,
  payload: unknown,
  provider: 'github' | 'gitlab'
): Promise<Array<{ planId: string; decision: { trigger: boolean; reason?: string; branch?: string } }>> {
  const targetUrl = normalizeRepoUrlForMatch(integration.repository_url);
  if (!targetUrl) return [];

  const { data: plans, error } = await supabaseAdmin
    .from('regression_plans')
    .select('id, automation_config')
    .eq('project_id', integration.project_id);

  if (error || !plans?.length) return [];

  const out: Array<{ planId: string; decision: { trigger: boolean; reason?: string; branch?: string } }> = [];
  for (const plan of plans) {
    const planAutomationConfig = (plan.automation_config as any) ?? {};
    const gt = planAutomationConfig.gitTriggers;
    if (!gt || gt.enabled === false) continue;
    const repoUrl = (gt.repositoryUrl || '').trim();
    if (!repoUrl || normalizeRepoUrlForMatch(repoUrl) !== targetUrl) continue;

    const allowedBranches = gt.branch ? [gt.branch] : undefined;
    const decision = GitWebhookService.shouldTrigger({
      provider,
      eventType: deliveryEventType as any,
      payload,
      allowedBranches,
    });
    if (!decision.trigger) continue;

    // Map the shouldTrigger decision reason to the actual trigger type
    const actualTriggerType = REASON_TO_TRIGGER_TYPE[decision.reason] || null;
    const planTriggerTypes = (gt.triggerTypes as string[] | undefined) ?? [];
    if (planTriggerTypes.length > 0 && actualTriggerType) {
      if (!planTriggerTypes.includes(actualTriggerType)) continue;
    }

    out.push({ planId: plan.id, decision });
  }
  return out;
}

/**
 * If integration has no plan_id, find a regression_plan in the same project with
 * gitTriggers.repositoryUrl matching this integration's repository_url and link it.
 * Returns plan_id if linked, null otherwise.
 */
async function tryAutoLinkPlanToIntegration(integration: {
  id: string;
  project_id: string;
  repository_url: string;
}): Promise<string | null> {
  const targetUrl = normalizeRepoUrlForMatch(integration.repository_url);
  if (!targetUrl) return null;

  const { data: plans, error } = await supabaseAdmin
    .from('regression_plans')
    .select('id, automation_config')
    .eq('project_id', integration.project_id);

  if (error || !plans?.length) return null;

  for (const plan of plans) {
    const gt = (plan.automation_config as any)?.gitTriggers;
    if (!gt?.enabled) continue;
    const repoUrl = (gt.repositoryUrl || '').trim();
    if (!repoUrl) continue;
    if (normalizeRepoUrlForMatch(repoUrl) !== targetUrl) continue;

    const { error: updateError } = await supabaseAdmin
      .from('git_integrations')
      .update({ plan_id: plan.id })
      .eq('id', integration.id);

    if (!updateError) return plan.id;
    logger.warn('[GIT_WEBHOOK_JOB] Auto-link update failed', {
      integrationId: integration.id,
      planId: plan.id,
      error: updateError.message,
    });
    return null;
  }
  return null;
}

/**
 * Phase 5 — extract the commit SHA from a raw webhook payload.
 *
 * Returns `undefined` when no SHA can be confidently identified; callers
 * must fall back to branch-only matching in that case. Intentionally
 * lenient: GitHub and GitLab put the commit in different places depending
 * on the event, and we'd rather miss-pin a build than crash the run.
 *
 *   - GitHub push     → payload.after
 *   - GitHub PR       → payload.pull_request.head.sha
 *   - GitHub release  → payload.release.target_commitish (may be a branch name; filter by shape)
 *   - GitLab push     → payload.after  OR  payload.checkout_sha
 *   - GitLab MR       → payload.object_attributes.last_commit.id
 *
 * The resolver treats a missing commitSha as "use latest on branch", which
 * is the sane default for most CI pipelines that upload an APK and then
 * immediately fire the webhook.
 */
function extractCommitShaFromPayload(
  payload: unknown,
  provider: 'github' | 'gitlab',
  eventType: string,
): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, any>;

  const looksLikeSha = (s: unknown): s is string =>
    typeof s === 'string' && /^[a-f0-9]{7,40}$/i.test(s);

  try {
    if (provider === 'github') {
      if (eventType === 'pull_request') {
        const sha = p.pull_request?.head?.sha;
        if (looksLikeSha(sha)) return sha;
      }
      if (eventType === 'push') {
        if (looksLikeSha(p.after)) return p.after;
      }
      if (eventType === 'release') {
        // target_commitish may be a branch name ('main') OR a SHA — only trust shape.
        if (looksLikeSha(p.release?.target_commitish)) return p.release.target_commitish;
      }
    } else if (provider === 'gitlab') {
      if (eventType === 'merge_request') {
        const sha = p.object_attributes?.last_commit?.id;
        if (looksLikeSha(sha)) return sha;
      }
      if (eventType === 'push') {
        if (looksLikeSha(p.checkout_sha)) return p.checkout_sha;
        if (looksLikeSha(p.after)) return p.after;
      }
    }
  } catch {
    // payload shape is untrusted — any exception means "no SHA".
  }

  return undefined;
}

