import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  handleListTestCases,
  handleListTestExecutions,
  handleListPageVisits,
  handleGetTestCase,
  handleGetRunReport,
  handleListRegressionPlans,
  handleGetAnalyticsSummary,
  handleGetTestResults,
  handleListTestFindings,
  handleListTestModules,
  handleListTestFlows,
  handleListSchedules,
  handleDetectFlakyTests,
} from './qa-tool-handlers';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QA SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * QA data tools — read-only access to test cases, executions, plans, and analytics.
 * The agent composes these primitives to answer analytical questions
 * (coverage gaps, failure analysis, recommendations) without dedicated intents.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const QA_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'qa_list_test_cases',
      description:
        'List saved test cases for the project. Use to find tests by name, status, tags, or URL. Returns id, name, url, status, priority, tags, updatedAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query test cases for',
          },
          status: {
            type: 'string',
            enum: ['draft', 'published', 'archived'],
            description: 'Filter by status. Default: published',
          },
          search: {
            type: 'string',
            description: 'Search by name or URL substring',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 50)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_test_executions',
      description:
        'List recent test execution results. Use to check pass/fail history, find failures, or see execution trends. Returns id, testCaseId, testCaseName, status, durationMs, browser, createdAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query executions for',
          },
          days: {
            type: 'number',
            description: 'Look back N days (default 30, max 90)',
          },
          status: {
            type: 'string',
            enum: ['passed', 'failed', 'skipped'],
            description: 'Filter by execution status',
          },
          test_case_id: {
            type: 'string',
            description: 'Filter by specific test case ID',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 50)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_page_visits',
      description:
        'Get page visit patterns — URLs visited during testing sessions. Use to understand which URLs have been explored and how often. Returns url, visitCount, pageType, lastVisited.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query page visits for',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 30, max 50)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_test_case',
      description:
        'Get detailed info about a single test case including steps, commands, tags, and preconditions. Use when the user asks about a specific test.',
      parameters: {
        type: 'object',
        properties: {
          test_case_id: {
            type: 'string',
            description: 'The test case ID to look up',
          },
        },
        required: ['test_case_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_run_report',
      description:
        'Get a regression run report with all execution results. Use to see what passed/failed in a specific run. Returns run metadata + execution list with pass rate.',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'The regression run ID',
          },
        },
        required: ['run_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_regression_plans',
      description:
        'List regression test plans for the project. Returns plan id, name, description, isDefault, testCount, tags.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query plans for',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_analytics_summary',
      description:
        'Get high-level QA analytics: total runs, executions, pass/fail rates, avg duration, and top failures. Use for dashboard-style overviews.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to get analytics for',
          },
          days: {
            type: 'number',
            description: 'Look back N days (default 30, max 90)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_test_results',
      description:
        'Get test execution artifacts: video URL, trace URL, screenshot, console logs, network logs, errors, and AI analysis summary. Use when user asks about test evidence, screenshots, videos, or AI bug analysis.',
      parameters: {
        type: 'object',
        properties: {
          test_id: {
            type: 'string',
            description: 'The test ID (from test_executions result field) to get artifacts for',
          },
        },
        required: ['test_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_test_findings',
      description:
        'List bugs and findings discovered during autonomous/intelligent test sessions. Returns severity, title, description, and when found. Use when user asks "what bugs were found?" or "any issues?".',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query findings for',
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Filter by severity level',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 50)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_test_modules',
      description:
        'List test modules (organizational groups) for the project. Each module belongs to a platform (web_ui or api). Returns id, name, description, platformKey, tags, priority.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query modules for',
          },
          platform_key: {
            type: 'string',
            enum: ['web_ui', 'api'],
            description: 'Filter by platform type',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_test_flows',
      description:
        'List test flows within a module. Flows represent ordered test scenarios (ui, api, or mixed). Returns id, name, flowType, priority, tags, orderIndex.',
      parameters: {
        type: 'object',
        properties: {
          module_id: {
            type: 'string',
            description: 'Module ID to list flows for',
          },
        },
        required: ['module_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_schedules',
      description:
        'List test schedules for the project. Shows what is configured to run automatically: cron expression, timezone, next run time, active status.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query schedules for',
          },
          active_only: {
            type: 'boolean',
            description: 'Only return active schedules (default: false)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_detect_flaky_tests',
      description:
        'Detect flaky (unstable) tests — test cases that have both passed and failed in recent runs. Returns test case names with pass/fail counts and flakiness rate.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to analyze',
          },
          days: {
            type: 'number',
            description: 'Look back N days (default 30, max 90)',
          },
        },
        required: ['project_id'],
      },
    },
  },
];

/**
 * QA Skill definition
 */
export const QASkill: SkillDefinition = {
  id: 'qa',
  name: 'QA Tools',
  provider: 'qa',
  description:
    'Query test cases, execution results, regression plans, page visits, analytics, test artifacts (videos/screenshots/logs), bug findings, test modules/flows, schedules, and flaky test detection. Use these tools to answer any analytical QA question.',
  tools: QA_TOOLS,

  /**
   * QA tools are always available when projectId is in context
   */
  async isAvailable(context: SkillContext): Promise<boolean> {
    return !!context.projectId;
  },

  /**
   * Execute a QA tool
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[QA_SKILL] Executing tool', {
      toolName,
      args: JSON.stringify(args),
      userId: context.userId,
      projectId: context.projectId,
    });

    try {
      switch (toolName) {
        case 'qa_list_test_cases':
          return await handleListTestCases(args, context);

        case 'qa_list_test_executions':
          return await handleListTestExecutions(args, context);

        case 'qa_list_page_visits':
          return await handleListPageVisits(args, context);

        case 'qa_get_test_case':
          return await handleGetTestCase(args, context);

        case 'qa_get_run_report':
          return await handleGetRunReport(args, context);

        case 'qa_list_regression_plans':
          return await handleListRegressionPlans(args, context);

        case 'qa_get_analytics_summary':
          return await handleGetAnalyticsSummary(args, context);

        case 'qa_get_test_results':
          return await handleGetTestResults(args, context);

        case 'qa_list_test_findings':
          return await handleListTestFindings(args, context);

        case 'qa_list_test_modules':
          return await handleListTestModules(args, context);

        case 'qa_list_test_flows':
          return await handleListTestFlows(args, context);

        case 'qa_list_schedules':
          return await handleListSchedules(args, context);

        case 'qa_detect_flaky_tests':
          return await handleDetectFlakyTests(args, context);

        default:
          return {
            success: false,
            message: `Unknown QA tool: ${toolName}`,
            displayToUser: false,
          };
      }
    } catch (error) {
      logger.error('[QA_SKILL] Execution error', {
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
