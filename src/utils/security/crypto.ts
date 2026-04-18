/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Symmetric encryption helper — AES-256-GCM with env-derived key.
 *
 * Used for anything stored at rest that must be recoverable server-side:
 *   - test_credentials (email/username/password) — credentials-manager.service
 *   - test_resources.sensitive envelope fields   — test-resource.service
 *     (e.g. auth.storageState, auth.totpSecret, secret.* api keys)
 *
 * Output format: "iv:authTag:ciphertext" (hex-encoded, colon-separated).
 * AES-GCM provides authenticated encryption — tampering with the payload
 * causes decrypt() to throw instead of silently returning garbage.
 *
 * Key derivation uses scrypt(ENCRYPTION_SECRET, 'salt', 32). The static
 * salt is intentional (we don't store per-record salts — that would
 * require a second column for every encrypted field). ENCRYPTION_SECRET
 * itself must be high-entropy in production; rotation = re-encrypt all
 * stored values offline.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

function getEncryptionKey(): Buffer {
  const secret = env.ENCRYPTION_SECRET || 'default-secret-change-in-production';
  return scryptSync(secret, 'salt', 32);
}

/**
 * Encrypt plaintext. Returns "iv:authTag:ciphertext" (hex).
 * Never use for non-recoverable data (use hash instead).
 */
export function encryptString(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a value produced by encryptString. Throws on any failure
 * (tampering, wrong key, malformed input) so callers can't accidentally
 * use garbage.
 */
export function decryptString(encryptedText: string): string {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format (expected iv:authTag:ciphertext)');
    }
    const [ivHex, authTagHex, ciphertext] = parts;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    logger.error('Decryption failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Failed to decrypt');
  }
}

/**
 * Convenience: encrypt any JSON-serializable value. Pair with decryptJSON.
 */
export function encryptJSON<T>(value: T): string {
  return encryptString(JSON.stringify(value));
}

export function decryptJSON<T>(encryptedText: string): T {
  return JSON.parse(decryptString(encryptedText)) as T;
}
