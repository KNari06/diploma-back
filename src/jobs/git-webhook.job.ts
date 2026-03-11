import { Job } from 'bullmq';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

import { GitWebhookService } from '@/services/integrations/git-webhook.service';
import { NotificationService } from '@/services/notifications/notification.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';

export class GitWebhookJobHandler {
  static async process(
    job: Job<{
      provider: 'github' | 'gitlab';
      deliveryId: string;
    }>
  ): Promise<void> {
    const { provider, deliveryId } = job.data;

    // Load delivery record
    const { data: delivery, error: deliveryError } = await supabaseAdmin
      .from('git_webhook_deliveries')
      .select('*')
      .eq('provider', provider)
      .eq('delivery_id', deliveryId)
      .maybeSingle();

    if (deliveryError || !delivery) {
      throw new Error(`Delivery not found: ${provider}:${deliveryId}`);
    }

    if (['processed', 'ignored', 'failed'].includes(delivery.status)) {
      logger.info('[GIT_WEBHOOK_JOB] Delivery already handled', {
        provider,
        deliveryId,
        status: delivery.status,
      });
      return;
    }

    const integrationId = delivery.integration_id as string | null;
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

    // Use linked plan_id or try to auto-link by matching a plan's gitTriggers.repositoryUrl to this integration
    let planId = integration.plan_id as string | null;
    if (!planId) {
      const linked = await tryAutoLinkPlanToIntegration(integration);
      if (linked) {
        planId = linked;
        logger.info('[GIT_WEBHOOK_JOB] Auto-linked plan to integration', {
          integrationId: integration.id,
          planId: linked,
          deliveryId,
        });
      }
    }
    if (!planId) {
      logger.warn('[GIT_WEBHOOK_JOB] No plan linked to git integration, skipping', {
        integrationId: integration.id,
        deliveryId,
      });
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'no_plan_linked',
      });
      return;
    }

    // Read plan-level automation config for branch filtering
    const planAutomationConfig = await (async () => {
      const { data: planRow } = await supabaseAdmin
        .from('regression_plans')
        .select('automation_config')
        .eq('id', planId)
        .maybeSingle();
      return planRow?.automation_config;
    })();

    // Check if git triggers are enabled in plan config
    if (planAutomationConfig?.gitTriggers && planAutomationConfig.gitTriggers.enabled === false) {
      logger.info('[GIT_WEBHOOK_JOB] Git triggers disabled in plan config', { planId, deliveryId });
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: 'git_triggers_disabled_in_plan',
      });
      return;
    }

    // Determine allowed branches from plan config (falls back to default main/master)
    const allowedBranches = planAutomationConfig?.gitTriggers?.branch
      ? [planAutomationConfig.gitTriggers.branch]
      : undefined;

    // Check plan-level triggerTypes filter
    const planTriggerTypes = planAutomationConfig?.gitTriggers?.triggerTypes as string[] | undefined;
    if (planTriggerTypes && planTriggerTypes.length > 0) {
      // Map webhook event type to plan trigger type(s). Push can match either push_to_branch or merge_to_main.
      const eventToTriggerMap: Record<string, string[]> = {
        pull_request: ['merge_to_main'],
        merge_request: ['merge_to_main'],
        push: ['push_to_branch', 'merge_to_main'],
        release: ['release'],
      };
      const allowedTriggers = eventToTriggerMap[deliveryEventType];
      const isEnabled =
        allowedTriggers && allowedTriggers.some((t) => planTriggerTypes.includes(t));
      if (allowedTriggers && !isEnabled) {
        logger.info('[GIT_WEBHOOK_JOB] Trigger type not enabled in plan', {
          deliveryId,
          planId,
          deliveryEventType,
          allowedTriggers,
          planTriggerTypes,
        });
        await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
          status: 'ignored',
          error: 'trigger_type_not_enabled',
        });
        return;
      }
    }

    // Decide if we should trigger regression based on payload + branch filters
    const decision = GitWebhookService.shouldTrigger({
      provider,
      eventType: deliveryEventType as any,
      payload: delivery.payload,
      allowedBranches,
    });

    if (!decision.trigger) {
      logger.info('[GIT_WEBHOOK_JOB] Webhook ignored by shouldTrigger', {
        provider,
        deliveryId,
        planId,
        deliveryEventType,
        reason: decision.reason,
        branch: decision.branch,
        allowedBranches,
      });
      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'ignored',
        error: decision.reason,
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

    logger.info('[GIT_WEBHOOK_JOB] Triggering regression run', {
      provider,
      deliveryId,
      planId,
      branch: decision.branch,
      reason: decision.reason,
    });

    try {

      // Trigger plan execution via webhook
      const result = await RegressionRunService.runPlan({
        planId,
        userId: project.user_id,
        trigger: 'webhook',
      });

      logger.info('[GIT_WEBHOOK_JOB] Plan execution triggered', {
        planId,
        runId: result.runId,
        totalTests: result.totalTests,
        deliveryId,
      });

      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, {
        status: 'processed',
        regressionRunId: result.runId,
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

        // Create in-app notification
        try {
          await NotificationService.createNotification({
            userId: project.user_id,
            type: 'personal',
            category: 'billing',
            title: 'Insufficient credits for CI run',
            message: `Your ${provider} webhook triggered a test run but failed due to insufficient credits. Please add credits to continue.`,
            metadata: {
              provider,
              deliveryId,
              projectId: integration.project_id,
              branch: decision.branch,
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

