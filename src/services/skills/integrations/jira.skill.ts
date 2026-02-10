import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getJiraToken,
  ensureValidToken,
  createJiraIssue,
  searchJiraIssues,
  addJiraComment,
  getJiraIssue,
  transitionJiraIssue,
} from '@/services/api/jira.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * JIRA SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Wraps existing Jira service functions for agent tool calling.
 * Provides: create issue, search issues, add comment, get issue, transition issue
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Jira skill tools
 */
const JIRA_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'jira_create_issue',
      description: 'Create a new Jira issue (Bug, Task, Story, etc.). Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          project_key: {
            type: 'string',
            description: 'Jira project key (e.g., "PROJ", "TEST"). Ask user if unknown.',
          },
          summary: {
            type: 'string',
            description: 'Issue title/summary',
          },
          description: {
            type: 'string',
            description: 'Detailed issue description (optional)',
          },
          issue_type: {
            type: 'string',
            enum: ['Bug', 'Task', 'Story', 'Epic'],
            description: 'Issue type. Default: Bug',
          },
          priority: {
            type: 'string',
            enum: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
            description: 'Priority level. Default: Medium',
          },
        },
        required: ['project_key', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_search_issues',
      description: 'Search Jira issues using JQL (Jira Query Language). Use for finding issues by status, type, assignee, etc.',
      parameters: {
        type: 'object',
        properties: {
          jql: {
            type: 'string',
            description: 'JQL query (e.g., "project = PROJ AND status = Open", "issuetype = Bug AND priority = High")',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return. Default: 10',
          },
        },
        required: ['jql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_add_comment',
      description: 'Add a comment to an existing Jira issue. Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          issue_key: {
            type: 'string',
            description: 'Jira issue key (e.g., "PROJ-123")',
          },
          comment: {
            type: 'string',
            description: 'Comment text to add',
          },
        },
        required: ['issue_key', 'comment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_get_issue',
      description: 'Get details of a specific Jira issue by key.',
      parameters: {
        type: 'object',
        properties: {
          issue_key: {
            type: 'string',
            description: 'Jira issue key (e.g., "PROJ-123")',
          },
        },
        required: ['issue_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_transition_issue',
      description: 'Change the status of a Jira issue (e.g., To Do → In Progress → Done). Requires user confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          issue_key: {
            type: 'string',
            description: 'Jira issue key (e.g., "PROJ-123")',
          },
          status: {
            type: 'string',
            description: 'Target status name (e.g., "In Progress", "Done", "Closed")',
          },
        },
        required: ['issue_key', 'status'],
      },
    },
  },
];

/**
 * Jira skill definition
 */
