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

    // Check if a plan is linked to this integration
    const planId = integration.plan_id as string | null;
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

    // Determine allowed branches from plan config (falls back to default main/master)
    const allowedBranches = planAutomationConfig?.gitTriggers?.branch
      ? [planAutomationConfig.gitTriggers.branch]
      : undefined;

    // Check plan-level triggerTypes filter
    const planTriggerTypes = planAutomationConfig?.gitTriggers?.triggerTypes as string[] | undefined;
    if (planTriggerTypes && planTriggerTypes.length > 0) {
      // Map webhook event type to plan trigger type
      const eventToTriggerMap: Record<string, string> = {
        pull_request: 'merge_to_main',
        merge_request: 'merge_to_main',
        push: 'merge_to_main',
        release: 'release',
      };
      const mappedTrigger = eventToTriggerMap[deliveryEventType];
      if (mappedTrigger && !planTriggerTypes.includes(mappedTrigger)) {
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

      await GitWebhookService.updateDeliveryStatus(provider, deliveryId, { status: 'processed' });
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

