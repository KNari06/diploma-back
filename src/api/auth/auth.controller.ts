import { env, isDevelopment } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import {
  exchangeCodeForSession,
  getCurrentUser,
  getOAuthUrl,
  refreshAccessToken,
  requestPasswordReset,
  resendVerificationEmail,
  signInWithEmail,
  signInWithMagicLink,
  signOut,
  signUpWithEmail,
  BusinessEmailError,
  updatePassword,
  updateUserProfile,
  invalidateAuthCache,
  invalidateAuthCacheForUser,
} from '@/services/auth/auth.service';
import { notifyAdminsOfNewUser } from '@/services/auth/new-user-notification.service';
import { EmailService } from '@/services/core/email.service';
import { SelfServeProvisioningService } from '@/services/core/self-serve-provisioning.service';
import { INDIVIDUAL_PLANS } from '@/services/core/token-calculator.service';
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

    // Welcome email — fire-and-forget so a mail failure never breaks signup.
    // Distinct from the Supabase verification email and the approval email.
    // We don't read the live balance here: the trial grant is applied later
    // (on first verify/login via SelfServeProvisioning), so at signup it's
    // always absent. Instead we state the configured free-plan grant, which is
    // what the user will receive — single-sourced from INDIVIDUAL_PLANS.free.
    if (result.user?.email) {
      const recipientEmail = result.user.email;
      EmailService.sendWelcomeEmail({
        recipientEmail,
        recipientName: result.user.name || undefined,
        frontendUrl: env.FRONTEND_URL,
        freeCredits: INDIVIDUAL_PLANS.free.credits,
      })
        .then((emailResult) => {
          if (!emailResult.success) {
            logger.error('[AUTH] Welcome email not sent', {
              email: recipientEmail,
              error: emailResult.error,
            });
          }
        })
        .catch((err) =>
          logger.error('[AUTH] Failed to send welcome email', {
            error: err instanceof Error ? err.message : String(err),
            email: recipientEmail,
          })
        );
    }

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email for verification.',
      data: result,
    });
  } catch (error: any) {
    // Business-email rejection is a client-fixable validation error — surface
    // the code so frontends can show a localized toast.
    if (error instanceof BusinessEmailError) {
      logger.info('[AUTH] Signup rejected: non-business email', { code: error.code });
      res.status(400).json({
        success: false,
        code: error.code,
        error: error.message,
      });
      return;
    }

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

    // Self-serve PLG: also provision on login, not just first signup/verify.
    // Covers the case where a user signed up while AUTO_APPROVE_SIGNUP was off
    // (left pending) and the flag was later turned on — their next email/
    // password login then approves + provisions them. No-op when the flag is
    // off; idempotent; best-effort (never throws).
    const provisioned = await SelfServeProvisioningService.provision(result.user.id);
    const effectiveStatus = provisioned ? 'approved' : result.user.status;

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        ...result,
        user: { ...result.user, status: effectiveStatus },
      },
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

    // Self-serve PLG: approve + provision workspace/project on first auth.
    // No-op unless AUTO_APPROVE_SIGNUP is set. Best-effort, never throws.
    // Returns true only when the user is genuinely approved, so the response
    // never claims approval after a silent provisioning failure.
    const provisioned = await SelfServeProvisioningService.provision(result.user.id);
    const effectiveStatus = provisioned ? 'approved' : result.user.status;

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
          status: effectiveStatus,
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
    await invalidateAuthCache(accessToken);

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
 * Resend verification email
 * POST /auth/resend-verification
 */
export const resendVerification = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, redirectTo } = req.body;

    const result = await resendVerificationEmail(email, redirectTo);

    res.json({
      success: true,
      message: result.message,
    });
  } catch (error: any) {
    logger.error('Resend verification error', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to resend verification email',
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

/**
 * Get users pending approval
 * GET /auth/users/pending
 * Requires admin role
 */
export const getPendingUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, email, name, role, status, created_at, updated_at')
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[AUTH] Failed to fetch pending users', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch pending users',
      });
      return;
    }

    // Enrich with workspace/onboarding data
    const enrichedUsers = await Promise.all(
      (users || []).map(async (user) => {
        const { data: workspace } = await supabaseAdmin
          .from('workspaces')
          .select('id, name, settings, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        return {
          ...user,
          workspace: workspace
            ? {
                id: workspace.id,
                name: workspace.name,
                accountType: workspace.settings?.accountType,
                companyName: workspace.settings?.companyName,
                role: workspace.settings?.role,
                baseUrls: workspace.settings?.baseUrls,
                onboarding_completed: workspace.settings?.onboarding_completed,
              }
            : null,
        };
      })
    );

    res.json({
      success: true,
      data: enrichedUsers,
      count: enrichedUsers.length,
    });
  } catch (error: any) {
    logger.error('[AUTH] Get pending users error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch pending users',
    });
  }
};

/**
 * Update user approval status
 * PATCH /auth/users/:userId/status
 * Requires admin role
 */
