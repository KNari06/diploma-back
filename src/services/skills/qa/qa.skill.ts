import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from '../types';
import {
  handleListTestCases,
  handleListTestExecutions,
  handleListPageVisits,
  handleGetTestCase,
  handleGetRunReport,
  handleShareResult,
  handleListRegressionPlans,
  handleGetAnalyticsSummary,
  handleGetTestResults,
  handleListTestFindings,
  handleListTestModules,
  handleListTestFlows,
  handleListSchedules,
  handleDetectFlakyTests,
  handleListApiTestConfigs,
  handleListApiTestHistory,
  handleGetCoverageReport,
  handleAnalyzeFailure,
  handleGetRecommendations,
  handleGetRecentFailures,
  handleGetCriticalChecks,
  handleListTestFixtures,
  handleListApiEnvironments,
  handleGetAiUsage,
  handleListDeployments,
  handleListJiraIssues,
  handleListElementInteractions,
  // Analytics deep-dive tools
  handleGetResultsOverview,
  handleGetHeatmap,
  handleGetTimeSeries,
  handleGetFullDashboard,
  handleGetAgentHealth,
  handleUpdateTestCaseSteps,
  // Editor mode tools
  handleScreenshot,
  // Write tools — Tier 1
  handleUpdateTestCase,
  handleRunTest,
  handleRunDraftSteps,
  handleCreateTestCase,
  // Write tools — Tier 2
  handleManageRegressionPlan,
  handleManageSchedule,
  handleDeleteTestCase,
  // Write tools — Tier 3
  handleManageFixture,
  handleManageModule,
  handleManageFlow,
  handleBulkTag,
  handleGetLastRuns,
  handleGetRunStatus,
  handleCancelRun,
  handleManageAutomationAction,
} from './qa-tool-handlers';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QA SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * QA data tools — read access to test cases, executions, plans, analytics,
 * and write access to modify test case steps (with user confirmation).
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
        'List saved test cases for the project. Use to find tests by name, status, tags, or URL. Supports sorting by created_at or updated_at. Use status="all" to search across all statuses. Returns id, name, url, status, priority, tags, createdAt, updatedAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query test cases for',
          },
          status: {
            type: 'string',
            enum: ['draft', 'published', 'archived', 'all'],
            description: 'Filter by status. Use "all" to include every status. Default: all',
          },
          search: {
            type: 'string',
            description: 'Search by name or URL substring',
          },
          sort_by: {
            type: 'string',
            enum: ['created_at', 'updated_at', 'name', 'priority'],
            description: 'Sort field. Use created_at for "newest/oldest created", updated_at for "recently modified". Default: created_at',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction. "desc" = newest first (default), "asc" = oldest first',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 50). Use limit=1 with sort to get the single latest/oldest item',
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
        'List recent test execution results. Use to check pass/fail history, find failures, or see execution trends. Returns id, testCaseId, testCaseName, status, durationMs, browser, createdAt, errorMessage.',
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
            description: 'Filter by specific test case ID or test case name',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction by created_at. "desc" = newest first (default), "asc" = oldest first',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 50). Use limit=1 to get only the latest/oldest execution',
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
        'Get detailed info about a single test case including steps, commands, tags, preconditions, and testType (ui/api/mixed). Returns the test definition only — for execution results (pass/fail, duration, errors), also call qa_list_test_executions with the same test_case_id.',
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
      name: 'qa_share_result',
      description:
        'Generate a public share link for a regression run report. The link can be sent to anyone (Telegram, Slack, email) — no authentication required to view. Idempotent: returns the same link if already generated.',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'The regression run ID to share',
          },
        },
        required: ['run_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_last_runs',
      description:
        'Get the most recent regression runs for a project or plan. Use this when the user asks about recent regressions, last run, or wants to re-run the latest test. Returns run ID, plan name, trigger, status, summary, timing.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID (auto-resolved from context if not provided)',
          },
          plan_id: {
            type: 'string',
            description: 'Filter by specific regression plan (optional)',
          },
          search: {
            type: 'string',
            description:
              'Search by plan name (fuzzy match). Use when user refers to a plan by name instead of ID, e.g. "покажи последние регрессии Login" or "last runs for checkout flow"',
          },
          limit: {
            type: 'number',
            description: 'Number of runs to return (default: 5, max: 20)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_run_status',
      description:
        'Check the current execution status and progress of a regression run. Shows how many tests passed, failed, are still running, or pending. Use when user asks "how is my regression going?" or "is the test done?".',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'The regression run ID to check',
          },
        },
        required: ['run_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_cancel_run',
      description:
        '⚠️ WRITE operation — Cancel/stop a running or pending regression run. Cancels all underlying tests and BullMQ jobs. Only works on runs with status "running" or "pending". Describe action → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'The regression run ID to cancel',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing the cancellation to user AND receiving explicit approval.',
          },
        },
        required: ['run_id', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_manage_automation_action',
      description:
        '⚠️ WRITE operation — Create/update/delete/list automation actions. Automation actions fire automatically when events happen (e.g., send Telegram when regression fails, create Jira ticket on test failure). Actions: create (trigger_event + action_type + config), update, delete, list. Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete', 'list'],
            description: 'Operation to perform',
          },
          project_id: {
            type: 'string',
            description: 'Project ID (auto-resolved from context)',
          },
          action_id: {
            type: 'string',
            description: 'Automation action ID (required for update/delete)',
          },
          trigger_event: {
            type: 'string',
            enum: ['run_completed', 'run_failed', 'run_passed', 'test_completed', 'test_failed', 'schedule_executed'],
            description: 'When to fire the action (required for create)',
          },
          action_type: {
            type: 'string',
            enum: ['telegram_notify', 'slack_notify', 'jira_create_issue', 'webhook_post', 'generate_share_link'],
            description: 'What to do when triggered (required for create)',
          },
          condition: {
            type: 'string',
            enum: ['always', 'on_failure', 'on_success'],
            description: 'Additional filter. Default: always',
          },
          config: {
            type: 'object',
            description: 'Action-specific config. telegram_notify: {chat_id?, include_share_link?}. webhook_post: {url, headers?}. jira_create_issue: {project_key, issue_type?, priority?}.',
          },
          name: {
            type: 'string',
            description: 'Human-readable label for this automation',
          },
          schedule_id: {
            type: 'string',
            description: 'Scope to a specific schedule (optional)',
          },
          plan_id: {
            type: 'string',
            description: 'Scope to a specific regression plan (optional)',
          },
          is_active: {
            type: 'boolean',
            description: 'Enable/disable (for update)',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true for write operations. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_regression_plans',
      description:
        'List regression test plans for the project. Supports search by name and sorting. Returns plan id, name, description, isDefault, testCount, tags, createdAt, updatedAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query plans for',
          },
          search: {
            type: 'string',
            description: 'Search by plan name substring',
          },
          sort_by: {
            type: 'string',
            enum: ['created_at', 'updated_at', 'name'],
            description: 'Sort field. Default: created_at',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction. Default: desc',
          },
          limit: {
            type: 'number',
            description: 'Max results (default: all, max 50)',
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
            description: 'Look back N days (default 30, max 90). Ignored if start_date is provided.',
          },
          start_date: {
            type: 'string',
            description: 'Custom start date in ISO 8601 format (e.g. 2025-01-01). Overrides days param.',
          },
          end_date: {
            type: 'string',
            description: 'Custom end date in ISO 8601 format (e.g. 2025-01-31). Optional, defaults to now.',
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
        'Get test execution artifacts: video URL, trace URL, screenshot, console logs, network logs, errors, and AI analysis summary. Accepts EITHER test_id (execution ID) OR test_case_id (test case name or UUID) — when test_case_id is given, automatically finds the latest execution. Use when user asks about test evidence, screenshots, videos, or AI bug analysis.',
      parameters: {
        type: 'object',
        properties: {
          test_id: {
            type: 'string',
            description: 'The execution ID (from test_executions). Use this when you have a specific execution ID.',
          },
          test_case_id: {
            type: 'string',
            description: 'Test case ID (UUID) or test case name. When provided, automatically finds the latest execution for this test case. Use this when user asks about a test by name.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_test_findings',
      description:
        'List bugs and findings discovered during autonomous/intelligent test sessions. Returns severity, title, description, findingType, and when found. Use when user asks "what bugs were found?", "any issues?", or "findings this week".',
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
          search: {
            type: 'string',
            description: 'Search by title or description text. Use to find findings related to specific features.',
          },
          days: {
            type: 'number',
            description: 'Look back N days (max 90). Use to find recent findings, e.g. days=7 for "this week".',
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
        'List test modules (organizational groups) for the project. Each module belongs to a platform (web_ui, api, or mobile). Returns id, name, description, platformKey, tags, priority, createdAt, updatedAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query modules for',
          },
          platform_key: {
            type: 'string',
            enum: ['web_ui', 'api', 'mobile'],
            description: 'Filter by platform type',
          },
          sort_by: {
            type: 'string',
            enum: ['created_at', 'updated_at', 'name'],
            description: 'Sort field. Default: created_at',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction. Default: desc (newest first)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default: all). Use limit=1 with sort to get the single latest item',
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
        'List test flows within a module. Flows represent ordered test scenarios (ui, api, or mixed). Returns id, name, flowType, priority, tags, orderIndex, createdAt, updatedAt.',
      parameters: {
        type: 'object',
        properties: {
          module_id: {
            type: 'string',
            description: 'Module ID (UUID or name) to list flows for',
          },
          sort_by: {
            type: 'string',
            enum: ['order_index', 'created_at', 'updated_at', 'name'],
            description: 'Sort field. Default: order_index',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction. Default: asc',
          },
          limit: {
            type: 'number',
            description: 'Max results (default: all). Use limit=1 with sort to get the single latest item',
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
        'List test schedules for the project. Shows what is configured to run automatically: cron expression, timezone, next run time, active status. Supports search by name and filtering by plan/module.',
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
          search: {
            type: 'string',
            description: 'Search by schedule name substring',
          },
          plan_id: {
            type: 'string',
            description: 'Filter by regression plan ID',
          },
          module_id: {
            type: 'string',
            description: 'Filter by module ID',
          },
          sort_by: {
            type: 'string',
            enum: ['created_at', 'next_run_at', 'name'],
            description: 'Sort field. Use next_run_at to see which schedule runs next. Default: created_at',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction. Default: desc',
          },
          limit: {
            type: 'number',
            description: 'Max results (default: all, max 50)',
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

  // ═══════════════════════════════════════════════════════════════
  // Phase 4c — HIGH priority tools (14–20)
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_list_api_test_configs',
      description:
        'List saved API test configs + endpoints for a project. Returns environments (name, baseUrl, authType, endpointCount) and endpoints (method, path, name, category, tags).',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query API configs for',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_api_test_history',
      description:
        'List recent API test execution results. Returns id, method, url, statusCode, durationMs, success, fuzzingScore, executedAt. Supports filtering by URL, HTTP method, time range, and success status.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query API test history for',
          },
          url_search: {
            type: 'string',
            description: 'Search API tests by URL (partial match). E.g. "/api/users" to find all tests targeting that endpoint.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
            description: 'Filter by HTTP method',
          },
          days: {
            type: 'number',
            description: 'Time range in days (default 30, max 90). Use days=7 for "last week", days=1 for "today".',
          },
          success: {
            type: 'boolean',
            description: 'Filter by success status (true = passed, false = failed)',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction by execution date. "desc" = newest first (default), "asc" = oldest first',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 50). Use limit=1 with sort_order to get the single latest/oldest test.',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_coverage_report',
      description:
        'Get full coverage analysis: score, gaps, and AI-generated summary. Returns score (0-100), totalUrls, coveredUrls, totalTestCases, staleTestCases, gaps array, and summary text.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to analyze coverage for',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_analyze_failure',
      description:
        'AI-powered root cause analysis for a failed test execution. Returns rootCause, category, severity, suggestions, affectedStep, errorDetails.',
      parameters: {
        type: 'object',
        properties: {
          test_id: {
            type: 'string',
            description: 'The test execution ID to analyze (from test_executions)',
          },
        },
        required: ['test_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_recommendations',
      description:
        'AI-powered test suggestions: what to test next based on coverage, failures, and patterns. Returns array of {type, title, reason, url, relatedTestCaseId, priority}.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to get recommendations for',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_recent_failures',
      description:
        'Recent test failures with severity and error context. Returns testCaseName, testCaseId, runId, errorMessage, severity, failedAt, timeAgo.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query failures for',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 10, max 20)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_critical_checks',
      description:
        'Status of all critical-priority test cases: ok, failed, or unknown. Returns id, name, status, lastRunAt, lastRunId.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query critical checks for',
          },
        },
        required: ['project_id'],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // Phase 4c — MEDIUM priority tools (21–26)
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_list_test_fixtures',
      description:
        'List reusable test data (fixtures) for a project. Returns id, name, description, scope, tags, data (truncated to 1000 chars), createdAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query fixtures for',
          },
          scope: {
            type: 'string',
            enum: ['global', 'project', 'module', 'flow'],
            description: 'Filter by fixture scope',
          },
          limit: {
            type: 'number',
            description: 'Max results (default: all). Use limit=1 to get single latest fixture',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_api_environments',
      description:
        'List configured API environments (base URLs, auth types). Returns id, name, baseUrl, authType, isDefault, variableKeys. Auth secrets are stripped for security.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query environments for',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_ai_usage',
      description:
        'AI token usage and cost summary for the workspace. Returns totalTokens, totalCostUSD, totalCalls, and breakdown by operation type.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Look back N days (default 30, max 90)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_deployments',
      description:
        'Recent deployments/webhook events and their test run results. Returns id, version, eventType, provider, status, branch, deliveredAt, runId.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query deployments for',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 5, max 20)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_list_jira_issues',
      description:
        'Jira issues linked to test results. Returns testId, jiraIssueKey, jiraIssueUrl, createdAt.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to query Jira issues for',
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
      name: 'qa_list_element_interactions',
      description:
        'Element interaction patterns — which selectors are used, success rates, and reliability. Use to find unreliable selectors.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to analyze element patterns for',
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

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS DEEP-DIVE tools
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_get_results_overview',
      description:
        'Test results breakdown: passed/failed/skipped/flaky counts with percentages and API test breakdown. Use for donut-chart-style questions about test distribution.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to get results overview for',
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
      name: 'qa_get_heatmap',
      description:
        'Activity heatmap: daily counts of runs, failures, or flaky tests over 30/90/365 days. Shows busiest days and activity trends. Use for questions like "when do we test most?", "which days have most failures?".',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to get heatmap for',
          },
          metric: {
            type: 'string',
            enum: ['runs', 'failures', 'flaky'],
            description: 'What to measure: test runs, failures, or flaky tests (default: runs)',
          },
          range: {
            type: 'string',
            enum: ['30d', '90d', '365d'],
            description: 'Time range (default: 30d)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_time_series',
      description:
        'Time series of test runs: bucketed counts with passed/failed breakdown over time. Use for trend analysis, "how are tests performing today/this week?", or graphing run activity.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to get time series for',
          },
          interval: {
            type: 'string',
            enum: ['1m', '5m', '15m', '1h', '1d'],
            description: 'Bucket interval (default: 1h)',
          },
          hours: {
            type: 'number',
            description: 'Look back N hours (default 24, max 720 = 30 days)',
          },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_get_full_dashboard',
      description:
        'All-in-one dashboard snapshot: summary stats + results overview + performance metrics + recent failures + critical checks. Use when user asks about overall project health, full analytics, or dashboard overview. Saves multiple separate calls.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to get dashboard for',
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
      name: 'qa_get_agent_health',
      description:
        'Agent pipeline performance metrics: success/fallback rates, avg latency, router confidence, top tools used. Use for questions about agent performance, reliability, or "how is the AI doing?".',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Look back N days (default 7, max 30)',
          },
        },
        required: [],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // Editor mode tools
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_screenshot',
      description:
        'Capture a screenshot of the live preview page. Use when the user asks about visual appearance, colors, layout, or anything that requires seeing the page. Returns a JPEG screenshot that you can analyze visually.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // WRITE tools (require confirm=true after user approval)
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_update_test_case_steps',
      description:
        '⚠️ WRITE operation — Update the steps of a test case. BEFORE calling this tool: 1) Read the current test case with qa_get_test_case to see existing steps, 2) Describe the EXACT changes you will make to the user, 3) Wait for the user to explicitly approve. Only then call with confirm=true. Each step needs: id (UUID), type (click/type/navigate/etc.), description (what the step does). WARNING: This replaces ALL steps — always include the full step list, not just changed ones.',
      parameters: {
        type: 'object',
        properties: {
          test_case_id: {
            type: 'string',
            description: 'The test case ID to update',
          },
          steps: {
            type: 'array',
            description: 'Full array of steps to replace existing steps. Each step: {id: string (UUID), type: string, description: string, value?: string, assertionText?: string, expectedOutcome?: "success"|"error"}',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique step ID (UUID). Keep existing IDs for unchanged steps, generate new UUIDs for new steps.' },
                type: {
                  type: 'string',
                  enum: ['type', 'click', 'wait', 'assert', 'navigate', 'select', 'hover', 'scroll', 'press', 'check', 'uncheck', 'toggle', 'open', 'close', 'ai_check', 'wait_for', 'upload'],
                  description: 'Action type for this step',
                },
                description: { type: 'string', description: 'Human-readable description of what this step does' },
                value: { type: 'string', description: 'Value for type/press actions (e.g., text to type)' },
                assertionText: { type: 'string', description: 'Assertion text for ai_check steps' },
                expectedOutcome: {
                  type: 'string',
                  enum: ['success', 'error'],
                  description: 'Expected outcome. Use "error" for negative test steps that intentionally submit invalid/wrong data and expect validation errors or 4xx responses. Default: "success".',
                },
              },
              required: ['id', 'type', 'description'],
            },
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['test_case_id', 'steps', 'confirm'],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // Tier 1 — HIGH priority write tools (28–30)
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_update_test_case',
      description:
        '⚠️ WRITE operation — Update test case metadata (name, status, priority, tags, description). NOT for steps — use qa_update_test_case_steps for that. Describe changes → get approval → call with confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          test_case_id: {
            type: 'string',
            description: 'The test case ID to update',
          },
          name: {
            type: 'string',
            description: 'New name for the test case',
          },
          status: {
            type: 'string',
            enum: ['draft', 'published', 'archived'],
            description: 'New status',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'New priority',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'New tags array (replaces existing tags)',
          },
          description: {
            type: 'string',
            description: 'New description',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['test_case_id', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_run_test',
      description:
        '⚠️ WRITE operation — Run a test case, plan, module, flow, or filter by tag/priority. Use run_type="preview" to run steps on the live editor preview session. Describe what will run → get approval → call with confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          run_type: {
            type: 'string',
            enum: ['test_case', 'plan', 'module', 'flow', 'tag', 'priority', 'preview'],
            description: 'What to run. Use "preview" to execute test case steps on the live editor preview browser.',
          },
          target_id: {
            type: 'string',
            description: 'ID of the test_case/plan/module/flow to run (required for those run types)',
          },
          tag: {
            type: 'string',
            description: 'Tag to filter by (required when run_type=tag)',
          },
          priority_filter: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Priority to filter by (required when run_type=priority)',
          },
          project_id: {
            type: 'string',
            description: 'Project ID (required for tag/priority run types)',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing what will run to user AND receiving explicit approval.',
          },
        },
        required: ['run_type', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_run_draft_steps',
      description:
        '⚠️ WRITE operation — Execute draft test steps on the live editor preview WITHOUT saving to DB. Use this to test-drive generated steps before saving. After the user is satisfied, use qa_create_test_case to persist. Requires an active editor preview session. Describe the steps → get approval → call with confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Array of steps to execute. Each step: {id: string (UUID), type: string, description: string, value?: string, assertionText?: string}',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique step ID (UUID)' },
                type: {
                  type: 'string',
                  enum: ['type', 'click', 'wait', 'assert', 'navigate', 'select', 'hover', 'scroll', 'press', 'check', 'uncheck', 'toggle', 'open', 'close', 'ai_check', 'wait_for', 'upload'],
                  description: 'Action type for this step',
                },
                description: { type: 'string', description: 'What this step does' },
                value: { type: 'string', description: 'Value for type/press/select actions' },
                assertionText: { type: 'string', description: 'Assertion text for ai_check steps' },
                expectedOutcome: {
                  type: 'string',
                  enum: ['success', 'error'],
                  description: 'Expected outcome. Use "error" for negative test steps.',
                },
              },
              required: ['id', 'type', 'description'],
            },
          },
          start_url: {
            type: 'string',
            description: 'Starting URL for the test. Use the current preview page URL from the page context.',
          },
          suggested_name: {
            type: 'string',
            description: 'Short, descriptive name (3-5 words) for this test scenario, derived from the user\'s intent and the page being tested. Examples: "Positive Login Flow", "Checkout with Promo Code", "Reset Password Email". Used as the default test case name when the user later clicks "Save as test case". Always include this when you call qa_run_draft_steps.',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing the steps to user AND receiving explicit approval.',
          },
        },
        required: ['steps', 'start_url', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_create_test_case',
      description:
        '⚠️ WRITE operation — Create a new test case with steps and SAVE to DB. Use this ONLY when the user explicitly asks to save/persist a test case. Describe the test case → get approval → call with confirm=true. Each step needs: id (UUID), type, description.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to create the test case in',
          },
          name: {
            type: 'string',
            description: 'Name of the test case',
          },
          steps: {
            type: 'array',
            description: 'Array of steps. Each step: {id: string (UUID), type: string, description: string, value?: string, assertionText?: string, expectedOutcome?: "success"|"error"}',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique step ID (UUID)' },
                type: {
                  type: 'string',
                  enum: ['type', 'click', 'wait', 'assert', 'navigate', 'select', 'hover', 'scroll', 'press', 'check', 'uncheck', 'toggle', 'open', 'close', 'ai_check', 'wait_for', 'upload'],
                  description: 'Action type for this step',
                },
                description: { type: 'string', description: 'What this step does' },
                value: { type: 'string', description: 'Value for type/press actions' },
                assertionText: { type: 'string', description: 'Assertion text for ai_check steps' },
                expectedOutcome: {
                  type: 'string',
                  enum: ['success', 'error'],
                  description: 'Expected outcome. Use "error" for negative test steps that intentionally submit invalid/wrong data and expect validation errors or 4xx responses. Default: "success".',
                },
              },
              required: ['id', 'type', 'description'],
            },
          },
          description: {
            type: 'string',
            description: 'Description of the test case',
          },
          start_url: {
            type: 'string',
            description: 'Starting URL for the test',
          },
          status: {
            type: 'string',
            enum: ['draft', 'published'],
            description: 'Initial status (default: draft)',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Priority level',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for the test case',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing the test case to user AND receiving explicit approval.',
          },
        },
        required: ['project_id', 'name', 'steps', 'confirm'],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // Tier 2 — MEDIUM priority write tools (31–33)
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_manage_regression_plan',
      description:
        '⚠️ WRITE operation — Create/update regression plan or add/remove items. Actions: create (need project_id, name), update (need plan_id), add_item (need plan_id, item_type, item_id), remove_item (need item_id). Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'add_item', 'remove_item'],
            description: 'Operation to perform',
          },
          project_id: {
            type: 'string',
            description: 'Project ID (required for create)',
          },
          plan_id: {
            type: 'string',
            description: 'Plan ID (required for update, add_item)',
          },
          name: {
            type: 'string',
            description: 'Plan name (required for create, optional for update)',
          },
          description: {
            type: 'string',
            description: 'Plan description',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Plan tags',
          },
          is_default: {
            type: 'boolean',
            description: 'Whether this is the default plan',
          },
          item_type: {
            type: 'string',
            enum: ['module', 'flow', 'test_case'],
            description: 'Type of item to add (required for add_item)',
          },
          item_id: {
            type: 'string',
            description: 'ID of the item to add/remove',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_manage_schedule',
      description:
        '⚠️ WRITE operation — Create/update/activate/deactivate/delete test schedule. Create needs: project_id, name, exactly one of cron_expression (recurring) OR run_at (one-time), and exactly one of plan_id or module_id. Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'activate', 'deactivate', 'delete'],
            description: 'Operation to perform',
          },
          project_id: {
            type: 'string',
            description: 'Project ID (required for create)',
          },
          schedule_id: {
            type: 'string',
            description: 'Schedule ID (required for update/activate/deactivate/delete)',
          },
          name: {
            type: 'string',
            description: 'Schedule name (required for create, optional for update)',
          },
          cron_expression: {
            type: 'string',
            description: 'Cron expression for a RECURRING schedule (e.g. "0 9 * * *" for daily at 9am). Provide this OR run_at, not both.',
          },
          run_at: {
            type: 'string',
            description: 'Absolute ISO-8601 datetime for a ONE-TIME run (e.g. "2026-06-10T14:30:00Z"), fires once then deactivates. Provide this OR cron_expression, not both.',
          },
          timezone: {
            type: 'string',
            description: 'Timezone (e.g. "Asia/Almaty"). Optional. Applies to cron_expression; for run_at send an offset-aware instant instead.',
          },
          plan_id: {
            type: 'string',
            description: 'Plan to run on schedule (exactly one of plan_id or module_id for create)',
          },
          module_id: {
            type: 'string',
            description: 'Module to run on schedule (exactly one of plan_id or module_id for create)',
          },
          is_active: {
            type: 'boolean',
            description: 'Active state (for update)',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_delete_test_case',
      description:
        '🔴 DESTRUCTIVE WRITE operation — Permanently delete a test case. CANNOT BE UNDONE. You MUST warn the user about permanent deletion, wait for explicit approval, then call with confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          test_case_id: {
            type: 'string',
            description: 'The test case ID to permanently delete',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after warning user about permanent deletion AND receiving explicit approval.',
          },
        },
        required: ['test_case_id', 'confirm'],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // Tier 3 — LOW priority write tools (34–37)
  // ═══════════════════════════════════════════════════════════════

  {
    type: 'function',
    function: {
      name: 'qa_manage_fixture',
      description:
        '⚠️ WRITE operation — Create/update/delete test fixtures (reusable test data). Create needs: project_id, name, data. Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
            description: 'Operation to perform',
          },
          project_id: {
            type: 'string',
            description: 'Project ID (required for create)',
          },
          fixture_id: {
            type: 'string',
            description: 'Fixture ID (required for update/delete)',
          },
          name: {
            type: 'string',
            description: 'Fixture name',
          },
          data: {
            description: 'Fixture data (object or string). Required for create.',
          },
          description: {
            type: 'string',
            description: 'Fixture description',
          },
          scope: {
            type: 'string',
            enum: ['global', 'project', 'module', 'flow'],
            description: 'Fixture scope',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fixture tags',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_manage_module',
      description:
        '⚠️ WRITE operation — Create or update test modules. Create needs: project_id, name, platform_key (web_ui, api, or mobile). Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update'],
            description: 'Operation to perform',
          },
          project_id: {
            type: 'string',
            description: 'Project ID (required for create)',
          },
          module_id: {
            type: 'string',
            description: 'Module ID (required for update)',
          },
          name: {
            type: 'string',
            description: 'Module name',
          },
          platform_key: {
            type: 'string',
            enum: ['web_ui', 'api', 'mobile'],
            description: 'Platform type (required for create)',
          },
          description: {
            type: 'string',
            description: 'Module description',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module tags',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Module priority',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_manage_flow',
      description:
        '⚠️ WRITE operation — Create, update, or reorder test flows. Create needs: module_id, name. Reorder needs: module_id, flow_ids[]. Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'reorder'],
            description: 'Operation to perform',
          },
          module_id: {
            type: 'string',
            description: 'Module ID (required for create and reorder)',
          },
          flow_id: {
            type: 'string',
            description: 'Flow ID (required for update)',
          },
          name: {
            type: 'string',
            description: 'Flow name',
          },
          description: {
            type: 'string',
            description: 'Flow description',
          },
          flow_type: {
            type: 'string',
            enum: ['ui', 'api', 'mixed'],
            description: 'Flow type',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Flow tags',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Flow priority',
          },
          preconditions: {
            type: 'string',
            description: 'Preconditions for the flow',
          },
          expected_result: {
            type: 'string',
            description: 'Expected result of the flow',
          },
          flow_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'New order of flow IDs (required for reorder)',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qa_bulk_tag',
      description:
        '⚠️ WRITE operation — Add or remove a tag from multiple test cases at once (max 50). Describe changes → get approval → confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove'],
            description: 'Whether to add or remove the tag',
          },
          tag: {
            type: 'string',
            description: 'The tag to add or remove',
          },
          test_case_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of test case IDs to update (max 50)',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Set ONLY after describing changes to user AND receiving explicit approval.',
          },
        },
        required: ['action', 'tag', 'test_case_ids', 'confirm'],
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
    'Query and manage test cases, executions, regression plans, analytics, API test configs/history, coverage reports, failure analysis, recommendations, fixtures, deployments, Jira issues, element interactions, AI usage, heatmaps, time series, and full dashboard snapshots. 31 read-only tools + 11 write tools for comprehensive QA data access and management.',
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

        case 'qa_share_result':
          return await handleShareResult(args, context);

        case 'qa_get_last_runs':
          return await handleGetLastRuns(args, context);

        case 'qa_get_run_status':
          return await handleGetRunStatus(args, context);

        case 'qa_cancel_run':
          return await handleCancelRun(args, context);

        case 'qa_manage_automation_action':
          return await handleManageAutomationAction(args, context);

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

        // Phase 4c — HIGH priority tools
        case 'qa_list_api_test_configs':
          return await handleListApiTestConfigs(args, context);

        case 'qa_list_api_test_history':
          return await handleListApiTestHistory(args, context);

        case 'qa_get_coverage_report':
          return await handleGetCoverageReport(args, context);

        case 'qa_analyze_failure':
          return await handleAnalyzeFailure(args, context);

        case 'qa_get_recommendations':
          return await handleGetRecommendations(args, context);

        case 'qa_get_recent_failures':
          return await handleGetRecentFailures(args, context);

        case 'qa_get_critical_checks':
          return await handleGetCriticalChecks(args, context);

        // Phase 4c — MEDIUM priority tools
        case 'qa_list_test_fixtures':
          return await handleListTestFixtures(args, context);

        case 'qa_list_api_environments':
          return await handleListApiEnvironments(args, context);

        case 'qa_get_ai_usage':
          return await handleGetAiUsage(args, context);

        case 'qa_list_deployments':
          return await handleListDeployments(args, context);

        case 'qa_list_jira_issues':
          return await handleListJiraIssues(args, context);

        case 'qa_list_element_interactions':
          return await handleListElementInteractions(args, context);

        // Analytics deep-dive tools
        case 'qa_get_results_overview':
          return await handleGetResultsOverview(args, context);

        case 'qa_get_heatmap':
          return await handleGetHeatmap(args, context);

        case 'qa_get_time_series':
          return await handleGetTimeSeries(args, context);

        case 'qa_get_full_dashboard':
          return await handleGetFullDashboard(args, context);

        case 'qa_get_agent_health':
          return await handleGetAgentHealth(args, context);

        // Editor mode tools
        case 'qa_screenshot':
          return await handleScreenshot(args, context);

        // Write tools
        case 'qa_update_test_case_steps':
          return await handleUpdateTestCaseSteps(args, context);

        // Write tools — Tier 1
        case 'qa_update_test_case':
          return await handleUpdateTestCase(args, context);

        case 'qa_run_test':
          return await handleRunTest(args, context);

        case 'qa_run_draft_steps':
          return await handleRunDraftSteps(args, context);

        case 'qa_create_test_case':
          return await handleCreateTestCase(args, context);

        // Write tools — Tier 2
        case 'qa_manage_regression_plan':
          return await handleManageRegressionPlan(args, context);

        case 'qa_manage_schedule':
          return await handleManageSchedule(args, context);

        case 'qa_delete_test_case':
          return await handleDeleteTestCase(args, context);

        // Write tools — Tier 3
        case 'qa_manage_fixture':
          return await handleManageFixture(args, context);

        case 'qa_manage_module':
          return await handleManageModule(args, context);

        case 'qa_manage_flow':
          return await handleManageFlow(args, context);

        case 'qa_bulk_tag':
          return await handleBulkTag(args, context);

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

export default QASkill;
