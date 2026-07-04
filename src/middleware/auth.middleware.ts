import { verifyToken } from '@/services/auth/auth.service';
import { supabaseAdmin } from '@/db/supabase';
import { isPaidUser } from '@/services/core/plan-access.service';
import { AuthUser } from '@/types';
import { logger } from '@/utils/core/logger';
import { NextFunction, Request, Response } from 'express';

// Endpoints the user is allowed to hit AFTER initiating account
// deletion. Currently used for self-cancel of a pending deletion
// during the grace window (`POST /api/v1/auth/me/delete/cancel`) —
// the route's controller uses `req.user.id`, so a user can only
// un-delete themselves, never anyone else.
//
// The list also exists so future "View my scheduled-deletion status"
// endpoints can opt in by adding their absolute path here.
//
// Matched against `req.originalUrl` (absolute path including the
// mount-point, query stripped) — NOT `req.path`, because inside a
// router-scoped middleware `req.path` is router-relative and would never
// match an absolute string. Exact match (not startsWith) so we don't
// accidentally allow `/cancel-something-else`.
const POST_DELETION_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/auth/me/delete/cancel',
]);

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
      // Session/token expiry or an invalid token — the canonical "please login
      // again" 401. Logged at INFO (not debug) so it ships to Loki keyed by
      // event/code: this is the signal a customer's session silently died,
      // previously invisible. INFO (not WARN) on purpose — this fires on EVERY
      // request bearing an expired/forged Bearer token (offline tabs, refresh
      // retry loops, internet scanners), so it must not page; alert on the
      // AGGREGATE rate instead. We can't cheaply tell expired from malformed here
      // (verifyToken returns null for both), so the code is generic; identity is
      // unavailable (no valid user), so we carry ip/path for correlation.
      logger.info('[AUTH] Token verification failed', {
        event: 'auth.token_invalid',
        code: 'TOKEN_INVALID_OR_EXPIRED',
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or expired token',
        message: 'Please login again',
      });
      return;
    }

    // Reject if the account is soft-deleted. The user's JWT may still
    // be valid in Supabase Auth for up to 30 days (the grace window),
    // but `users.deleted_at` set means the user explicitly asked to
    // delete their account and we must lock them out immediately.
    //
    // One small DB hop per request — acceptable cost given:
    //   - auth-cache already shaves the heavy lifting in verifyToken,
    //     and this column lookup is on the primary key with the partial
    //     index `idx_users_deletion_scheduled` keeping the scan tiny;
    //   - alternatives (caching the deleted flag) would create a
    //     correctness gap where a freshly deleted user could keep
    //     issuing requests for the cache TTL.
    //
    // The narrow whitelist (`POST_DELETION_ALLOWED_PATHS`) lets a
    // soft-deleted user reach the self-cancel endpoint so they can
    // back out within the 30-day grace window. See that constant's
    // docstring for the threat-model rationale.
    try {
      const { data: row } = await supabaseAdmin
        .from('users')
        .select('deleted_at')
        .eq('id', user.id)
        .maybeSingle();
      const deletedAt = (row as { deleted_at?: string | null } | null)?.deleted_at ?? null;
      if (deletedAt) {
        // `req.originalUrl` is absolute and includes the mount; strip
        // the query string so `?foo=bar` doesn't defeat the exact match.
        const absolutePath = (req.originalUrl || '').split('?')[0];
        const allowed = POST_DELETION_ALLOWED_PATHS.has(absolutePath);
        if (!allowed) {
          logger.debug('[AUTH] Rejecting deleted account', {
            userId: user.id,
            path: req.path,
            deletedAt,
          });
          res.status(401).json({
            success: false,
            error: 'Account deleted',
            code: 'ACCOUNT_DELETED',
            message: 'This account has been scheduled for deletion. Contact support if this is a mistake.',
          });
          return;
        }
      }
    } catch (err) {
      // Defensive: if the check itself fails, we fail OPEN — auth still
      // proceeds. A soft-deleted user can sneak through one request
      // before the next cache invalidation, which is acceptable vs.
      // locking everyone out on a Supabase blip.
      logger.warn('[AUTH] deleted_at check failed (failing open)', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
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

      // Gate on the SAME account that the run will actually be charged against.
      // Credits belong to the USER account only — every run path (regression /
      // manual / exploration, web + mobile) deducts from the user's personal
      // balance via UserCreditsService.deductCredits. There is no workspace
      // credits pool in the run path. requireCredits is mounted ONLY on run
      // routes, so the payer is always this user's personal account here.
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
          // Same machine-readable code the workspace-credits path emits, so the
          // frontend detects user-credit exhaustion identically (it keys off code).
          code: 'INSUFFICIENT_CREDITS',
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
 * Gate a route to paid plans only. Mobile testing (emulator sessions, APK
 * upload, mobile exploration/runs) is a Pro feature — free users get 403 with
 * an upgrade code the frontend turns into an upgrade prompt. Must run after
 * requireAuth. Fail-closed: any resolution error denies access.
 */
export const requirePaidPlan = (featureLabel: string = 'This feature') => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized: Authentication required',
          message: 'Please authenticate first',
        });
        return;
      }

      const paid = await isPaidUser(req.user.id);
      if (!paid) {
        logger.debug('[AUTH] Paid-plan feature blocked for free user', {
          userId: req.user.id,
          path: req.path,
        });
        res.status(403).json({
          success: false,
          error: 'Upgrade required',
          code: 'UPGRADE_REQUIRED',
          message: `${featureLabel} is available on the Pro plan. Upgrade to unlock it.`,
        });
        return;
      }

      next();
    } catch (error) {
      // Fail-closed: if we can't confirm a paid plan, deny rather than leak.
      logger.error('[AUTH] Paid-plan check error', {
        error: error instanceof Error ? error.message : String(error),
        userId: req.user?.id,
        path: req.path,
      });
      res.status(403).json({
        success: false,
        error: 'Upgrade required',
        code: 'UPGRADE_REQUIRED',
        message: 'Could not verify your plan. Please try again.',
      });
    }
  };
};
