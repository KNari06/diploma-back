import { SkillRegistry } from './skill-registry';
import { JiraSkill } from './integrations/jira.skill';
import { GitHubSkill } from './integrations/github.skill';
import { NotionSkill } from './integrations/notion.skill';
import { TelegramSkill } from './integrations/telegram.skill';
import { QASkill } from './qa/qa.skill';
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
 * Register all available skills
 * Called from src/index.ts during server startup
 */
export function registerAllSkills(): void {
  logger.info('[SKILLS] Registering all skills...');

  try {
    // Register integration skills
    SkillRegistry.register(JiraSkill);
    SkillRegistry.register(GitHubSkill);
    SkillRegistry.register(NotionSkill);
    SkillRegistry.register(TelegramSkill);

    // Register QA tools skill (read-only project analytics)
    SkillRegistry.register(QASkill);

    const registeredSkills = SkillRegistry.listSkills();
    logger.info('[SKILLS] All skills registered successfully', {
      count: registeredSkills.length,
      skills: registeredSkills.map((s) => s.id),
    });
  } catch (error) {
    logger.error('[SKILLS] Failed to register skills', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Re-export core types and registry for convenience
export { SkillRegistry } from './skill-registry';
export type { SkillDefinition, SkillContext, SkillResult, IntegrationProvider } from './types';
