import { Job } from 'bullmq';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

import { GitWebhookService } from '@/services/integrations/git-webhook.service';
import { NotificationService } from '@/services/notifications/notification.service';

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

    // Decide if we should trigger regression based on payload + branch filters
    const decision = GitWebhookService.shouldTrigger({
      provider,
      eventType: deliveryEventType as any,
      payload: delivery.payload,
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
      branch: decision.branch,
      reason: decision.reason,
    });

    try {
      // TODO: Update to use module or plan instead of suite (suite_id removed)
      logger.warn('[GIT_WEBHOOK_JOB] Suite-based git integrations no longer supported', {
        integrationId: integration.id,
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

