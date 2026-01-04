import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { ManualTestService } from '../ui/manualTest.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION RUN SERVICE - Execute saved test cases and suites
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages regression test execution:
 * - Runs individual saved test cases with parameter substitution
 * - Runs regression suites (ordered execution of multiple test cases)
 * - Tracks execution via regression_runs table
 * - Lists saved test cases, suites, and runs for a project
 *
 * Key Features:
 * - Parameter substitution for runtime values (e.g., passwords)
 * - Access control verification
 * - Links regression runs to underlying tests for status tracking
 */

// Limits for pagination
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

/**
 * Service for running saved test cases and regression suites
 * Creates and dispatches underlying test executions
 */
export class RegressionRunService {
  /**
   * Run a saved test case
   *
   * @param params.savedTestCaseId - ID of saved test case to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type ('manual' via API or 'chat' via AI command)
   * @param params.parameters - Runtime parameters for parameterized values
   * @returns Regression run ID and underlying test ID
   * @throws {NotFoundError} If saved test case not found
   * @throws {ValidationError} If validation fails or access denied
   */
  static async runSavedTestCase(params: {
    savedTestCaseId: string;
    userId: string;
    trigger: 'manual' | 'chat';
    parameters?: Record<string, any>;
  }): Promise<{
    runId: string;
    testId: string;
  }> {
    const { savedTestCaseId, userId, trigger, parameters = {} } = params;

    try {
      logger.info('[REGRESSION_RUN] Running saved test case', {
        savedTestCaseId,
        userId,
        trigger,
      });

      // 1. Get saved test case
      const savedCase = await this.getSavedTestCase(savedTestCaseId, userId);

      // 2. Create regression run record
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          saved_test_case_id: savedTestCaseId,
          project_id: savedCase.project_id,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create regression run: ${runError?.message}`);
      }

      // 3. Build test request from saved case
      const testRequest = await this.buildTestRequest(savedCase, userId, parameters);

      // 4. Execute test using existing test service
      const testResult = await ManualTestService.runTest(testRequest);

      if (!testResult.success || !testResult.data?.id) {
        throw new Error('Failed to start test execution');
      }

      const testId = testResult.data.id;

      // 5. Update regression run with test_id for status tracking
      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({ test_id: testId })
        .eq('id', run.id);

      if (updateError) {
        logger.warn('[REGRESSION_RUN] Failed to update run with test_id', {
          error: updateError,
          runId: run.id,
          testId,
        });
      }

      logger.info('[REGRESSION_RUN] Test execution started', {
        runId: run.id,
        testId,
        savedTestCaseId,
      });

      return {
        runId: run.id,
        testId,
      };
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to run saved test case', {
        error,
        savedTestCaseId,
      });
      throw error;
    }
  }

  /**
   * Run a regression suite (all test cases in order)
   *
   * @param params.suiteId - ID of suite to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type ('manual' or 'chat')
   * @param params.parameters - Runtime parameters applied to all test cases
   * @returns Regression run ID and array of underlying test IDs
   * @throws {NotFoundError} If suite not found
   * @throws {ValidationError} If validation fails or access denied
   */
  static async runSuite(params: {
    suiteId: string;
    userId: string;
    trigger: 'manual' | 'chat';
    parameters?: Record<string, any>;
  }): Promise<{
    runId: string;
    testIds: string[];
  }> {
    const { suiteId, userId, trigger, parameters = {} } = params;

    try {
      logger.info('[REGRESSION_RUN] Running suite', { suiteId, userId, trigger });

      // 1. Get suite with test cases
      const { suite, testCases } = await this.getSuiteWithCases(suiteId, userId);

      if (testCases.length === 0) {
        throw new ValidationError('Suite has no test cases');
      }

      // 2. Create regression run record
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          suite_id: suiteId,
          project_id: suite.project_id,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create suite run: ${runError?.message}`);
      }

      // 3. Execute each test case in order
      const testIds: string[] = [];
      const errors: string[] = [];

