/**
 * Script to create a Git (GitHub/GitLab) integration for webhook processing.
 * Use when webhooks arrive but are ignored with reason "integration_not_found".
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/create-git-integration.ts
 *   npx ts-node -r tsconfig-paths/register scripts/create-git-integration.ts --project-id <uuid>
 *   npx ts-node -r tsconfig-paths/register scripts/create-git-integration.ts --repo https://gitlab.com/owner/repo --secret my-webhook-secret
 *   npx ts-node -r tsconfig-paths/register scripts/create-git-integration.ts --repo https://gitlab.com/owner/repo
 *     (no --secret: no verification; or set GIT_INTEGRATION_WEBHOOK_SECRET / pass --secret with your GitLab Secret token)
 *
 * Default repo: https://gitlab.com/bekhop2006/COMP_MATH
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/core/logger';

const DEFAULT_REPO = 'https://gitlab.com/bekhop2006/COMP_MATH';
const PROVIDER = 'gitlab';
const EVENTS = ['push', 'pull_request', 'release'] as const;

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i >= process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}

function normalizeRepositoryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function main(): Promise<void> {
  let projectId = getArg('--project-id') || process.env.GIT_INTEGRATION_PROJECT_ID;

  if (!projectId) {
    const { data: projects, error } = await supabaseAdmin
      .from('projects')
      .select('id, name')
      .limit(1);

    if (error || !projects?.length) {
      logger.error('[CREATE_GIT_INTEGRATION] No projects in DB. Create a project first or pass --project-id <uuid>');
      process.exit(1);
    }
    projectId = projects[0].id;
    logger.info(`[CREATE_GIT_INTEGRATION] Using first project: ${projects[0].name} (${projectId})`);
  }

  const secretArg = process.argv.includes('--secret') ? getArg('--secret') : undefined;
  const webhookSecret =
    (secretArg !== undefined ? secretArg : process.env.GIT_INTEGRATION_WEBHOOK_SECRET) ?? '';
  if (!webhookSecret) {
    logger.info(
      '[CREATE_GIT_INTEGRATION] No webhook secret — verification will be skipped. To enable: set Secret token in GitLab and pass --secret <value> or GIT_INTEGRATION_WEBHOOK_SECRET.'
    );
  } else {
    logger.info(`[CREATE_GIT_INTEGRATION] Use this exact value in GitLab → Webhook → Secret token: ${webhookSecret}`);
  }

  const repositoryUrl = normalizeRepositoryUrl(getArg('--repo') || process.env.GIT_INTEGRATION_REPO_URL || DEFAULT_REPO);

  const { data, error } = await supabaseAdmin
    .from('git_integrations')
    .insert({
      project_id: projectId,
      provider: PROVIDER,
      repository_url: repositoryUrl,
      webhook_secret: webhookSecret,
      events: [...EVENTS],
      enabled: true,
    })
    .select('id, project_id, provider, repository_url, events, enabled')
    .single();

  if (error) {
    if (error.code === '23505') {
      logger.warn('[CREATE_GIT_INTEGRATION] Integration for this project+repo already exists.');
      const { data: existing } = await supabaseAdmin
        .from('git_integrations')
        .select('id, repository_url')
        .eq('project_id', projectId)
        .eq('repository_url', repositoryUrl)
        .maybeSingle();
      if (existing) {
        console.log(JSON.stringify(existing, null, 2));
      }
      process.exit(0);
    }
    logger.error('[CREATE_GIT_INTEGRATION] Insert failed', { error: error.message });
    process.exit(1);
  }

  logger.info('[CREATE_GIT_INTEGRATION] Created');
  console.log(JSON.stringify(data, null, 2));
  console.log('\nNext: In GitLab → Project → Webhooks, set Secret token to:', webhookSecret);
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
