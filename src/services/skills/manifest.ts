import type { SkillDefinition } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// SKILL MANIFEST — Single Source of Truth
// ═══════════════════════════════════════════════════════════════════════════
//
// All skills are listed here. To add a new skill:
//   1. Create `your-name.skill.ts` with `export default` SkillDefinition
//   2. Add one line below: { load: () => import('./path/your-name.skill') }
//
// ═══════════════════════════════════════════════════════════════════════════

export type SkillEntry = {
  /** Dynamic import factory — lazy loading */
  load: () => Promise<{ default: SkillDefinition }>;
};

export const SKILL_MANIFEST: SkillEntry[] = [
  // ── Integration skills ──────────────────────────────────────────────
  { load: () => import('./integrations/jira.skill') },
  { load: () => import('./integrations/github.skill') },
  { load: () => import('./integrations/notion.skill') },
  { load: () => import('./integrations/telegram.skill') },
  { load: () => import('./integrations/slack.skill') },

  // ── QA tools ────────────────────────────────────────────────────────
  { load: () => import('./qa/qa.skill') },
];
