import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { env } from '@/config/env';

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

    logger.info('Storing credentials', {
      userId,
      projectId,
      hasEmail: !!email,
      hasUsername: !!username,
    });

    // Encrypt sensitive data
    const encrypted = {
      email_encrypted: email ? encrypt(email) : null,
      username_encrypted: username ? encrypt(username) : null,
      password_encrypted: encrypt(password),
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

    // Update last_used_at
    await supabaseAdmin
      .from('test_credentials')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', credentialId);

    // Decrypt
    return {
      email: data.email_encrypted ? decrypt(data.email_encrypted) : undefined,
      username: data.username_encrypted ? decrypt(data.username_encrypted) : undefined,
      password: decrypt(data.password_encrypted),
      label: data.label || undefined,
    };
  } catch (error) {
    logger.error('Error retrieving credentials', { error, credentialId });
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