export const updateUserStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending_approval', 'approved', 'rejected'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
      return;
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!userId || !uuidRegex.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      });
      return;
    }

    // Read previous status to detect the pending_approval → approved transition
    // so we only send the approval email once (not on every idempotent PATCH).
    const { data: prevUser } = await supabaseAdmin
      .from('users')
      .select('status')
      .eq('id', userId)
      .maybeSingle();

    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('id, email, name, role, status, created_at, updated_at')
      .single();

    if (error) {
      logger.error('[AUTH] Failed to update user status', {
        userId,
        status,
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to update user status',
      });
      return;
    }

    logger.info('[AUTH] User status updated', {
      userId,
      newStatus: status,
      updatedBy: req.user?.id,
    });

    // Invalidate auth cache so the user's next request picks up the new status
    await invalidateAuthCacheForUser(userId);

    // Fire-and-forget status notification emails.
    // Guarded by the previous status so repeated PATCHes don't spam the user.
    if (updatedUser?.email && prevUser?.status !== status) {
      if (status === 'approved') {
        EmailService.sendApprovalEmail({
          recipientEmail: updatedUser.email,
          recipientName: updatedUser.name || undefined,
          frontendUrl: env.FRONTEND_URL,
        })
          .then((result) => {
            // A resolved {success:false} (e.g. SMTP misconfigured/rejected) is
            // NOT a thrown error — surface it explicitly, otherwise a dead
            // credential fails completely silently while the admin sees "approved".
            if (!result.success) {
              logger.error('[AUTH] Approval email not sent on status change', {
                userId,
                email: updatedUser.email,
                error: result.error,
              });
            }
          })
          .catch((err) =>
            logger.error('[AUTH] Failed to send approval email on status change', {
              error: err instanceof Error ? err.message : String(err),
              userId,
              email: updatedUser.email,
            })
          );
      } else if (status === 'rejected') {
        EmailService.sendRejectionEmail({
          recipientEmail: updatedUser.email,
          recipientName: updatedUser.name || undefined,
          frontendUrl: env.FRONTEND_URL,
        })
          .then((result) => {
            if (!result.success) {
              logger.error('[AUTH] Rejection email not sent on status change', {
                userId,
                email: updatedUser.email,
                error: result.error,
              });
            }
          })
          .catch((err) =>
            logger.error('[AUTH] Failed to send rejection email on status change', {
              error: err instanceof Error ? err.message : String(err),
              userId,
              email: updatedUser.email,
            })
          );
      }
    }

    res.json({
      success: true,
      data: updatedUser,
      message: `User status updated to ${status}`,
    });
  } catch (error: any) {
    logger.error('[AUTH] Update user status error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update user status',
    });
  }
};

/**
 * Send approval notification email
 * POST /auth/send-approval-email
 */
export const sendApprovalEmailHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, name } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ success: false, error: 'Email is required' });
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({ success: false, error: 'Invalid email format' });
      return;
    }

    // Verify user exists and is in approved status (only send to approved users)
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, status, email')
      .eq('email', email)
      .single();

    if (userError || !user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (user.status !== 'approved') {
      res.status(400).json({
        success: false,
        error: `Cannot send approval email: user status is "${user.status}"`,
      });
      return;
    }

    EmailService.sendApprovalEmail({
      recipientEmail: email,
      recipientName: name || undefined,
      frontendUrl: env.FRONTEND_URL,
    })
      .then((result) => {
        if (!result.success) {
          logger.error('[AUTH] Approval email not sent', {
            email,
            error: result.error,
          });
        }
      })
      .catch((err) =>
        logger.error('[AUTH] Failed to send approval email', {
          error: err instanceof Error ? err.message : String(err),
          email,
        })
      );

    res.json({ success: true, message: 'Approval email queued' });
  } catch (error: any) {
    logger.error('[AUTH] Send approval email error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to send approval email' });
  }
};

