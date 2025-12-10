import { env } from '@/config/env';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Encryption key derived from environment secret
 */
function getEncryptionKey(): Buffer {
  const secret = env.ENCRYPTION_SECRET || 'default-secret-change-in-production';
  return scryptSync(secret, 'salt', 32);
}

/**
 * Encrypt text using AES-256-GCM
 */
function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Return: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt text
 */
function decrypt(encryptedText: string): string {
  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error('Decryption failed', { error });
    throw new Error('Failed to decrypt credentials');
  }
}

/**
 * Store credentials securely
 */
export async function storeCredentials(params: {
  userId: string;
  projectId: string;
  email?: string;
  username?: string;
  password: string;
  label?: string;
  urlPattern?: string;
  notes?: string;
}): Promise<{ id: string; success: boolean }> {
  try {
    const {
      userId,
      projectId,
      email,
      username,
      password,
      label,
      urlPattern,
      notes,
    } = params;

    // ✅ VALIDATION: Validate required inputs
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('userId is required and must be a non-empty string');
    }

    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('projectId is required and must be a non-empty string');
    }

    if (!password || typeof password !== 'string' || password.trim().length === 0) {
      throw new Error('password is required and must be a non-empty string');
    }

    // ✅ VALIDATION: At least one identifier (email or username) must be provided
    if (!email && !username) {
      throw new Error('Either email or username must be provided');
    }

    // ✅ VALIDATION: Validate email format if provided
    if (email && typeof email === 'string' && email.trim().length > 0) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        throw new Error('Invalid email format');
      }
    }

    logger.info('Storing credentials', {
      userId,
      projectId,
      hasEmail: !!email,
      hasUsername: !!username,
    });

    // Encrypt sensitive data
    const encrypted = {
      email_encrypted: email && email.trim().length > 0 ? encrypt(email.trim()) : null,
      username_encrypted: username && username.trim().length > 0 ? encrypt(username.trim()) : null,
      password_encrypted: encrypt(password.trim()),
    };

    // Insert into database
    const { data, error } = await supabaseAdmin
      .from('test_credentials')
      .insert({
        user_id: userId,
        project_id: projectId,
        ...encrypted,
        label,
        url_pattern: urlPattern,
        notes,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to store credentials', { error });
      throw error;
    }

    logger.info('Credentials stored successfully', { id: data.id });

    return {
      id: data.id,
      success: true,
    };
  } catch (error) {
    logger.error('Error storing credentials', { error });
    throw error;
  }
}

/**
 * Retrieve and decrypt credentials
 */
export async function retrieveCredentials(
  credentialId: string,
  userId: string
): Promise<{
  email?: string;
  username?: string;
  password: string;
  label?: string;
} | null> {
  try {
    // ✅ VALIDATION: Validate inputs
    if (!credentialId || typeof credentialId !== 'string' || credentialId.trim().length === 0) {
      logger.warn('Invalid credentialId', { credentialId });
      return null;
    }

    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      logger.warn('Invalid userId', { userId });
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from('test_credentials')
      .select('*')
      .eq('id', credentialId)
      .eq('user_id', userId) // Security: only owner can retrieve
      .single();

    if (error || !data) {
      logger.warn('Credentials not found', { credentialId, userId });
      return null;
    }

    // ✅ VALIDATION: Check encrypted data exists
    if (!data.password_encrypted || typeof data.password_encrypted !== 'string' || data.password_encrypted.trim().length === 0) {
      logger.error('Invalid password_encrypted in database', { credentialId });
      return null;
    }

    // ✅ VALIDATION: At least one identifier must exist
    if (!data.email_encrypted && !data.username_encrypted) {
      logger.error('No identifier (email or username) found in credentials', { credentialId });
      return null;
    }

    // Update last_used_at (non-blocking, fire-and-forget)
    Promise.resolve(
      supabaseAdmin
        .from('test_credentials')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', credentialId)
    ).catch((updateError: unknown) => {
      logger.warn('Failed to update last_used_at', {
        error: updateError instanceof Error ? updateError.message : String(updateError),
        credentialId,
      });
    });

    // Decrypt with error handling
    try {
      const decrypted = {
        email: data.email_encrypted && data.email_encrypted.trim().length > 0
          ? decrypt(data.email_encrypted)
          : undefined,
        username: data.username_encrypted && data.username_encrypted.trim().length > 0
          ? decrypt(data.username_encrypted)
          : undefined,
        password: decrypt(data.password_encrypted),
        label: data.label || undefined,
      };

      // ✅ VALIDATION: Validate decryption result
      if (!decrypted.password || decrypted.password.trim().length === 0) {
        logger.error('Decrypted password is empty', { credentialId });
        return null;
      }

      // ✅ VALIDATION: At least one identifier must be decrypted successfully
      if (!decrypted.email && !decrypted.username) {
        logger.error('Failed to decrypt identifier (email or username)', { credentialId });
        return null;
      }

      return decrypted;
    } catch (decryptError) {
      logger.error('Decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
        credentialId,
      });
      return null;
    }
  } catch (error) {
    logger.error('Error retrieving credentials', {
      error: error instanceof Error ? error.message : String(error),
      credentialId,
      userId,
    });
    return null;
  }
}

/**
 * List user's credentials (without decrypting)
 */
export async function listCredentials(
  userId: string,
  projectId?: string
): Promise<Array<{
  id: string;
  label?: string;
  urlPattern?: string;
  createdAt: string;
  lastUsedAt?: string;
}>> {
  try {
    let query = supabaseAdmin
      .from('test_credentials')
      .select('id, label, url_pattern, created_at, last_used_at')
      .eq('user_id', userId);

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to list credentials', { error });
      return [];
    }

    return (data || []).map(c => ({
      id: c.id,
      label: c.label || undefined,
      urlPattern: c.url_pattern || undefined,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at || undefined,
    }));
  } catch (error) {
    logger.error('Error listing credentials', { error });
    return [];
  }
}

/**
 * Delete credentials
 */
export async function deleteCredentials(
  credentialId: string,
  userId: string
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('test_credentials')
      .delete()
      .eq('id', credentialId)
      .eq('user_id', userId); // Security check

    if (error) {
      logger.error('Failed to delete credentials', { error });
      return false;
    }

    logger.info('Credentials deleted', { credentialId });
    return true;
  } catch (error) {
    logger.error('Error deleting credentials', { error });
    return false;
  }
}
