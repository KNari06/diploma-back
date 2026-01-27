import { env, isDevelopment } from '@/config/environment/env';
import {
  exchangeCodeForSession,
  getCurrentUser,
  getOAuthUrl,
  refreshAccessToken,
  requestPasswordReset,
  signInWithEmail,
  signInWithMagicLink,
  signOut,
  signUpWithEmail,
  updatePassword,
  updateUserProfile,
} from '@/services/auth/auth.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// Simple in-memory per-IP rate limiting for OAuth completion endpoint
// This endpoint is unauthenticated (desktop needs to exchange code), so we limit by IP.
const OAUTH_COMPLETE_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const OAUTH_COMPLETE_RATE_LIMIT_MAX = 5; // 5 requests per minute per IP
const oauthCompleteRateLimit = new Map<string, { count: number; windowStart: number }>();

function getClientIp(req: Request): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return forwarded || req.ip || 'unknown';
}

/**
 * Sign up with email and password
 * POST /auth/signup
 */
export const signup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name } = req.body;

    const result = await signUpWithEmail(email, password, name);

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
    const { email, password } = req.body;

    const result = await signInWithEmail(email, password);

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
    const { redirect_uri, use_pkce } = req.query;

    if (!['google', 'github', 'gitlab', 'bitbucket'].includes(provider)) {
      res.status(400).json({
        success: false,
        error: 'Invalid OAuth provider',
      });
      return;
    }

    let finalRedirect = redirect_uri as string;

    if (!finalRedirect) {
      const origin = req.headers.origin || (isDevelopment ? 'http://localhost:8080' : env.FRONTEND_URL);
      finalRedirect = `${origin}/oauth/callback`;
    }

    // Use PKCE for desktop OAuth (when use_pkce=true)
    const usePKCE = use_pkce === 'true' || use_pkce === '1';

    const result = await getOAuthUrl(
      provider as 'google' | 'github' | 'gitlab' | 'bitbucket',
      finalRedirect,
      usePKCE
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
 * Complete OAuth flow - exchange authorization code for tokens
 * POST /auth/oauth/complete
 */
export const completeOAuthHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    // Rate limit by IP
    const ip = getClientIp(req);
    const now = Date.now();
    const entry = oauthCompleteRateLimit.get(ip);
    if (!entry || now - entry.windowStart >= OAUTH_COMPLETE_RATE_LIMIT_WINDOW_MS) {
      oauthCompleteRateLimit.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
      oauthCompleteRateLimit.set(ip, entry);
      if (entry.count > OAUTH_COMPLETE_RATE_LIMIT_MAX) {
        const retryAfterSec = Math.ceil((OAUTH_COMPLETE_RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
          success: false,
          error: 'Too many requests',
        });
        return;
      }
    }

    const { provider, code, state } = req.body;

    // Validate provider
    if (!provider || provider !== 'google') {
      res.status(400).json({
        success: false,
        error: 'Invalid provider',
      });
      return;
    }

    // Validate code
    if (!code || typeof code !== 'string' || code.length < 10) {
      res.status(400).json({
        success: false,
        error: 'Authorization code is required',
      });
      return;
    }

    let codeVerifier: string | undefined;
    let redirectUri: string | undefined;

    // If state is provided, validate and get PKCE data from Redis
    if (state) {
      const { redisConnection } = await import('@/config/infrastructure/queues');
      const stateKey = `oauth_state:${state}`;

      try {
        const stateDataStr = await redisConnection.get(stateKey);

        if (!stateDataStr) {
          res.status(400).json({
            success: false,
            error: 'Invalid or expired state',
          });
          return;
        }

        const stateData = JSON.parse(stateDataStr) as {
          code_verifier: string;
          redirect_uri: string;
          provider: string;
          created_at: string;
        };

        // Validate provider matches
        if (stateData.provider !== provider) {
          res.status(400).json({
            success: false,
            error: 'Invalid or expired state',
          });
          return;
        }

        // Check expiration (10 minutes)
        const createdAt = new Date(stateData.created_at).getTime();
        const now = Date.now();
        const age = now - createdAt;

        if (age > 600000) { // 10 minutes in milliseconds
          // Delete expired state
          await redisConnection.del(stateKey);
          res.status(400).json({
            success: false,
            error: 'Invalid or expired state',
          });
          return;
        }

        codeVerifier = stateData.code_verifier;
        redirectUri = stateData.redirect_uri;

        // Delete state after use (one-time use)
        await redisConnection.del(stateKey);

        logger.info('[AUTH] OAuth state validated and removed', {
          state: state.substring(0, 8) + '...',
          provider,
        });
      } catch (redisError) {
        logger.error('[AUTH] Failed to get OAuth state from Redis', {
          error: redisError instanceof Error ? redisError.message : String(redisError),
          state: state.substring(0, 8) + '...',
        });
        res.status(500).json({
          success: false,
          error: 'OAuth exchange failed',
        });
        return;
      }
    }

    // Exchange code for tokens
    const result = await exchangeCodeForSession(code, codeVerifier, redirectUri);

    res.json({
      success: true,
      data: {
        tokens: {
          access_token: result.tokens.access_token,
          refresh_token: result.tokens.refresh_token,
          expires_in: result.tokens.expires_in,
        },
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          avatar: result.user.avatar,
          role: result.user.role,
        },
      },
    });
  } catch (error: any) {
    logger.error('OAuth complete error', error);

    // Handle specific error cases
    const errorMessage = error.message || 'OAuth exchange failed';

    if (errorMessage.includes('Invalid authorization code') ||
      errorMessage.includes('code already used') ||
      errorMessage.includes('expired')) {
      res.status(400).json({
        success: false,
        error: 'Invalid authorization code',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
};

/**
 * Logout
 * POST /auth/logout
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const accessToken =
      authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.replace('Bearer ', '').trim()
        : '';

    if (!accessToken) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
      });
      return;
    }

    await signOut(accessToken);

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error: any) {
    logger.error('Logout error', error);
    res.status(401).json({
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

/**
 * Update user profile
 * PUT /auth/profile
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '') || '';
    const { name } = req.body;

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid name format',
        code: 'VALIDATION_ERROR',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (name.length > 255) {
      res.status(422).json({
        success: false,
        error: 'Name must be less than 255 characters',
        code: 'VALIDATION_ERROR',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const updatedUser = await updateUserProfile(token, name.trim());

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: updatedUser,
    });
  } catch (error: any) {
    logger.error('Profile update error', error);

    if (error.message === 'Invalid token') {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        code: 'INVALID_TOKEN',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update profile',
      code: 'UPDATE_ERROR',
      timestamp: new Date().toISOString(),
    });
  }
};
