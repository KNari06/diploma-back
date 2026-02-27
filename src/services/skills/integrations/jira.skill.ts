import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  getJiraToken,
  ensureValidToken,
  buildJiraAuthUrl,
  generateOAuthState,
  getJiraProjects,
  getProjectStatuses,
  updateJiraIssueFields,
  createJiraIssue,
  searchJiraIssues,
  addJiraComment,
  getJiraIssue,
  transitionJiraIssue,
} from '@/services/api/jira.service';
import { IntegrationTokenService } from '@/services/api/integration-token.service';
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
      name: 'jira_status',
      description:
        'Check if Jira is connected for the user. Returns connection status, site URL, and cloud ID. Always available.',
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
      name: 'jira_connect',
      description:
        'Start Jira OAuth connection. Use when user asks to connect/setup/integrate Jira OR reconnect/re-authorize. ' +
        'Returns an authorization URL — tell the user to open it in their browser to authorize. ' +
        'After authorization, Jira will be connected automatically. Can also be used to refresh an expired connection. Always available.',
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
      name: 'jira_disconnect',
      description:
        'Disconnect the Jira integration for the user. Requires confirmation. Always available.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description:
              'Must be true. Set ONLY after warning user that Jira will be disconnected AND receiving explicit approval.',
          },
        },
        required: ['confirm'],
      },
    },
  },
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
  {
    type: 'function',
    function: {
      name: 'jira_list_projects',
      description: 'List all Jira projects the user has access to. Returns project key, name, and type. Use when user asks which projects exist or what project_key to use.',
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
      name: 'jira_get_statuses',
      description: 'Get available workflow statuses for a Jira project. Use before jira_transition_issue to know which statuses are valid.',
      parameters: {
        type: 'object',
        properties: {
          project_key: {
            type: 'string',
            description: 'Jira project key (e.g., "PROJ")',
          },
        },
        required: ['project_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_update_issue',
      description: 'Update fields of a Jira issue: summary, description, priority. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          issue_key: {
            type: 'string',
            description: 'Jira issue key (e.g., "PROJ-123")',
          },
          summary: {
            type: 'string',
            description: 'New issue title/summary',
          },
          description: {
            type: 'string',
            description: 'New issue description',
          },
          priority: {
            type: 'string',
            enum: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
            description: 'New priority level',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['issue_key', 'confirm'],
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
   * Always available — jira_status/connect/disconnect work without a token.
   * Other tools fail gracefully if not connected.
   */
  async isAvailable(_context: SkillContext): Promise<boolean> {
    return true;
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
      // Tools that do not require an existing token
      if (toolName === 'jira_status') {
        return await handleStatus(context);
      }

      if (toolName === 'jira_connect') {
        return await handleConnect();
      }

      if (toolName === 'jira_disconnect') {
        return await handleDisconnect(args, context);
      }

      // All other tools require an existing token
      const tokenData = await getJiraToken(context.userId, undefined, context.workspaceId);
      if (!tokenData) {
        return {
          success: false,
          message:
            'Jira is not connected. Use jira_connect to get the authorization URL and guide the user through the OAuth flow.',
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

        case 'jira_list_projects':
          return await handleListProjects(accessToken, cloudId);

        case 'jira_get_statuses':
          return await handleGetStatuses(accessToken, cloudId, args);

        case 'jira_update_issue':
          return await handleUpdateIssue(accessToken, cloudId, args);

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
 * Status handler
 */
async function handleStatus(context: SkillContext): Promise<SkillResult> {
  const tokenData = await getJiraToken(context.userId, undefined, context.workspaceId);

  if (!tokenData) {
    return {
      success: true,
      data: { connected: false },
      message: 'Jira is not connected. Use jira_connect to start the OAuth flow.',
      displayToUser: true,
    };
  }

  return {
    success: true,
    data: {
      connected: true,
      siteUrl: tokenData.site_url || null,
      cloudId: tokenData.cloud_id || null,
      connectedAt: tokenData.created_at,
    },
    message: `Jira connected${tokenData.site_url ? `: ${tokenData.site_url}` : ''}.`,
    displayToUser: true,
  };
}

/**
 * Connect handler — returns OAuth URL for the user to open
 */
async function handleConnect(): Promise<SkillResult> {
  try {
    const state = generateOAuthState();
    const authUrl = buildJiraAuthUrl(state);

    return {
      success: true,
      data: { authUrl },
      message:
        `To connect Jira, open this URL in your browser:\n\n${authUrl}\n\n` +
        `Sign in to Atlassian and grant access. After completing the flow you will be redirected back and Jira will be connected.`,
      displayToUser: true,
    };
  } catch (error) {
    return {
      success: false,
      message: `Cannot start Jira OAuth: ${error instanceof Error ? error.message : String(error)}. Contact your admin to configure JIRA_CLIENT_ID.`,
      displayToUser: true,
    };
  }
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
        'Disconnecting Jira requires confirmation. Warn the user that the integration will be removed. Set confirm=true after explicit approval.',
      displayToUser: true,
    };
  }

  const tokenData = await getJiraToken(context.userId, undefined, context.workspaceId);
  if (!tokenData) {
    return {
      success: false,
      message: 'Jira is not connected — nothing to disconnect.',
      displayToUser: true,
    };
  }

  try {
    await IntegrationTokenService.deleteToken(context.userId, 'jira', undefined, context.workspaceId);
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to disconnect', {
      error: error instanceof Error ? error.message : String(error),
      userId: context.userId,
    });
    return {
      success: false,
      message: 'Failed to disconnect Jira. Please try again.',
      displayToUser: true,
    };
  }

  logger.info('[JIRA_SKILL] Jira disconnected via chat', { userId: context.userId });

  return {
    success: true,
    data: { disconnected: true },
    message: 'Jira disconnected successfully. You can reconnect anytime using jira_connect.',
    displayToUser: true,
  };
}

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

/**
 * List projects handler
 */
async function handleListProjects(
  accessToken: string,
  cloudId: string
): Promise<SkillResult> {
  try {
    const projects = await getJiraProjects(accessToken, cloudId);

    logger.info('[JIRA_SKILL] Projects listed', { count: projects.length });

    const formatted = projects.map((p) => ({
      key: (p as any).key,
      name: (p as any).name,
      type: (p as any).projectTypeKey || (p as any).style || null,
    }));

    return {
      success: true,
      data: { projects: formatted, total: formatted.length },
      message: `Found ${formatted.length} Jira project${formatted.length !== 1 ? 's' : ''}: ${formatted.map((p) => p.key).join(', ')}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to list projects', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list projects: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Get statuses handler
 */
async function handleGetStatuses(
  accessToken: string,
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { project_key } = args;

  if (!project_key) {
    return {
      success: false,
      message: 'Missing required field: project_key',
      displayToUser: false,
    };
  }

  try {
    const statuses = await getProjectStatuses(accessToken, cloudId, project_key);

    logger.info('[JIRA_SKILL] Statuses retrieved', { project_key, count: statuses.length });

    return {
      success: true,
      data: { statuses, project_key },
      message: `Statuses for ${project_key}: ${statuses.join(', ')}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to get statuses', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get statuses: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}

/**
 * Update issue handler
 */
async function handleUpdateIssue(
  accessToken: string,
  cloudId: string,
  args: Record<string, any>
): Promise<SkillResult> {
  const { issue_key, summary, description, priority, confirm } = args;

  if (!confirm) {
    return {
      success: false,
      message:
        'Updating a Jira issue requires confirmation. Describe the changes to the user and set confirm=true after approval.',
      displayToUser: true,
    };
  }

  if (!issue_key) {
    return {
      success: false,
      message: 'Missing required field: issue_key',
      displayToUser: false,
    };
  }

  const hasSummary = summary !== undefined && summary !== '';
  const hasDescription = description !== undefined && description !== '';
  const hasPriority = priority !== undefined && priority !== '';

  if (!hasSummary && !hasDescription && !hasPriority) {
    return {
      success: false,
      message: 'At least one field to update is required: summary, description, or priority.',
      displayToUser: false,
    };
  }

  try {
    await updateJiraIssueFields({
      accessToken,
      cloudId,
      issueKey: issue_key,
      ...(hasSummary ? { summary } : {}),
      ...(hasDescription ? { description } : {}),
      ...(hasPriority ? { priority } : {}),
    });

    logger.info('[JIRA_SKILL] Issue updated', { issue_key });

    const updatedFields = [
      hasSummary ? 'summary' : null,
      hasDescription ? 'description' : null,
      hasPriority ? 'priority' : null,
    ].filter(Boolean);

    return {
      success: true,
      data: { issueKey: issue_key, updatedFields },
      message: `✅ Updated ${issue_key}: ${updatedFields.join(', ')}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[JIRA_SKILL] Failed to update issue', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to update issue: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: true,
    };
  }
}
