/**
 * Coverage Analysis Service
 * Analyzes project test coverage by cross-referencing saved test cases,
 * recent test executions, and page visit data.
 * Returns a scored coverage report with identified gaps.
 * No tests are executed — pure DB analysis + LLM summary.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { PatternsQueryService } from '@/services/kb/patterns-query.service';
import { CoverageGap, CoverageReport } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { normalizeCoverageUrl } from '@/utils/parsing/url-scope';

// ============================================================================
// CONSTANTS
// ============================================================================

const LLM_MODEL = AI_TASK_MODELS.coverageAnalysis;
const LLM_TEMPERATURE = 0.3;
const LLM_MAX_TOKENS = 1500;

/** Tests not run in this many days are considered stale */
const STALE_THRESHOLD_DAYS = 14;

/** How far back to look for test executions */
const EXECUTION_LOOKBACK_DAYS = 30;

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface UrlCoverageEntry {
  url: string;
  hasTestCase: boolean;
  testCaseIds: string[];
  executionCount: number;
  lastExecuted: string | null;
  visitCount: number;
  failureCount: number;
}

interface RawTestCase {
  id: string;
  name: string;
  url: string | null;
  start_url: string | null;
  status: string;
  updated_at: string;
}

interface RawExecution {
  id: string;
  status: string;
  test_case_id: string;
  created_at: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export class CoverageAnalysisService {
  /**
   * Main entry point — analyze project coverage
   */
  static async analyze(
    projectId: string,
    _userId: string,
    workspaceId: string,
  ): Promise<CoverageReport> {
    logger.info('[COVERAGE_ANALYSIS] Starting analysis', { projectId });

    // Fetch all data sources in parallel
    const [savedCases, executions, pageVisits] = await Promise.all([
      this.fetchSavedTestCases(projectId),
      this.fetchTestExecutions(projectId, workspaceId),
      this.fetchPageVisits(projectId),
    ]);

    // Build unified coverage map
    const coverageMap = this.buildCoverageMap(savedCases, executions, pageVisits);

    // Identify gaps
    const gaps = this.identifyGaps(coverageMap, savedCases);

    // Calculate score
    const totalUrls = coverageMap.size;
    const coveredUrls = [...coverageMap.values()].filter(
      e => e.hasTestCase && e.executionCount > 0,
    ).length;
    const staleTestCases = this.countStaleCases(savedCases, executions);
    const score = this.calculateScore(totalUrls, coveredUrls, gaps.length, staleTestCases, savedCases.length);

    // LLM summary
    const summary = await this.callLLM(score, totalUrls, coveredUrls, savedCases.length, staleTestCases, gaps);

    const report: CoverageReport = {
      score,
      totalUrls,
      coveredUrls,
      totalTestCases: savedCases.length,
      staleTestCases,
      gaps,
      summary,
    };

    logger.info('[COVERAGE_ANALYSIS] Analysis complete', {
      projectId,
      score,
      totalUrls,
      coveredUrls,
      gapCount: gaps.length,
    });

    return report;
  }

  // ==========================================================================
  // DATA FETCHING
  // ==========================================================================

  /**
   * Fetch all published intent test cases for the project (project-wide, no user filter)
   */
  private static async fetchSavedTestCases(projectId: string): Promise<RawTestCase[]> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, url, start_url, status, updated_at')
      .eq('project_id', projectId)
      .eq('status', 'published')
      .order('updated_at', { ascending: false });

    if (error) {
      logger.warn('[COVERAGE_ANALYSIS] Failed to fetch test cases', { error, projectId });
      return [];
    }

    return (data || []) as RawTestCase[];
  }

