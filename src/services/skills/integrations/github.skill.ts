import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getGitHubToken,
  createIssue,
  listPullRequests,
  addComment,
  getRepoInfo,
} from '@/services/api/github.service';
import { IntegrationTokenService } from '@/services/api/integration-token.service';
import { supabaseAdmin } from '@/db/supabase';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GITHUB SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GitHub integration for issue and PR management.
 * Provides: connect, status, disconnect, create issue, list PRs, add comment, get repo info
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * GitHub skill tools
 */
const GITHUB_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'github_status',
      description:
        'Check if GitHub is connected for the user. Returns connection status, username, and profile URL. Always available.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_connect',
      description:
        'Start GitHub OAuth connection. Use when user asks to connect/setup/integrate GitHub OR reconnect/re-authorize. ' +
        'Returns an authorization URL — tell the user to open it in their browser to authorize. ' +
        'After authorization, GitHub will be connected automatically. Can also be used to refresh an expired connection. Always available.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_disconnect',
      description:
        'Disconnect the GitHub integration for the user. Requires confirmation. Always available.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after warning user that GitHub will be disconnected AND receiving explicit approval.',
          },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_issue',
      description: 'Create a new GitHub issue in a repository. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner (username or organization)',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          title: {
            type: 'string',
            description: 'Issue title',
          },
          body: {
            type: 'string',
            description: 'Issue description/body (optional)',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels to add (optional, e.g., ["bug", "urgent"])',
          },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_prs',
      description: 'List pull requests in a repository. Use to see open/closed PRs.',
      parameters: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner (username or organization)',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'PR state to filter by. Default: open',
          },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_add_comment',
      description: 'Add a comment to a GitHub issue or PR. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner (username or organization)',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          issue_number: {
            type: 'number',
            description: 'Issue or PR number',
          },
          comment: {
            type: 'string',
            description: 'Comment text',
          },
        },
        required: ['owner', 'repo', 'issue_number', 'comment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_repo',
      description: 'Get information about a GitHub repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner (username or organization)',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
        },
        required: ['owner', 'repo'],
      },
    },
  },
];

/**
 * GitHub skill definition
 */
export const GitHubSkill: SkillDefinition = {
  id: 'github',
  name: 'GitHub',
  provider: 'github',
  description: 'Create issues, manage pull requests, add comments, and access repository information. Connect your GitHub account to enable.',
  tools: GITHUB_TOOLS,

  /**
   * Always available — github_connect / github_status / github_disconnect work without a token.
   * Other tools fail gracefully if not connected.
   */
  async isAvailable(_context: SkillContext): Promise<boolean> {
    return true;
  },

  /**
   * Execute a GitHub tool
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[GITHUB_SKILL] Executing tool', {
      toolName,
      args: JSON.stringify(args),
      userId: context.userId,
    });

    try {
      // Tools that do not require an existing token
      if (toolName === 'github_status') {
        return await handleStatus(context);
      }

      if (toolName === 'github_connect') {
        return await handleConnect();
      }

      if (toolName === 'github_disconnect') {
        return await handleDisconnect(args, context);
      }

      // All other tools require an existing token
      const tokenData = await getGitHubToken(context.userId, context.workspaceId);
      if (!tokenData) {
        const hasDisabled = await hasDisabledGitHubToken(context.userId, context.workspaceId);
        return {
          success: false,
          message: hasDisabled
            ? 'GitHub was previously connected but is now disabled. Use github_connect to reconnect.'
            : 'GitHub is not connected. Use github_connect to start the OAuth flow and guide the user through authorization.',
          displayToUser: true,
        };
      }

      const accessToken = tokenData.access_token;

      // Route to appropriate handler
      let result: SkillResult;
      switch (toolName) {
        case 'github_create_issue':
          result = await handleCreateIssue(accessToken, args);
          break;

        case 'github_list_prs':
          result = await handleListPRs(accessToken, args);
          break;

        case 'github_add_comment':
          result = await handleAddComment(accessToken, args);
          break;

        case 'github_get_repo':
          result = await handleGetRepo(accessToken, args);
          break;

        default:
          return {
            success: false,
            message: `Unknown GitHub tool: ${toolName}`,
            displayToUser: false,
          };
      }

      // Detect revoked/invalid token
      if (!result.success && isGitHubTokenRevokedError(result.message)) {
        return {
          success: false,
          message: 'The GitHub access token has been revoked or is invalid. Please reconnect using github_connect.',
          displayToUser: true,
        };
      }

      return result;
    } catch (error) {
      logger.error('[GITHUB_SKILL] Execution error', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      if (isGitHubTokenRevokedError(error)) {
        return {
          success: false,
          message: 'The GitHub access token has been revoked or is invalid. Please reconnect using github_connect.',
          displayToUser: true,
        };
      }

      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Check if an error indicates a revoked/invalid GitHub token (401/403)
 */
function isGitHubTokenRevokedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /401|403|Bad credentials|token.*revoked|token.*expired/i.test(msg);
}

