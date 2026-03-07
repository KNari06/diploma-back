import crypto from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
import type {
  CommandFingerprint,
  OverallNode,
  ProjectOverallData,
  StatusFlag,
  TestCaseGroup,
  TestSource,
} from '@/types/overall.types';
import { logger } from '@/utils/core/logger';
import { OverallRelationshipService } from './overall-relationship.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OVERALL BUILDER SERVICE - Project-level test visualization
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Constructs comprehensive project visualization data:
 * - Nodes: Unique test cases (aggregated from multiple runs)
 * - Edges: Relationships between tests (URL flow, semantic similarity, etc.)
 * - Clusters: Groups of related tests
 *
 * Used by: /api/v1/test-visualization/project/:projectId/overall
 *
 * Key Features:
 * - Test run aggregation (multiple runs → one node per unique test case)
 * - Status flag detection (success, failed, danger, cancelled)
 * - Danger signal detection (retries, timeouts, warnings)
 * - Run history with pass rate tracking
 * - Findings integration
 * - Access control verification
 */

// Limits to prevent performance issues
const MAX_TESTS_FOR_OVERALL = 1000; // Prevent OOM on large projects
const MAX_RUN_HISTORY = 10; // Max run history entries per aggregated node

/**
 * Service for building project-level overall visualization data
 * Constructs nodes, edges, and clusters for the "planet" view
 */