  /**
   * Fetch test executions from the last 30 days.
   * Uses the same 2-step pattern as AnalyticsQueryService: get runIds → get executions.
   */
  private static async fetchTestExecutions(
    projectId: string,
    _workspaceId: string,
  ): Promise<RawExecution[]> {
    const since = new Date();
    since.setDate(since.getDate() - EXECUTION_LOOKBACK_DAYS);

    // Step 1: get run IDs for this project in the time window
    const { data: runs, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id')
      .eq('project_id', projectId)
      .gte('started_at', since.toISOString());

    if (runError) {
      logger.warn('[COVERAGE_ANALYSIS] Failed to fetch run IDs', { error: runError, projectId });
      return [];
    }

    const runIds = (runs || []).map(r => r.id);
    if (runIds.length === 0) return [];

    // Step 2: get executions for those runs
    const { data: executions, error: execError } = await supabaseAdmin
      .from('test_executions')
      .select('id, status, test_case_id, created_at')
      .in('run_id', runIds);

    if (execError) {
      logger.warn('[COVERAGE_ANALYSIS] Failed to fetch executions', { error: execError, projectId });
      return [];
    }

    return (executions || []) as RawExecution[];
  }

  /**
   * Fetch page visit patterns — reuses PatternsQueryService
   */
  private static async fetchPageVisits(
    projectId: string,
  ): Promise<Array<{ url: string; visitCount: number }>> {
    try {
      const patterns = await PatternsQueryService.getPagePatterns(projectId, 50);
      return patterns.map(p => ({ url: p.url, visitCount: p.visitCount }));
    } catch (error) {
      logger.warn('[COVERAGE_ANALYSIS] Failed to fetch page visits', { error, projectId });
      return [];
    }
  }

  // ==========================================================================
  // COVERAGE MAP
  // ==========================================================================

  /**
   * Merge 3 data sources into a unified URL → coverage entry map.
   * URL normalization: strip query params, trailing slashes, lowercase protocol+host.
   */
  private static buildCoverageMap(
    savedCases: RawTestCase[],
    executions: RawExecution[],
    pageVisits: Array<{ url: string; visitCount: number }>,
  ): Map<string, UrlCoverageEntry> {
    const map = new Map<string, UrlCoverageEntry>();

    const getOrCreate = (rawUrl: string): UrlCoverageEntry => {
      const normalized = this.normalizeUrl(rawUrl);
      if (!map.has(normalized)) {
        map.set(normalized, {
          url: normalized,
          hasTestCase: false,
          testCaseIds: [],
          executionCount: 0,
          lastExecuted: null,
          visitCount: 0,
          failureCount: 0,
        });
      }
      return map.get(normalized)!;
    };

    // 1. Add saved test cases
    for (const tc of savedCases) {
      const url = tc.url || tc.start_url;
      if (!url) continue;
      const entry = getOrCreate(url);
      entry.hasTestCase = true;
      entry.testCaseIds.push(tc.id);
    }

    // 2. Map executions to test cases → URLs
    const testCaseUrlMap = new Map<string, string>();
    for (const tc of savedCases) {
      const url = tc.url || tc.start_url;
      if (url) testCaseUrlMap.set(tc.id, url);
    }

    for (const exec of executions) {
      const url = testCaseUrlMap.get(exec.test_case_id);
      if (!url) continue;
      const entry = getOrCreate(url);
      entry.executionCount++;
      if (exec.status === 'failed') entry.failureCount++;
      if (!entry.lastExecuted || exec.created_at > entry.lastExecuted) {
        entry.lastExecuted = exec.created_at;
      }
    }

    // 3. Add page visits (URLs visited during testing but may not have test cases)
    for (const pv of pageVisits) {
      const entry = getOrCreate(pv.url);
      entry.visitCount += pv.visitCount;
    }

    return map;
  }

  // ==========================================================================
  // GAP IDENTIFICATION
  // ==========================================================================

  /**
   * Identify coverage gaps from the unified map
   */
  private static identifyGaps(
    coverageMap: Map<string, UrlCoverageEntry>,
    savedCases: RawTestCase[],
  ): CoverageGap[] {
    const gaps: CoverageGap[] = [];

    // 1. Untested URLs: visited pages with no test case
    for (const entry of coverageMap.values()) {
      if (!entry.hasTestCase && entry.visitCount > 0) {
        gaps.push({
          type: 'untested_url',
          title: `No test case for ${entry.url}`,
          description: `This URL was visited ${entry.visitCount} time(s) during testing sessions but has no saved test case covering it.`,
          url: entry.url,
          priority: entry.visitCount >= 5 ? 'high' : entry.visitCount >= 2 ? 'medium' : 'low',
        });
      }
    }

    // 2. Unstable areas: URLs with high failure rate
    for (const entry of coverageMap.values()) {
      if (entry.executionCount >= 2 && entry.failureCount / entry.executionCount > 0.5) {
        gaps.push({
          type: 'unstable_area',
          title: `Unstable: ${entry.url}`,
          description: `${entry.failureCount} of ${entry.executionCount} recent executions failed (${Math.round(entry.failureCount / entry.executionCount * 100)}% failure rate).`,
          url: entry.url,
          priority: 'high',
        });
      }
    }

    // 3. Stale tests: test cases not executed recently
    const now = Date.now();
    const staleMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    for (const entry of coverageMap.values()) {
      if (entry.hasTestCase && entry.executionCount === 0) {
        // Has test case but never executed in the lookback window
        for (const tcId of entry.testCaseIds) {
          const tc = savedCases.find(c => c.id === tcId);
          gaps.push({
            type: 'stale_test',
            title: `Never executed: ${tc?.name || tcId}`,
            description: `This test case exists but hasn't been run in the last ${EXECUTION_LOOKBACK_DAYS} days.`,
            url: entry.url,
            testCaseId: tcId,
            priority: 'medium',
          });
        }
      } else if (entry.hasTestCase && entry.lastExecuted) {
        const lastExecTime = new Date(entry.lastExecuted).getTime();
        if (now - lastExecTime > staleMs) {
          gaps.push({
            type: 'stale_test',
            title: `Stale: ${entry.url}`,
            description: `Last executed ${Math.round((now - lastExecTime) / (24 * 60 * 60 * 1000))} days ago.`,
            url: entry.url,
            priority: 'low',
          });
        }
      }
    }

    // 4. No test case at all: test cases with no URL (orphaned)
    for (const tc of savedCases) {
      if (!tc.url && !tc.start_url) {
        gaps.push({
          type: 'no_test_case',
          title: `No URL: ${tc.name}`,
          description: 'This test case has no associated URL, making it hard to track coverage.',
          testCaseId: tc.id,
          priority: 'low',
        });
      }
    }

    // Sort: high → medium → low
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    gaps.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));