/**
 * Check for a disabled token (exists but enabled=false).
 */
async function hasDisabledGitHubToken(userId: string, workspaceId?: string): Promise<boolean> {
  try {
    let query = supabaseAdmin
      .from('integration_tokens')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', 'github')
      .eq('enabled', false);

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data } = await query.limit(1).maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════

/**
 * Status handler — check if GitHub is connected
 */
async function handleStatus(context: SkillContext): Promise<SkillResult> {
  const tokenData = await getGitHubToken(context.userId, context.workspaceId);

  if (!tokenData) {
    const hasDisabled = await hasDisabledGitHubToken(context.userId, context.workspaceId);

    if (hasDisabled) {
      return {
        success: true,
        data: { connected: false, disabled: true },
        message: 'GitHub was previously connected but is now disabled. Use github_connect to reconnect.',
        displayToUser: true,
      };
    }

    return {
      success: true,
      data: { connected: false },
      message: 'GitHub is not connected. Use github_connect to start the OAuth flow.',
      displayToUser: true,
    };
  }

  const meta = tokenData.metadata || {};
  return {
    success: true,
    data: {
      connected: true,
      username: meta.username || tokenData.external_id || null,
      name: meta.name || null,
      profileUrl: tokenData.external_url || null,
      connectedAt: tokenData.created_at,
    },
    message: `GitHub connected: @${meta.username || tokenData.external_id || 'unknown'}${tokenData.external_url ? ` (${tokenData.external_url})` : ''}`,
    displayToUser: true,
  };
}

/**
 * Connect handler — returns GitHub OAuth URL
 */
async function handleConnect(): Promise<SkillResult> {
  const clientId = env.GITHUB_CLIENT_ID;

  if (!clientId) {
    return {
      success: false,
      message:
        'GitHub OAuth is not configured on the server. Contact your admin to set GITHUB_CLIENT_ID.',
      displayToUser: true,
    };
  }

  const backendUrl = env.BACKEND_URL || `http://localhost:${env.PORT}`;
  const callbackUrl = `${backendUrl}/api/${env.API_VERSION}/integrations/github/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: 'repo,read:user',
  });

  const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

  return {
    success: true,
    data: { authUrl },
    message:
      `To connect GitHub, open this URL in your browser:\n\n${authUrl}\n\n` +
      `Sign in to GitHub and grant access. After completing the flow you will be redirected back and GitHub will be connected.`,
    displayToUser: true,
  };
}

/**
 * Disconnect handler
 */
async function handleDisconnect(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  if (!args.confirm) {
    return {
      success: false,
      message:
        'Disconnecting GitHub requires confirmation. Warn the user that the integration will be removed and they will need to re-authorize. Set confirm=true after explicit approval.',
      displayToUser: true,
    };
  }

  const tokenData = await getGitHubToken(context.userId, context.workspaceId);
  if (!tokenData) {
    return {
      success: false,
      message: 'GitHub is not connected — nothing to disconnect.',
      displayToUser: true,
    };
  }

  try {
    await IntegrationTokenService.deleteToken(context.userId, 'github', undefined, context.workspaceId);
  } catch (error) {
    logger.error('[GITHUB_SKILL] Failed to disconnect', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to disconnect GitHub. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[GITHUB_SKILL] GitHub disconnected via chat', { userId: context.userId });

  return {
    success: true,
    data: { disconnected: true },
    message: 'GitHub disconnected successfully. You can reconnect anytime using github_connect.',
    displayToUser: true,
  };
}

/**
 * Create issue handler
 */
async function handleCreateIssue(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { owner, repo, title, body, labels } = args;

  if (!owner || !repo || !title) {
    return {
      success: false,
      message: 'Missing required fields: owner, repo, title',
      displayToUser: false,
    };
  }

  try {
    const issue = await createIssue(accessToken, owner, repo, title, body, labels);

    logger.info('[GITHUB_SKILL] Issue created', {
      issueNumber: issue.number,
      owner,
      repo,
    });

    return {
      success: true,
      data: {
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
      },
      message: `Created GitHub issue #${issue.number}: ${title}\n${issue.html_url}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[GITHUB_SKILL] Failed to create issue', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to create issue: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * List PRs handler
 */
async function handleListPRs(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { owner, repo, state = 'open' } = args;

  if (!owner || !repo) {
    return {
      success: false,
      message: 'Missing required fields: owner, repo',
      displayToUser: false,
    };
  }

  try {
    const prs = await listPullRequests(accessToken, owner, repo, state, 10);

    logger.info('[GITHUB_SKILL] PRs listed', {
      count: prs.length,
      owner,
      repo,
      state,
    });

    const formatted = prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.user.login,
      head: pr.head.ref,
      base: pr.base.ref,
      url: pr.html_url,
      created: pr.created_at,
    }));

    return {
      success: true,
      data: { prs: formatted },
      message: `Found ${prs.length} ${state} pull requests in ${owner}/${repo}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[GITHUB_SKILL] Failed to list PRs', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to list PRs: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Add comment handler
 */
async function handleAddComment(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { owner, repo, issue_number, comment } = args;

  if (!owner || !repo || !issue_number || !comment) {
    return {
      success: false,
      message: 'Missing required fields: owner, repo, issue_number, comment',
      displayToUser: false,
    };
  }

  try {
    await addComment(accessToken, owner, repo, issue_number, comment);

    logger.info('[GITHUB_SKILL] Comment added', {
      issueNumber: issue_number,
      owner,
      repo,
    });

    return {
      success: true,
      data: { issueNumber: issue_number, owner, repo },
      message: `Added comment to ${owner}/${repo}#${issue_number}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[GITHUB_SKILL] Failed to add comment', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to add comment: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Get repo handler
 */
async function handleGetRepo(
  accessToken: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { owner, repo } = args;

  if (!owner || !repo) {
    return {
      success: false,
      message: 'Missing required fields: owner, repo',
      displayToUser: false,
    };
  }

  try {
    const repoInfo = await getRepoInfo(accessToken, owner, repo);

    logger.info('[GITHUB_SKILL] Repo info retrieved', {
      fullName: repoInfo.full_name,
    });

    return {
      success: true,
      data: {
        name: repoInfo.name,
        fullName: repoInfo.full_name,
        description: repoInfo.description,
        url: repoInfo.html_url,
        defaultBranch: repoInfo.default_branch,
        private: repoInfo.private,
        language: repoInfo.language,
        stars: repoInfo.stargazers_count,
        forks: repoInfo.forks_count,
      },
      message: `Repository: ${repoInfo.full_name}\n${repoInfo.description || 'No description'}\nStars: ${repoInfo.stargazers_count} | Forks: ${repoInfo.forks_count}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[GITHUB_SKILL] Failed to get repo info', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to get repo info: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}
