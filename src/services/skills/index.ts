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
  logger.info('[SKILLS] Phase 1 complete — all skills registered', {
    count: registered.length,
    skills: registered.map((s) => s.id),
  });

  // ── Phase 2: Initialize (async, non-fatal) ───────────────────────────
  const skillsWithInit = registered.filter((s) => typeof s.onInit === 'function');

  if (skillsWithInit.length > 0) {
    logger.info('[SKILLS] Phase 2 — running onInit() hooks', {
      skills: skillsWithInit.map((s) => s.id),
    });

    const initResults = await Promise.allSettled(
      skillsWithInit.map(async (skill) => {
        const initStart = Date.now();
        try {
          await skill.onInit!();
          logger.info('[SKILLS] onInit() succeeded', {
            skillId: skill.id,
            durationMs: Date.now() - initStart,
          });
        } catch (err) {
          logger.warn('[SKILLS] onInit() failed (skill remains registered)', {
            skillId: skill.id,
            durationMs: Date.now() - initStart,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err; // rethrow so Promise.allSettled marks it as rejected
        }
      }),
    );

    const succeeded = initResults.filter((r) => r.status === 'fulfilled').length;
    const failed = initResults.filter((r) => r.status === 'rejected').length;

    logger.info('[SKILLS] Phase 2 complete', { total: skillsWithInit.length, succeeded, failed });
  }
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
