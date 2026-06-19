/**
 * Failure Analysis Service
 * Provides AI-powered structured root-cause analysis for failed tests.
 * Uses LLM classification (gemini-2.5-flash-lite) with error context from test results
 * and intelligent session data.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { FailureAnalysisResult, FailureCategory } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const LLM_MODEL = AI_TASK_MODELS.failureAnalysis;
const LLM_TEMPERATURE = 0.1;
const LLM_MAX_TOKENS = 1000;
const MAX_ERROR_SUMMARY_LENGTH = 4000; // Limit context sent to LLM

const VALID_CATEGORIES: FailureCategory[] = [
  'network', 'ui_element', 'validation', 'timeout', 'auth', 'server', 'unknown',
];

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

const ANALYSIS_SYSTEM_PROMPT = `You are an expert QA engineer analyzing test failures.
Given error details from an automated UI/API test, produce a structured root-cause analysis.

Return ONLY valid JSON with this schema:
{
  "rootCause": "Human-readable root cause explanation (1-2 sentences)",
  "category": "network" | "ui_element" | "validation" | "timeout" | "auth" | "server" | "unknown",
  "severity": "critical" | "high" | "medium" | "low",
  "suggestions": ["Actionable fix suggestion 1", "Suggestion 2", ...],
  "affectedStep": <number or null>
}

Category definitions:
- network: DNS, connection refused, CORS, HTTP errors (4xx/5xx from external calls)
- ui_element: Element not found, click intercepted, stale element, selector mismatch
- validation: Assertion failed, unexpected value, wrong text content
- timeout: Page load timeout, element wait timeout, navigation timeout
- auth: Login failed, session expired, 401/403 errors
- server: 500 errors, backend crashes, database errors
- unknown: Cannot determine category from available data

Severity rules:
- critical: Complete test blocking, data loss risk, security issue
- high: Core flow broken, major feature failure
- medium: Non-critical feature failure, intermittent issue
- low: Minor UI glitch, non-blocking warning

Provide 2-4 actionable suggestions. Be specific, not generic.
If you can identify which step failed, set affectedStep (1-based index).`;

// ============================================================================
// SERVICE
// ============================================================================

export class FailureAnalysisService {
  /**
   * Analyze a failed test and produce structured root-cause analysis
   */
  static async analyze(testId: string, userId: string): Promise<FailureAnalysisResult> {
    logger.info('[FAILURE_ANALYSIS] Starting analysis', { testId, userId });

    // 1. Fetch test data with ownership check
    const test = await this.fetchTest(testId, userId);

    // 2. Early check: if test passed/completed with no errors, inform user
    if (test.status === 'completed') {
      return {
        rootCause: 'This test completed successfully — no failure detected.',
        category: 'unknown',
        severity: 'low',
        suggestions: ['The test passed. If you expected a failure, re-run the test or check a different test ID.'],
        errorDetails: `Test status: ${test.status}`,
      };
    }

    // 3 + 4. Fetch test results, intelligent session, and integration status in parallel
    const workspaceId = (test.projects as any)?.workspace_id;
    const [testResults, session, integrationContext] = await Promise.all([
      this.fetchTestResults(testId),
      this.fetchIntelligentSession(testId),
      import('@/services/api/integration-token.service')
        .then(m => m.IntegrationTokenService.getIntegrationSummary(userId, workspaceId ?? undefined))
        .catch(() => ''),
    ]);

    // 5. Build error summary (truncated to stay within LLM limits)
    let errorDetails = this.buildErrorSummary(test, testResults, session);
    if (errorDetails.length > MAX_ERROR_SUMMARY_LENGTH) {
      errorDetails = errorDetails.substring(0, MAX_ERROR_SUMMARY_LENGTH) + '\n\n[... truncated]';
    }

    // 6. Search intelligent_test_findings for similar past failures in same project
    let memoryContext = '';
    try {
      // Get all session IDs for this project (excluding current session)
      const { data: projectSessions } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('project_id', test.project_id)
        .limit(50);

      const sessionIds = (projectSessions || [])
        .map(s => s.id)
        .filter(id => !session || id !== session.id);

      if (sessionIds.length > 0) {
        const { data: pastFindings } = await supabaseAdmin
          .from('intelligent_test_findings')
          .select('title, description, severity, finding_type')
          .in('session_id', sessionIds)
          .eq('finding_type', 'bug')
          .order('found_at', { ascending: false })
          .limit(5);

        if (pastFindings && pastFindings.length > 0) {
          memoryContext = '\n\nPreviously seen similar issues in this project:\n' +
            pastFindings.map(f => `- [${f.severity}] ${f.title}: ${(f.description || '').slice(0, 150)}`).join('\n');
          logger.info('[FAILURE_ANALYSIS] Found similar past failures in findings', {
            testId, matchCount: pastFindings.length,
          });
        }
      }
    } catch {
      // Non-fatal — continue analysis without memory context
    }

    // 7. Call LLM for analysis (with memory + integration context)
    const analysis = await this.callLLM(errorDetails + memoryContext, integrationContext);

    logger.info('[FAILURE_ANALYSIS] Analysis complete', {
      testId,
      category: analysis.category,
      severity: analysis.severity,
    });

    return { ...analysis, errorDetails };
  }

  /**
   * Fetch test with ownership verification
   */
  private static async fetchTest(testId: string, userId: string): Promise<any> {
    const { data: test, error } = await supabaseAdmin
      .from('tests')
      .select('id, project_id, status, url, goal, browsers, metadata, created_at, projects!inner(user_id, workspace_id)')
      .eq('id', testId)
      .single();

    if (error || !test) {
      throw new Error(`Test not found: ${testId}`);
    }

    const projectUserId = (test.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new Error('Access denied to this test');
    }

    return test;
  }

  /**
   * Fetch test_results for error data
   */
  private static async fetchTestResults(testId: string): Promise<any[]> {
    const { data, error } = await supabaseAdmin
      .from('test_results')
      .select('id, status, browser, errors, created_at')
      .eq('test_id', testId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      logger.warn('[FAILURE_ANALYSIS] Failed to fetch test_results', { error, testId });
      return [];
    }

    return data || [];
  }

  /**
   * Fetch intelligent test session for graph/execution context
   */
  private static async fetchIntelligentSession(testId: string): Promise<any | null> {
    const { data, error } = await supabaseAdmin
      .from('intelligent_test_sessions')
      .select('id, graph_data, result, status')
      .eq('test_id', testId)
      .maybeSingle();

    if (error) {
      logger.warn('[FAILURE_ANALYSIS] Failed to fetch intelligent session', { error, testId });
      return null;
    }

    return data;
  }

  /**
   * Build structured error summary text for LLM consumption
   */
  private static buildErrorSummary(test: any, testResults: any[], session: any): string {
    const parts: string[] = [];

    parts.push(`Test URL: ${test.url || 'N/A'}`);
    parts.push(`Test Goal: ${test.goal || 'N/A'}`);
    parts.push(`Test Status: ${test.status}`);
    parts.push(`Browsers: ${JSON.stringify(test.browsers || [])}`);

    // Add error details from test results
    if (testResults.length > 0) {
      parts.push('\n--- Test Results ---');
      for (const result of testResults) {
        parts.push(`Browser: ${result.browser || 'unknown'}, Status: ${result.status}`);
        if (result.errors) {
          const errors = Array.isArray(result.errors) ? result.errors : [result.errors];
          for (const err of errors) {
            if (typeof err === 'string') {
              parts.push(`Error: ${err}`);
            } else if (err?.message) {
              parts.push(`Error: ${err.message}`);
              if (err.stack) parts.push(`Stack: ${err.stack.substring(0, 500)}`);
            }
          }
        }
      }
    }

    // Add execution context from intelligent session
    if (session?.result) {
      const result = session.result;
      if (result.error) {
        parts.push(`\n--- Session Error ---`);
        parts.push(`Session Error: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error).substring(0, 500)}`);
      }
      if (result.executedSteps && Array.isArray(result.executedSteps)) {
        const failedSteps = result.executedSteps.filter((s: any) => s.success === false);
        if (failedSteps.length > 0) {
          parts.push(`\n--- Failed Steps ---`);
          for (const step of failedSteps) {
            parts.push(`Step: ${step.action || 'unknown'} | ${step.description || ''} | Error: ${step.error || 'N/A'}`);
          }
        }
        parts.push(`Total steps executed: ${result.executedSteps.length}`);
      }
    }

    // Add graph context for step mapping
    if (session?.graph_data?.nodes) {
      const failedNodes = session.graph_data.nodes.filter(
        (n: any) => n.status === 'failed' || n.status === 'error'
      );
      if (failedNodes.length > 0) {
        parts.push(`\n--- Failed Graph Nodes ---`);
        for (const node of failedNodes.slice(0, 5)) {
          parts.push(`Node: ${node.label || node.stepType || 'unknown'} | Status: ${node.status}`);
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Call LLM for structured failure analysis
   */
  private static async callLLM(errorDetails: string, integrationContext?: string): Promise<Omit<FailureAnalysisResult, 'errorDetails'>> {
    try {
      const integrationHint = integrationContext
        ? `\n\nUser's integrations: ${integrationContext}\nWhen suggesting fixes, consider available integrations (e.g. "Create a Jira issue" if Jira is connected).`
        : '';

      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: `Analyze this test failure:\n\n${errorDetails}${integrationHint}` },
        ],
        {
          model: LLM_MODEL,
          temperature: LLM_TEMPERATURE,
          max_tokens: LLM_MAX_TOKENS,
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(response.content);
      return this.validateLLMResponse(parsed);
    } catch (error) {
      logger.error('[FAILURE_ANALYSIS] LLM call failed, using fallback', { error });
      return {
        rootCause: 'Unable to determine root cause automatically. Please review error details manually.',
        category: 'unknown',
        severity: 'medium',
        suggestions: ['Review the error details below', 'Check if the test environment is accessible', 'Try re-running the test'],
      };
    }
  }

  /**
   * Validate and sanitize LLM response
   */
  private static validateLLMResponse(parsed: any): Omit<FailureAnalysisResult, 'errorDetails'> {
    return {
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : 'Unknown root cause',
      category: VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'unknown',
      severity: VALID_SEVERITIES.includes(parsed.severity) ? parsed.severity : 'medium',
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s: any) => typeof s === 'string').slice(0, 5)
        : [],
      affectedStep: typeof parsed.affectedStep === 'number' ? parsed.affectedStep : undefined,
    };
  }
}
