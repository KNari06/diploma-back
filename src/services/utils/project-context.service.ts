import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { CredentialsParserService, Credentials } from '../api/credentials-parser.service';

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
 */
export class ProjectContextService {
  /**
   * Find or create project by URL within workspace
   * Projects are identified by base URL (origin)
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
      logger.info('[PROJECT] Finding or creating project', {
        workspaceId,
        url,
        userId,
      });

      // 1. Extract base URL (origin only, without path/query)
      const baseUrl = this.extractBaseUrl(url);
      logger.info('[PROJECT] Extracted base URL', { baseUrl, originalUrl: url });

      // 2. Search for existing project with this URL
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

      // 3. Create new project
      logger.info('[PROJECT] Creating new project', { baseUrl });

      const projectName = this.generateProjectName(baseUrl);

      const { data: newProject, error } = await supabaseAdmin
        .from('projects')
        .insert({
          name: projectName,
          description: `Auto-generated from chat for ${baseUrl}`,
          user_id: userId,
          workspace_id: workspaceId,
          settings: {
            main_url: baseUrl,
            tested_pages: [],
            common_elements: {},
            created_from_chat: true,
            created_at: new Date().toISOString(),
          },
        })
        .select('id, name, settings')
        .single();

      if (error) {
        logger.error('[PROJECT] Error creating project', { error, baseUrl });
        throw error;
      }

      logger.info('[PROJECT] Created new project', {
        project_id: newProject.id,
        name: newProject.name,
      });

      return {
        project_id: newProject.id,
        is_new: true,
        settings: newProject.settings || {},
      };
    } catch (error) {
      logger.error('[PROJECT] Failed to find/create project', {
        error,
        workspaceId,
        url,
      });
      throw error;
    }
  }

  /**
   * Find project by URL in workspace
   */
  private static async findProjectByUrl(
    workspaceId: string,
    userId: string,
    baseUrl: string
  ): Promise<{ id: string; name: string; settings: ProjectSettings } | null> {
    try {
      // Get all projects in workspace
      const { data: projects, error } = await supabaseAdmin
        .from('projects')
        .select('id, name, settings')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId);

      if (error) {
        logger.error('[PROJECT] Error searching projects', { error });
        return null;
      }

      if (!projects || projects.length === 0) {
        return null;
      }

      // Find project with matching main_url
      const match = projects.find(
        p => p.settings?.main_url === baseUrl
      );

      return match || null;
    } catch (error) {
      logger.error('[PROJECT] Error finding project by URL', { error, baseUrl });
      return null;
    }
  }

  /**
   * Get project settings
   */
  static async getProjectSettings(
    projectId: string
  ): Promise<ProjectSettings | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('settings')
        .eq('id', projectId)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting settings', { error, projectId });
        return null;
      }

      return data?.settings || null;
    } catch (error) {
      logger.error('[PROJECT] Failed to get settings', { error, projectId });
      return null;
    }
  }

  /**
   * Update project settings
   * Merges with existing settings
   */
  static async updateProjectSettings(
    projectId: string,
    settingsUpdate: Partial<ProjectSettings>
  ): Promise<boolean> {
    try {
      logger.info('[PROJECT] Updating settings', { projectId, settingsUpdate });

      // Get current settings
      const current = await this.getProjectSettings(projectId);
      const merged = {
        ...(current || {}),
        ...settingsUpdate,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabaseAdmin
        .from('projects')
        .update({ settings: merged })
        .eq('id', projectId);

      if (error) {
        logger.error('[PROJECT] Error updating settings', { error, projectId });
        return false;
      }

      logger.info('[PROJECT] Settings updated successfully', { projectId });
      return true;
    } catch (error) {
      logger.error('[PROJECT] Failed to update settings', { error, projectId });
      return false;
    }
  }

  /**
   * Get saved credentials for project
   */
  static async getProjectCredentials(
    projectId: string,
    userId: string
  ): Promise<Credentials | null> {
    try {
      logger.info('[PROJECT] Getting credentials', { projectId, userId });

      const { data, error } = await supabaseAdmin
        .from('test_credentials')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting credentials', {
          error,
          projectId,
        });
        return null;
      }

      if (!data) {
        logger.info('[PROJECT] No credentials found', { projectId });
        return null;
      }

      // Decrypt credentials
      const decrypted = CredentialsParserService.decryptCredentials({
        email_encrypted: data.email_encrypted,
        username_encrypted: data.username_encrypted,
        password_encrypted: data.password_encrypted,
      });

      logger.info('[PROJECT] Credentials retrieved and decrypted', {
        projectId,
        hasEmail: !!decrypted.email,
        hasUsername: !!decrypted.username,
      });

      return decrypted;
    } catch (error) {
      logger.error('[PROJECT] Failed to get credentials', {
        error,
        projectId,
      });
      return null;
    }
  }

  /**
   * Save credentials for project
   */
  static async saveProjectCredentials(
    projectId: string,
    userId: string,
    credentials: Credentials,
    label?: string
  ): Promise<boolean> {
    try {
      logger.info('[PROJECT] Saving credentials', {
        projectId,
        userId,
        hasEmail: !!credentials.email,
        hasUsername: !!credentials.username,
        label,
      });

      // Encrypt credentials
      const encrypted = CredentialsParserService.encryptCredentials(credentials);

      // Check if credentials already exist
      const { data: existing } = await supabaseAdmin
        .from('test_credentials')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        // Update existing
        const { error } = await supabaseAdmin
          .from('test_credentials')
          .update({
            ...encrypted,
            label: label || 'Test credentials',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (error) {
          logger.error('[PROJECT] Error updating credentials', {
            error,
            projectId,
          });
          return false;
        }

        logger.info('[PROJECT] Credentials updated', { projectId });
      } else {
        // Insert new
        const { error } = await supabaseAdmin
          .from('test_credentials')
          .insert({
            project_id: projectId,
            user_id: userId,
            ...encrypted,
            label: label || 'Test credentials',
          });

        if (error) {
          logger.error('[PROJECT] Error inserting credentials', {
            error,
            projectId,
          });
          return false;
        }

        logger.info('[PROJECT] Credentials saved', { projectId });
      }

      return true;
    } catch (error) {
      logger.error('[PROJECT] Failed to save credentials', {
        error,
        projectId,
      });
      return false;
    }
  }

  /**
   * Add tested page to project settings
   */
  static async addTestedPage(
    projectId: string,
    pagePath: string
  ): Promise<boolean> {
    try {
      const settings = await this.getProjectSettings(projectId);
      const testedPages = settings?.tested_pages || [];

      if (!testedPages.includes(pagePath)) {
        testedPages.push(pagePath);

        return await this.updateProjectSettings(projectId, {
          tested_pages: testedPages,
          last_test_at: new Date().toISOString(),
        });
      }

      return true;
    } catch (error) {
      logger.error('[PROJECT] Failed to add tested page', {
        error,
        projectId,
        pagePath,
      });
      return false;
    }
  }

  /**
   * Extract base URL (origin) from full URL
   */
  private static extractBaseUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.origin; // e.g., "https://example.com"
    } catch (error) {
      // If URL parsing fails, try to extract manually
      const match = url.match(/^(https?:\/\/[^/]+)/);
      if (match) {
        return match[1];
      }

      // Last resort: return as is
      logger.warn('[PROJECT] Could not parse URL, using as is', { url });
      return url;
    }
  }

  /**
   * Generate project name from base URL
   */
  private static generateProjectName(baseUrl: string): string {
    try {
      const parsed = new URL(baseUrl);
      const hostname = parsed.hostname.replace('www.', '');

      // Capitalize first letter
      return hostname.charAt(0).toUpperCase() + hostname.slice(1);
    } catch {
      return `Project ${baseUrl.slice(0, 20)}`;
    }
  }

  /**
   * Get default project in workspace (if any)
   */
  static async getDefaultProject(
    workspaceId: string,
    userId: string
  ): Promise<{ id: string; name: string; settings: ProjectSettings } | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, name, settings')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting default project', { error });
        return null;
      }

      return data || null;
    } catch (error) {
      logger.error('[PROJECT] Failed to get default project', { error });
      return null;
    }
  }
}
