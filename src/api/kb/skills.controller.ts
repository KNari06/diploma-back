import { Request, Response } from 'express';
import { supabaseAdmin } from '@/db/supabase';
import {
  WorkspaceMemoryService,
  type MemoryCategory,
  type MemorySource,
} from '@/services/ai/memory/workspace-memory.service';
import { WorkspaceService } from '@/services/core/workspace.service';
import { successResponse, errorResponse } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKILLS CONTROLLER (Knowledge Base — Skills Tab)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CRUD operations for workspace skills (backed by workspace_memory table).
 * Skills are user-confirmed knowledge entries that help the AI agent.
 *
 * Principle: "The save button is only pressed by the human."
 * All skills have source = 'user_provided' and confidence = 1.0.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'test_pattern', 'bug_pattern', 'integration_context'];

/**
 * Resolve workspaceId — use provided value or fall back to user's active workspace
 */
async function resolveWorkspaceId(userId: string, providedWorkspaceId?: string): Promise<string> {
  if (providedWorkspaceId && UUID_REGEX.test(providedWorkspaceId)) {
    // Verify user owns this workspace
    const userWorkspaces = await WorkspaceService.getUserWorkspaces(userId);
    const ownsWorkspace = userWorkspaces.some(w => w.id === providedWorkspaceId);
    if (!ownsWorkspace) {
      throw new Error('Access denied to this workspace');
    }
    return providedWorkspaceId;
  }
  const activeWorkspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
  if (!activeWorkspaceId) {
    throw new Error('No workspace found for user');
  }
  return activeWorkspaceId;
}

/**
 * Format a workspace memory entry for the Skills UI
 */
function formatSkillForResponse(memory: any) {
  return {
    id: memory.id,
    key: memory.key,
    content: memory.content,
    category: memory.category,
    source: memory.source,
    confidence: memory.confidence,
    enabled: memory.metadata?.enabled !== false, // default true
    accessCount: memory.access_count,
    lastAccessedAt: memory.last_accessed_at,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    metadata: memory.metadata || {},
  };
}

