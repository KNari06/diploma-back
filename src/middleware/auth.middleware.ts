import { verifyToken } from '@/services/auth/auth.service';
import { AuthUser } from '@/types';
import { logger } from '@/utils/core/logger';
import { NextFunction, Request, Response } from 'express';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Middleware to require authentication
 * Returns 401 if no valid token
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.debug('[AUTH] No token provided', {
        path: req.path,
        method: req.method,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
        message: 'Please provide a valid access token in Authorization header',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    // Validate token format
    if (!token || token.length < 10) {
      logger.debug('[AUTH] Invalid token format', {
        path: req.path,
        method: req.method,
        tokenLength: token?.length,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid token format',
        message: 'Please provide a valid access token',
      });
      return;
    }

    // Verify token and get user
    const user = await verifyToken(token);

    if (!user) {
      logger.debug('[AUTH] Token verification failed', {
        path: req.path,
        method: req.method,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or expired token',
        message: 'Please login again',
      });
      return;
    }

    // Attach user to request
    req.user = user;

    // logger.debug('[AUTH] Authentication successful', {
    //   userId: user.id,
    //   email: user.email,
    //   role: user.role,
    //   path: req.path,
    // });

    next();
  } catch (error) {
    // Log error but don't crash - return 401
    logger.error('[AUTH] Authentication error', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      method: req.method,
    });
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication failed',
    });
  }
};


/**
 * Middleware to require admin role
 * Must be used after requireAuth middleware
 */
