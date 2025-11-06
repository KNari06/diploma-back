import { env } from '@/config/env';
import { supabase, supabaseAdmin } from '@/db/supabase';
import { AuthTokens, AuthUser } from '@/types';
import { logger } from '@/utils/logger';

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
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name: name || email.split('@')[0],
        },
      },
    });

    if (error) throw error;
    if (!data.user) {
      throw new Error('Sign up failed: no user returned');
    }

    // Check if email confirmation is required
    if (!data.session && !data.user.email_confirmed_at) {
      logger.info('User signed up, email confirmation required', { userId: data.user.id, email });

      return {
        user: {
          id: data.user.id,
          email: data.user.email!,
          name: data.user.user_metadata?.name,
          role: 'user',
        },
        tokens: {
          access_token: '', // No tokens until email is confirmed
          refresh_token: '',
          expires_in: 0,
        },
      };
    }

    if (!data.session) {
      throw new Error('Sign up failed: no session returned');
    }

    logger.info('User signed up with session', { userId: data.user.id, email, confirmed: !!data.user.email_confirmed_at });

    return {
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata?.name,
        role: 'user',
      },
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in!,
      },
    };
  } catch (error) {
    logger.error('Sign up error', error);
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
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    if (!data.user || !data.session) {
      throw new Error('Sign in failed: no user or session returned');
    }

    logger.info('User signed in', { userId: data.user.id, email });

    return {
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata?.name,
        role: 'user',
      },
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in!,
      },
    };
  } catch (error) {
    logger.error('Sign in error', error);
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
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
      },
    });

    if (error) throw error;

    logger.info('Magic link sent', { email });

    return {
      success: true,
      message: 'Magic link sent to your email',
    };
  } catch (error) {
    logger.error('Magic link error', error);
    throw error;
  }
}

/**
 * Get OAuth URL for provider
 * @param provider - OAuth provider (google, github, etc.)
 * @param redirectTo - Redirect URL after OAuth
 * @returns OAuth URL (Supabase handles state internally)
 */
export async function getOAuthUrl(
  provider: 'google' | 'github' | 'gitlab' | 'bitbucket',
  redirectTo?: string
): Promise<{ url: string }> {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: redirectTo || `${env.FRONTEND_URL}/auth/callback`,
      },
    });

    if (error) throw error;
    if (!data.url) throw new Error('No OAuth URL returned');

    logger.info('OAuth URL generated', { provider });

    return { url: data.url };
  } catch (error) {
    logger.error('OAuth URL generation error', error);
    throw error;
  }
}

/**
 * Sign out user
 * Note: Supabase signOut invalidates all sessions for the user
 * @returns Success status
 */
export async function signOut(): Promise<{ success: boolean }> {
  try {
    const { error } = await supabase.auth.signOut();

    if (error) throw error;

    logger.info('User signed out');

    return { success: true };
  } catch (error) {
    logger.error('Sign out error', error);
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
  try {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) throw error;
    if (!data.session) throw new Error('No session returned');

    logger.info('Token refreshed');

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in!,
    };
  } catch (error) {
    logger.error('Token refresh error', error);
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
      logger.debug('Invalid token format');
      return null;
    }

    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) {
      logger.debug('Token verification failed', { error: error.message });
      return null;
    }

    if (!data.user) return null;

    // Check if user is confirmed (for email verification)
    if (!data.user.email_confirmed_at) {
      logger.debug('User email not confirmed', { userId: data.user.id });
      return null;
    }

    // Get additional user data from public.users
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('role, name')
      .eq('id', data.user.id)
      .maybeSingle();

    return {
      id: data.user.id,
      email: data.user.email!,
      name: userData?.name || data.user.user_metadata?.name,
      role: userData?.role || 'user',
    };
  } catch (error) {
    logger.error('Token verification error', error);
    return null;
  }
}

/**
 * Get current user from token
 * @param accessToken - Access token
 * @returns User data with credits and subscription
 */
