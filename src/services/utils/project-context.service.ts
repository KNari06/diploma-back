import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { Credentials, CredentialsParserService } from '../api/credentials-parser.service';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TESTED_PAGES = 100;
const MAX_PROJECT_NAME_LENGTH = 50;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project Settings interface
 */
export interface ProjectSettings {
  main_url?: string;
  tested_pages?: string[];
  common_elements?: Record<string, string>;
  common_scope?: string;
  last_test_at?: string;
  preferences?: {
    auto_approve?: boolean;
    scope_default?: string;
  };
  created_from_chat?: boolean;
}

/**
 * Project Context Service
 * Manages projects within workspaces
 * Handles project discovery, creation, settings, and credentials
 *
 * FIXES APPLIED:
 * - Issue #1: Race condition prevention with upsert
 * - Issue #2: Input validation for all parameters
 * - Issue #3: Optimized DB queries
 * - Issue #4: Data loss prevention
 * - Issue #5: Ownership verification
 * - Issue #6: Safe credentials handling
 * - Issue #7: Duplicate prevention
 * - Issue #8: URL validation
 * - Issue #9: Better name generation
 */
export class ProjectContextService {

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION HELPERS (FIX #2)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Validate UUID format
   */
  private static isValidUUID(str: string): boolean {
    return typeof str === 'string' && UUID_REGEX.test(str);
  }

  /**
   * Validate URL format and normalize it
   * Automatically adds https:// if protocol is missing
   */
  private static isValidUrl(url: string): boolean {
    if (typeof url !== 'string' || url.trim().length === 0) {
      return false;
    }

    const trimmedUrl = url.trim();

    try {
      // If URL doesn't have protocol, try adding https://
      if (!trimmedUrl.includes('://')) {
        new URL(`https://${trimmedUrl}`);
        return true;
      }

      // If URL has protocol, validate as-is
      new URL(trimmedUrl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Normalize URL by adding protocol if missing
   */
  private static normalizeUrl(url: string): string {
    if (typeof url !== 'string' || url.trim().length === 0) {
      return url;
    }

    const trimmedUrl = url.trim();

    // If URL doesn't have protocol, add https://
    if (!trimmedUrl.includes('://')) {
      return `https://${trimmedUrl}`;
    }

    return trimmedUrl;
  }

  /**
   * Verify project ownership (FIX #5)
   */
  private static async verifyProjectOwnership(
    projectId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const { data } = await supabaseAdmin
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .eq('user_id', userId)
        .maybeSingle();

      return !!data;
    } catch (error) {
      logger.error('[PROJECT] Error verifying ownership', { error, projectId, userId });
      return false;
    }
  }
  /**
   * Find or create project by URL within workspace
   * Projects are identified by base URL (origin)
   * FIX #1: Race condition prevention with validation
   * FIX #2: Input validation
   */
  static async findOrCreateProject(
    workspaceId: string,
    url: string,
    userId: string
  ): Promise<{
    project_id: string;
    is_new: boolean;
    settings: ProjectSettings;
  }> {
    try {
      // FIX #2: Validate inputs
      if (!this.isValidUUID(workspaceId)) {
        throw new Error(`Invalid workspaceId format: ${workspaceId}`);
      }
      if (!this.isValidUUID(userId)) {
        throw new Error(`Invalid userId format: ${userId}`);
      }
      if (!this.isValidUrl(url)) {
        throw new Error(`Invalid URL format: ${url}`);
      }

      // Normalize URL (add https:// if missing)
      const normalizedUrl = this.normalizeUrl(url);

      logger.info('[PROJECT] Finding or creating project', {
        workspaceId,
        url: normalizedUrl.substring(0, 100), // Truncate for logging
        originalUrl: url.substring(0, 100),
        userId,
      });

      // 1. Extract and validate base URL
      const baseUrl = this.extractBaseUrl(normalizedUrl);
      logger.info('[PROJECT] Extracted base URL', { baseUrl, originalUrl: url.substring(0, 100) });

      // 2. Try to find existing project first (optimized query)
      const existing = await this.findProjectByUrl(workspaceId, userId, baseUrl);

      if (existing) {
        logger.info('[PROJECT] Found existing project', {
          project_id: existing.id,
          name: existing.name,
        });

        return {
          project_id: existing.id,
          is_new: false,
          settings: existing.settings || {},
        };
      }

      // 3. FIX #1: Use upsert to prevent race conditions
      logger.info('[PROJECT] Creating new project with race condition protection', { baseUrl });

      const projectName = this.generateProjectName(baseUrl);
      const projectSettings = {
        main_url: baseUrl,
        tested_pages: [],
        common_elements: {},
        created_from_chat: true,
        created_at: new Date().toISOString(),
      };

      // First attempt: try to insert
      const { data: newProject, error: insertError } = await supabaseAdmin
        .from('projects')
        .insert({
          name: projectName,
          description: `Auto-generated from chat for ${baseUrl}`,
          user_id: userId,
          workspace_id: workspaceId,
          settings: projectSettings,
        })
        .select('id, name, settings')
        .maybeSingle();

      if (!insertError && newProject) {
        logger.info('[PROJECT] Created new project successfully', {
          project_id: newProject.id,
          name: newProject.name,
        });

        return {
          project_id: newProject.id,
          is_new: true,
          settings: newProject.settings || {},
        };
      }

      // If insert failed (likely due to race condition), try to find again
      if (insertError) {
        logger.warn('[PROJECT] Insert failed, checking for race condition', {
          error: insertError,
          baseUrl
        });

        const raceCheck = await this.findProjectByUrl(workspaceId, userId, baseUrl);
        if (raceCheck) {
          logger.info('[PROJECT] Found project after race condition', {
            project_id: raceCheck.id,
            name: raceCheck.name,
          });

          return {
            project_id: raceCheck.id,
            is_new: false,
            settings: raceCheck.settings || {},
          };
        }

        // If still not found, re-throw the original error
        logger.error('[PROJECT] Failed to create project and no race condition detected', {
          error: insertError,
          baseUrl
        });
        throw insertError;
      }

      // Should not reach here
      throw new Error('Unexpected state in findOrCreateProject');
    } catch (error) {
      logger.error('[PROJECT] Failed to find/create project', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        url: url.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Find project by URL in workspace
   * FIX #3: Optimized with DB filtering instead of memory filtering
   */
  private static async findProjectByUrl(
    workspaceId: string,
    userId: string,
    baseUrl: string
  ): Promise<{ id: string; name: string; settings: ProjectSettings } | null> {
    try {
      // FIX #3: Filter in database using JSONB query (much more efficient)
      // Note: This requires a JSONB index on settings->>main_url for optimal performance
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, name, settings')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('settings->>main_url', baseUrl) // ← Filter in DB, not memory!
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error searching projects by URL', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          baseUrl,
          workspaceId,
          userId,
        });
        return null;
      }

      if (data) {
        logger.debug('[PROJECT] Found project by URL in database', {
          projectId: data.id,
          baseUrl,
        });
      }

      return data || null;
    } catch (error) {
      logger.error('[PROJECT] Error finding project by URL', {
        error: error instanceof Error ? error.message : String(error),
        baseUrl,
        workspaceId,
        userId,
      });
      return null;
    }
  }

  /**
   * Get project settings
   * FIX #2: Input validation
   */
  static async getProjectSettings(
    projectId: string
  ): Promise<ProjectSettings | null> {
    try {
      // FIX #2: Validate input
      if (!this.isValidUUID(projectId)) {
        throw new Error(`Invalid projectId format: ${projectId}`);
      }

      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('settings')
        .eq('id', projectId)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting settings', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          projectId,
        });
        return null;
      }

      return data?.settings || null;
    } catch (error) {
      logger.error('[PROJECT] Failed to get settings', {
        error: error instanceof Error ? error.message : String(error),
        projectId
      });
      return null;
    }
  }