// ─────────────────────────────────────────────────────────────────────────
// LIST SKILLS
// GET /api/v1/kb/skills?workspaceId=&category=&source=&enabled=
// ─────────────────────────────────────────────────────────────────────────
export async function listSkills(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const category = req.query.category as MemoryCategory | undefined;
    const source = req.query.source as MemorySource | undefined;
    const enabledParam = req.query.enabled as string | undefined;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));

    // Validate category
    if (category && !VALID_CATEGORIES.includes(category)) {
      errorResponse(res, `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
      return;
    }

    const workspaceId = await resolveWorkspaceId(userId, req.query.workspaceId as string);

    let skills = await WorkspaceMemoryService.listMemories(workspaceId, category, limit);

    // Post-filter by source
    if (source) {
      skills = skills.filter(s => s.source === source);
    }

    // Post-filter by enabled status
    if (enabledParam !== undefined) {
      const enabledFilter = enabledParam === 'true';
      skills = skills.filter(s => {
        const isEnabled = s.metadata?.enabled !== false;
        return isEnabled === enabledFilter;
      });
    }

    successResponse(res, {
      skills: skills.map(formatSkillForResponse),
      total: skills.length,
    });
  } catch (error: any) {
    logger.error('[SKILLS_API] List skills failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to list skills', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE SKILL
// POST /api/v1/kb/skills
// ─────────────────────────────────────────────────────────────────────────
export async function createSkill(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { key, content, category, workspaceId: providedWorkspaceId } = req.body;

    // Validate required fields
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      errorResponse(res, 'Key is required and must be a non-empty string', 400);
      return;
    }

    if (key.length > 200) {
      errorResponse(res, 'Key must be at most 200 characters', 400);
      return;
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      errorResponse(res, 'Content is required and must be a non-empty string', 400);
      return;
    }

    if (content.length > 5000) {
      errorResponse(res, 'Content must be at most 5000 characters', 400);
      return;
    }

    if (!category || !VALID_CATEGORIES.includes(category)) {
      errorResponse(res, `Category is required and must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
      return;
    }

    const workspaceId = await resolveWorkspaceId(userId, providedWorkspaceId);

    const memory = await WorkspaceMemoryService.writeMemory(
      workspaceId,
      userId,
      key.trim(),
      content.trim(),
      category,
      'user_provided',
      { enabled: true },
      1.0
    );

    logger.info('[SKILLS_API] Skill created', {
      skillId: memory.id,
      key: memory.key,
      category,
      userId,
    });

    successResponse(res, formatSkillForResponse(memory), 201);
  } catch (error: any) {
    logger.error('[SKILLS_API] Create skill failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to create skill', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET SKILL
// GET /api/v1/kb/skills/:id
// ─────────────────────────────────────────────────────────────────────────
export async function getSkill(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      errorResponse(res, 'Invalid skill ID format', 400);
      return;
    }

    const memory = await WorkspaceMemoryService.readMemoryById(id);
    if (!memory) {
      errorResponse(res, 'Skill not found', 404);
      return;
    }

    // Verify the skill belongs to one of user's workspaces
    const userWorkspaces = await WorkspaceService.getUserWorkspaces(userId);
    if (!userWorkspaces.some(w => w.id === memory.workspace_id)) {
      errorResponse(res, 'Access denied', 403);
      return;
    }

    successResponse(res, formatSkillForResponse(memory));
  } catch (error: any) {
    logger.error('[SKILLS_API] Get skill failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to get skill', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE SKILL
// PUT /api/v1/kb/skills/:id
// ─────────────────────────────────────────────────────────────────────────
export async function updateSkill(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      errorResponse(res, 'Invalid skill ID format', 400);
      return;
    }

    // Verify skill exists and belongs to user's workspace
    const existing = await WorkspaceMemoryService.readMemoryById(id);
    if (!existing) {
      errorResponse(res, 'Skill not found', 404);
      return;
    }

    const userWorkspaces = await WorkspaceService.getUserWorkspaces(userId);
    if (!userWorkspaces.some(w => w.id === existing.workspace_id)) {
      errorResponse(res, 'Access denied', 403);
      return;
    }

    // Build updates object
    const { key, content, category } = req.body;
    const updates: Record<string, any> = {};

    if (key !== undefined) {
      if (typeof key !== 'string' || key.trim().length === 0 || key.length > 200) {
        errorResponse(res, 'Key must be a non-empty string of at most 200 characters', 400);
        return;
      }
      updates.key = key.trim();
    }

    if (content !== undefined) {
      if (typeof content !== 'string' || content.trim().length === 0 || content.length > 5000) {
        errorResponse(res, 'Content must be a non-empty string of at most 5000 characters', 400);
        return;
      }
      updates.content = content.trim();
    }

    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category)) {
        errorResponse(res, `Category must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
        return;
      }
      updates.category = category;
    }

    if (Object.keys(updates).length === 0) {
      errorResponse(res, 'No fields to update. Provide at least one of: key, content, category', 400);
      return;
    }

    const updated = await WorkspaceMemoryService.updateMemoryById(id, updates);

    logger.info('[SKILLS_API] Skill updated', { skillId: id, fields: Object.keys(updates) });

    successResponse(res, formatSkillForResponse(updated));
  } catch (error: any) {
    logger.error('[SKILLS_API] Update skill failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to update skill', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE SKILL
// DELETE /api/v1/kb/skills/:id
// ─────────────────────────────────────────────────────────────────────────
export async function deleteSkill(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      errorResponse(res, 'Invalid skill ID format', 400);
      return;
    }

    // Verify skill exists and belongs to user's workspace
    const existing = await WorkspaceMemoryService.readMemoryById(id);
    if (!existing) {
      errorResponse(res, 'Skill not found', 404);
      return;
    }

    const userWorkspaces = await WorkspaceService.getUserWorkspaces(userId);
    if (!userWorkspaces.some(w => w.id === existing.workspace_id)) {
      errorResponse(res, 'Access denied', 403);
      return;
    }

    await WorkspaceMemoryService.deleteMemoryById(id);

    logger.info('[SKILLS_API] Skill deleted', { skillId: id, key: existing.key });

    successResponse(res, { message: 'Skill deleted successfully', id });
  } catch (error: any) {
    logger.error('[SKILLS_API] Delete skill failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to delete skill', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TOGGLE SKILL
// PATCH /api/v1/kb/skills/:id/toggle
// ─────────────────────────────────────────────────────────────────────────
export async function toggleSkill(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      errorResponse(res, 'Invalid skill ID format', 400);
      return;
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      errorResponse(res, 'enabled must be a boolean', 400);
      return;
    }

    // Verify skill exists and belongs to user's workspace
    const existing = await WorkspaceMemoryService.readMemoryById(id);
    if (!existing) {
      errorResponse(res, 'Skill not found', 404);
      return;
    }

    const userWorkspaces = await WorkspaceService.getUserWorkspaces(userId);
    if (!userWorkspaces.some(w => w.id === existing.workspace_id)) {
      errorResponse(res, 'Access denied', 403);
      return;
    }

    const updatedMetadata = { ...(existing.metadata || {}), enabled };
    const updated = await WorkspaceMemoryService.updateMemoryById(id, {
      metadata: updatedMetadata,
    });

    logger.info('[SKILLS_API] Skill toggled', { skillId: id, enabled });

    successResponse(res, formatSkillForResponse(updated));
  } catch (error: any) {
    logger.error('[SKILLS_API] Toggle skill failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to toggle skill', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BATCH CREATE SKILLS
// POST /api/v1/kb/skills/batch
// ─────────────────────────────────────────────────────────────────────────
export async function batchCreateSkills(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { skills, workspaceId: providedWorkspaceId } = req.body;

    if (!Array.isArray(skills) || skills.length === 0) {
      errorResponse(res, 'skills must be a non-empty array', 400);
      return;
    }

    if (skills.length > 10) {
      errorResponse(res, 'Maximum 10 skills per batch', 400);
      return;
    }

    // Validate each skill
    for (const skill of skills) {
      if (!skill.key || typeof skill.key !== 'string' || skill.key.trim().length === 0) {
        errorResponse(res, 'Each skill must have a non-empty key', 400);
        return;
      }
      if (!skill.content || typeof skill.content !== 'string' || skill.content.trim().length === 0) {
        errorResponse(res, `Skill "${skill.key}" must have non-empty content`, 400);
        return;
      }
      if (skill.key.length > 200) {
        errorResponse(res, `Skill "${skill.key.substring(0, 30)}..." key is too long (max 200 characters)`, 400);
        return;
      }
      if (skill.content.length > 5000) {
        errorResponse(res, `Skill "${skill.key}" content is too long (max 5000 characters)`, 400);
        return;
      }
      if (!skill.category || !VALID_CATEGORIES.includes(skill.category)) {
        errorResponse(res, `Skill "${skill.key}" has invalid category`, 400);
        return;
      }
    }

    const workspaceId = await resolveWorkspaceId(userId, providedWorkspaceId);

    const created = [];
    for (const skill of skills) {
      const memory = await WorkspaceMemoryService.writeMemory(
        workspaceId,
        userId,
        skill.key.trim(),
        skill.content.trim(),
        skill.category,
        'user_provided',
        { enabled: true },
        1.0
      );
      created.push(formatSkillForResponse(memory));
    }

    logger.info('[SKILLS_API] Batch skills created', {
      count: created.length,
      userId,
    });

    successResponse(res, { created: created.length, skills: created }, 201);
  } catch (error: any) {
    logger.error('[SKILLS_API] Batch create skills failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to create skills', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SUGGEST SKILLS FROM TEST CASE
// POST /api/v1/kb/skills/suggest-from-test
// ─────────────────────────────────────────────────────────────────────────
export async function suggestFromTest(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { testCaseId } = req.body;
    if (!testCaseId || !UUID_REGEX.test(testCaseId)) {
      errorResponse(res, 'Valid testCaseId (UUID) is required', 400);
      return;
    }

    // Verify user owns the test case
    const { data: testCase, error: tcError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('user_id')
      .eq('id', testCaseId)
      .maybeSingle();

    if (tcError || !testCase) {
      errorResponse(res, 'Test case not found', 404);
      return;
    }

    if (testCase.user_id !== userId) {
      errorResponse(res, 'Access denied to this test case', 403);
      return;
    }

    // Lazy import to avoid circular deps
    const { SkillSuggestionService } = await import('@/services/kb/skill-suggestion.service');
    const suggestions = await SkillSuggestionService.suggestFromTestCase(testCaseId);

    successResponse(res, { suggestions });
  } catch (error: any) {
    logger.error('[SKILLS_API] Suggest from test failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to generate suggestions', 500);
  }
}
