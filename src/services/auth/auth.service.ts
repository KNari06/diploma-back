import { env } from '@/config/environment/env';
import { redisConnection } from '@/config/infrastructure/queues';
import { supabase, supabaseAdmin } from '@/db/supabase';
import { AuthTokens, AuthUser } from '@/types';
import { logger } from '@/utils/core/logger';
import * as crypto from 'crypto';

// Supabase JWT expiry is configured in Supabase Dashboard (Auth settings).
// This is only a fallback for cases when expires_in is missing.
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60; // 30 days

function normalizeExpiresIn(expiresIn?: number): number {
  const v = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? Math.floor(expiresIn) : 0;
  return v > 0 ? v : DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS;
}

function warnIfUnexpectedJwtExpiry(expiresIn?: number): void {
  // If Supabase still returns ~1h, it means the dashboard setting wasn't updated.
  if (typeof expiresIn === 'number' && expiresIn > 0 && expiresIn < DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS) {
    logger.warn('[AUTH] Supabase JWT expiry appears lower than expected', {
      expiresInSeconds: expiresIn,
      expectedSeconds: DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      hint: 'Update Supabase Auth setting: JWT expiry limit',
    });
  }
}

/**
 * Sign up with email and password
 * @param email - User email
 * @param password - User password
 * @param name - User name
 * @returns Auth tokens and user data
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  // Validate inputs
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new Error('Password must be at least 6 characters long');
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: {
          name: name?.trim() || email.split('@')[0],
        },
      },
    });

    if (error) {
      logger.error('[AUTH] Sign up error', {
        error: error.message,
        code: error.status,
        email: email.substring(0, 5) + '***', // Log partial email only
      });
      throw error;
    }

    if (!data.user) {
      logger.error('[AUTH] Sign up failed: no user returned', { email: email.substring(0, 5) + '***' });
      throw new Error('Sign up failed: no user returned');
    }

    // Check if email confirmation is required
    if (!data.session && !data.user.email_confirmed_at) {
      logger.info('[AUTH] User signed up, email confirmation required', {
        userId: data.user.id,
        email: data.user.email || email.substring(0, 5) + '***',
      });

      return {
        user: {
          id: data.user.id,
          email: data.user.email || email,
          name: data.user.user_metadata?.name || name?.trim() || email.split('@')[0],
          role: 'user',
          status: 'pending_approval',
        },
        tokens: {
          access_token: '', // No tokens until email is confirmed
          refresh_token: '',
          expires_in: 0,
        },
      };
    }

    if (!data.session) {
      logger.error('[AUTH] Sign up failed: no session returned', {
        userId: data.user.id,
        email: data.user.email || email.substring(0, 5) + '***',
        emailConfirmed: !!data.user.email_confirmed_at,
      });
      throw new Error('Sign up failed: no session returned');
    }

    logger.info('[AUTH] User signed up with session', {
      userId: data.user.id,
      email: data.user.email || email.substring(0, 5) + '***',
      confirmed: !!data.user.email_confirmed_at,
    });

    return {
      user: {
        id: data.user.id,
        email: data.user.email || email,
        name: data.user.user_metadata?.name || name?.trim() || email.split('@')[0],
        role: 'user',
        status: 'pending_approval',
      },
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: normalizeExpiresIn(data.session.expires_in),
      },
    };
  } catch (error) {
    logger.error('[AUTH] Sign up error', {
      error: error instanceof Error ? error.message : String(error),
      email: email.substring(0, 5) + '***',
    });
    throw error;
  }
}

/**
 * Sign in with email and password
 * @param email - User email
 * @param password - User password
 * @returns Auth tokens and user data
 */
