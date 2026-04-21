import { supabaseAdmin } from '@/db/supabase';
import * as kbService from '@/services/kb/kb.service';
import { getLocalKBStats, rebuildGlobalKB } from '@/services/kb/localKB.service';
import { WorkspaceService } from '@/services/core/workspace.service';
import { errorResponse, successResponse } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if user is admin
 */
async function isAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) {
      return false;
    }

    return data.role === 'admin';
  } catch (error) {
    logger.error('Admin check failed', { error, userId });
    return false;
  }
}

/**
 * Check if user owns project
 */
async function isProjectOwner(userId: string, projectId: string): Promise<boolean> {
  try {
    // Validate projectId format (UUID)
    if (!UUID_REGEX.test(projectId)) {
      return false;
    }

    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !data) {
      return false;
    }

    return data.user_id === userId;
  } catch (error) {
    logger.error('Project ownership check failed', { error, userId, projectId });
    return false;
  }
}

/**
 * Upload file to global KB (admin only)
 * POST /api/kb/global/upload
 */
export async function uploadGlobalKB(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    // Check admin
    const admin = await isAdmin(userId);
    if (!admin) {
      errorResponse(res, 'Admin access required', 403);
      return;
    }

    const file = req.file;
    if (!file) {
      errorResponse(res, 'No file provided', 400);
      return;
    }

    // Safe JSON parsing for tags
    let tags = [];
    if (req.body.tags) {
      try {
        tags = JSON.parse(req.body.tags);
        if (!Array.isArray(tags)) {
          tags = [];
        }
      } catch (error) {
        logger.warn('Invalid tags JSON format', { tags: req.body.tags });
        tags = [];
      }
    }

    const result = await kbService.uploadGlobalKB(file.path, file.originalname, tags, userId);

    successResponse(res, {
      message: 'Global KB file uploaded successfully',
      fileName: file.originalname,
      chunkCount: result.chunkCount,
    });
  } catch (error: any) {
    logger.error('Upload global KB failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Upload failed', 500);
  }
}

/**
 * Upload file to project KB
 * POST /api/kb/upload
 */
export async function uploadProjectKB(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = req.body.projectId;
    if (!projectId) {
      errorResponse(res, 'Project ID required', 400);
      return;
    }

    // Validate projectId format (UUID)
    if (!UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid project ID format', 400);
      return;
    }

    // Check project ownership
    const isOwner = await isProjectOwner(userId, projectId);
    if (!isOwner) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const file = req.file;
    if (!file) {
      errorResponse(res, 'No file provided', 400);
      return;
    }

    const result = await kbService.uploadProjectKB(file.path, file.originalname, projectId, userId);

    successResponse(res, {
      message: result.previousVersionsRetired > 0
        ? `Uploaded v${result.fileVersion} (${result.previousVersionsRetired} previous version${result.previousVersionsRetired === 1 ? '' : 's'} retired)`
        : 'Project KB file uploaded successfully',
      fileName: file.originalname,
      name: file.originalname,
      chunkCount: result.chunkCount,
      chunks: result.chunkCount,
      // New fields from Phase 4 — callers can surface to the user
      format: result.format,
      summary: result.summary,
      fileVersion: result.fileVersion,
      previousVersionsRetired: result.previousVersionsRetired,
      status: 'ready',
    });
  } catch (error: any) {
    logger.error('Upload project KB failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Upload failed', 500);
  }
}

/**
 * Query knowledge base (RAG search)
 * POST /api/kb/query
 */
export async function queryKB(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { query, projectId, matchThreshold, matchCount } = req.body;

    if (!query || typeof query !== 'string') {
      errorResponse(res, 'Query is required', 400);
      return;
    }

    if (query.trim().length === 0) {
      errorResponse(res, 'Query cannot be empty', 400);
      return;
    }

    // Validate optional parameters
    if (matchThreshold !== undefined && (typeof matchThreshold !== 'number' || matchThreshold < 0 || matchThreshold > 1)) {
      errorResponse(res, 'matchThreshold must be a number between 0 and 1', 400);
      return;
    }

    if (matchCount !== undefined && (typeof matchCount !== 'number' || matchCount < 1 || matchCount > 100)) {
      errorResponse(res, 'matchCount must be a number between 1 and 100', 400);
      return;
    }

    // If projectId provided, validate and verify ownership
    if (projectId) {
      if (!UUID_REGEX.test(projectId)) {
        errorResponse(res, 'Invalid project ID format', 400);
        return;
      }

      const isOwner = await isProjectOwner(userId, projectId);
      if (!isOwner) {
        errorResponse(res, 'Access denied to this project', 403);
        return;
      }
    }

    const results = await kbService.searchKB(query, projectId, {
      matchThreshold,
      matchCount,
    });

    successResponse(res, results);
  } catch (error: any) {
    logger.error('KB query failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Query failed', 500);
  }
}

/**
 * Get project files
 * GET /api/kb/project-files?projectId=xxx
 */
export async function getProjectFiles(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = req.query.projectId as string;
    if (!projectId) {
      errorResponse(res, 'Project ID required', 400);
      return;
    }

    // Validate projectId format (UUID)
    if (!UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid project ID format', 400);
      return;
    }

    // Check project ownership
    const isOwner = await isProjectOwner(userId, projectId);
    if (!isOwner) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const files = await kbService.getProjectFiles(projectId);

    successResponse(res, files);
  } catch (error: any) {
    logger.error('Get project files failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Failed to get files', 500);
  }
}

