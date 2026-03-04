import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';

export type GitProvider = 'github' | 'gitlab';
export type GitEvent = 'pull_request' | 'release' | 'push';

export interface GitIntegrationRow {
  id: string;
  project_id: string;
  provider: GitProvider;
  repository_url: string;
  webhook_secret: string;
  plan_id: string | null;
  events: GitEvent[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateGitIntegrationParams {
  projectId: string;
  userId: string;
  provider: GitProvider;
  repositoryUrl: string;
  webhookSecret: string;
  events?: GitEvent[];
}

export interface UpdateGitIntegrationParams {
  integrationId: string;
  userId: string;
  webhookSecret?: string;
  events?: GitEvent[];
  enabled?: boolean;
  planId?: string | null;
}

export class GitIntegrationService {
  static async createIntegration(params: CreateGitIntegrationParams): Promise<GitIntegrationRow> {
    const { projectId, userId, provider, repositoryUrl, webhookSecret, events } = params;

    await this.verifyProjectAccess(projectId, userId);

    const normalizedRepositoryUrl = this.normalizeRepositoryUrl(repositoryUrl, provider);
    this.validateRepositoryUrl(normalizedRepositoryUrl, provider);

    const safeEvents = this.validateEvents(events);

    const { data, error } = await supabaseAdmin
      .from('git_integrations')
      .insert({
        project_id: projectId,
        provider,
        repository_url: normalizedRepositoryUrl,
        webhook_secret: webhookSecret,
        events: safeEvents,
        enabled: true,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create git integration: ${error?.message}`);
    }

    logger.info('[GIT_INTEGRATION] Created', {
      integrationId: data.id,
      projectId,
      provider,
      repositoryUrl: normalizedRepositoryUrl,
    });

    return data as GitIntegrationRow;
  }

  static async getIntegration(integrationId: string, userId: string): Promise<GitIntegrationRow> {
    const { data, error } = await supabaseAdmin
      .from('git_integrations')
      .select('*, projects!inner(user_id)')
      .eq('id', integrationId)
      .single();

    if (error || !data) {
      throw new NotFoundError('Git integration', integrationId);
    }

    const projectUserId = (data.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new ValidationError('Access denied to this git integration');
    }

    // Remove projects relation from response
    const row = { ...data } as any;
    delete row.projects;
    return row as GitIntegrationRow;
  }

  static async listIntegrations(projectId: string, userId: string): Promise<GitIntegrationRow[]> {
    await this.verifyProjectAccess(projectId, userId);

    const { data, error } = await supabaseAdmin
      .from('git_integrations')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list git integrations: ${error.message}`);
    }

    return (data || []) as GitIntegrationRow[];
  }

  static async updateIntegration(params: UpdateGitIntegrationParams): Promise<GitIntegrationRow> {
    const { integrationId, userId, webhookSecret, events, enabled, planId } = params;

    await this.getIntegration(integrationId, userId);

    const updateData: Record<string, unknown> = {};
    if (webhookSecret !== undefined) updateData.webhook_secret = webhookSecret;
    if (events !== undefined) updateData.events = this.validateEvents(events);
    if (enabled !== undefined) updateData.enabled = enabled;
    if (planId !== undefined) updateData.plan_id = planId;

    const { data, error } = await supabaseAdmin
      .from('git_integrations')
      .update(updateData)
      .eq('id', integrationId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to update git integration: ${error?.message}`);
    }

    logger.info('[GIT_INTEGRATION] Updated', { integrationId });
    return data as GitIntegrationRow;
  }

  static async deleteIntegration(integrationId: string, userId: string): Promise<void> {
    // access check
    await this.getIntegration(integrationId, userId);

    const { error } = await supabaseAdmin
      .from('git_integrations')
      .delete()
      .eq('id', integrationId);

    if (error) {
      throw new Error(`Failed to delete git integration: ${error.message}`);
    }

    logger.info('[GIT_INTEGRATION] Deleted', { integrationId });
  }

  private static async verifyProjectAccess(projectId: string, userId: string): Promise<void> {
    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !project) {
      throw new NotFoundError('Project', projectId);
    }

    if ((project as any).user_id !== userId) {
      throw new ValidationError('Access denied to this project');
    }
  }

  private static validateEvents(events?: GitEvent[]): GitEvent[] {
    const defaultEvents: GitEvent[] = ['pull_request', 'release', 'push'];
    const value = events && Array.isArray(events) ? events : defaultEvents;

    const unique = Array.from(new Set(value));
    const allowed: GitEvent[] = ['pull_request', 'release', 'push'];

    for (const ev of unique) {
      if (!allowed.includes(ev)) {
        throw new ValidationError(`Invalid event: ${String(ev)}`);
      }
    }

    return unique;
  }

  static async findByProviderAndRepositoryUrl(
    provider: GitProvider,
    repositoryUrl: string
  ): Promise<GitIntegrationRow | null> {
    const normalizedRepositoryUrl = this.normalizeRepositoryUrl(repositoryUrl, provider);
    this.validateRepositoryUrl(normalizedRepositoryUrl, provider);

    const { data, error } = await supabaseAdmin
      .from('git_integrations')
      .select('*')
      .eq('provider', provider)
      .eq('repository_url', normalizedRepositoryUrl)
      .eq('enabled', true)
      .maybeSingle();

    if (error) {
      logger.error('[GIT_INTEGRATION] Failed to find integration', {
        provider,
        repositoryUrl: normalizedRepositoryUrl,
        error: error.message,
      });
      return null;
    }

    return (data || null) as GitIntegrationRow | null;
  }

  /**
   * Detect git provider from a repository URL by parsing the hostname.
   * Matches github.com (and www.github.com) → 'github', everything else → 'gitlab'.
   */
  static detectProviderFromUrl(repositoryUrl: string): GitProvider {
    try {
      const url = repositoryUrl.startsWith('http')
        ? new URL(repositoryUrl)
        : new URL(`https://${repositoryUrl}`);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'github.com') return 'github';
      return 'gitlab';
    } catch {
      // If URL parsing fails, fall back to simple check
      return 'gitlab';
    }
  }

  /** Find git integration by project and repository URL (for plan automation: repo chosen from user's GitHub/GitLab list). */
  static async findByProjectAndRepositoryUrl(
    projectId: string,
    repositoryUrl: string
  ): Promise<GitIntegrationRow | null> {
    const provider = this.detectProviderFromUrl(repositoryUrl);
    const normalizedUrl = this.normalizeRepositoryUrl(repositoryUrl, provider);
    this.validateRepositoryUrl(normalizedUrl, provider);

    const { data, error } = await supabaseAdmin
      .from('git_integrations')
      .select('*')
      .eq('project_id', projectId)
      .eq('repository_url', normalizedUrl)
      .eq('enabled', true)
      .maybeSingle();

    if (error) {
      logger.error('[GIT_INTEGRATION] Failed to find integration by project+repo', {
        projectId,
        repositoryUrl: normalizedUrl,
        error: error.message,
      });
      return null;
    }

    return (data || null) as GitIntegrationRow | null;
  }

  private static normalizeRepositoryUrl(input: string, provider: GitProvider): string {
    const trimmed = (input || '').trim();
    if (!trimmed) {
      throw new ValidationError('Repository URL is required');
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed.replace(/\/+$/, '');
    }

    // owner/repo → normalize to provider URL
    const base = provider === 'github' ? 'https://github.com/' : 'https://gitlab.com/';
    return (base + trimmed).replace(/\/+$/, '');
  }

  private static validateRepositoryUrl(url: string, provider: GitProvider): void {
    if (provider === 'github') {
      const githubPattern = /^https?:\/\/(www\.)?github\.com\/[\w\-.]+\/[\w\-.]+$/i;
      if (!githubPattern.test(url)) {
        throw new ValidationError('Invalid GitHub repository URL format');
      }
      return;
    }

    const gitlabPattern = /^https?:\/\/(www\.)?gitlab\.com\/[\w\-.]+\/[\w\-.]+$/i;
    if (!gitlabPattern.test(url)) {
      throw new ValidationError('Invalid GitLab repository URL format');
    }
  }
}
