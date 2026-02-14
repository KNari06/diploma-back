import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
import type {
  CommandFingerprint,
  OverallNode,
  ProjectOverallData,
  StatusFlag,
} from '@/types/overall.types';
import { logger } from '@/utils/core/logger';
import { OverallRelationshipService } from './overall-relationship.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OVERALL BUILDER SERVICE - Project-level test visualization
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Constructs comprehensive project visualization data:
 * - Nodes: Individual test entities with status flags
 * - Edges: Relationships between tests (URL flow, semantic similarity, etc.)
 * - Clusters: Groups of related tests
 *
 * Used by: /api/v1/test-visualization/project/:projectId/overall
 *
 * Key Features:
 * - Status flag detection (success, failed, danger, cancelled)
 * - Danger signal detection (retries, timeouts, warnings)
 * - Findings integration
 * - Access control verification
 */

// Limits to prevent performance issues
const MAX_TESTS_FOR_OVERALL = 1000; // Prevent OOM on large projects

/**
 * Service for building project-level overall visualization data
 * Constructs nodes, edges, and clusters for the "planet" view
 */
export class OverallBuilderService {
  /**
   * Build complete project overall visualization
   * Currently includes test_run entities (Phase 1)
   * Future: Will include saved_cases and suites (Phase 2)
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

      // ✅ Performance: Limit tests to prevent OOM
      if (tests.length > MAX_TESTS_FOR_OVERALL) {
        logger.warn('[OVERALL_BUILDER] Too many tests, limiting to most recent', {
          projectId,
          totalTests: tests.length,
          limitedTo: MAX_TESTS_FOR_OVERALL,
        });
        tests.splice(MAX_TESTS_FOR_OVERALL); // Keep only first N (most recent)
      }

      // 3. Get intelligent sessions with graph_data for tests
      const sessionsMap = await this.getIntelligentSessions(
        tests.map(t => t.id)
      );

      // 4. Build edges, clusters, and fingerprints using RelationshipService
      const { edges, clusters, fingerprints } = await OverallRelationshipService.buildRelationshipsAndClusters(
        tests,
        sessionsMap
      );

      // 5. Build nodes (with fingerprints attached)
      const nodes = await this.buildNodes(tests, sessionsMap, fingerprints);

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
   *
   * @returns Array of test records (may be truncated to MAX_TESTS_FOR_OVERALL)
   */
  private static async getProjectTests(projectId: string): Promise<any[]> {
    const { data: tests, error } = await supabaseAdmin
      .from('tests')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get tests: ${error.message}`);
    }

    return tests || [];
  }

  /**
   * Get intelligent test sessions with graph_data
   * Batch loads sessions for multiple tests efficiently
   *
   * @param testIds - Array of test UUIDs
   * @returns Map of testId -> session data
   */
  private static async getIntelligentSessions(
    testIds: string[]
  ): Promise<Map<string, any>> {
    if (testIds.length === 0) {
      return new Map();
    }

    // ✅ Performance: Batch process in chunks if too many
    const BATCH_SIZE = 100;
    const sessionsMap = new Map();

    for (let i = 0; i < testIds.length; i += BATCH_SIZE) {
      const batch = testIds.slice(i, i + BATCH_SIZE);

      const { data: sessions, error } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select(
          'id, test_id, graph_data, goal, summary, pages_visited, actions_taken, duration_ms'
        )
        .in('test_id', batch);

      if (error) {
        logger.warn('[OVERALL_BUILDER] Failed to get intelligent sessions', {
          error,
          batchIndex: i / BATCH_SIZE,
        });
        continue; // Continue with next batch
      }

      (sessions || []).forEach(session => {
        sessionsMap.set(session.test_id, session);
      });
    }

    return sessionsMap;
  }

  /**
   * Build nodes from tests
   * Converts raw test data into visualization nodes with status flags
   *
   * @param tests - Array of test records
   * @param sessionsMap - Map of testId -> intelligent session data
   * @returns Array of OverallNode objects
   */
  private static async buildNodes(
    tests: any[],
    sessionsMap: Map<string, any>,
    fingerprints: Map<string, CommandFingerprint>
  ): Promise<OverallNode[]> {
    const nodes: OverallNode[] = [];

    for (const test of tests) {
      const session = sessionsMap.get(test.id);

      // Determine status flag (will implement danger logic in next todo)
      const statusFlag = this.determineStatusFlag(test, session);

      // Determine source type
      const source = test.intelligent_mode ? 'intelligent' : 'manual';

      // Build label
      const label = session?.goal || test.url || `Test ${test.id.substring(0, 8)}`;

      // Build meta
      const meta: OverallNode['meta'] = {
        url: test.url,
        browsers: test.browsers || [],
        pagesVisited: session?.pages_visited,
        actionsTaken: session?.actions_taken,
        durationMs: session?.duration_ms,
      };

      // Attach fingerprint (pre-computed by RelationshipService)
      const fp = fingerprints.get(test.id);
      if (fp) {
        meta.fingerprint = fp;
      }

      // Check for findings
      if (session?.id) {
        const hasFindings = await this.checkForFindings(session.id);
        if (hasFindings) {
          meta.hasFindings = true;
        }
      }

      nodes.push({
        id: test.id,
        entityType: 'test_run',
        label,
        statusFlag,
        source,
        lastRunAt: test.completed_at || test.created_at,
        meta,
      });
    }

    return nodes;
  }

  /**
   * Determine status flag for a test
   * Implements danger detection based on flaky/warning signals
   *
   * Priority order:
   * 1. cancelled -> 'cancelled'
   * 2. failed/timeout -> 'failed'
   * 3. success with danger signals -> 'danger'
   * 4. success without danger -> 'success'
   *
   * @param test - Test record from database
   * @param session - Intelligent session (may be null for manual tests)
   * @returns StatusFlag enum value
   */
  private static determineStatusFlag(test: any, session: any): StatusFlag {
    // Cancelled
    if (test.status === 'cancelled') {
      return 'cancelled';
    }

    // Failed/timeout
    if (test.status === 'failed' || test.status === 'timeout') {
      return 'failed';
    }

    // ✅ FIX: Check test results for actual success/failure
    // Test status can be 'completed' but results show failures
    if (test.status === 'completed') {
      // Check session success flag if available
      if (session && session.success === false) {
        return 'failed';
      }

      // Check for danger signals (test passed but with issues)
      const hasDangerSignals = this.checkDangerSignals(session);
      if (hasDangerSignals) {
        return 'danger';
      }

      return 'success';
    }

    // ✅ FIX: Handle 'running' or 'pending' status
    if (test.status === 'running' || test.status === 'pending') {
      logger.debug('[OVERALL_BUILDER] Test still in progress', {
        testId: test.id,
        status: test.status,
      });
      return 'failed'; // Treat as failed for visualization (shouldn't be in overall normally)
    }

    // Default to failed if unknown status
    logger.warn('[OVERALL_BUILDER] Unknown test status', {
      testId: test.id,
      status: test.status,
    });
    return 'failed';
  }

  /**
   * Check for danger signals (flaky/warning) in graph_data
   * Danger = test passed but with retries, timeouts, or warnings
   *
   * @param session - Intelligent session with graph_data
   * @returns true if danger signals detected, false otherwise
   */
  private static checkDangerSignals(session: any): boolean {
    if (!session?.graph_data?.nodes || !Array.isArray(session.graph_data.nodes)) {
      return false;
    }

    const nodes = session.graph_data.nodes;

    // Check each node for danger signals
    for (const node of nodes) {
      if (!node || !node.meta) continue;

      // Retry detected
      if (
        typeof node.meta.retryCount === 'number' &&
        node.meta.retryCount > 0
      ) {
        logger.debug('[OVERALL_BUILDER] Danger signal: retry detected', {
          sessionId: session.id,
          nodeId: node.id,
          retryCount: node.meta.retryCount,
        });
        return true;
      }

      // Timeout flag
      if (node.meta.isTimeout === true) {
        logger.debug('[OVERALL_BUILDER] Danger signal: timeout detected', {
          sessionId: session.id,
          nodeId: node.id,
        });
        return true;
      }

      // Warning present (non-empty string or object)
      if (node.meta.warning) {
        logger.debug('[OVERALL_BUILDER] Danger signal: warning detected', {
          sessionId: session.id,
          nodeId: node.id,
          warning:
            typeof node.meta.warning === 'string'
              ? node.meta.warning.substring(0, 100)
              : 'warning object',
        });
        return true;
      }
    }

    return false;
  }

  /**
   * Check if session has findings
   * Queries intelligent_test_findings table for critical issues
   *
   * @param sessionId - Intelligent session UUID
   * @returns true if findings exist, false otherwise
   */
  private static async checkForFindings(sessionId: string): Promise<boolean> {
    const { count, error } = await supabaseAdmin
      .from('intelligent_test_findings')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (error) {
      logger.warn('[OVERALL_BUILDER] Failed to check findings', { error, sessionId });
      return false;
    }

    return (count || 0) > 0;
  }
}
