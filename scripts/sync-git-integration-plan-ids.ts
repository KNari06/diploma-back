/**
 * One-time sync: set git_integrations.plan_id for integrations that match
 * regression_plans with automation_config.gitTriggers (integrationId or repositoryUrl).
 * Use when plans already exist in DB (e.g. created manually or before the link feature)
 * and webhooks are ignored with reason "no_plan_linked".
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/sync-git-integration-plan-ids.ts
 */

import { supabaseAdmin } from '../src/db/supabase';
import { GitIntegrationService } from '../src/services/integrations/git-integration.service';
import { logger } from '../src/utils/core/logger';

type AutomationConfig = {
  gitTriggers?: {
    enabled?: boolean;
    integrationId?: string;
    repositoryUrl?: string;
    branch?: string;
    triggerTypes?: string[];
  };
};

async function main(): Promise<void> {
  const { data: plans, error: plansError } = await supabaseAdmin
    .from('regression_plans')
    .select('id, project_id, name, automation_config');

  if (plansError) {
    logger.error('[SYNC_GIT_PLAN_IDS] Failed to load regression_plans', { error: plansError.message });
    process.exit(1);
  }

  const toSync = (plans || []).filter((row) => {
    const ac = row.automation_config as AutomationConfig | null;
    if (!ac?.gitTriggers?.enabled) return false;
    return !!(ac.gitTriggers.integrationId || ac.gitTriggers.repositoryUrl?.trim());
  });

  if (toSync.length === 0) {
    logger.info('[SYNC_GIT_PLAN_IDS] No plans with automation_config.gitTriggers (enabled + integrationId/repositoryUrl) found.');
    process.exit(0);
  }

  logger.info('[SYNC_GIT_PLAN_IDS] Found plans to sync', { count: toSync.length });

  let linked = 0;
  let skipped = 0;

  for (const plan of toSync) {
    const ac = plan.automation_config as AutomationConfig;
    const projectId = plan.project_id as string;
    const planId = plan.id as string;
    const planName = (plan.name as string) || planId;

    let integrationId: string | null = null;

    if (ac.gitTriggers!.integrationId) {
      const { data } = await supabaseAdmin
        .from('git_integrations')
        .select('id')
        .eq('id', ac.gitTriggers!.integrationId)
        .eq('project_id', projectId)
        .maybeSingle();
      integrationId = data?.id ?? null;
      if (!integrationId) {
        logger.warn('[SYNC_GIT_PLAN_IDS] Integration not found or wrong project', {
          planId,
          planName,
          integrationId: ac.gitTriggers!.integrationId,
        });
        skipped++;
        continue;
      }
    } else if (ac.gitTriggers!.repositoryUrl?.trim()) {
      try {
        const integration = await GitIntegrationService.findByProjectAndRepositoryUrl(
          projectId,
          ac.gitTriggers!.repositoryUrl!.trim()
        );
        integrationId = integration?.id ?? null;
      } catch (e) {
        logger.warn('[SYNC_GIT_PLAN_IDS] Invalid repositoryUrl or integration not found', {
          planId,
          planName,
          repositoryUrl: ac.gitTriggers!.repositoryUrl,
          error: e instanceof Error ? e.message : String(e),
        });
        skipped++;
        continue;
      }
    }

    if (!integrationId) {
      skipped++;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('git_integrations')
      .update({ plan_id: planId })
      .eq('id', integrationId);

    if (updateError) {
      logger.error('[SYNC_GIT_PLAN_IDS] Failed to set plan_id', {
        integrationId,
        planId,
        error: updateError.message,
      });
      skipped++;
      continue;
    }

    linked++;
    logger.info('[SYNC_GIT_PLAN_IDS] Linked', { planId, planName, integrationId });
  }

  logger.info('[SYNC_GIT_PLAN_IDS] Done', { linked, skipped });
  console.log(`Linked: ${linked}, Skipped: ${skipped}`);
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
