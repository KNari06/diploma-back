import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '@/services/auth/auth.service';
import { logger } from '@/utils/logger';
import { AuthUser } from '@/types';
import { supabaseAdmin } from '@/db/supabase';

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
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
        message: 'Please provide a valid access token in Authorization header',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    // Verify token and get user
    const user = await verifyToken(token);

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or expired token',
        message: 'Please login again',
      });
      return;
    }

    // Attach user to request
    req.user = user;

    next();
  } catch (error) {
    // Log error but don't crash - return 401
    logger.debug('Auth middleware error', {
      error: error instanceof Error ? error.message : String(error),
      // Don't log full stack for auth errors
    });
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication failed',
    });
  }
};

/**
 * Middleware for optional authentication
 * Attaches user if token is valid, but doesn't fail if missing
 */
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      const user = await verifyToken(token);

      if (user) {
        req.user = user;
        logger.debug('Optional auth: user attached', { userId: user.id });
      }
    }

    next();
  } catch (error) {
    logger.debug('Optional auth: no valid token, continuing without user');
    next();
  }
};

/**
 * Middleware to require admin role
 */
export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication required',
    });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Forbidden: Admin access required',
    });
    return;
  }

  next();
};

/**
 * Middleware to check user credits before expensive operations
 * @param requiredCredits - Minimum credits required
 */
export const requireCredits = (requiredCredits: number = 1) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized: Authentication required',
        });
        return;
      }

      // Get user credits from database
      const { data: userData, error } = await supabaseAdmin
        .from('users')
        .select('credits')
        .eq('id', req.user!.id)
        .single();

      if (error) throw error;

      if (!userData || userData.credits < requiredCredits) {
        res.status(402).json({
          success: false,
          error: 'Insufficient credits',
          message: `You need at least ${requiredCredits} credits to perform this action. Current: ${userData?.credits || 0}`,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Credit check error', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check credits',
      });
    }
  };
};