export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  // Validate inputs
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  if (!password || typeof password !== 'string' || password.length === 0) {
    throw new Error('Password is required');
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) {
      // Check if Supabase returned HTML instead of JSON (503/500 errors)
      const errorMessage = error.message || '';
      const isSupabaseDown = errorMessage.includes('not valid JSON') ||
        errorMessage.includes('Unexpected token') ||
        errorMessage.includes('Internal server error');

      logger.error('[AUTH] Sign in error', {
        error: error.message,
        code: error.status,
        email: email.substring(0, 5) + '***',
        supabaseDown: isSupabaseDown,
      });

      // User-friendly error for service unavailability
      if (isSupabaseDown) {
        throw new Error('Authentication service temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }

    if (!data.user || !data.session) {
      logger.error('[AUTH] Sign in failed: no user or session returned', {
        hasUser: !!data.user,
        hasSession: !!data.session,
        email: email.substring(0, 5) + '***',
      });
      throw new Error('Sign in failed: no user or session returned');
    }

    logger.info('[AUTH] User signed in', {
      userId: data.user.id,
      email: data.user.email || email.substring(0, 5) + '***',
    });

    warnIfUnexpectedJwtExpiry(data.session.expires_in);

    // Fetch role and status from public.users
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('role, name, status, avatar_url')
      .eq('id', data.user.id)
      .maybeSingle();

    return {
      user: {
        id: data.user.id,
        email: data.user.email || email,
        name: userData?.name || data.user.user_metadata?.name,
        role: userData?.role || 'user',
        status: userData?.status || 'pending_approval',
        avatar: userData?.avatar_url || data.user.user_metadata?.avatar_url,
      },
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: normalizeExpiresIn(data.session.expires_in),
      },
    };
  } catch (error) {
    // Enhanced error logging for debugging Supabase issues
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('[AUTH] Sign in error', {
      error: errorMessage,
      email: email.substring(0, 5) + '***',
      stack: errorStack,
      // Check if it's a network/Supabase infrastructure error
      isNetworkError: errorMessage.includes('fetch') ||
        errorMessage.includes('network') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT'),
    });
    throw error;
  }
}

/**
 * Sign in with magic link
 * @param email - User email
 * @param redirectTo - Optional redirect URL after verification
 * @returns Success status
 */
export async function signInWithMagicLink(
  email: string,
  redirectTo?: string
): Promise<{ success: boolean; message: string }> {
  // Validate inputs
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  try {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: redirectTo,
      },
    });

    if (error) {
      logger.error('[AUTH] Magic link error', {
        error: error.message,
        code: error.status,
        email: email.substring(0, 5) + '***',
      });
      throw error;
    }

    logger.info('[AUTH] Magic link sent', {
      email: email.substring(0, 5) + '***',
      hasRedirectTo: !!redirectTo,
    });

    return {
      success: true,
      message: 'Magic link sent to your email',
    };
  } catch (error) {
    logger.error('[AUTH] Magic link error', {
      error: error instanceof Error ? error.message : String(error),
      email: email.substring(0, 5) + '***',
    });
    throw error;
  }
}

/**
 * Generate PKCE code verifier and challenge
 * @returns Object with code_verifier and code_challenge
 */
function generatePKCE(): { code_verifier: string; code_challenge: string } {
  // Generate 32 random bytes (256 bits) for code_verifier
  const codeVerifier = crypto.randomBytes(32).toString('base64url');

  // Generate code_challenge: SHA256(code_verifier) encoded as base64url
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return {
    code_verifier: codeVerifier,
    code_challenge: codeChallenge,
  };
}

/**
 * Generate random state token
 * @returns Base64url encoded random string
 */
function generateStateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Get OAuth URL for provider
 * @param provider - OAuth provider (google, github, etc.)
 * @param redirectTo - Required redirect URL after OAuth
 * @param usePKCE - Whether to use PKCE flow (default: false for web, true for desktop)
 * @returns OAuth URL with state and optionally PKCE
 */