/**
 * Delete project file
 * DELETE /api/kb/project-files/:fileId
 */
export async function deleteProjectFile(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { projectId, fileName } = req.body;
    if (!projectId || !fileName) {
      errorResponse(res, 'Project ID and file name required', 400);
      return;
    }

    // Validate projectId format (UUID)
    if (!UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid project ID format', 400);
      return;
    }

    // Validate fileName
    if (typeof fileName !== 'string' || fileName.trim().length === 0) {
      errorResponse(res, 'File name must be a non-empty string', 400);
      return;
    }

    // Check project ownership
    const isOwner = await isProjectOwner(userId, projectId);
    if (!isOwner) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    await kbService.deleteProjectFile(projectId, fileName);

    successResponse(res, {
      message: 'File deleted successfully',
      fileName,
    });
  } catch (error: any) {
    logger.error('Delete project file failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Delete failed', 500);
  }
}

/**
 * Get KB statistics
 * GET /api/kb/stats?projectId=xxx
 */
export async function getKBStats(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = req.query.projectId as string;

    // Get local global KB stats
    const localStats = await getLocalKBStats();

    // If projectId provided, validate and verify ownership and get project stats
    let projectStats = null;
    if (projectId) {
      // Validate projectId format (UUID)
      if (!UUID_REGEX.test(projectId)) {
        errorResponse(res, 'Invalid project ID format', 400);
        return;
      }

      const isOwner = await isProjectOwner(userId, projectId);
      if (!isOwner) {
        errorResponse(res, 'Access denied to this project', 403);
        return;
      }

      projectStats = await kbService.getKBStats(projectId);
    }

    // Get skills count from workspace memory (excluding bug_pattern — those belong in Patterns)
    let skillsTotal = 0;
    try {
      const workspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
      if (workspaceId) {
        const { count, error: countError } = await supabaseAdmin
          .from('workspace_memory')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .neq('category', 'bug_pattern');
        if (!countError && count !== null) {
          skillsTotal = count;
        }
      }
    } catch (err) {
      logger.warn('[KB_STATS] Failed to get skills count (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Get patterns count (total test sessions for the project)
    let patternsTotal = 0;
    if (projectId) {
      try {
        const { count, error: countError } = await supabaseAdmin
          .from('intelligent_test_sessions')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', projectId);
        if (!countError && count !== null) {
          patternsTotal = count;
        }
      } catch (err) {
        logger.warn('[KB_STATS] Failed to get patterns count (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    successResponse(res, {
      global: {
        type: 'local',
        totalChunks: localStats.totalChunks,
        totalFiles: localStats.totalFiles,
        model: localStats.model,
        version: localStats.version,
        lastGenerated: localStats.lastGenerated,
      },
      project: projectStats,
      skills: { total: skillsTotal },
      patterns: { total: patternsTotal },
    });
  } catch (error: any) {
    logger.error('Get KB stats failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Failed to get stats', 500);
  }
}

/**
 * Get document chunks for preview
 * GET /api/kb/project-files/chunks?projectId=xxx&fileName=xxx
 */
export async function getDocumentChunks(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = req.query.projectId as string;
    const fileName = req.query.fileName as string;

    if (!projectId || !fileName) {
      errorResponse(res, 'projectId and fileName are required', 400);
      return;
    }

    if (!UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid project ID format', 400);
      return;
    }

    const isOwner = await isProjectOwner(userId, projectId);
    if (!isOwner) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    // Preview shows the CURRENT version only. History is available via
    // explicit ?version=N (added in a later pass once a UI needs it).
    const { data, error } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('id, content, metadata, file_version, format')
      .eq('project_id', projectId)
      .eq('file_name', fileName)
      .eq('is_current', true)
      .order('metadata->chunkIndex', { ascending: true });

    if (error) {
      logger.error('[KB_API] Failed to fetch document chunks', { error: error.message, projectId, fileName });
      errorResponse(res, 'Failed to fetch chunks', 500);
      return;
    }

    const rows = Array.isArray(data) ? data : [];
    const chunks = rows.map((row, idx) => ({
      id: row.id,
      index: row.metadata?.chunkIndex ?? idx,
      content: row.content,
      tokenCount: row.metadata?.tokenCount,
    }));

    successResponse(res, {
      fileName,
      totalChunks: chunks.length,
      fileVersion: rows.length > 0 ? rows[0].file_version : undefined,
      format: rows.length > 0 ? rows[0].format : undefined,
      chunks,
    });
  } catch (error: any) {
    logger.error('[KB_API] Get document chunks failed', { error });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to get chunks', 500);
  }
}

/**
 * Rebuild global KB from source files (admin only)
 */
export async function rebuildKB(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    // Check admin role
    const admin = await isAdmin(userId);
    if (!admin) {
      errorResponse(res, 'Admin access required', 403);
      return;
    }

    logger.info('Rebuilding global KB', { userId });

    // Rebuild KB (generates new embeddings.json and reloads into memory)
    const result = await rebuildGlobalKB();

    successResponse(res, {
      message: 'Global KB rebuilt successfully',
      chunks: result.chunks,
      files: result.files,
    });
  } catch (error: any) {
    logger.error('Rebuild KB failed', { error });

    if (res.headersSent) {
      logger.warn('[KB_API] Response already sent, cannot send error response');
      return;
    }

    errorResponse(res, error.message || 'Failed to rebuild KB', 500);
  }
}