  /**
   * Update project settings
   * Merges with existing settings
   * FIX #4: Prevent data loss by validating current settings exist
   * FIX #2: Input validation
   */
  static async updateProjectSettings(
    projectId: string,
    settingsUpdate: Partial<ProjectSettings>
  ): Promise<boolean> {
    try {
      // FIX #2: Validate inputs
      if (!this.isValidUUID(projectId)) {
        throw new Error(`Invalid projectId format: ${projectId}`);
      }
      if (!settingsUpdate || typeof settingsUpdate !== 'object') {
        throw new Error('Invalid settingsUpdate: must be an object');
      }

      logger.info('[PROJECT] Updating settings', {
        projectId,
        updateKeys: Object.keys(settingsUpdate)
      });

      // FIX #4: Get current settings and validate they exist
      const current = await this.getProjectSettings(projectId);
      if (current === null) {
        logger.error('[PROJECT] Cannot update settings: project not found or settings retrieval failed', {
          projectId
        });
        return false; // ← Fail fast instead of losing data
      }

      const merged = {
        ...current, // ← Safe because we validated current is not null
        ...settingsUpdate,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabaseAdmin
        .from('projects')
        .update({ settings: merged })
        .eq('id', projectId);

      if (error) {
        logger.error('[PROJECT] Error updating settings', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          projectId,
        });
        return false;
      }

      logger.info('[PROJECT] Settings updated successfully', {
        projectId,
        mergedKeys: Object.keys(merged),
      });
      return true;
    } catch (error) {
      logger.error('[PROJECT] Failed to update settings', {
        error: error instanceof Error ? error.message : String(error),
        projectId
      });
      return false;
    }
  }

