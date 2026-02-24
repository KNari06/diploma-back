/**
 * Test Recommendation Service
 * Provides AI-powered test recommendations based on project coverage,
 * recent failures, and test history.
 * Uses LLM classification (gpt-4o-mini) to suggest what to test next.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { TestRecommendation, TestRecommendationType } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const LLM_MODEL = AI_TASK_MODELS.testRecommendation;
const LLM_TEMPERATURE = 0.3;
const LLM_MAX_TOKENS = 1200;
const MAX_RECOMMENDATIONS = 5;

const VALID_TYPES: TestRecommendationType[] = [
  'retest_failure', 'untested_area', 'stale_test', 'regression_risk',
];

const VALID_PRIORITIES = ['high', 'medium', 'low'] as const;

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

const RECOMMENDATION_SYSTEM_PROMPT = `You are an expert QA engineer advising a team on what to test next.
Given a project's test history, recent failures, and saved test cases, suggest what should be tested.

Return ONLY valid JSON with this schema:
{
  "recommendations": [
    {
      "type": "retest_failure" | "untested_area" | "stale_test" | "regression_risk",
      "title": "Short recommendation title",
      "reason": "Why this is recommended",
      "url": "URL to test (if applicable, or null)",
      "relatedTestCaseId": "ID of related saved test case (if applicable, or null)",
      "priority": "high" | "medium" | "low"
    }
  ]
}

Recommendation types:
- retest_failure: A recently failed test that should be retested after a fix
- untested_area: A URL or feature that hasn't been tested recently
- stale_test: A saved test case that hasn't been run in a while
- regression_risk: An area likely to break based on recent changes/patterns

Rules:
- Return 3-5 recommendations sorted by priority (high first)
- Be specific in titles and reasons (reference actual URLs, test names, dates)
- If there's limited data, provide general best-practice recommendations
- Focus on actionable items the user can immediately test`;

// ============================================================================
// SERVICE
// ============================================================================

export class TestRecommendationService {
  /**
   * Get AI-powered test recommendations for a project
   */
  static async getRecommendations(
    projectId: string,
    userId: string,
    workspaceId: string,
  ): Promise<TestRecommendation[]> {
    logger.info('[TEST_RECOMMENDATIONS] Generating recommendations', { projectId, userId });

    // Fetch data sources in parallel
    const [recentTests, savedCases, recentFailures] = await Promise.all([
      this.fetchRecentTests(projectId, userId),
      this.fetchSavedCases(projectId, userId),
      this.fetchRecentFailures(projectId),
    ]);

    // Build context for LLM
    const contextSummary = this.buildContextSummary(recentTests, savedCases, recentFailures);

    // Call LLM for recommendations
    const recommendations = await this.callLLM(contextSummary);

    logger.info('[TEST_RECOMMENDATIONS] Generated recommendations', {
      projectId,
      count: recommendations.length,
    });

    return recommendations;
  }

  /**
   * Fetch recent tests (last 20), grouped by URL with pass/fail counts
   */
  private static async fetchRecentTests(projectId: string, userId: string): Promise<any[]> {
    const { data, error } = await supabaseAdmin
      .from('tests')
      .select('id, url, status, goal, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.warn('[TEST_RECOMMENDATIONS] Failed to fetch recent tests', { error, projectId });
      return [];
    }

    return data || [];
  }

  /**
   * Fetch saved test cases (names, URLs, last run dates)
   */
  private static async fetchSavedCases(projectId: string, userId: string): Promise<any[]> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, url, start_url, created_at, updated_at, status')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('status', 'published')
      .order('updated_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.warn('[TEST_RECOMMENDATIONS] Failed to fetch saved cases', { error, projectId });
      return [];
    }

    return data || [];
  }

  /**
   * Fetch recent failures from test_results
   */
  private static async fetchRecentFailures(projectId: string): Promise<any[]> {
    const { data, error } = await supabaseAdmin
      .from('tests')
      .select('id, url, goal, status, created_at')
      .eq('project_id', projectId)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      logger.warn('[TEST_RECOMMENDATIONS] Failed to fetch recent failures', { error, projectId });
      return [];
    }

    return data || [];
  }

  /**
   * Build context summary for LLM
   */
  private static buildContextSummary(
    recentTests: any[],
    savedCases: any[],
    recentFailures: any[],
  ): string {
    const parts: string[] = [];

    // Recent tests summary
    parts.push('--- RECENT TESTS (last 20) ---');
    if (recentTests.length === 0) {
      parts.push('No recent tests found.');
    } else {
      // Group by URL
      const urlGroups = new Map<string, { passed: number; failed: number; lastRun: string }>();
      for (const test of recentTests) {
        const url = test.url || 'unknown';
        const group = urlGroups.get(url) || { passed: 0, failed: 0, lastRun: test.created_at };
        if (test.status === 'completed') group.passed++;
        else if (test.status === 'failed') group.failed++;
        urlGroups.set(url, group);
      }
      for (const [url, stats] of urlGroups) {
        parts.push(`URL: ${url} | Passed: ${stats.passed} | Failed: ${stats.failed} | Last run: ${stats.lastRun}`);
      }
    }

    // Saved cases summary
    parts.push('\n--- SAVED TEST CASES ---');
    if (savedCases.length === 0) {
      parts.push('No saved test cases found.');
    } else {
      for (const tc of savedCases.slice(0, 10)) {
        parts.push(`ID: ${tc.id} | Name: ${tc.name} | URL: ${tc.url || tc.start_url || 'N/A'} | Updated: ${tc.updated_at}`);
      }
    }

    // Recent failures
    parts.push('\n--- RECENT FAILURES ---');
    if (recentFailures.length === 0) {
      parts.push('No recent failures found.');
    } else {
      for (const f of recentFailures.slice(0, 5)) {
        parts.push(`Test: ${f.goal || 'N/A'} | URL: ${f.url || 'N/A'} | Failed at: ${f.created_at}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Call LLM for recommendations
   */
  private static async callLLM(contextSummary: string): Promise<TestRecommendation[]> {
    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: RECOMMENDATION_SYSTEM_PROMPT },
          { role: 'user', content: `Based on this project's testing profile, what should be tested next?\n\n${contextSummary}` },
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
      logger.error('[TEST_RECOMMENDATIONS] LLM call failed, using fallback', { error });
      return [
        {
          type: 'untested_area',
          title: 'Run a smoke test on your main flow',
          reason: 'Unable to generate AI recommendations. Start with your most critical user flow.',
          priority: 'medium',
        },
      ];
    }
  }

  /**
   * Validate and sanitize LLM response.
   * Strips hallucinated relatedTestCaseId values (LLM may invent IDs).
   * We keep the recommendation but remove the fake reference.
   */
  private static validateLLMResponse(parsed: any): TestRecommendation[] {
    const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

    // UUID pattern to validate relatedTestCaseId format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    return recs
      .slice(0, MAX_RECOMMENDATIONS)
      .map((r: any) => {
        // Only keep relatedTestCaseId if it looks like a valid UUID
        // (actual existence check would require a DB query — kept lightweight)
        const testCaseId = typeof r.relatedTestCaseId === 'string' && uuidRegex.test(r.relatedTestCaseId)
          ? r.relatedTestCaseId
          : undefined;

        return {
          type: VALID_TYPES.includes(r.type) ? r.type : 'untested_area',
          title: typeof r.title === 'string' ? r.title : 'Test recommendation',
          reason: typeof r.reason === 'string' ? r.reason : '',
          url: typeof r.url === 'string' && r.url.length > 0 ? r.url : undefined,
          relatedTestCaseId: testCaseId,
          priority: VALID_PRIORITIES.includes(r.priority) ? r.priority : 'medium',
        };
      })
      .filter((r: TestRecommendation) => r.title && r.reason);
  }
}