/**
 * Verify email via Supabase token (callback from email link).
 * GET /auth/verify-email?token=...
 *
 * Supabase confirm-signup tokens are exchanged via verifyOtp(type: 'signup').
 * On success we return tokens + user data so the frontend can auto-login.
 */
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = (req.query.token as string) || '';

    if (!token) {
      res.status(400).json({ success: false, error: 'Verification token is required' });
      return;
    }

    // Import supabase client (not admin — we need to exchange the user token)
    const { supabase } = await import('@/db/supabase');

    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: 'signup',
    });

    if (error) {
      logger.error('[AUTH] Email verification failed', {
        error: error.message,
        code: error.status,
      });
      res.status(400).json({
        success: false,
        error: error.message || 'Invalid or expired verification link',
      });
      return;
    }

    if (!data.user) {
      res.status(400).json({ success: false, error: 'Verification failed: no user returned' });
      return;
    }

    // Fetch role/status from public.users
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('role, name, status, avatar_url')
      .eq('id', data.user.id)
      .maybeSingle();

    // First-time email verification → notify admins (idempotent: only fires
    // when status is still 'pending_approval' and no prior sign-in exists).
    const isFirstVerification =
      (!userData || userData.status === 'pending_approval') &&
      !data.user.last_sign_in_at;
    if (isFirstVerification && data.user.email) {
      notifyAdminsOfNewUser({
        userId: data.user.id,
        email: data.user.email,
        name: userData?.name || data.user.user_metadata?.name || data.user.email.split('@')[0],
        provider: 'email',
        signedUpAt: data.user.created_at,
      });
    }

    // Self-serve PLG: approve + provision workspace/project on first auth.
    // No-op unless AUTO_APPROVE_SIGNUP is set. Best-effort, never throws.
    // Returns true only when the user is genuinely approved, so the response
    // never claims approval after a silent provisioning failure.
    const provisioned = await SelfServeProvisioningService.provision(data.user.id);
    const effectiveStatus = provisioned
      ? 'approved'
      : userData?.status || 'pending_approval';

    const user = {
      id: data.user.id,
      email: data.user.email || '',
      name: userData?.name || data.user.user_metadata?.name,
      role: userData?.role || 'user',
      status: effectiveStatus,
      avatar: userData?.avatar_url || data.user.user_metadata?.avatar_url,
    };

    const tokens = data.session
      ? {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_in: data.session.expires_in ?? 0,
        }
      : { access_token: '', refresh_token: '', expires_in: 0 };

    logger.info('[AUTH] Email verified', { userId: data.user.id });

    res.json({
      success: true,
      message: 'Email verified successfully',
      data: { user, tokens },
    });
  } catch (error: any) {
    logger.error('[AUTH] Email verification error', { error: error.message });
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
};

/**
 * Send a general-info / announcement email to one or more users (admin only).
 * POST /auth/admin/send-info-email
 * Body: { userIds?: string[], emails?: string[], heading, body, subject?, cta? }
 * Recipients resolve from userIds (looked up) and/or raw emails. Sends are
 * sequential and best-effort; the response reports per-recipient success.
 */
export const sendInfoEmailHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userIds, emails, heading, body, subject, cta } = req.body as {
      userIds?: string[];
      emails?: string[];
      heading?: string;
      body?: string;
      subject?: string;
      cta?: { label: string; url: string };
    };

    if (!heading || typeof heading !== 'string' || !body || typeof body !== 'string') {
      res.status(400).json({ success: false, error: 'heading and body are required' });
      return;
    }
    if ((!Array.isArray(userIds) || userIds.length === 0) && (!Array.isArray(emails) || emails.length === 0)) {
      res.status(400).json({ success: false, error: 'Provide userIds and/or emails' });
      return;
    }

    // Validate the optional CTA up-front: both fields must be strings and the
    // URL must be http(s)/mailto. The template also sanitizes (safeUrl), but
    // reject obviously-bad input here so the admin gets a clear 400.
    if (cta !== undefined) {
      const okShape = cta && typeof cta.label === 'string' && typeof cta.url === 'string';
      if (!okShape || !/^(https?:|mailto:)/i.test(cta.url.trim())) {
        res.status(400).json({ success: false, error: 'cta must be { label, url } with an http(s)/mailto url' });
        return;
      }
    }

    // Cap total recipients per call so a fat-fingered broadcast can't hang the
    // request (sends are sequential) or silently truncate a huge .in() lookup.
    const MAX_RECIPIENTS = 500;
    const idList = Array.isArray(userIds) ? userIds.slice(0, MAX_RECIPIENTS) : [];
    const emailList = Array.isArray(emails) ? emails.slice(0, MAX_RECIPIENTS) : [];
    if ((userIds?.length || 0) + (emails?.length || 0) > MAX_RECIPIENTS) {
      res.status(400).json({ success: false, error: `Too many recipients (max ${MAX_RECIPIENTS} per call)` });
      return;
    }

    // Resolve recipients: {email, name}. userIds are looked up; raw emails
    // pass through with no name. De-dupe by email.
    const recipients = new Map<string, { email: string; name?: string }>();

    if (idList.length > 0) {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('email, name')
        .in('id', idList);
      for (const u of users || []) {
        if (u.email) recipients.set(u.email, { email: u.email, name: u.name || undefined });
      }
    }
    for (const e of emailList) {
      if (typeof e === 'string' && e.includes('@') && !recipients.has(e)) {
        recipients.set(e, { email: e });
      }
    }

    if (recipients.size === 0) {
      res.status(400).json({ success: false, error: 'No valid recipients resolved' });
      return;
    }

    let sent = 0;
    const failed: string[] = [];
    for (const r of recipients.values()) {
      const result = await EmailService.sendGeneralInfoEmail({
        recipientEmail: r.email,
        recipientName: r.name,
        heading,
        body,
        subject,
        cta,
      });
      if (result.success) sent += 1;
      else failed.push(r.email);
    }

    if (failed.length > 0) {
      logger.error('[AUTH] Info email partially failed', { sent, failed: failed.length });
    }

    res.json({
      success: true,
      data: { total: recipients.size, sent, failed },
      message: `Info email sent to ${sent}/${recipients.size} recipients`,
    });
  } catch (error: any) {
    logger.error('[AUTH] Send info email error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to send info email' });
  }
};
