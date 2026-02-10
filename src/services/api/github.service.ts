import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GITHUB API SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GitHub REST API client using integration_tokens table.
 * Provides: issue management, PR operations, repo info
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const GITHUB_API_URL = 'https://api.github.com';

export interface GitHubTokenData {
  id: string;
  user_id: string;
  workspace_id?: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
  external_id?: string;
  external_url?: string;
  metadata?: Record<string, any>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
  };
  labels: Array<{ name: string; color: string }>;
  created_at: string;
  updated_at: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
  };
  head: {
    ref: string;
  };
  base: {
    ref: string;
  };
  created_at: string;
  updated_at: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
}

/**
 * Get GitHub token for user
 * Now uses centralized IntegrationTokenService
 */
export async function getGitHubToken(userId: string): Promise<GitHubTokenData | null> {
  try {
    const { IntegrationTokenService } = await import('./integration-token.service');
    const token = await IntegrationTokenService.getToken(userId, 'github');

    if (!token) {
      logger.debug('[GITHUB_SERVICE] No token found', { userId });
      return null;
    }

    logger.debug('[GITHUB_SERVICE] Token retrieved', { userId });
    return token as GitHubTokenData;
  } catch (error) {
    logger.error('[GITHUB_SERVICE] Get token error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    throw error;
  }
}

/**
 * Create a GitHub issue
 */
export async function createIssue(
  accessToken: string,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[]
): Promise<GitHubIssue> {
  try {
    logger.info('[GITHUB_SERVICE] Creating issue', { owner, repo, title });

    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title,
        body: body || '',
        labels: labels || [],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITHUB_SERVICE] Failed to create issue', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const issue = (await response.json()) as GitHubIssue;
    logger.info('[GITHUB_SERVICE] Issue created', { issueNumber: issue.number });

    return issue;
  } catch (error) {
    logger.error('[GITHUB_SERVICE] Create issue error', {
      error: error instanceof Error ? error.message : String(error),
      owner,
      repo,
    });
    throw error;
  }
}

/**
 * List pull requests
 */
export async function listPullRequests(
  accessToken: string,
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  perPage: number = 10
): Promise<GitHubPullRequest[]> {
  try {
    logger.info('[GITHUB_SERVICE] Listing PRs', { owner, repo, state });

    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITHUB_SERVICE] Failed to list PRs', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const prs = (await response.json()) as GitHubPullRequest[];
    logger.info('[GITHUB_SERVICE] PRs listed', { count: prs.length });

    return prs;
  } catch (error) {
    logger.error('[GITHUB_SERVICE] List PRs error', {
      error: error instanceof Error ? error.message : String(error),
      owner,
      repo,
    });
    throw error;
  }
}

/**
 * Create a pull request
 */
export async function createPullRequest(
  accessToken: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<GitHubPullRequest> {
  try {
    logger.info('[GITHUB_SERVICE] Creating PR', { owner, repo, title, head, base });

    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title,
        body,
        head,
        base,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITHUB_SERVICE] Failed to create PR', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const pr = (await response.json()) as GitHubPullRequest;
    logger.info('[GITHUB_SERVICE] PR created', { prNumber: pr.number });

    return pr;
  } catch (error) {
    logger.error('[GITHUB_SERVICE] Create PR error', {
      error: error instanceof Error ? error.message : String(error),
      owner,
      repo,
    });
    throw error;
  }
}

/**
 * Add comment to issue or PR
 */
export async function addComment(
  accessToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  try {
    logger.info('[GITHUB_SERVICE] Adding comment', { owner, repo, issueNumber });

    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITHUB_SERVICE] Failed to add comment', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    logger.info('[GITHUB_SERVICE] Comment added', { issueNumber });
  } catch (error) {
    logger.error('[GITHUB_SERVICE] Add comment error', {
      error: error instanceof Error ? error.message : String(error),
      owner,
      repo,
      issueNumber,
    });
    throw error;
  }
}

/**
 * Get repository information
 */
export async function getRepoInfo(
  accessToken: string,
  owner: string,
  repo: string
): Promise<GitHubRepo> {
  try {
    logger.info('[GITHUB_SERVICE] Getting repo info', { owner, repo });

    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITHUB_SERVICE] Failed to get repo info', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const repoInfo = (await response.json()) as GitHubRepo;
    logger.info('[GITHUB_SERVICE] Repo info retrieved', { fullName: repoInfo.full_name });

    return repoInfo;
  } catch (error) {
    logger.error('[GITHUB_SERVICE] Get repo info error', {
      error: error instanceof Error ? error.message : String(error),
      owner,
      repo,
    });
    throw error;
  }
}

/**
 * List user's repositories
 */
export async function listUserRepos(
  accessToken: string,
  perPage: number = 10
): Promise<GitHubRepo[]> {
  try {
    logger.info('[GITHUB_SERVICE] Listing user repos');

    const response = await fetch(
      `${GITHUB_API_URL}/user/repos?per_page=${perPage}&sort=updated`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITHUB_SERVICE] Failed to list repos', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const repos = (await response.json()) as GitHubRepo[];
    logger.info('[GITHUB_SERVICE] Repos listed', { count: repos.length });

    return repos;
  } catch (error) {
    logger.error('[GITHUB_SERVICE] List repos error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
