import {
  getCurrentUser,
  getOAuthUrl,
  refreshAccessToken,
  requestPasswordReset,
  signInWithEmail,
  signInWithMagicLink,
  signOut,
  signUpWithEmail,
  updatePassword,
} from '@/services/auth.service';
import { AnonymousLimiterService } from '@/services/anonymous-limiter.service';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';

/**
 * Sign up with email and password
 * POST /auth/signup
 */
export const signup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, anonymousId } = req.body;

    const result = await signUpWithEmail(email, password, name);

    // Reset anonymous user's rate limit after successful signup
    if (anonymousId) {
      try {
        await AnonymousLimiterService.resetRequestCount(anonymousId);
        logger.info('[AUTH] Reset anonymous rate limit after signup', {
          userId: result.user?.id,
          anonymousId
        });
      } catch (resetError) {
        logger.error('[AUTH] Failed to reset anonymous limit', { resetError, anonymousId });
      }
    }

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email for verification.',
      data: result,
    });
  } catch (error: any) {
    logger.error('Signup error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Signup failed',
    });
  }
};

/**
 * Sign in with email and password
 * POST /auth/login
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, anonymousId } = req.body;

    const result = await signInWithEmail(email, password);

    // Reset anonymous user's rate limit after successful login
    if (anonymousId) {
      try {
        await AnonymousLimiterService.resetRequestCount(anonymousId);
        logger.info('[AUTH] Reset anonymous rate limit after login', {
          userId: result.user.id,
          anonymousId
        });
      } catch (resetError) {
        logger.error('[AUTH] Failed to reset anonymous limit', { resetError, anonymousId });
      }
    }

    res.json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  } catch (error: any) {
    logger.error('Login error', error);
    res.status(401).json({
      success: false,
      error: error.message || 'Invalid credentials',
    });
  }
};

/**
 * Send magic link to email
 * POST /auth/magic-link
 */
export const sendMagicLink = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, redirectTo } = req.body;

    const result = await signInWithMagicLink(email, redirectTo);

    res.json({
      success: true,
      message: result.message,
    });
  } catch (error: any) {
    logger.error('Magic link error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to send magic link',
    });
  }
};

/**
 * Get OAuth URL
 * GET /auth/oauth/:provider
 */
export const getOAuthUrlHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider } = req.params;
    const { redirectTo } = req.query;

    if (!['google', 'github', 'gitlab', 'bitbucket'].includes(provider)) {
      res.status(400).json({
        success: false,
        error: 'Invalid OAuth provider',
      });
      return;
    }

    const result = await getOAuthUrl(
      provider as 'google' | 'github' | 'gitlab' | 'bitbucket',
      redirectTo as string
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('OAuth URL error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to generate OAuth URL',
    });
  }
};

/**
 * Logout
 * POST /auth/logout
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    await signOut();

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error: any) {
    logger.error('Logout error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Logout failed',
    });
  }
};

/**
 * Refresh access token
 * POST /auth/refresh
 */
export const refresh = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      res.status(400).json({
        success: false,
        error: 'Refresh token is required',
      });
      return;
    }

    const tokens = await refreshAccessToken(refresh_token);

    res.json({
      success: true,
      data: tokens,
    });
  } catch (error: any) {
    logger.error('Token refresh error', error);
    res.status(401).json({
      success: false,
      error: error.message || 'Failed to refresh token',
    });
  }
};

/**
 * Get current user
 * GET /auth/me
 */
export const me = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '') || '';

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
      });
      return;
    }

    const user = await getCurrentUser(token);

    res.json({
      success: true,
      data: user,
    });
  } catch (error: any) {
    logger.error('Get current user error', error);
    res.status(401).json({
      success: false,
      error: error.message || 'Failed to get user',
    });
  }
};

/**
 * Request password reset
 * POST /auth/password/reset-request
 */
export const passwordResetRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, redirectTo } = req.body;

    const result = await requestPasswordReset(email, redirectTo);

    res.json({
      success: true,
      message: result.message,
    });
  } catch (error: any) {
    logger.error('Password reset request error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to send password reset email',
    });
  }
};

/**
 * Update password
 * POST /auth/password/update
 */
export const passwordUpdate = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '') || '';
    const { newPassword } = req.body;

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
      });
      return;
    }

    if (!newPassword || newPassword.length < 6) {
      res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters',
      });
      return;
    }

    await updatePassword(token, newPassword);

    res.json({
      success: true,
      message: 'Password updated successfully',
    });
  } catch (error: any) {
    logger.error('Password update error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update password',
    });
  }
};