export async function getOAuthUrl(
  provider: 'google' | 'github' | 'gitlab' | 'bitbucket',
  redirectTo: string,
  usePKCE: boolean = false
): Promise<{ url: string; state?: string }> {
  // Validate inputs
  if (!provider || !['google', 'github', 'gitlab', 'bitbucket'].includes(provider)) {
    throw new Error('Invalid OAuth provider');
  }

  if (!redirectTo || typeof redirectTo !== 'string' || !redirectTo.startsWith('http')) {
    throw new Error('Invalid redirect URL: must be a valid HTTP/HTTPS URL');
  }

  try {
    let pkceData: { code_verifier: string; code_challenge: string } | null = null;
    let state: string | null = null;

    // Generate PKCE if needed (for desktop OAuth)
    if (usePKCE) {
      pkceData = generatePKCE();
      state = generateStateToken();

      // Store state + code_verifier in Redis with 10 minute TTL
      const stateKey = `oauth_state:${state}`;
      const stateData = {
        code_verifier: pkceData.code_verifier,
        redirect_uri: redirectTo,
        provider,
        created_at: new Date().toISOString(),
      };

      try {
        await redisConnection.setex(stateKey, 600, JSON.stringify(stateData)); // 10 minutes
        logger.info('[AUTH] OAuth state stored in Redis', {
          state: state.substring(0, 8) + '...',
          provider,
        });
      } catch (redisError) {
        logger.error('[AUTH] Failed to store OAuth state in Redis', {
          error: redisError instanceof Error ? redisError.message : String(redisError),
          provider,
        });
        throw new Error('Failed to store OAuth state');
      }
    }

    // Build OAuth options
    const oauthOptions: any = {
      redirectTo,
    };

    // Add PKCE parameters if using PKCE
    if (usePKCE && pkceData && state) {
      oauthOptions.queryParams = {
        code_challenge: pkceData.code_challenge,
        code_challenge_method: 'S256',
        state,
      };
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: oauthOptions,
    });

    if (error) {
      logger.error('[AUTH] OAuth URL generation error', {
        error: error.message,
        code: error.status,
        provider,
        usePKCE,
      });
      throw error;
    }

    if (!data.url) {
      logger.error('[AUTH] No OAuth URL returned', { provider });
      throw new Error('No OAuth URL returned');
    }

    logger.info('[AUTH] OAuth URL generated', {
      provider,
      usePKCE,
      hasState: !!state,
    });

    return {
      url: data.url,
      state: state || undefined,
    };
  } catch (error) {
    logger.error('[AUTH] OAuth URL generation error', {
      error: error instanceof Error ? error.message : String(error),
      provider,
      usePKCE,
    });
    throw error;
  }
}

/**
 * Exchange authorization code for session tokens (with PKCE support)
 * @param code - Authorization code from OAuth callback
 * @param codeVerifier - PKCE code verifier (required for desktop OAuth)
 * @param redirectUri - Redirect URI used in OAuth flow (must match)
 * @returns Auth tokens and user data
 */
