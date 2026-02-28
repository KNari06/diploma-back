import { SkillRegistry } from './skill-registry';
import { JiraSkill } from './integrations/jira.skill';
import { GitHubSkill } from './integrations/github.skill';
import { NotionSkill } from './integrations/notion.skill';
import { TelegramSkill } from './integrations/telegram.skill';
import { SlackSkill } from './integrations/slack.skill';
import { QASkill } from './qa/qa.skill';
import { MemorySkill } from './memory/memory.skill';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKILLS REGISTRATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Centralized registration of all skills.
 * Called during server startup.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Register all available skills and run onInit lifecycle hooks.
 * Called from src/index.ts during server startup.
 *
 * Phase 1: Register — synchronous, any failure is fatal (throws)
 * Phase 2: Initialize — runs onInit() for each skill that defines it.
 *   - Uses Promise.allSettled so one failing onInit doesn't block others.
 *   - onInit failure is non-fatal: skill stays registered, warning logged.
 */
export async function registerAllSkills(): Promise<void> {
  logger.info('[SKILLS] Registering all skills...');

  // ── Phase 1: Register (sync, fatal on error) ─────────────────────────
  try {
    // Register integration skills
    SkillRegistry.register(JiraSkill);
    SkillRegistry.register(GitHubSkill);
    SkillRegistry.register(NotionSkill);
    SkillRegistry.register(TelegramSkill);
    SkillRegistry.register(SlackSkill);

    // Register QA tools skill (read-only project analytics)
    SkillRegistry.register(QASkill);

    // Register memory tools (workspace-level persistent memory)
    SkillRegistry.register(MemorySkill);

    const registeredSkills = SkillRegistry.listSkills();
    logger.info('[SKILLS] Phase 1 complete — all skills registered', {
      count: registeredSkills.length,
      skills: registeredSkills.map((s) => s.id),
    });
  } catch (error) {
    logger.error('[SKILLS] Failed to register skills', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // ── Phase 2: Initialize (async, non-fatal) ───────────────────────────
  const skillsWithInit = SkillRegistry.listSkills().filter((s) => typeof s.onInit === 'function');

  if (skillsWithInit.length === 0) {
    logger.info('[SKILLS] Phase 2 skipped — no skills define onInit()');
    return;
  }

  logger.info('[SKILLS] Phase 2 — running onInit() hooks', {
    skills: skillsWithInit.map((s) => s.id),
  });

  const initResults = await Promise.allSettled(
    skillsWithInit.map(async (skill) => {
      const initStart = Date.now();
      try {
        await skill.onInit!();
        const durationMs = Date.now() - initStart;
        logger.info('[SKILLS] onInit() succeeded', {
          skillId: skill.id,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - initStart;
        logger.warn('[SKILLS] onInit() failed (skill remains registered)', {
          skillId: skill.id,
          durationMs,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err; // rethrow so Promise.allSettled marks it as rejected
      }
    }),
  );

  const succeeded = initResults.filter((r) => r.status === 'fulfilled').length;
  const failed = initResults.filter((r) => r.status === 'rejected').length;

  logger.info('[SKILLS] Phase 2 complete', {
    total: skillsWithInit.length,
    succeeded,
    failed,
  });
}

// Re-export core types and registry for convenience
export { SkillRegistry } from './skill-registry';
export type {
  SkillDefinition,
  SkillContext,
  SkillResult,
  SkillRetryConfig,
  SkillErrorContext,
  WorkspaceSkillConfig,
  IntegrationProvider,
} from './types';