export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Check if user is authenticated (should be set by requireAuth)
    if (!req.user) {
      logger.warn('[AUTH] Admin check failed - no user', {
        path: req.path,
        method: req.method,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required',
        message: 'Please authenticate first',
      });
      return;
    }

    // Check if user has admin role
    if (req.user.role !== 'admin') {
      logger.warn('[AUTH] Admin access denied', {
        userId: req.user.id,
        role: req.user.role,
        path: req.path,
        method: req.method,
      });
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access required',
        message: 'You do not have permission to access this resource',
      });
      return;
    }

    logger.debug('[AUTH] Admin access granted', {
      userId: req.user.id,
      email: req.user.email,
      path: req.path,
    });

    next();
  } catch (error) {
    logger.error('[AUTH] Admin check error', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      method: req.method,
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Middleware to require approved account status
 * Must be used after requireAuth middleware
 * Returns 403 if user account is not approved
 */
export const requireApproved = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required',
        message: 'Please authenticate first',
      });
      return;
    }

    if (req.user.status !== 'approved') {
      logger.debug('[AUTH] Access denied - account not approved', {
        userId: req.user.id,
        status: req.user.status,
        path: req.path,
      });
      res.status(403).json({
        success: false,
        error: 'Account pending approval',
        code: 'PENDING_APPROVAL',
        status: req.user.status || 'pending_approval',
        message: 'Your account is pending approval. Please wait for an administrator to approve your access.',
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('[AUTH] Approval check error', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      method: req.method,
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Middleware to check credits before expensive operations
 * Must be used after requireAuth middleware
 *
 * Credit source priority:
 * 1. Workspace credits (if workspaceId is provided via header, params, or body)
 * 2. Fallback to user credits (legacy support during migration)
 *
 * @param requiredCredits - Minimum credits required (default: 1, must be >= 0)
 */
export const requireCredits = (requiredCredits: number = 1) => {
  // Validate requiredCredits parameter at middleware creation
  if (requiredCredits < 0 || !Number.isFinite(requiredCredits)) {
    throw new Error('Invalid requiredCredits: must be a non-negative number');
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Check if user is authenticated (should be set by requireAuth)
      if (!req.user) {
        logger.warn('[AUTH] Credit check failed - no user', {
          path: req.path,
          method: req.method,
          requiredCredits,
        });
        res.status(401).json({
          success: false,
          error: 'Unauthorized: Authentication required',
          message: 'Please authenticate first',
        });
        return;
      }

      const userId = req.user.id;

      // Try to resolve workspaceId from various sources
      const workspaceId = resolveWorkspaceId(req);

      // If we have a workspaceId, use workspace credits
      if (workspaceId) {
        const result = await checkWorkspaceCredits(workspaceId, userId, requiredCredits, req, res);
        if (result === 'next') {
          next();
        }
        // If result is not 'next', response was already sent
        return;
      }

      // Fallback to user credits (legacy support)
      logger.debug('[AUTH] No workspaceId found, using user credits', {
        userId,
        requiredCredits,
        path: req.path,
      });

      const { UserCreditsService } = await import('@/services/core/user-credits.service');
      const userCredits = await UserCreditsService.getUserCredits(userId);

      if (!userCredits) {
        logger.warn('[AUTH] User credits not found, creating record...', {
          userId,
          path: req.path,
        });
        await UserCreditsService.getOrCreateUserCredits(userId);
        const retryCredits = await UserCreditsService.getUserCredits(userId);
        if (!retryCredits) {
          logger.error('[AUTH] Failed to create user credits', {
            userId,
            path: req.path,
          });
          res.status(500).json({
            success: false,
            error: 'Failed to check credits',
            message: 'Database error while checking credits',
          });
          return;
        }
        const currentCredits = Number.isFinite(retryCredits.credits_balance)
          ? (retryCredits.credits_balance || 0)
          : 0;

        if (currentCredits < requiredCredits) {
          logger.warn('[AUTH] Insufficient credits', {
            userId,
            currentCredits,
            requiredCredits,
            path: req.path,
          });
          res.status(402).json({
            success: false,
            error: 'Insufficient credits',
            message: `You need at least ${requiredCredits} credits to perform this action. Current: ${currentCredits}`,
            currentCredits,
            requiredCredits,
          });
          return;
        }

        next();
        return;
      }

      const currentCredits = Number.isFinite(userCredits.credits_balance)
        ? (userCredits.credits_balance || 0)
        : 0;

      if (currentCredits < requiredCredits) {
        logger.warn('[AUTH] Insufficient credits', {
          userId,
          currentCredits,
          requiredCredits,
          path: req.path,
        });
        res.status(402).json({
          success: false,
          error: 'Insufficient credits',
          message: `You need at least ${requiredCredits} credits to perform this action. Current: ${currentCredits}`,
          currentCredits,
          requiredCredits,
        });
        return;
      }

      logger.debug('[AUTH] Credits check passed (user credits)', {
        userId,
        currentCredits,
        requiredCredits,
        path: req.path,
      });

      next();
    } catch (error) {
      logger.error('[AUTH] Credit check error', {
        error: error instanceof Error ? error.message : String(error),
        userId: req.user?.id,
        requiredCredits,
        path: req.path,
        method: req.method,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to check credits',
        message: 'Internal server error while checking credits',
      });
    }
  };
};

/**
 * Helper to resolve workspaceId from request
 * Priority: X-Workspace-Id header > params.workspaceId > body.workspace_id > query.workspace_id
 */
function resolveWorkspaceId(req: Request): string | null {
  // Header (preferred)
  const headerWorkspaceId = req.headers['x-workspace-id'];
  if (headerWorkspaceId && typeof headerWorkspaceId === 'string') {
    return headerWorkspaceId;
  }

  // URL params
  if (req.params?.workspaceId) {
    return req.params.workspaceId;
  }

  // For workspace-scoped routes like /workspaces/:id/...
  if (req.params?.id && req.path.includes('/workspaces/')) {
    return req.params.id;
  }

  // Body
  if (req.body?.workspace_id) {
    return req.body.workspace_id;
  }

  // Query
  if (req.query?.workspace_id && typeof req.query.workspace_id === 'string') {
    return req.query.workspace_id;
  }

  return null;
}

/**
 * Helper to check workspace credits and verify membership
 */
async function checkWorkspaceCredits(
  workspaceId: string,
  userId: string,
  requiredCredits: number,
  req: Request,
  res: Response
): Promise<'next' | 'responded'> {
  const { WorkspaceCreditsService } = await import('@/services/core/workspace-credits.service');
  const { WorkspaceAccessService } = await import('@/services/core/workspace-access.service');

  // First verify the user is a member of this workspace
  const isMember = await WorkspaceAccessService.isMember(userId, workspaceId);
  if (!isMember) {
    logger.warn('[AUTH] User is not a member of workspace for credit check', {
      userId,
      workspaceId,
      path: req.path,
    });
    res.status(403).json({
      success: false,
      error: 'Access denied',
      message: 'You are not a member of this workspace',
    });
    return 'responded';
  }

  // Get or create workspace credits
  let workspaceCredits = await WorkspaceCreditsService.getWorkspaceCredits(workspaceId);

  if (!workspaceCredits) {
    logger.warn('[AUTH] Workspace credits not found, creating record...', {
      workspaceId,
      path: req.path,
    });
    await WorkspaceCreditsService.getOrCreateWorkspaceCredits(workspaceId);
    workspaceCredits = await WorkspaceCreditsService.getWorkspaceCredits(workspaceId);

    if (!workspaceCredits) {
      logger.error('[AUTH] Failed to create workspace credits', {
        workspaceId,
        path: req.path,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to check credits',
        message: 'Database error while checking credits',
      });
      return 'responded';
    }
  }

  const currentCredits = Number.isFinite(workspaceCredits.credits_balance)
    ? workspaceCredits.credits_balance
    : 0;

  if (currentCredits < requiredCredits) {
    logger.warn('[AUTH] Insufficient workspace credits', {
      userId,
      workspaceId,
      currentCredits,
      requiredCredits,
      path: req.path,
    });
    res.status(402).json({
      success: false,
      error: 'Insufficient credits',
      message: `Your organization needs at least ${requiredCredits} credits to perform this action. Current: ${currentCredits}`,
      currentCredits,
      requiredCredits,
      workspaceId,
    });
    return 'responded';
  }

  logger.debug('[AUTH] Credits check passed (workspace credits)', {
    userId,
    workspaceId,
    currentCredits,
    requiredCredits,
    path: req.path,
  });

  return 'next';
}
