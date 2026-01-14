import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';

/**
 * Credentials interface
 * Supports email, username, phone, and password
 */
export interface Credentials {
  email?: string;
  username?: string;
  phone?: string;
  password: string;
}

/**
 * Credentials Parser Service
 * Parses credentials from any format (JSON, text, natural language)
 * Handles encryption/decryption
 */
export class CredentialsParserService {
  // Encryption settings
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly SALT_LENGTH = 64;
  private static readonly TAG_LENGTH = 16;

  /**
   * Parse credentials from any format
   * Supports:
   * - JSON: {"email":"test@test.com","password":"123"}
   * - Key-value: "email: test@test.com, password: 123"
   * - Slash: "test@test.com / 123"
   * - Space: "test@test.com 123456"
   */
  static parseNaturalCredentials(text: string): Credentials {
    try {
      logger.info('[CREDENTIALS] Parsing credentials from text');

      // Clean input
      const cleaned = text.trim();

      // Attempt 1: JSON format
      try {
        const json = JSON.parse(cleaned);
        if (json.password) {
          logger.info('[CREDENTIALS] Parsed as JSON');
          return {
            email: json.email,
            username: json.username,
            password: json.password,
          };
        }
      } catch {
        // Not JSON, continue
      }

      // Attempt 2: Key-value format (email: test@test.com, password: 123)
      const kvResult = this.parseKeyValueFormat(cleaned);
      if (kvResult) {
        logger.info('[CREDENTIALS] Parsed as key-value format');
        return kvResult;
      }

      // Attempt 3: Slash or pipe separator (test@test.com / 123 or test@test.com | 123)
      const slashResult = this.parseSlashFormat(cleaned);
      if (slashResult) {
        logger.info('[CREDENTIALS] Parsed as slash/pipe format');
        return slashResult;
      }

      // Attempt 4: Space separator (test@test.com 123456)
      const spaceResult = this.parseSpaceFormat(cleaned);
      if (spaceResult) {
        logger.info('[CREDENTIALS] Parsed as space format');
        return spaceResult;
      }

      // Attempt 5: Newline separator
      const lineResult = this.parseLineFormat(cleaned);
      if (lineResult) {
        logger.info('[CREDENTIALS] Parsed as line format');
        return lineResult;
      }

      logger.error('[CREDENTIALS] Failed to parse credentials format', {
        textLength: cleaned.length,
      });
      throw new Error('Cannot parse credentials format. Please provide in format: email / password or {"email":"...","password":"..."}');
    } catch (error) {
      logger.error('[CREDENTIALS] Error parsing credentials', { error });
      throw error;
    }
  }

  /**
   * Check if a string looks like a phone number
   * Supports formats: +7..., 8..., (XXX), etc.
   */
  private static looksLikePhone(value: string): boolean {
    // Starts with + or contains mostly digits (at least 7 digits)
    const digitsOnly = value.replace(/[\s\-()]/g, '');
    const digitCount = (digitsOnly.match(/\d/g) || []).length;
    return (
      (value.startsWith('+') && digitCount >= 7) ||
      (digitCount >= 7 && digitCount <= 15 && /^[\d\s\-()+]+$/.test(value))
    );
  }

  /**
   * Parse key-value format: "email: test@test.com, password: 123"
   * Now also supports phone: "+7..."
   */
  private static parseKeyValueFormat(text: string): Credentials | null {
    const patterns = {
      email: /email[:\s]+([^\s,;]+)/i,
      username: /username[:\s]+([^\s,;]+)/i,
      phone: /(?:phone|tel|mobile|телефон|номер)[:\s]+([^\s,;]+)/i,
      password: /password[:\s]+([^\s,;]+)/i,
    };

    const result: Partial<Credentials> = {};

    for (const [key, regex] of Object.entries(patterns)) {
      const match = text.match(regex);
      if (match) {
        result[key as keyof Credentials] = match[1];
      }
    }

    // Must have password
    if (result.password) {
      return result as Credentials;
    }

    return null;
  }

  /**
   * Parse slash/pipe format: "test@test.com / 123" or "username | pass" or "+7... / pass"
   */
  private static parseSlashFormat(text: string): Credentials | null {
    const match = text.match(/([^\s/|]+)[\s]*[/|][\s]*([^\s]+)/);
    if (match) {
      const firstPart = match[1].trim();
      const secondPart = match[2].trim();

      // Check if first part is email
      if (firstPart.includes('@')) {
        return {
          email: firstPart,
          password: secondPart,
        };
      }

      // Check if first part is phone
      if (this.looksLikePhone(firstPart)) {
        return {
          phone: firstPart,
          password: secondPart,
        };
      }

      // Otherwise, treat as username
      return {
        username: firstPart,
        password: secondPart,
      };
    }

    return null;
  }

