import { supabaseAdmin } from '@/db/supabase';
import { verifyToken } from '@/services/auth/auth.service';
import { AuthUser } from '@/types';
import { logger } from '@/utils/logger';
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

    logger.debug('[AUTH] Authentication successful', {
      userId: user.id,
      email: user.email,
      role: user.role,
      path: req.path,
    });

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
 * Middleware to check user credits before expensive operations
 * Must be used after requireAuth middleware
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

      logger.debug('[AUTH] Checking user credits', {
        userId,
        requiredCredits,
        path: req.path,
      });

      // Get user credits from user_credits table
      const { UserCreditsService } = await import('@/services/core/user-credits.service');
      const userCredits = await UserCreditsService.getUserCredits(userId);

      if (!userCredits) {
        logger.warn('[AUTH] User credits not found, creating record...', {
          userId,
          path: req.path,
        });
        // Create user_credits record if it doesn't exist
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

        logger.debug('[AUTH] Credits check passed', {
          userId,
          currentCredits,
          requiredCredits,
          path: req.path,
        });
        next();
        return;
      }

      const currentCredits = Number.isFinite(userCredits.credits_balance)
        ? (userCredits.credits_balance || 0)
        : 0;

      // Check if user has sufficient credits
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

      logger.debug('[AUTH] Credits check passed', {
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