export class OverallBuilderService {
  /**
   * Build complete project overall visualization
   * Groups test runs into unique test cases and builds relationships between them
   *
   * @param projectId - Project UUID
   * @param userId - User UUID for access verification
   * @returns Complete visualization data with nodes, edges, clusters
   * @throws {NotFoundError} If project not found
   * @throws {ValidationError} If access denied
   */
  static async buildProjectOverall(
    projectId: string,
    userId: string
  ): Promise<ProjectOverallData> {
    try {
      logger.info('[OVERALL_BUILDER] Building project overall', { projectId, userId });

      // 1. Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // 2. Get all tests for project (with limit for performance)
      const tests = await this.getProjectTests(projectId);

      // 3. Get intelligent sessions with graph_data for tests
      const sessionsMap = await this.getIntelligentSessions(
        tests.map(t => t.id)
      );

      // 4. Group test runs into unique test cases
      const testCaseGroups = this.groupTestsByTestCase(tests);

      // 5. Extract representative tests (one per group) for relationship analysis
      const representativeTests = Array.from(testCaseGroups.values()).map(g => g.representative);

      logger.info('[OVERALL_BUILDER] Tests grouped into test cases', {
        projectId,
        totalRuns: tests.length,
        uniqueTestCases: representativeTests.length,
      });

      // 6. Build edges, clusters, and fingerprints using only representative tests
      const { edges, clusters, fingerprints } = await OverallRelationshipService.buildRelationshipsAndClusters(
        representativeTests,
        sessionsMap
      );

      // 7. Build aggregated nodes (with run history)
      const nodes = await this.buildAggregatedNodes(
        testCaseGroups,
        sessionsMap,
        fingerprints
      );

      logger.info('[OVERALL_BUILDER] Project overall built', {
        projectId,
        nodesCount: nodes.length,
        edgesCount: edges.length,
        clustersCount: clusters.length,
      });

      return {
        nodes,
        edges,
        clusters,
        metadata: {
          projectId,
          totalTests: tests.length,
          uniqueTestCases: testCaseGroups.size,
          totalSavedCases: 0, // Phase 2
          totalModules: 0, // Phase 2
          generatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      logger.error('[OVERALL_BUILDER] Failed to build project overall', {
        error,
        projectId,
        userId,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST CASE GROUPING - Aggregate runs into unique test cases
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Group test runs into unique test cases
   *
   * Strategy:
   * 1. Regression tests: Group by options.metadata.intentTestCaseId
   * 2. Tests with commands: Group by sha256(normalizedUrl + commandsStructureHash)
   * 3. Fallback: Group by sha256(url + test_goal)
   */
  private static groupTestsByTestCase(
    tests: any[]
  ): Map<string, TestCaseGroup> {
    const groups = new Map<string, TestCaseGroup>();

    for (const test of tests) {
      const groupKey = this.computeGroupKey(test, null);

      if (groups.has(groupKey)) {
        const group = groups.get(groupKey)!;
        group.tests.push(test);
        // Keep representative as the most recent test
        const testDate = new Date(test.completed_at || test.created_at).getTime();
        const repDate = new Date(group.representative.completed_at || group.representative.created_at).getTime();
        if (testDate > repDate) {
          group.representative = test;
        }
      } else {
        const intentTestCaseId = test.options?.metadata?.intentTestCaseId;
        groups.set(groupKey, {
          groupKey,
          groupType: intentTestCaseId ? 'regression' : 'fingerprint',
          intentTestCaseId: intentTestCaseId || undefined,
          tests: [test],
          representative: test,
        });
      }
    }

    return groups;
  }

  /**
   * Compute a stable group key for a test run
   *
   * Priority:
   * 1. intentTestCaseId (regression tests) -> "intent:<id>"
   * 2. commands array -> sha256(normalizedUrl + commandsHash)
   * 3. Fallback -> sha256(normalizedUrl + testGoal)
   *
   * Note: We intentionally do NOT use graph_data/fingerprint for grouping.
   * Sessions are stored per-test-id and sessionsMap may not have entries
   * for older runs (overwritten by newer sessions). Using graph_data would
   * cause runs of the same test to split into different groups depending
   * on whether their session exists in the map.
   * Commands and URL are stable across runs and always available on the test record.
   */
  private static computeGroupKey(test: any, _session: any): string {
    // Path 1: Regression tests with explicit intentTestCaseId
    const intentId = test.options?.metadata?.intentTestCaseId;
    if (intentId) {
      return `intent:${intentId}`;
    }

    const normalizedUrl = this.normalizeUrlForGrouping(test.url || '');

    // Path 2: Tests with commands array (stable across reruns)
    if (Array.isArray(test.commands) && test.commands.length > 0) {
      const commandsHash = this.hashCommands(test.commands);
      return this.sha256(`cmd:${normalizedUrl}:${commandsHash}`);
    }

    // Path 3: Fallback - group by URL + testGoal
    // This covers: intelligent tests (no commands), pending tests, tests with empty commands
    const goal = test.test_goal || test.options?.testGoal || '';
    return this.sha256(`fallback:${normalizedUrl}:${goal}`);
  }

  private static normalizeUrlForGrouping(url: string): string {
    if (!url) return '';
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return url.toLowerCase().trim();
    }
  }

  private static hashCommands(commands: any[]): string {
    const normalized = commands
      .filter(cmd => cmd && cmd.action)
      .map(cmd => {
        const parts = [cmd.action];
        if (cmd.selector) parts.push(cmd.selector);
        if (cmd.url) parts.push(cmd.url);
        return parts.join('|');
      })
      .join('::');
    return this.sha256(normalized);
  }

  private static sha256(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AGGREGATED NODE BUILDING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build aggregated nodes from test case groups
   * Each node represents a unique test case with run history metadata
   */
  private static async buildAggregatedNodes(
    groups: Map<string, TestCaseGroup>,
    sessionsMap: Map<string, any>,
    fingerprints: Map<string, CommandFingerprint>
  ): Promise<OverallNode[]> {
    // Batch: collect all session IDs to check findings in one query
    const sessionIds: string[] = [];
    for (const group of groups.values()) {
      const session = sessionsMap.get(group.representative.id);
      if (session?.id) sessionIds.push(session.id);
    }
    const findingsSet = await this.batchCheckForFindings(sessionIds);

    const nodes: OverallNode[] = [];

    for (const [groupKey, group] of groups) {
      const rep = group.representative;
      const session = sessionsMap.get(rep.id);

      // Sort all runs by date DESC (most recent first)
      const sortedRuns = group.tests.sort(
        (a, b) => new Date(b.completed_at || b.created_at).getTime()
              - new Date(a.completed_at || a.created_at).getTime()
      );

      const statusFlag = this.determineStatusFlag(rep, session);
      const source = this.determineSource(rep);
      const label = this.computeGroupLabel(rep, session);

      // Pass rate
      const completedRuns = sortedRuns.filter(t =>
        t.status === 'completed' || t.status === 'failed' || t.status === 'timeout'
      );
      const passedCount = completedRuns.filter(t => {
        const s = sessionsMap.get(t.id);
        return t.status === 'completed' && !(s && s.success === false);
      }).length;
      const passRate = completedRuns.length > 0
        ? Math.round((passedCount / completedRuns.length) * 100) / 100
        : undefined;

      // Average duration
      const durations = sortedRuns
        .map(t => sessionsMap.get(t.id)?.duration_ms)
        .filter((d): d is number => typeof d === 'number' && d > 0);
      const avgDurationMs = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : session?.duration_ms || undefined;

      // Run history (last N)
      const runHistory = sortedRuns.slice(0, MAX_RUN_HISTORY).map(t => ({
        testId: t.id,
        status: t.status,
        runAt: t.completed_at || t.created_at,
      }));

      // Build meta
      const meta: OverallNode['meta'] = {
        url: rep.url,
        browsers: rep.browsers || [],
        pagesVisited: session?.pages_visited,
        actionsTaken: session?.actions_taken,
        durationMs: session?.duration_ms,
        runCount: sortedRuns.length,
        passRate,
        runHistory,
        avgDurationMs,
        groupKey,
      };

      if (group.intentTestCaseId) {
        meta.intentTestCaseId = group.intentTestCaseId;
      }

      // Attach fingerprint
      const fp = fingerprints.get(rep.id);
      if (fp) {
        meta.fingerprint = fp;
      }

      // Check for findings (from batched result)
      if (session?.id && findingsSet.has(session.id)) {
        meta.hasFindings = true;
      }

      nodes.push({
        id: rep.id,
        entityType: sortedRuns.length > 1 ? 'test_case' : 'test_run',
        label,
        statusFlag,
        source,
        lastRunAt: rep.completed_at || rep.created_at,
        meta,
      });
    }

    return nodes;
  }

  private static determineSource(test: any): TestSource {
    if (test.options?.metadata?.source === 'intent_test_case') return 'regression';
    if (test.intelligent_mode) return 'intelligent';
    if (test.options?.chatSessionId) return 'api';
    return 'manual';
  }

  private static computeGroupLabel(rep: any, session: any): string {
    const intentName = rep.options?.metadata?.intentTestCaseName;
    if (intentName) return intentName;
    if (session?.goal) return session.goal;
    if (rep.test_goal) return rep.test_goal;
    if (rep.url) return rep.url;
    return `Test ${rep.id.substring(0, 8)}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACCESS & DATA FETCHING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Verify user has access to project
   *
   * @throws {NotFoundError} If project not found
   * @throws {ValidationError} If access denied
   */
  private static async verifyProjectAccess(
    projectId: string,
    userId: string
  ): Promise<void> {
    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error) {
      logger.error('[OVERALL_BUILDER] Database error verifying project access', {
        error,
        projectId,
      });
      throw new Error(`Failed to get project: ${error.message}`);
    }

    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id !== userId) {
      throw new ValidationError('Access denied to this project');
    }
  }

  /**
   * Get all tests for project
   * Ordered by most recent first (for limiting if needed)
   */
  private static async getProjectTests(projectId: string): Promise<any[]> {
    const { data: tests, error } = await supabaseAdmin
      .from('tests')
      .select('id, url, status, browsers, project_id, user_id, options, commands, test_goal, intelligent_mode, created_at, completed_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(MAX_TESTS_FOR_OVERALL);

    if (error) {
      throw new Error(`Failed to get tests: ${error.message}`);
    }

    return tests || [];
  }

  /**
   * Get intelligent test sessions with graph_data
   * Batch loads sessions for multiple tests efficiently
   */
  private static async getIntelligentSessions(
    testIds: string[]
  ): Promise<Map<string, any>> {
    if (testIds.length === 0) {
      return new Map();
    }

    const BATCH_SIZE = 100;
    const sessionsMap = new Map();

    // Build batches and fetch in parallel
    const batches: string[][] = [];
    for (let i = 0; i < testIds.length; i += BATCH_SIZE) {
      batches.push(testIds.slice(i, i + BATCH_SIZE));
    }

    const results = await Promise.all(
      batches.map(async (batch, idx) => {
        const { data: sessions, error } = await supabaseAdmin
          .from('intelligent_test_sessions')
          .select(
            'id, test_id, graph_data, goal, summary, pages_visited, actions_taken, duration_ms, success'
          )
          .in('test_id', batch);

        if (error) {
          logger.warn('[OVERALL_BUILDER] Failed to get intelligent sessions', {
            error,
            batchIndex: idx,
          });
          return [];
        }
        return sessions || [];
      })
    );

    for (const sessions of results) {
      for (const session of sessions) {
        sessionsMap.set(session.test_id, session);
      }
    }

    return sessionsMap;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATUS & DANGER DETECTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Determine status flag for a test
   *
   * Priority order:
   * 1. cancelled -> 'cancelled'
   * 2. failed/timeout -> 'failed'
   * 3. success with danger signals -> 'danger'
   * 4. success without danger -> 'success'
   */
  private static determineStatusFlag(test: any, session: any): StatusFlag {
    if (test.status === 'cancelled') {
      return 'cancelled';
    }

    if (test.status === 'failed' || test.status === 'timeout') {
      return 'failed';
    }

    if (test.status === 'completed') {
      if (session && session.success === false) {
        return 'failed';
      }

      const hasDangerSignals = this.checkDangerSignals(session);
      if (hasDangerSignals) {
        return 'danger';
      }

      return 'success';
    }

    if (test.status === 'running' || test.status === 'pending') {
      logger.debug('[OVERALL_BUILDER] Test still in progress', {
        testId: test.id,
        status: test.status,
      });
      return 'failed';
    }

    logger.warn('[OVERALL_BUILDER] Unknown test status', {
      testId: test.id,
      status: test.status,
    });
    return 'failed';
  }

  /**
   * Check for danger signals (flaky/warning) in graph_data
   * Danger = test passed but with retries, timeouts, or warnings
   */
  private static checkDangerSignals(session: any): boolean {
    if (!session?.graph_data?.nodes || !Array.isArray(session.graph_data.nodes)) {
      return false;
    }

    const nodes = session.graph_data.nodes;

    for (const node of nodes) {
      if (!node || !node.meta) continue;

      if (
        typeof node.meta.retryCount === 'number' &&
        node.meta.retryCount > 0
      ) {
        return true;
      }

      if (node.meta.isTimeout === true) {
        return true;
      }

      if (node.meta.warning) {
        return true;
      }
    }

    return false;
  }

  /**
   * Batch check which sessions have findings (single query instead of N+1)
   * @returns Set of session IDs that have at least one finding
   */
  private static async batchCheckForFindings(sessionIds: string[]): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();

    try {
      const { data, error } = await supabaseAdmin
        .from('intelligent_test_findings')
        .select('session_id')
        .in('session_id', sessionIds);

      if (error) {
        logger.warn('[OVERALL_BUILDER] Failed to batch check findings', { error });
        return new Set();
      }

      return new Set((data || []).map((r: any) => r.session_id));
    } catch (err) {
      logger.warn('[OVERALL_BUILDER] batchCheckForFindings failed', { error: (err as Error).message });
      return new Set();
    }
  }
}
