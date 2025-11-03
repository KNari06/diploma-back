import { Request, Response } from 'express';
import { logger } from '@/utils/logger';
import { errorResponse, successResponse } from '@/utils/error-handler';
import * as kbService from '@/services/kb.service';
import { rebuildGlobalKB, getLocalKBStats } from '@/services/localKB.service';
import { supabase } from '@/db/supabase';

/**
 * Check if user is admin
 */
async function isAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

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
    const { data, error } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

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

    const tags = req.body.tags ? JSON.parse(req.body.tags) : [];

    const result = await kbService.uploadGlobalKB(file.path, file.originalname, tags, userId);

    successResponse(res, {
      message: 'Global KB file uploaded successfully',
      fileName: file.originalname,
      chunkCount: result.chunkCount,
    });
  } catch (error: any) {
    logger.error('Upload global KB failed', { error });
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
      message: 'Project KB file uploaded successfully',
      fileName: file.originalname,
      chunkCount: result.chunkCount,
    });
  } catch (error: any) {
    logger.error('Upload project KB failed', { error });
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

    // If projectId provided, verify ownership
    if (projectId) {
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

    // If projectId provided, verify ownership and get project stats
    let projectStats = null;
    if (projectId) {
      const isOwner = await isProjectOwner(userId, projectId);
      if (!isOwner) {
        errorResponse(res, 'Access denied to this project', 403);
        return;
      }

      projectStats = await kbService.getKBStats(projectId);
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
    });
  } catch (error: any) {
    logger.error('Get KB stats failed', { error });
    errorResponse(res, error.message || 'Failed to get stats', 500);
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
    errorResponse(res, error.message || 'Failed to rebuild KB', 500);
  }
}