export async function exchangeCodeForSession(
  code: string,
  codeVerifier?: string,
  redirectUri?: string
): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  // Validate inputs
  if (!code || typeof code !== 'string' || code.length < 10) {
    throw new Error('Invalid authorization code');
  }

  try {
    // If code_verifier is provided, use PKCE flow via REST API
    if (codeVerifier) {
      const supabaseUrl = env.SUPABASE_URL;
      const supabaseAnonKey = env.SUPABASE_ANON_KEY;

      if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase configuration is missing');
      }

      logger.info('[AUTH] Exchanging code for tokens (PKCE)', {
        codeLength: code.length,
        hasRedirectUri: !!redirectUri,
      });

      // Supabase/Auth flows can vary depending on provider/setup.
      // We try the most common GoTrue PKCE exchange first and fallback to OAuth token endpoint.
      const tryPkceTokenExchange = async (): Promise<Response> => {
        const tokenUrl = `${supabaseUrl}/auth/v1/token?grant_type=pkce`;
        const formData = new URLSearchParams();
        formData.append('auth_code', code);
        formData.append('code_verifier', codeVerifier);
        if (redirectUri) formData.append('redirect_uri', redirectUri);

        return fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
          body: formData.toString(),
        });
      };

      const tryOauthTokenExchange = async (): Promise<Response> => {
        const tokenUrl = `${supabaseUrl}/auth/v1/oauth/token`;
        const formData = new URLSearchParams();
        formData.append('grant_type', 'authorization_code');
        formData.append('code', code);
        formData.append('code_verifier', codeVerifier);
        if (redirectUri) formData.append('redirect_uri', redirectUri);

        return fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
          body: formData.toString(),
        });
      };

      let response = await tryPkceTokenExchange();
      if (!response.ok) {
        // Fallback to alternate endpoint
        response = await tryOauthTokenExchange();
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[AUTH] Token exchange failed', {
          status: response.status,
          error: errorText,
        });
        throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
      }

      const tokenData = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        user?: any;
      };

      if (!tokenData.access_token || !tokenData.refresh_token) {
        logger.error('[AUTH] Token exchange returned invalid data');
        throw new Error('Invalid token response');
      }

      // Get user data from access token
      const { data: userData, error: userError } = await supabase.auth.getUser(
        tokenData.access_token
      );

      if (userError || !userData.user) {
        logger.error('[AUTH] Failed to get user from token', {
          error: userError?.message,
        });
        throw new Error('Failed to get user data');
      }

      logger.info('[AUTH] Code exchanged for tokens (PKCE)', {
        userId: userData.user.id,
      });

      // Fetch role and status from public.users
      const { data: dbUser } = await supabaseAdmin
        .from('users')
        .select('role, name, status, avatar_url')
        .eq('id', userData.user.id)
        .maybeSingle();

      return {
        user: {
          id: userData.user.id,
          email: userData.user.email || '',
          name: dbUser?.name || userData.user.user_metadata?.name || userData.user.email?.split('@')[0] || 'User',
          role: dbUser?.role || 'user',
          status: dbUser?.status || 'pending_approval',
          avatar: dbUser?.avatar_url || userData.user.user_metadata?.avatar_url,
        },
        tokens: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: normalizeExpiresIn(tokenData.expires_in),
        },
      };
    } else {
      // Use Supabase client method (for web OAuth without PKCE)
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (error) {
        logger.error('[AUTH] Code exchange error', {
          error: error.message,
          code: error.status,
        });
        throw error;
      }

      if (!data.session || !data.user) {
        logger.error('[AUTH] Code exchange failed: no session or user returned');
        throw new Error('Code exchange failed: no session or user returned');
      }

      logger.info('[AUTH] Code exchanged for tokens', {
        userId: data.user.id,
      });

      warnIfUnexpectedJwtExpiry(data.session.expires_in);

      // Fetch role and status from public.users
      const { data: dbUser } = await supabaseAdmin
        .from('users')
        .select('role, name, status, avatar_url')
        .eq('id', data.user.id)
        .maybeSingle();

      return {
        user: {
          id: data.user.id,
          email: data.user.email || '',
          name: dbUser?.name || data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
          role: dbUser?.role || 'user',
          status: dbUser?.status || 'pending_approval',
          avatar: dbUser?.avatar_url || data.user.user_metadata?.avatar_url,
        },
        tokens: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_in: normalizeExpiresIn(data.session.expires_in),
        },
      };
    }
  } catch (error) {
    logger.error('[AUTH] Code exchange error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Sign out user
 * Revokes the CURRENT session refresh token (scope=local).
 * @returns Success status
 */
export async function signOut(accessToken: string): Promise<{ success: boolean }> {
  try {
    if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length < 10) {
      throw new Error('Invalid access token');
    }

    // Server-side: revoke refresh token for THIS session.
    // Note: Supabase cannot revoke the access token JWT before it expires.
    const { error } = await supabaseAdmin.auth.admin.signOut(accessToken.trim(), 'local');
    if (error) {
      logger.warn('[AUTH] Sign out failed', { error: error.message });
      throw new Error(error.message || 'Logout failed');
    }

    logger.info('[AUTH] User signed out (session revoked)');

    return { success: true };
  } catch (error) {
    logger.error('[AUTH] Sign out error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Refresh access token
 * @param refreshToken - Refresh token
 * @returns New tokens
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<AuthTokens> {
  // Validate input
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length < 10) {
    throw new Error('Invalid refresh token');
  }

  try {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) {
      logger.error('[AUTH] Token refresh error', {
        error: error.message,
        code: error.status,
      });
      throw error;
    }

    if (!data.session) {
      logger.error('[AUTH] Token refresh failed: no session returned');
      throw new Error('No session returned');
    }

    logger.info('[AUTH] Token refreshed', {
      userId: data.user?.id,
    });

    warnIfUnexpectedJwtExpiry(data.session.expires_in);

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: normalizeExpiresIn(data.session.expires_in),
    };
  } catch (error) {
    logger.error('[AUTH] Token refresh error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Verify JWT token and get user
 * @param accessToken - Access token
 * @returns User data or null
 */
export async function verifyToken(accessToken: string): Promise<AuthUser | null> {
  try {
    // Verify token format first
    if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 10) {
      logger.debug('[AUTH] Invalid token format', {
        tokenLength: accessToken?.length,
        hasToken: !!accessToken,
      });
      return null;
    }

    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) {
      logger.debug('[AUTH] Token verification failed', {
        error: error.message,
        code: error.status,
      });
      return null;
    }

    if (!data.user) {
      logger.debug('[AUTH] No user returned from token verification');
      return null;
    }

    // Check if user is confirmed (for email verification)
    // Note: Some OAuth providers may not require email confirmation
    // We'll allow verified OAuth users even without email_confirmed_at
    const isOAuthUser = data.user.app_metadata?.provider && data.user.app_metadata.provider !== 'email';

    if (!data.user.email_confirmed_at && !isOAuthUser) {
      logger.debug('[AUTH] User email not confirmed', {
        userId: data.user.id,
        provider: data.user.app_metadata?.provider,
      });
      return null;
    }

    // Get additional user data from public.users
    // Use maybeSingle() to handle case when user not found (trigger may not have run yet)
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .select('role, name, status, avatar_url')
      .eq('id', data.user.id)
      .maybeSingle();

    // Log warning if user not found in public.users but don't fail
    if (dbError) {
      logger.warn('[AUTH] Error fetching user from public.users', {
        userId: data.user.id,
        error: dbError.message,
      });
    }

    // Return user even if not in public.users yet (trigger will sync later)
    return {
      id: data.user.id,
      email: data.user.email || '',
      name: userData?.name || data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
      role: userData?.role || 'user',
      status: userData?.status || 'pending_approval',
      avatar: userData?.avatar_url || data.user.user_metadata?.avatar_url,
    };
  } catch (error) {
    // Log error but don't throw - return null to indicate invalid token
    logger.debug('[AUTH] Token verification error', {
      error: error instanceof Error ? error.message : String(error),
      // Don't log stack trace for auth errors to avoid noise
    });
    return null;
  }
}

/**
 * Get current user from token
 * @param accessToken - Access token
 * @returns User data with credits and subscription
 */
export async function getCurrentUser(accessToken: string): Promise<any> {
  // Validate input
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 10) {
    throw new Error('Invalid access token');
  }

  try {
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) {
      logger.error('[AUTH] Get current user error', {
        error: error.message,
        code: error.status,
      });
      throw error;
    }

    if (!data.user) {
      logger.error('[AUTH] Get current user failed: no user returned');
      throw new Error('User not found');
    }

    const userId = data.user.id;
    const userEmail = data.user.email || '';

    logger.debug('[AUTH] Getting current user data', {
      userId,
      email: userEmail.substring(0, 5) + '***',
    });

    // Get full user data from public.users
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (dbError) {
      logger.error('[AUTH] Error fetching user from public.users', {
        userId,
        error: dbError.message,
        code: dbError.code,
      });
      throw dbError;
    }

    // If user not found in public.users, create them (fallback for missing sync)
    // Use INSERT ... ON CONFLICT to avoid race condition
    if (!userData) {
      logger.warn('[AUTH] User not found in public.users, creating fallback entry', { userId });

      const fallbackUser = {
        id: userId,
        email: userEmail,
        name: data.user.user_metadata?.name || userEmail.split('@')[0] || 'User',
        role: 'user',
        credits: 0,
        subscription: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Use upsert to avoid race condition if trigger creates user concurrently
      const { data: createdUser, error: createError } = await supabaseAdmin
        .from('users')
        .upsert(fallbackUser, {
          onConflict: 'id',
        })
        .select('*')
        .maybeSingle();

      if (createError) {
        // If conflict (user was created by trigger), fetch again
        if (createError.code === '23505') { // Unique violation
          logger.info('[AUTH] User was created by trigger, fetching again', { userId });

          const { data: retryUserData, error: retryError } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

          if (retryError || !retryUserData) {
            logger.error('[AUTH] Failed to fetch user after race condition', {
              userId,
              error: retryError?.message,
            });
            throw new Error('User data not found and could not be created. Please try logging in again.');
          }

          // Get credits from user_credits table
          const { UserCreditsService } = await import('@/services/core/user-credits.service');
          const userCredits = await UserCreditsService.getUserCredits(userId);
          const creditsBalance = userCredits ? (userCredits.credits_balance || 0) : 0;

          return {
            id: userId,
            email: userEmail,
            name: retryUserData.name,
            role: retryUserData.role,
            status: retryUserData.status || 'pending_approval',
            avatar: retryUserData.avatar_url,
            credits: creditsBalance,
            subscription: retryUserData.subscription,
            created_at: retryUserData.created_at,
          };
        }

        logger.error('[AUTH] Failed to create fallback user', {
          error: createError.message,
          code: createError.code,
          userId,
        });
        throw new Error('User data not found and could not be created. Please try logging in again.');
      }

      if (!createdUser) {
        logger.error('[AUTH] User creation returned no data', { userId });
        throw new Error('User data not found and could not be created. Please try logging in again.');
      }

      logger.info('[AUTH] Fallback user created successfully', { userId });

      // Get credits from user_credits table
      const { UserCreditsService } = await import('@/services/core/user-credits.service');
      const userCredits = await UserCreditsService.getUserCredits(userId);
      const creditsBalance = userCredits ? (userCredits.credits_balance || 0) : 0;

      return {
        id: userId,
        email: userEmail,
        name: createdUser.name,
        role: createdUser.role,
        status: createdUser.status || 'pending_approval',
        avatar: createdUser.avatar_url,
        credits: creditsBalance,
        subscription: createdUser.subscription,
        created_at: createdUser.created_at,
      };
    }

    // Get credits from user_credits table
    const { UserCreditsService } = await import('@/services/core/user-credits.service');
    const userCredits = await UserCreditsService.getUserCredits(userId);
    const creditsBalance = userCredits ? (userCredits.credits_balance || 0) : 0;

    return {
      id: userId,
      email: userEmail,
      name: userData.name,
      role: userData.role || 'user',
      status: userData.status || 'pending_approval',
      avatar: userData.avatar_url,
      credits: creditsBalance,
      subscription: userData.subscription,
      created_at: userData.created_at,
    };
  } catch (error) {
    logger.error('[AUTH] Get current user error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Reset password request
 * @param email - User email
 * @param redirectTo - Optional redirect URL after verification
 * @returns Success status
 */
export async function requestPasswordReset(
  email: string,
  redirectTo?: string
): Promise<{ success: boolean; message: string }> {
  // Validate inputs
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: redirectTo || `${env.FRONTEND_URL}/auth/reset-password`,
    });

    if (error) {
      logger.error('[AUTH] Password reset request error', {
        error: error.message,
        code: error.status,
        email: email.substring(0, 5) + '***',
      });
      throw error;
    }

    logger.info('[AUTH] Password reset requested', {
      email: email.substring(0, 5) + '***',
      hasRedirectTo: !!redirectTo,
    });

    return {
      success: true,
      message: 'Password reset link sent to your email',
    };
  } catch (error) {
    logger.error('[AUTH] Password reset request error', {
      error: error instanceof Error ? error.message : String(error),
      email: email.substring(0, 5) + '***',
    });
    throw error;
  }
}

/**
 * Update password
 * @param accessToken - User access token
 * @param newPassword - New password
 * @returns Success status
 */
export async function updatePassword(
  accessToken: string,
  newPassword: string
): Promise<{ success: boolean }> {
  // Validate inputs
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 10) {
    throw new Error('Invalid access token');
  }

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters long');
  }

  try {
    // Get user data from token
    const { data: authData, error: getUserError } = await supabase.auth.getUser(accessToken);

    if (getUserError || !authData.user) {
      logger.error('[AUTH] Invalid token for password update', {
        error: getUserError?.message,
        hasUser: !!authData.user,
      });
      throw new Error('Invalid token');
    }

    const userId = authData.user.id;

    logger.info('[AUTH] Updating password', { userId });

    // Use admin API to update password
    const { error } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { password: newPassword }
    );

    if (error) {
      logger.error('[AUTH] Password update error', {
        userId,
        error: error.message,
        code: error.status,
      });
      throw error;
    }

    logger.info('[AUTH] Password updated successfully', { userId });

    return { success: true };
  } catch (error) {
    logger.error('[AUTH] Password update error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Update user profile
 * @param accessToken - User access token
 * @param name - New user name
 * @returns Updated user data
 */
export async function updateUserProfile(
  accessToken: string,
  name: string
): Promise<any> {
  // Validate inputs
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 10) {
    throw new Error('Invalid access token');
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Name is required and must be non-empty');
  }

  const trimmedName = name.trim();

  try {
    // Verify token first and get user data
    const { data: authData, error: getUserError } = await supabase.auth.getUser(accessToken);

    if (getUserError || !authData.user) {
      logger.error('[AUTH] Invalid token for profile update', {
        error: getUserError?.message,
        hasUser: !!authData.user,
      });
      throw new Error('Invalid token');
    }

    const userId = authData.user.id;
    const userEmail = authData.user.email || '';

    logger.info('[AUTH] Updating user profile', {
      userId,
      name: trimmedName.substring(0, 20), // Log partial name
    });

    // Update user metadata in Supabase Auth using admin API
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      {
        user_metadata: { name: trimmedName }
      }
    );

    if (authError) {
      logger.error('[AUTH] Failed to update user metadata in Auth', {
        error: authError.message,
        code: authError.status,
        userId,
      });
      throw authError;
    }

    // Update user data in public.users table
    // Use upsert to handle case when user doesn't exist yet (avoid race condition)
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: userId,
        email: userEmail,
        name: trimmedName,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'id',
      })
      .select('*')
      .maybeSingle();

    if (dbError) {
      // If unique violation (race condition), fetch existing user
      if (dbError.code === '23505') {
        logger.info('[AUTH] Race condition detected, fetching user', { userId });

        const { data: existingUser, error: fetchError } = await supabaseAdmin
          .from('users')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (fetchError || !existingUser) {
          logger.error('[AUTH] Failed to fetch user after race condition', {
            userId,
            error: fetchError?.message,
          });
          throw new Error('Failed to update user profile in database');
        }

        // Update existing user
        const { data: updatedUser, error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            name: trimmedName,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId)
          .select('*')
          .maybeSingle();

        if (updateError || !updatedUser) {
          logger.error('[AUTH] Failed to update user after race condition', {
            userId,
            error: updateError?.message,
          });
          throw new Error('Failed to update user profile in database');
        }

        logger.info('[AUTH] User profile updated successfully', { userId });

        // Get credits from user_credits table
        const { UserCreditsService } = await import('@/services/core/user-credits.service');
        const userCredits = await UserCreditsService.getUserCredits(userId);
        const creditsBalance = userCredits ? (userCredits.credits_balance || 0) : 0;

        return {
          id: userId,
          email: userEmail,
          name: updatedUser.name,
          role: updatedUser.role || 'user',
          avatar: updatedUser.avatar_url,
          credits: creditsBalance,
          subscription: updatedUser.subscription,
          createdAt: updatedUser.created_at,
          updatedAt: updatedUser.updated_at,
        };
      }

      logger.error('[AUTH] Failed to update user in database', {
        error: dbError.message,
        code: dbError.code,
        userId,
      });
      throw new Error('Failed to update user profile in database');
    }

    if (!userData) {
      logger.error('[AUTH] User profile update returned no data', { userId });
      throw new Error('Failed to update user profile in database');
    }

    logger.info('[AUTH] User profile updated successfully', { userId });

    // Get credits from user_credits table
    const { UserCreditsService } = await import('@/services/core/user-credits.service');
    const userCredits = await UserCreditsService.getUserCredits(userId);
    const creditsBalance = userCredits ? (userCredits.credits_balance || 0) : 0;

    return {
      id: userId,
      email: userEmail,
      name: userData.name || trimmedName,
      role: userData.role || 'user',
      avatar: userData.avatar_url,
      credits: creditsBalance,
      subscription: userData.subscription,
      createdAt: userData.created_at,
      updatedAt: userData.updated_at,
    };
  } catch (error) {
    logger.error('[AUTH] Update user profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Verify email with token
 * @param token - Email verification token
 * @param type - Token type (signup, recovery, etc.)
 * @returns Auth tokens
 */
export async function verifyEmail(
  token: string,
  type: 'signup' | 'recovery' | 'invite' | 'magiclink' = 'signup'
): Promise<AuthTokens> {
  // Validate inputs
  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new Error('Invalid verification token');
  }

  const validTypes = ['signup', 'recovery', 'invite', 'magiclink'];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid token type: ${type}. Must be one of: ${validTypes.join(', ')}`);
  }

  try {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type,
    });

    if (error) {
      logger.error('[AUTH] Email verification error', {
        error: error.message,
        code: error.status,
        type,
      });
      throw error;
    }

    if (!data.session) {
      logger.error('[AUTH] Email verification failed: no session returned', {
        userId: data.user?.id,
        type,
      });
      throw new Error('No session returned');
    }

    logger.info('[AUTH] Email verified', {
      userId: data.user?.id,
      type,
    });

    warnIfUnexpectedJwtExpiry(data.session.expires_in);

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: normalizeExpiresIn(data.session.expires_in),
    };
  } catch (error) {
    logger.error('[AUTH] Email verification error', {
      error: error instanceof Error ? error.message : String(error),
      type,
    });
    throw error;
  }
}