    return gaps;
  }

  // ==========================================================================
  // SCORING
  // ==========================================================================

  /**
   * Count test cases that haven't been executed recently
   */
  private static countStaleCases(
    savedCases: RawTestCase[],
    executions: RawExecution[],
  ): number {
    const executedCaseIds = new Set(executions.map(e => e.test_case_id));
    return savedCases.filter(tc => !executedCaseIds.has(tc.id)).length;
  }

  /**
   * Calculate a 0-100 coverage score.
   * Weighted: URL coverage (50%), gap penalty (30%), staleness penalty (20%).
   */
  private static calculateScore(
    totalUrls: number,
    coveredUrls: number,
    gapCount: number,
    staleCases: number,
    totalCases: number,
  ): number {
    if (totalUrls === 0 && totalCases === 0) return 0;

    // URL coverage ratio (0-1)
    const urlRatio = totalUrls > 0 ? coveredUrls / totalUrls : 0;

    // Gap penalty: more gaps = lower score
    const maxGaps = Math.max(totalUrls, 5);
    const gapRatio = 1 - Math.min(gapCount / maxGaps, 1);

    // Staleness ratio: fewer stale = better
    const stalenessRatio = totalCases > 0 ? 1 - (staleCases / totalCases) : 0;

    const score = Math.round(
      urlRatio * 50 + gapRatio * 30 + stalenessRatio * 20,
    );

    return Math.max(0, Math.min(100, score));
  }

  // ==========================================================================
  // LLM SUMMARY
  // ==========================================================================

  /**
   * Use LLM to generate a human-readable coverage summary
   */
  private static async callLLM(
    score: number,
    totalUrls: number,
    coveredUrls: number,
    totalCases: number,
    staleCases: number,
    gaps: CoverageGap[],
  ): Promise<string> {
    const gapSummary = gaps.slice(0, 10).map(g =>
      `- [${g.priority.toUpperCase()}] ${g.type}: ${g.title}`,
    ).join('\n');

    const userPrompt = `Summarize this test coverage report in 3-5 sentences. Be specific and actionable.

Score: ${score}/100
URLs found: ${totalUrls}, covered by tests: ${coveredUrls}
Test cases: ${totalCases}, stale (not run in 14+ days): ${staleCases}
Top gaps:
${gapSummary || 'No gaps identified.'}`;

    try {
      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: 'You are a QA lead summarizing a test coverage report. Be concise, specific, and actionable. Use plain text (no markdown headers). Mention the score and top priorities.',
          },
          { role: 'user', content: userPrompt },
        ],
        {
          model: LLM_MODEL,
          temperature: LLM_TEMPERATURE,
          max_tokens: LLM_MAX_TOKENS,
        },
      );

      return response.content;
    } catch (error) {
      logger.error('[COVERAGE_ANALYSIS] LLM summary failed', { error });
      return `Coverage score: ${score}/100. ${coveredUrls}/${totalUrls} URLs covered. ${gaps.length} gap(s) found. ${staleCases} stale test case(s).`;
    }
  }

  // ==========================================================================
  // URL NORMALIZATION
  // ==========================================================================

  /**
   * Normalize URL for comparison: strip query params, trailing slash, lowercase host.
   * Delegates to the shared `normalizeCoverageUrl` so readiness scoping keys URLs
   * identically to this map (see critical-patterns.md #10).
   */
  private static normalizeUrl(rawUrl: string): string {
    return normalizeCoverageUrl(rawUrl);
  }
}