export async function getCurrentUser(accessToken: string): Promise<any> {
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) throw error;
    if (!data.user) throw new Error('User not found');

    // Get full user data from public.users
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (dbError) throw dbError;

    // If user not found in public.users, create them (fallback for missing sync)
    if (!userData) {
      logger.warn('User not found in public.users, creating fallback entry', { userId: data.user.id });

      const fallbackUser = {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata?.name || data.user.email!.split('@')[0],
        role: 'user',
        credits: 0,
        subscription: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: createdUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert(fallbackUser)
        .select('*')
        .maybeSingle();

      if (createError) {
        logger.error('Failed to create fallback user', { error: createError, userId: data.user.id });
        throw new Error('User data not found and could not be created. Please try logging in again.');
      }

      return {
        id: data.user.id,
        email: data.user.email,
        name: createdUser?.name,
        role: createdUser?.role,
        credits: createdUser?.credits,
        subscription: createdUser?.subscription,
        created_at: createdUser?.created_at,
      };
    }

    return {
      id: data.user.id,
      email: data.user.email,
      name: userData?.name,
      role: userData?.role,
      credits: userData?.credits,
      subscription: userData?.subscription,
      created_at: userData?.created_at,
    };
  } catch (error) {
    logger.error('Get current user error', error);
    throw error;
  }
}

/**
 * Reset password request
 * @param email - User email
 * @returns Success status
 */
export async function requestPasswordReset(
  email: string,
  redirectTo?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo || `${env.FRONTEND_URL}/auth/reset-password`,
    });

    if (error) throw error;

    logger.info('Password reset requested', { email });

    return {
      success: true,
      message: 'Password reset link sent to your email',
    };
  } catch (error) {
    logger.error('Password reset request error', error);
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
  try {
    // Verify token first
    const user = await verifyToken(accessToken);
    if (!user) throw new Error('Invalid token');

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) throw error;

    logger.info('Password updated', { userId: user.id });

    return { success: true };
  } catch (error) {
    logger.error('Password update error', error);
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
  try {
    // Verify token first
    const user = await verifyToken(accessToken);
    if (!user) throw new Error('Invalid token');

    // Update user metadata in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.updateUser({
      data: { name }
    });

    if (authError) throw authError;

    // Update user data in public.users table
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .update({
        name,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select('*')
      .maybeSingle();

    if (dbError) {
      logger.error('Failed to update user in database', { error: dbError, userId: user.id });
      throw new Error('Failed to update user profile in database');
    }

    // If user not found in public.users, create them
    if (!userData) {
      logger.warn('User not found in public.users, creating entry', { userId: user.id });

      const newUser = {
        id: user.id,
        email: user.email,
        name,
        role: 'user',
        credits: 0,
        subscription: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: createdUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert(newUser)
        .select('*')
        .maybeSingle();

      if (createError) {
        logger.error('Failed to create user in database', { error: createError, userId: user.id });
        throw new Error('Failed to create user profile in database');
      }

      logger.info('User profile updated (created)', { userId: user.id, name });

      return {
        id: user.id,
        email: user.email,
        name: createdUser?.name,
        role: createdUser?.role,
        credits: createdUser?.credits,
        subscription: createdUser?.subscription,
        createdAt: createdUser?.created_at,
        updatedAt: createdUser?.updated_at,
      };
    }

    logger.info('User profile updated', { userId: user.id, name });

    return {
      id: user.id,
      email: user.email,
      name: userData.name,
      role: userData.role,
      credits: userData.credits,
      subscription: userData.subscription,
      createdAt: userData.created_at,
      updatedAt: userData.updated_at,
    };
  } catch (error) {
    logger.error('Update user profile error', error);
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
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type,
    });

    if (error) throw error;
    if (!data.session) throw new Error('No session returned');

    logger.info('Email verified', { userId: data.user?.id });

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in!,
    };
  } catch (error) {
    logger.error('Email verification error', error);
    throw error;
  }
}