      for (const testCase of testCases) {
        try {
          const testRequest = await this.buildTestRequest(testCase, userId, parameters);
          const testResult = await ManualTestService.runTest(testRequest);

          if (testResult.success && testResult.data?.id) {
            testIds.push(testResult.data.id);
          } else {
            const errorMsg = `Test case ${testCase.name} failed to start`;
            errors.push(errorMsg);
            logger.warn('[REGRESSION_RUN] Test case failed to start', {
              testCaseId: testCase.id,
              testCaseName: testCase.name,
            });
          }
        } catch (error) {
          const errorMsg = `Error running test case ${testCase.name}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          errors.push(errorMsg);
          logger.error('[REGRESSION_RUN] Failed to run test case in suite', {
            error,
            testCaseId: testCase.id,
            suiteId,
          });
          // Continue with next test case even if one fails
        }
      }

      // ✅ Improved: Check if any tests were started
      if (testIds.length === 0) {
        // All tests failed - mark run as failed immediately
        await supabaseAdmin
          .from('regression_runs')
          .update({
            status: 'failed',
            summary: {
              total: testCases.length,
              started: 0,
              errors,
            },
            completed_at: new Date().toISOString(),
          })
          .eq('id', run.id);

        throw new ValidationError(
          `Failed to start any tests in suite. Errors: ${errors.join('; ')}`
        );
      }

      // 4. Update regression run with test_ids for status tracking
      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({ test_ids: testIds })
        .eq('id', run.id);

      if (updateError) {
        logger.warn('[REGRESSION_RUN] Failed to update run with test_ids', {
          error: updateError,
          runId: run.id,
          testIds,
        });
      }

      logger.info('[REGRESSION_RUN] Suite execution started', {
        runId: run.id,
        testIds,
        totalCases: testCases.length,
        started: testIds.length,
        failed: errors.length,
      });

      return {
        runId: run.id,
        testIds,
      };
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to run suite', { error, suiteId });
      throw error;
    }
  }

  /**
   * Get saved test case and verify access
   *
   * @throws {NotFoundError} If saved test case not found
   * @throws {ValidationError} If access denied
   */
  private static async getSavedTestCase(
    savedTestCaseId: string,
    userId: string
  ): Promise<any> {
    const { data: savedCase, error } = await supabaseAdmin
      .from('saved_test_cases')
      .select('*, projects!inner(user_id)')
      .eq('id', savedTestCaseId)
      .single();

    if (error || !savedCase) {
      throw new NotFoundError('Saved test case', savedTestCaseId);
    }

    // ✅ FIX: Handle projects as object (when using single())
    const projectUserId = (savedCase.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new ValidationError('Access denied to this saved test case');
    }

    return savedCase;
  }

  /**
   * Get suite with all test cases
   *
   * @throws {NotFoundError} If suite not found
   * @throws {ValidationError} If access denied
   */
  private static async getSuiteWithCases(
    suiteId: string,
    userId: string
  ): Promise<{ suite: any; testCases: any[] }> {
    // Get suite
    const { data: suite, error: suiteError } = await supabaseAdmin
      .from('regression_suites')
      .select('*, projects!inner(user_id)')
      .eq('id', suiteId)
      .single();

    if (suiteError || !suite) {
      throw new NotFoundError('Suite', suiteId);
    }

    // ✅ FIX: Handle projects as object (when using single())
    const projectUserId = (suite.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new ValidationError('Access denied to this suite');
    }

    // Get test cases
    const { data: items, error: itemsError } = await supabaseAdmin
      .from('regression_suite_items')
      .select('*, saved_test_cases(*)')
      .eq('suite_id', suiteId)
      .order('order_index', { ascending: true });

    if (itemsError) {
      throw new Error(`Failed to get suite items: ${itemsError.message}`);
    }

    const testCases = (items || []).map((item: any) => item.saved_test_cases);

    return { suite, testCases };
  }

  /**
   * Build test request from saved case
   * Constructs a test execution request with parameterized values
   *
   * @throws {ValidationError} If saved case has no replayable data or URL
   */
  private static async buildTestRequest(
    savedCase: any,
    userId: string,
    parameters: Record<string, any>
  ): Promise<any> {
    // Get source test for base configuration (optional - only for browsers/options)
    const { data: sourceTest } = await supabaseAdmin
      .from('tests')
      .select('browsers, options')
      .eq('id', savedCase.source_test_id)
      .maybeSingle();

    let commands: any[] = [];

    // Extract commands based on strategy
    if (savedCase.replay_strategy === 'commands' && savedCase.commands) {
      commands = this.applyParameters(savedCase.commands, parameters);
    } else if (savedCase.replay_strategy === 'graph_extract' && savedCase.graph_ref?.steps) {
      commands = this.applyParameters(savedCase.graph_ref.steps, parameters);
    } else {
      throw new ValidationError('Saved test case has no replayable data');
    }

    // Validate URL exists (no unsafe fallback)
    if (!savedCase.url) {
      throw new ValidationError(
        'Saved test case has no URL. Please re-save the test case with a valid URL.'
      );
    }

    // Build request
    return {
      url: savedCase.url, // Use persisted URL from saved_test_cases
      projectId: savedCase.project_id,
      userId,
      browsers: sourceTest?.browsers || ['chrome'],
      intelligentMode: true, // Use intelligent mode for saved cases
      testGoal: savedCase.description || savedCase.name,
      commands, // Pre-generated commands
      options: sourceTest?.options || {},
    };
  }

  /**
   * Apply parameters to commands/steps
   * Replaces {{paramName}} placeholders with actual values
   *
   * @param items - Commands or steps with parameter placeholders
   * @param parameters - Runtime parameter values
   * @returns Commands with substituted values
   */
  private static applyParameters(
    items: any[],
    parameters: Record<string, any>
  ): any[] {
    return items.map(item => {
      const newItem = { ...item };

      // Replace parameter placeholders in value
      if (newItem.value && typeof newItem.value === 'string') {
        newItem.value = newItem.value.replace(/\{\{(.+?)\}\}/g, (match: string, paramName: string) => {
          if (parameters[paramName] !== undefined) {
            return String(parameters[paramName]);
          }
          logger.warn('[REGRESSION_RUN] Missing parameter', { paramName });
          return match; // Keep placeholder if parameter not provided
        });
      }

      return newItem;
    });
  }

  /**
   * Update run status (called after test completion)
   * Note: This is now primarily handled by test-completion-handler.service.ts
   * but kept for manual status updates if needed
   *
   * @deprecated Use test completion hook instead
   */
  static async updateRunStatus(params: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    summary?: any;
  }): Promise<void> {
    const { runId, status, summary } = params;

    try {
      const { error } = await supabaseAdmin
        .from('regression_runs')
        .update({
          status,
          summary: summary || null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);

      if (error) {
        throw new Error(`Failed to update run status: ${error.message}`);
      }

      logger.info('[REGRESSION_RUN] Run status updated', { runId, status });
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to update run status', { error, runId });
      throw error;
    }
  }

  /**
   * List saved test cases for project
   *
   * @param projectId - Project ID to list cases for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @returns List of saved test cases
   */
  static async listSavedTestCases(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    const { data: cases, error } = await supabaseAdmin
      .from('saved_test_cases')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      throw new Error(`Failed to list saved test cases: ${error.message}`);
    }

    return cases || [];
  }

  /**
   * List suites for project
   *
   * @param projectId - Project ID to list suites for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @returns List of regression suites
   */
  static async listSuites(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    const { data: suites, error } = await supabaseAdmin
      .from('regression_suites')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false})
      .limit(safeLimit);

    if (error) {
      throw new Error(`Failed to list suites: ${error.message}`);
    }

    return suites || [];
  }

  /**
   * List runs for project
   *
   * @param projectId - Project ID to list runs for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @returns List of regression runs with status and summary
   */
  static async listRuns(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    const { data: runs, error } = await supabaseAdmin
      .from('regression_runs')
      .select('*')
      .eq('project_id', projectId)
      .order('started_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      throw new Error(`Failed to list runs: ${error.message}`);
    }

    return runs || [];
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
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id !== userId) {
      throw new ValidationError('Access denied to this project');
    }
  }
}