  /**
   * Get saved credentials for project
   * FIX #5: Ownership verification
   * FIX #6: Safe credentials decryption
   * FIX #2: Input validation
   */
  static async getProjectCredentials(
    projectId: string,
    userId: string
  ): Promise<Credentials | null> {
    try {
      // FIX #2: Validate inputs
      if (!this.isValidUUID(projectId)) {
        throw new Error(`Invalid projectId format: ${projectId}`);
      }
      if (!this.isValidUUID(userId)) {
        throw new Error(`Invalid userId format: ${userId}`);
      }

      logger.info('[PROJECT] Getting credentials', { projectId, userId });

      // FIX #5: Verify ownership before accessing credentials
      const hasAccess = await this.verifyProjectOwnership(projectId, userId);
      if (!hasAccess) {
        logger.warn('[PROJECT] Access denied: user does not own project', {
          projectId,
          userId,
        });
        return null; // Don't throw error, just return null for security
      }

      const { data, error } = await supabaseAdmin
        .from('test_credentials')
        .select('email_encrypted, username_encrypted, password_encrypted, label, created_at')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting credentials', {
          error: error instanceof Error ? error.message : String(error),
          projectId,
        });
        return null;
      }

      if (!data) {
        logger.info('[PROJECT] No credentials found', { projectId });
        return null;
      }

      // FIX #6: Safe credentials decryption with validation
      try {
        // Validate encrypted data exists (check for null/undefined)
        if ((!data.email_encrypted || data.email_encrypted.trim().length === 0) &&
            (!data.username_encrypted || data.username_encrypted.trim().length === 0)) {
          logger.warn('[PROJECT] No encrypted credentials found', { projectId });
          return null;
        }

        if (!data.password_encrypted || data.password_encrypted.trim().length === 0) {
          logger.warn('[PROJECT] No encrypted password found', { projectId });
          return null;
        }

        const decrypted = CredentialsParserService.decryptCredentials({
          email_encrypted: data.email_encrypted || undefined,
          username_encrypted: data.username_encrypted || undefined,
          password_encrypted: data.password_encrypted,
        });

        // Validate decryption result
        if (!decrypted || typeof decrypted !== 'object') {
          logger.error('[PROJECT] Decryption returned invalid result', { projectId });
          return null;
        }

        // Validate at least one identifier exists and is not empty
        const hasEmail = decrypted.email && decrypted.email.trim().length > 0;
        const hasUsername = decrypted.username && decrypted.username.trim().length > 0;
        if (!hasEmail && !hasUsername) {
          logger.error('[PROJECT] Decrypted credentials missing identifier', { projectId });
          return null;
        }

        // Validate password exists and is not empty
        if (!decrypted.password || decrypted.password.trim().length === 0) {
          logger.error('[PROJECT] Decrypted credentials missing password', { projectId });
          return null;
        }

        logger.info('[PROJECT] Credentials retrieved and decrypted successfully', {
          projectId,
          hasEmail: !!decrypted.email,
          hasUsername: !!decrypted.username,
          label: data.label,
        });

        return decrypted;
      } catch (decryptError) {
        logger.error('[PROJECT] Decryption failed', {
          error: decryptError instanceof Error ? decryptError.message : String(decryptError),
          projectId,
        });
        return null;
      }
    } catch (error) {
      logger.error('[PROJECT] Failed to get credentials', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        userId,
      });
      return null;
    }
  }

  /**
   * Save credentials for project
   * FIX #5: Ownership verification
   * FIX #2: Input validation
   */
  static async saveProjectCredentials(
    projectId: string,
    userId: string,
    credentials: Credentials,
    label?: string
  ): Promise<boolean> {
    try {
      // FIX #2: Validate inputs
      if (!this.isValidUUID(projectId)) {
        throw new Error(`Invalid projectId format: ${projectId}`);
      }
      if (!this.isValidUUID(userId)) {
        throw new Error(`Invalid userId format: ${userId}`);
      }
      if (!credentials || typeof credentials !== 'object') {
        throw new Error('Invalid credentials: must be an object');
      }
      if (!credentials.password || typeof credentials.password !== 'string') {
        throw new Error('Invalid credentials: password is required');
      }
      if (!credentials.email && !credentials.username) {
        throw new Error('Invalid credentials: email or username is required');
      }

      logger.info('[PROJECT] Saving credentials', {
        projectId,
        userId,
        hasEmail: !!credentials.email,
        hasUsername: !!credentials.username,
        label: label || 'Test credentials',
      });

      // FIX #5: Verify ownership before saving credentials
      const hasAccess = await this.verifyProjectOwnership(projectId, userId);
      if (!hasAccess) {
        logger.warn('[PROJECT] Access denied: user does not own project', {
          projectId,
          userId,
        });
        throw new Error('Access denied: insufficient permissions');
      }

      // Encrypt credentials with error handling
      let encrypted;
      try {
        encrypted = CredentialsParserService.encryptCredentials(credentials);
        if (!encrypted || typeof encrypted !== 'object') {
          throw new Error('Encryption returned invalid result');
        }
      } catch (encryptError) {
        logger.error('[PROJECT] Encryption failed', {
          error: encryptError instanceof Error ? encryptError.message : String(encryptError),
          projectId,
        });
        return false;
      }

      // Check if credentials already exist
      const { data: existing } = await supabaseAdmin
        .from('test_credentials')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .maybeSingle();

      const credentialData = {
        ...encrypted,
        label: label || 'Test credentials',
        updated_at: new Date().toISOString(),
      };

      if (existing) {
        // Update existing
        const { error } = await supabaseAdmin
          .from('test_credentials')
          .update(credentialData)
          .eq('id', existing.id);

        if (error) {
          logger.error('[PROJECT] Error updating credentials', {
            error: error instanceof Error ? error.message : String(error),
            projectId,
          });
          return false;
        }

        logger.info('[PROJECT] Credentials updated successfully', { projectId });
      } else {
        // Insert new
        const { error } = await supabaseAdmin
          .from('test_credentials')
          .insert({
            project_id: projectId,
            user_id: userId,
            ...credentialData,
          });

        if (error) {
          logger.error('[PROJECT] Error inserting credentials', {
            error: error instanceof Error ? error.message : String(error),
            projectId,
          });
          return false;
        }

        logger.info('[PROJECT] Credentials saved successfully', { projectId });
      }

      return true;
    } catch (error) {
      logger.error('[PROJECT] Failed to save credentials', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        userId,
      });
      return false;
    }
  }

  /**
   * Add tested page to project settings
   * FIX #7: Prevent duplicates and limit size
   * FIX #2: Input validation
   */
  static async addTestedPage(
    projectId: string,
    pagePath: string
  ): Promise<boolean> {
    try {
      // FIX #2: Validate inputs
      if (!this.isValidUUID(projectId)) {
        throw new Error(`Invalid projectId format: ${projectId}`);
      }
      if (!pagePath || typeof pagePath !== 'string') {
        throw new Error('Invalid pagePath: must be a non-empty string');
      }

      // Normalize page path
      const normalizedPath = pagePath.trim();
      if (normalizedPath.length === 0) {
        throw new Error('Invalid pagePath: cannot be empty');
      }

      const settings = await this.getProjectSettings(projectId);
      if (!settings) {
        logger.error('[PROJECT] Cannot add tested page: project settings not found', { projectId });
        return false;
      }

      // FIX #7: Use Set to prevent duplicates and limit size
      const currentPages = settings.tested_pages || [];
      const pagesSet = new Set(currentPages);

      // Add new page
      pagesSet.add(normalizedPath);

      // Convert back to array and limit size (keep most recent)
      const updatedPages = Array.from(pagesSet).slice(-MAX_TESTED_PAGES);

      // Only update if there's actually a change
      if (updatedPages.length === currentPages.length &&
          updatedPages.every(page => currentPages.includes(page))) {
        logger.debug('[PROJECT] Page already exists in tested pages', {
          projectId,
          pagePath: normalizedPath
        });
        return true; // No change needed
      }

      logger.info('[PROJECT] Adding tested page', {
        projectId,
        pagePath: normalizedPath,
        totalPages: updatedPages.length,
        maxPages: MAX_TESTED_PAGES,
      });

      return await this.updateProjectSettings(projectId, {
        tested_pages: updatedPages,
        last_test_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[PROJECT] Failed to add tested page', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        pagePath,
      });
      return false;
    }
  }

  /**
   * Extract base URL (origin) from full URL
   * FIX #8: Validate return value and handle edge cases
   */
  private static extractBaseUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.origin; // e.g., "https://example.com"
    } catch (error) {
      // If URL parsing fails, try to extract manually
      const match = url.match(/^(https?:\/\/[^/\s]+)/);
      if (match) {
        const extracted = match[1];

        // Validate extracted URL by trying to parse it
        try {
          new URL(extracted);
          return extracted;
        } catch {
          // If extracted URL is still invalid, don't return it
          logger.error('[PROJECT] Extracted URL is invalid', {
            url: url.substring(0, 100),
            extracted
          });
        }
      }

      // FIX #8: Don't return invalid URLs - throw error instead
      logger.error('[PROJECT] Cannot extract valid base URL', {
        url: url.substring(0, 100)
      });
      throw new Error(`Invalid URL format: cannot extract base URL from "${url.substring(0, 50)}"`);
    }
  }

  /**
   * Generate project name from base URL
   * FIX #9: Handle edge cases (empty hostname, IPs, special chars)
   */
  private static generateProjectName(baseUrl: string): string {
    try {
      const parsed = new URL(baseUrl);
      let hostname = parsed.hostname.replace('www.', '');

      if (!hostname || hostname.length === 0) {
        return this.createFallbackProjectName(baseUrl);
      }

      // FIX #9: Handle IP addresses
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        return `Project ${hostname}`;
      }

      // Handle IPv6 addresses
      if (hostname.includes(':') && hostname.includes('[')) {
        return `Project ${hostname.replace(/[\[\]]/g, '')}`;
      }

      // Sanitize hostname (remove special chars, keep alphanumeric and dots/hyphens)
      const sanitized = hostname.replace(/[^a-zA-Z0-9.-]/g, '');
      if (sanitized.length === 0) {
        return this.createFallbackProjectName(baseUrl);
      }

      // Capitalize first letter and limit length
      const capitalized = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
      return capitalized.length > MAX_PROJECT_NAME_LENGTH
        ? capitalized.substring(0, MAX_PROJECT_NAME_LENGTH) + '...'
        : capitalized;
    } catch {
      return this.createFallbackProjectName(baseUrl);
    }
  }

  /**
   * Create fallback project name when hostname extraction fails
   */
  private static createFallbackProjectName(baseUrl: string): string {
    // Sanitize the URL for use in project name
    const sanitized = baseUrl
      .replace(/^https?:\/\//, '') // Remove protocol
      .replace(/[^a-zA-Z0-9.-]/g, '') // Remove special chars
      .slice(0, 30); // Limit length

    return sanitized.length > 0
      ? `Project ${sanitized}`
      : `Project ${Date.now()}`; // Ultimate fallback
  }

  /**
   * Get default project in workspace (if any)
   * FIX #2: Input validation
   */
  static async getDefaultProject(
    workspaceId: string,
    userId: string
  ): Promise<{ id: string; name: string; settings: ProjectSettings } | null> {
    try {
      // FIX #2: Validate inputs
      if (!this.isValidUUID(workspaceId)) {
        throw new Error(`Invalid workspaceId format: ${workspaceId}`);
      }
      if (!this.isValidUUID(userId)) {
        throw new Error(`Invalid userId format: ${userId}`);
      }

      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, name, settings')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting default project', {
          error: error instanceof Error ? error.message : String(error),
          workspaceId,
          userId,
        });
        return null;
      }

      return data || null;
    } catch (error) {
      logger.error('[PROJECT] Failed to get default project', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        userId,
      });
      return null;
    }
  }
}