  /**
   * Parse space format: "test@test.com 123456" or "+7... 123456"
   */
  private static parseSpaceFormat(text: string): Credentials | null {
    const parts = text.split(/\s+/).filter(p => p.length > 0);

    // Need exactly 2 parts
    if (parts.length !== 2) {
      return null;
    }

    const [firstPart, secondPart] = parts;

    // Check if first part looks like email
    if (firstPart.includes('@')) {
      return {
        email: firstPart,
        password: secondPart,
      };
    }

    // Check if first part looks like phone
    if (this.looksLikePhone(firstPart)) {
      return {
        phone: firstPart,
        password: secondPart,
      };
    }

    return {
      username: firstPart,
      password: secondPart,
    };
  }

  /**
   * Parse line format (each on separate line)
   */
  private static parseLineFormat(text: string): Credentials | null {
    const lines = text.split(/[\r\n]+/).filter(l => l.trim().length > 0);

    if (lines.length === 2) {
      const [firstLine, secondLine] = lines.map(l => l.trim());

      if (firstLine.includes('@')) {
        return {
          email: firstLine,
          password: secondLine,
        };
      }

      if (this.looksLikePhone(firstLine)) {
        return {
          phone: firstLine,
          password: secondLine,
        };
      }

      return {
        username: firstLine,
        password: secondLine,
      };
    }

    return null;
  }

  /**
   * Encrypt credentials for storage
   */
  static encryptCredentials(credentials: Credentials): {
    email_encrypted?: string;
    username_encrypted?: string;
    phone_encrypted?: string;
    password_encrypted: string;
  } {
    try {
      const result: any = {};

      if (credentials.email) {
        result.email_encrypted = this.encrypt(credentials.email);
      }

      if (credentials.username) {
        result.username_encrypted = this.encrypt(credentials.username);
      }

      if (credentials.phone) {
        result.phone_encrypted = this.encrypt(credentials.phone);
      }

      result.password_encrypted = this.encrypt(credentials.password);

      return result;
    } catch (error) {
      logger.error('[CREDENTIALS] Error encrypting credentials', { error });
      throw new Error('Failed to encrypt credentials');
    }
  }

  /**
   * Decrypt credentials from storage
   */
  static decryptCredentials(encrypted: {
    email_encrypted?: string;
    username_encrypted?: string;
    phone_encrypted?: string;
    password_encrypted: string;
  }): Credentials {
    try {
      const result: Credentials = {
        password: this.decrypt(encrypted.password_encrypted),
      };

      if (encrypted.email_encrypted) {
        result.email = this.decrypt(encrypted.email_encrypted);
      }

      if (encrypted.username_encrypted) {
        result.username = this.decrypt(encrypted.username_encrypted);
      }

      if (encrypted.phone_encrypted) {
        result.phone = this.decrypt(encrypted.phone_encrypted);
      }

      return result;
    } catch (error) {
      logger.error('[CREDENTIALS] Error decrypting credentials', { error });
      throw new Error('Failed to decrypt credentials');
    }
  }

  /**
   * Encrypt a single string
   */
  private static encrypt(text: string): string {
    try {
      const iv = crypto.randomBytes(this.IV_LENGTH);
      const salt = crypto.randomBytes(this.SALT_LENGTH);

      const key = crypto.pbkdf2Sync(
        env.ENCRYPTION_SECRET,
        salt,
        100000,
        this.KEY_LENGTH,
        'sha512'
      );

      const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

      const encrypted = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);

      const tag = cipher.getAuthTag();

      // Combine: salt + iv + tag + encrypted
      const result = Buffer.concat([salt, iv, tag, encrypted]);

      return result.toString('base64');
    } catch (error) {
      logger.error('[CREDENTIALS] Encryption error', { error });
      throw error;
    }
  }

  /**
   * Decrypt a single string
   */
  private static decrypt(encryptedText: string): string {
    try {
      const buffer = Buffer.from(encryptedText, 'base64');

      const salt = buffer.subarray(0, this.SALT_LENGTH);
      const iv = buffer.subarray(this.SALT_LENGTH, this.SALT_LENGTH + this.IV_LENGTH);
      const tag = buffer.subarray(
        this.SALT_LENGTH + this.IV_LENGTH,
        this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH
      );
      const encrypted = buffer.subarray(
        this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH
      );

      const key = crypto.pbkdf2Sync(
        env.ENCRYPTION_SECRET,
        salt,
        100000,
        this.KEY_LENGTH,
        'sha512'
      );

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch (error) {
      logger.error('[CREDENTIALS] Decryption error', { error });
      throw error;
    }
  }
}