export const JiraSkill: SkillDefinition = {
  id: 'jira',
  name: 'Jira',
  provider: 'jira',
  description: 'Create issues, search tickets, add comments, and manage Jira workflows. Connect your Jira workspace to enable.',
  tools: JIRA_TOOLS,

  /**
   * Check if user has connected Jira
   */
  async isAvailable(context: SkillContext): Promise<boolean> {
    try {
      const token = await getJiraToken(context.userId);
      return token !== null;
    } catch (error) {
      logger.error('[JIRA_SKILL] Error checking availability', {
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
      });
      return false;
    }
  },

  /**
   * Execute a Jira tool
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[JIRA_SKILL] Executing tool', {
      toolName,
      args: JSON.stringify(args),
      userId: context.userId,
    });

    try {
      // Get Jira token
      const tokenData = await getJiraToken(context.userId);
      if (!tokenData) {
        return {
          success: false,
          message: 'Jira integration not connected. Please connect your Jira account first.',
          displayToUser: true,
        };
      }

      // Ensure token is valid (refresh if needed)
      const accessToken = await ensureValidToken(tokenData);
      const cloudId = tokenData.cloud_id;

      if (!cloudId) {
        return {
          success: false,
          message: 'Jira cloud ID not found. Please reconnect your Jira account.',
          displayToUser: true,
        };
      }

      // Route to appropriate handler
      switch (toolName) {
        case 'jira_create_issue':
          return await handleCreateIssue(accessToken, cloudId, args);

        case 'jira_search_issues':
          return await handleSearchIssues(accessToken, cloudId, args);

        case 'jira_add_comment':
          return await handleAddComment(accessToken, cloudId, args);

        case 'jira_get_issue':
          return await handleGetIssue(accessToken, cloudId, args);

        case 'jira_transition_issue':
          return await handleTransitionIssue(accessToken, cloudId, args);

        default:
          return {
            success: false,
            message: `Unknown Jira tool: ${toolName}`,
            displayToUser: false,
          };
      }
    } catch (error) {
      logger.error('[JIRA_SKILL] Execution error', {
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
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { project_key, summary, description, issue_type = 'Bug', priority = 'Medium' } = args;

  if (!project_key || !summary) {
    return {
      success: false,
      message: 'Missing required fields: project_key, summary',
      displayToUser: false,
    };
  }

  try {
    const issue = await createJiraIssue({
      accessToken,
      cloudId,
      projectKey: project_key,
      summary,
      description,
      issueType: issue_type,
      priority,
    });

    logger.info('[JIRA_SKILL] Issue created', {
      issueKey: issue.key,
      issueId: issue.id,
    });

    return {
      success: true,
      data: { issueKey: issue.key, issueId: issue.id, self: issue.self },
      message: `✅ Created Jira issue: ${issue.key}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to create issue', {
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
 * Search issues handler
 */
async function handleSearchIssues(
  accessToken: string,
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { jql, max_results = 10 } = args;

  if (!jql) {
    return {
      success: false,
      message: 'Missing required field: jql',
      displayToUser: false,
    };
  }

  try {
    const result = await searchJiraIssues(accessToken, cloudId, jql, 0, max_results);

    logger.info('[JIRA_SKILL] Search completed', {
      jql,
      resultsCount: result.issues.length,
      total: result.total,
    });

    const formatted = result.issues.map((issue) => ({
      key: issue.key,
      summary: issue.summary,
      status: issue.status.name,
      priority: issue.priority?.name || 'None',
      assignee: issue.assignee?.displayName || 'Unassigned',
      created: issue.created,
    }));

    return {
      success: true,
      data: { issues: formatted, total: result.total },
      message: `Found ${result.issues.length} issues (total: ${result.total})`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to search issues', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to search issues: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Add comment handler
 */
async function handleAddComment(
  accessToken: string,
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { issue_key, comment } = args;

  if (!issue_key || !comment) {
    return {
      success: false,
      message: 'Missing required fields: issue_key, comment',
      displayToUser: false,
    };
  }

  try {
    await addJiraComment(accessToken, cloudId, issue_key, comment);

    logger.info('[JIRA_SKILL] Comment added', { issueKey: issue_key });

    return {
      success: true,
      data: { issueKey: issue_key },
      message: `✅ Added comment to ${issue_key}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to add comment', {
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
 * Get issue handler
 */
async function handleGetIssue(
  accessToken: string,
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { issue_key } = args;

  if (!issue_key) {
    return {
      success: false,
      message: 'Missing required field: issue_key',
      displayToUser: false,
    };
  }

  try {
    const issue = await getJiraIssue(accessToken, cloudId, issue_key);

    logger.info('[JIRA_SKILL] Issue retrieved', { issueKey: issue.key });

    return {
      success: true,
      data: {
        key: issue.key,
        summary: issue.summary,
        description: issue.description,
        status: issue.status.name,
        priority: issue.priority?.name || 'None',
        assignee: issue.assignee?.displayName || 'Unassigned',
        reporter: issue.reporter?.displayName || 'Unknown',
        created: issue.created,
        updated: issue.updated,
      },
      message: `Retrieved ${issue.key}: ${issue.summary}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to get issue', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to get issue: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Transition issue handler
 */
async function handleTransitionIssue(
  accessToken: string,
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { issue_key, status } = args;

  if (!issue_key || !status) {
    return {
      success: false,
      message: 'Missing required fields: issue_key, status',
      displayToUser: false,
    };
  }

  try {
    await transitionJiraIssue(accessToken, cloudId, issue_key, status);

    logger.info('[JIRA_SKILL] Issue transitioned', {
      issueKey: issue_key,
      newStatus: status,
    });

    return {
      success: true,
      data: { issueKey: issue_key, newStatus: status },
      message: `✅ Moved ${issue_key} to ${status}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to transition issue', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: `Failed to transition issue: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}
