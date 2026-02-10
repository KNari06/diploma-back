import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getGitHubToken,
  createIssue,
  listPullRequests,
  addComment,
  getRepoInfo,
} from '@/services/api/github.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GITHUB SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GitHub integration for issue and PR management.
 * Provides: create issue, list PRs, add comment, get repo info
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
   * Check if user has connected GitHub
   */
  async isAvailable(context: SkillContext): Promise<boolean> {
    try {
      const token = await getGitHubToken(context.userId);
      return token !== null;
    } catch (error) {
      logger.error('[GITHUB_SKILL] Error checking availability', {
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
      });
      return false;
    }
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
      // Get GitHub token
      const tokenData = await getGitHubToken(context.userId);
      if (!tokenData) {
        return {
          success: false,
          message: 'GitHub integration not connected. Please connect your GitHub account first.',
          displayToUser: true,
        };
      }

      const accessToken = tokenData.access_token;

      // Route to appropriate handler
      switch (toolName) {
        case 'github_create_issue':
          return await handleCreateIssue(accessToken, args);

        case 'github_list_prs':
          return await handleListPRs(accessToken, args);

        case 'github_add_comment':
          return await handleAddComment(accessToken, args);

        case 'github_get_repo':
          return await handleGetRepo(accessToken, args);

        default:
          return {
            success: false,
            message: `Unknown GitHub tool: ${toolName}`,
            displayToUser: false,
          };
      }
    } catch (error) {
      logger.error('[GITHUB_SKILL] Execution error', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }
  },
};

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
      message: `✅ Created GitHub issue #${issue.number}: ${title}\n${issue.html_url}`,
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
      message: `✅ Added comment to ${owner}/${repo}#${issue_number}`,
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
