import { SkillRegistry } from './skill-registry';
import { SKILL_MANIFEST } from './manifest';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKILLS REGISTRATION (Manifest-Driven)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Loads and registers all skills listed in manifest.ts.
 * Called during server startup.
 *
 * To add a new skill:
 *   1. Create `your-name.skill.ts` with `export default` SkillDefinition
 *   2. Add one line in `manifest.ts`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Register all skills from the manifest.
 * Called from src/index.ts during server startup.
 */
export async function registerAllSkills(): Promise<void> {
  logger.info('[SKILLS] Registering skills from manifest...', {
    count: SKILL_MANIFEST.length,
  });

  for (const entry of SKILL_MANIFEST) {
    try {
      const mod = await entry.load();
      const skill = mod.default;

      if (!skill || !skill.id) {
        throw new Error('Skill module does not export a valid default SkillDefinition');
      }

      SkillRegistry.register(skill);
    } catch (error) {
      logger.error('[SKILLS] Failed to load/register skill', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Fatal — server cannot start with broken skills
    }
  }

  const registered = SkillRegistry.listSkills();
  logger.info('[SKILLS] All skills registered successfully', {
    count: registered.length,
    skills: registered.map((s) => s.id),
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
