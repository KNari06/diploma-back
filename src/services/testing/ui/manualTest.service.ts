import { QueueManager } from '@/config/queues';
import { dbAdminService, dbService, supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ApiResponse, BrowserType, NotFoundError, PaginatedResponse, Test, TestResult, TestRunRequest, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/logger';
import { TestCreatedPayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { v4 as uuidv4 } from 'uuid';
import { TestCompletionHandlerService } from '@/services/testing/results/test-completion-handler.service';

export class ManualTestService {
  /**
   * Create and run a new test
   */
  static async runTest(testRequest: TestRunRequest): Promise<ApiResponse<Test>> {
    try {
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 1: runTest called', {
        url: testRequest.url,
        intelligentMode: testRequest.intelligentMode,
        testGoal: testRequest.testGoal ? `"${testRequest.testGoal.substring(0, 50)}..."` : undefined,
      });

      // Validate test request
      this.validateTestRequest(testRequest);
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 2: Validation passed');

      // Validate userId (required)
      if (!testRequest.userId) {
        throw new ValidationError('User ID is required - anonymous users are not supported');
      }

      // NOTE: Credits check and deduction should be done BEFORE calling runTest()
      // - Chat flow: Done in executeUiTestFlow via CreditCostTrackerService
      // - Direct API: Done in /manual-test/run controller via CreditCostTrackerService
      // - Retry: Done in retryTest() method via checkUserCredits + deductCredits
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 3: Credits check/deduction handled by caller');

      // Create test record
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 4: Creating test record in DB');
      const test = await this.createTest(testRequest);
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 5: Test record created', { testId: test.id });

      // Add jobs to queue for each browser
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 6: Adding jobs to queue');

      for (const browser of testRequest.browsers) {
        logger.info('🟢 [MANUAL_TEST_FLOW] Step 7: Adding job to queue', { browser, testId: test.id });

        const job = await QueueManager.addTestRunJob({
          testId: test.id,
          url: testRequest.url,
          browser,
          options: testRequest.options,
          projectId: testRequest.projectId,
          userId: testRequest.userId,
          // Pass Playwright commands if available
          commands: (testRequest as any).commands,
          intent: (testRequest as any).intent,
          // Pass intelligent mode settings
          intelligentMode: testRequest.intelligentMode,
          testGoal: testRequest.testGoal,
        });

        logger.info('🟢 [MANUAL_TEST_FLOW] Step 8: Job added to queue successfully', {
          browser,
          jobId: job?.id
        });

        // Monitor the job after adding
        if (job?.id) {
          const { QueueMonitor } = await import('@/utils/queue-monitor');
          QueueMonitor.monitorAfterJobAdd(job.id, test.id);
        }
      }

      // NOTE: Credits should be deducted BEFORE calling runTest()
      // - Chat flow: Credits deducted in executeUiTestFlow via CreditCostTrackerService
      // - Direct API: Credits should be deducted in controller before calling runTest()
      // - Retry: Credits deducted in retryTest() method
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 9: Credits already deducted by caller');

      logTestEvent('created', test.id, { url: testRequest.url, browsers: testRequest.browsers });

      // Emit WebSocket event for test creation
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 10: Emitting WebSocket event');
      const testCreatedPayload: TestCreatedPayload = {
        testId: test.id,
        url: testRequest.url,
        browsers: testRequest.browsers,
        userId: testRequest.userId,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitTestCreated(test.id, testCreatedPayload);

      logger.info('🟢 [MANUAL_TEST_FLOW] Step 11: DONE! Returning test', {
        testId: test.id,
        success: true
      });

      return {
        success: true,
        data: test,
        message: 'Test created successfully',
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error('Failed to run test:', error);
      throw error;
    }
  }

  /**
   * Get test by ID with results
   */
  static  async getTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    try {
      const test = await dbService.getTest(testId) as any;

      if (!test) {
        throw new NotFoundError('Test', testId);
      }

      // Check if user has access to this test
      if (userId && test.user_id && test.user_id !== userId) {
        throw new ValidationError('Access denied to this test');
      }

      logTestEvent('retrieved', testId, { userId });

      return {
        success: true,
        data: test,
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to get test ${testId}:`, error);
      throw error;
    }
  }

  /**
   * Get test results
   */
  static   async getTestResults(testId: string, userId?: string): Promise<ApiResponse<TestResult[]>> {
    try {
      // First check if test exists and user has access
      const test = await dbService.getTest(testId) as any;
      if (!test) {
        throw new NotFoundError('Test', testId);
      }

      if (userId && test.user_id && test.user_id !== userId) {
        throw new ValidationError('Access denied to this test');
      }

      const results = await dbService.getTestResults(testId) as any[];

      logTestEvent('results_retrieved', testId, { resultsCount: results.length });

      return {
        success: true,
        data: results,
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to get test results ${testId}:`, error);
      throw error;
    }
  }

  /**
   * Get tests by project with pagination
   */
  static async getTestsByProject(
    projectId: string,
    userId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResponse<Test>> {
    try {
      // Check if user has access to project
      const project = await dbService.getProject(projectId) as any;
      if (!project) {
        throw new NotFoundError('Project', projectId);
      }

      if (project.user_id !== userId) {
        throw new ValidationError('Access denied to this project');
      }

      const offset = (page - 1) * limit;
      const tests = await dbService.getTestsByProject(projectId, limit, offset) as any[];

      // Get total count for pagination
      const { count } = await dbService.supabaseAdmin
        .from('tests')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId);

      const totalPages = Math.ceil((count || 0) / limit);

      logTestEvent('project_tests_retrieved', projectId, {
        userId,
        page,
        limit,
        total: count
      });

      return {
        success: true,
        data: tests,
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages,
        },
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to get tests for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel a running test
   * - Updates test status to 'cancelled' in database
   * - Removes all related jobs from queue (waiting and active)
   * - Emits WebSocket event for cancellation
   */
  static async cancelTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    try {
      const test = await dbService.getTest(testId) as any;
      if (!test) {
        throw new NotFoundError('Test', testId);
      }

      if (userId && test.user_id && test.user_id !== userId) {
        throw new ValidationError('Access denied to this test');
      }

      if (test.status === 'completed' || test.status === 'failed') {
        throw new ValidationError('Cannot cancel completed or failed test');
      }

      // Update test status first (so workers can check it)
      const updatedTest = await dbService.updateTest(testId, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      }) as any;

      // Cancel all jobs in queue for this test
      await this.cancelTestJobs(testId, test.browsers || []);

      // Emit WebSocket event
      const { webSocketService } = await import('@/websocket/websocket.service');
      webSocketService.emitTestCancelled(testId, {
        testId,
        timestamp: new Date().toISOString(),
      });

      logTestEvent('cancelled', testId, { userId });

      return {
        success: true,
        data: updatedTest,
        message: 'Test cancelled successfully',
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to cancel test ${testId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel all queue jobs for a test
   * Removes waiting jobs and marks active jobs for cancellation
   */
  private static async cancelTestJobs(testId: string, browsers: string[]): Promise<void> {
    try {
      const { testRunQueue } = await import('@/config/queues');
      let cancelledCount = 0;

      // Cancel jobs for each browser
      for (const browser of browsers) {
        const jobId = `${testId}-${browser}`;

        try {
          // Get job from queue
          const job = await testRunQueue.getJob(jobId);

          if (job) {
            // Check job state
            const state = await job.getState();

            if (state === 'waiting' || state === 'delayed') {
              // Remove waiting/delayed jobs
              await job.remove();
              cancelledCount++;
              logger.info(`[CANCEL_TEST] Removed waiting job: ${jobId}`, {
                testId,
                browser,
                state,
              });
            } else if (state === 'active') {
              // Active jobs will be checked by worker and stopped
              // Worker checks test status in DB via checkTestCancelled()
              // No need to update job.data - status in DB is the source of truth
              logger.info(`[CANCEL_TEST] Active job will be cancelled by worker: ${jobId}`, {
                testId,
                browser,
                state,
                note: 'Worker checks test status in DB',
              });
            } else {
              logger.debug(`[CANCEL_TEST] Job already in final state: ${jobId}`, {
                testId,
                browser,
                state,
              });
            }
          } else {
            logger.debug(`[CANCEL_TEST] Job not found in queue: ${jobId}`, {
              testId,
              browser,
            });
          }
        } catch (jobError) {
          logger.warn(`[CANCEL_TEST] Failed to cancel job ${jobId}:`, {
            testId,
            browser,
            error: jobError instanceof Error ? jobError.message : String(jobError),
          });
        }
      }

      logger.info(`[CANCEL_TEST] Cancelled ${cancelledCount} jobs for test: ${testId}`, {
        testId,
        totalBrowsers: browsers.length,
        cancelledJobs: cancelledCount,
      });
    } catch (error) {
      logger.error(`[CANCEL_TEST] Error cancelling jobs for test ${testId}:`, error);
      // Don't throw - test status is already updated, workers will check it
    }
  }

  /**
   * Retry a failed test
   * - For intelligent mode: Retry with same plan (Variant A) on first attempt
   * - If retryCount >= 2: Switch to Variant B (regenerate plan) - handled by user
   */
  static async retryTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    try {
      const test = await dbService.getTest(testId) as any;
      if (!test) {
        throw new NotFoundError('Test', testId);
      }

      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      if (test.user_id !== userId) {
        throw new ValidationError('Access denied to this test');
      }

      if (test.status !== 'failed') {
        throw new ValidationError('Can only retry failed tests');
      }

      logger.info('[RETRY_TEST] Retrying test', {
        testId,
        intelligentMode: test.intelligent_mode,
        userId: userId.substring(0, 8) + '...',
      });

      // Check user credits (with intelligent mode consideration)
      await this.checkUserCredits(
        userId,
        test.browsers,
        test.intelligent_mode,
        test.options?.estimatedCost // May be stored in options from original test
      );

      // Reset test status
      const updatedTest = await dbService.updateTest(testId, {
        status: 'pending',
        started_at: null,
        completed_at: null,
      }) as any;

      // Add jobs to queue for each browser
      // IMPORTANT: Restore full AI context (commands, testGoal, etc.)
      for (const browser of test.browsers) {
        await QueueManager.addTestRunJob({
          testId: test.id,
          url: test.url,
          browser,
          options: test.options,
          projectId: test.project_id,
          userId: test.user_id,
          // Restore AI context from DB
          commands: test.commands || [], // Playwright commands
          intent: test.test_goal || undefined, // Use test_goal as intent
          intelligentMode: test.intelligent_mode || false,
          testGoal: test.test_goal || undefined,
          retryCount: 1, // Variant A: Retry with same plan (first retry)
        });
      }

      // Deduct credits
      await this.deductCredits(
        userId,
        test.id,
        test.browsers,
        test.intelligent_mode,
        test.options?.estimatedCost
      );

      logTestEvent('retried', testId, {
        userId,
        browsers: test.browsers,
        intelligentMode: test.intelligent_mode,
      });

      return {
        success: true,
        data: updatedTest,
        message: test.intelligent_mode
          ? 'Intelligent test retry initiated (using same plan)'
          : 'Test retry initiated successfully',
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to retry test ${testId}:`, error);
      throw error;
    }
  }

  /**
   * Get test statistics
   */
  static async getTestStats(projectId: string, userId: string): Promise<ApiResponse<any>> {
    try {
      // Check if user has access to project
      const project = await dbService.getProject(projectId) as any;
      if (!project) {
        throw new NotFoundError('Project', projectId);
      }

      if (project.user_id !== userId) {
        throw new ValidationError('Access denied to this project');
      }

      // Get statistics using Supabase function
      const { data, error } = await dbService.supabaseAdmin
        .rpc('get_test_stats', { project_uuid: projectId });

      if (error) throw error;

      logTestEvent('stats_retrieved', projectId, { userId });

      return {
        success: true,
        data: data || {},
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to get test stats for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Validate test request
   */
  private static validateTestRequest(testRequest: TestRunRequest): void {
    if (!testRequest.url) {
      throw new ValidationError('URL is required');
    }

    if (!testRequest.browsers || testRequest.browsers.length === 0) {
      throw new ValidationError('At least one browser is required');
    }

    if (!testRequest.projectId) {
      throw new ValidationError('Project ID is required');
    }

    // Validate URL format
    try {
      new URL(testRequest.url);
    } catch {
      throw new ValidationError('Invalid URL format');
    }

    // Validate browsers
    const validBrowsers: BrowserType[] = ['chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari'];
    for (const browser of testRequest.browsers) {
      if (!validBrowsers.includes(browser)) {
        throw new ValidationError(`Invalid browser: ${browser}`);
      }
    }
  }

  /**
   * Create test record
   */
  private static async createTest(testRequest: TestRunRequest): Promise<Test> {
    const userId = testRequest.userId!;

    logger.info('[MANUAL_TEST] Creating test for user', {
      userId,
      intelligentMode: testRequest.intelligentMode || false,
    });

    // Validate projectId is a valid UUID, otherwise get/create user project
    const isValidProjectUUID = testRequest.projectId && testRequest.projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    let validProjectId = isValidProjectUUID ? testRequest.projectId : null;

    if (!validProjectId) {
      logger.info('[MANUAL_TEST] No valid projectId provided, creating user project', {
        projectId: testRequest.projectId,
        userId
      });
      validProjectId = await this.getOrCreateUserProject(userId);
    }

    const testData = {
      id: uuidv4(),
      url: testRequest.url,
      project_id: validProjectId,
      user_id: userId,
      status: 'pending' as const,
      browsers: testRequest.browsers,
      options: testRequest.options || {},
      // Intelligent testing fields
      intelligent_mode: testRequest.intelligentMode || false,
      test_goal: testRequest.testGoal || null,
      commands: testRequest.commands || [],
    };

    logger.info('[CREATE_TEST] Attempting to create test in DB', {
      testId: testData.id,
      projectId: validProjectId,
      userId,
      intelligentMode: testData.intelligent_mode,
      hasCommands: (testData.commands as any[]).length > 0,
    });

    const createdTest = await dbAdminService.createTest(testData);

    logger.info('[CREATE_TEST] Test created successfully in DB', {
      testId: (createdTest as any).id,
      intelligentMode: testData.intelligent_mode,
    });

    return createdTest;
  }

  /**
   * Get or create project for user
   */
  private static async getOrCreateUserProject(userId: string): Promise<string> {
    try {
      logger.info('[MANUAL_TEST] Getting/creating project for user', { userId });

      // First, ensure user has a workspace
      const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);

      logger.info('[MANUAL_TEST] Workspace ensured', { userId, workspaceId: workspace_id });

      // Check if user already has a project in this workspace
      const { data: existingProject } = await supabaseAdmin
        .from('projects')
        .select('id, name')
        .eq('user_id', userId)
        .eq('workspace_id', workspace_id)
        .maybeSingle();

      if (existingProject) {
        logger.info('[MANUAL_TEST] Found existing project', {
          userId,
          projectId: existingProject.id,
          projectName: existingProject.name
        });
        return existingProject.id;
      }

      // Create new project for user
      const projectData = {
        name: 'My Testing Project',
        description: 'Default testing project',
        user_id: userId,
        workspace_id: workspace_id,
        settings: {
          created_from_test: true,
          created_at: new Date().toISOString(),
        },
      };

      const { data: newProject, error } = await supabaseAdmin
        .from('projects')
        .insert(projectData)
        .select('id, name')
        .single();

      if (error) {
        logger.error('[MANUAL_TEST] Failed to create project', { error, userId });
        throw error;
      }

      logger.info('[MANUAL_TEST] Created new project', {
        userId,
        projectId: newProject.id,
        projectName: newProject.name,
        workspaceId: workspace_id
      });

      return newProject.id;
    } catch (error) {
      logger.error('[MANUAL_TEST] Error getting/creating user project', { error, userId });
      throw error;
    }
  }

  /**
   * Check user credits
   */
  private static async checkUserCredits(
    userId: string,
    browsers: BrowserType[],
    intelligentMode?: boolean,
    estimatedCost?: string
  ): Promise<void> {
    const user = await dbService.getUser(userId) as any;
    if (!user) {
      throw new NotFoundError('User', userId);
    }

    // Get credits from user_credits table
    const { UserCreditsService } = await import('@/services/core/user-credits.service');
    const userCredits = await UserCreditsService.getOrCreateUserCredits(userId);
    const availableCredits = Number.isFinite(userCredits.credits_balance)
      ? (userCredits.credits_balance || 0)
      : 0;

    // Calculate required credits
    const requiredCredits = this.calculateRequiredCredits(browsers, intelligentMode, estimatedCost);

    logger.info('[CREDIT_CHECK] Credits calculation', {
      userId: userId.substring(0, 8) + '...',
      intelligentMode,
      estimatedCost,
      requiredCredits,
      availableCredits,
    });

    if (availableCredits < requiredCredits) {
      throw new ValidationError(`Insufficient credits. Required: ${requiredCredits}, Available: ${availableCredits}`);
    }
  }

  /**
   * Deduct user credits
   */
  private static async deductCredits(
    userId: string,
    testId: string,
    browsers: BrowserType[],
    intelligentMode?: boolean,
    estimatedCost?: string
  ): Promise<void> {
    const requiredCredits = this.calculateRequiredCredits(browsers, intelligentMode, estimatedCost);

    logger.info('[CREDIT_DEDUCT] Deducting credits', {
      userId: userId.substring(0, 8) + '...',
      testId: testId.substring(0, 8) + '...',
      requiredCredits,
      intelligentMode,
    });

    // Deduct credits using Supabase function
    const { data, error } = await dbService.supabaseAdmin
      .rpc('deduct_test_credits', {
        user_uuid: userId,
        test_uuid: testId, // Real test ID (not 'temp')
        credit_amount: requiredCredits,
      });

    if (error) throw error;

    if (!data) {
      throw new ValidationError('Failed to deduct credits');
    }
  }

  /**
   * Calculate required credits for browsers
   * Formula:
   * - Standard test: 1 credit per browser (2 for mobile browsers)
   * - Intelligent test: base + AI cost (parsed from estimatedCost or 2x base)
   */
  private static calculateRequiredCredits(
    browsers: BrowserType[],
    intelligentMode?: boolean,
    estimatedCost?: string
  ): number {
    const creditCosts: Record<BrowserType, number> = {
      'chrome': 1,
      'firefox': 1,
      'safari': 1,
      'edge': 1,
      'mobile-chrome': 2,
      'mobile-safari': 2,
    };

    // 1. Calculate base browser cost
    const baseBrowserCost = browsers.reduce(
      (total, browser) => total + (creditCosts[browser] || 1),
      0
    );

    // 2. If NOT intelligent mode - return base cost
    if (!intelligentMode) {
      return baseBrowserCost;
    }

    // 3. For intelligent mode - parse estimatedCost or use 2x multiplier
    if (estimatedCost) {
      // Parse "$0.10-0.20" or "$0.15" format
      const match = estimatedCost.match(/\$([0-9.]+)(?:-\$?([0-9.]+))?/);
      if (match) {
        // Take upper bound if range, otherwise single value
        const maxCost = match[2] ? parseFloat(match[2]) : parseFloat(match[1]);

        // Convert $ to credits (1 credit = $0.01)
        const aiCredits = Math.ceil(maxCost * 100);

        logger.debug('[CREDIT_CALC] Intelligent mode cost calculated', {
          estimatedCost,
          parsedMaxCost: maxCost,
          aiCredits,
          baseBrowserCost,
          total: baseBrowserCost + aiCredits,
        });

        return baseBrowserCost + aiCredits;
      }
    }

    // 4. Fallback: If no estimatedCost - use 2x multiplier
    logger.debug('[CREDIT_CALC] Using fallback 2x multiplier for intelligent mode', {
      baseBrowserCost,
      total: baseBrowserCost * 2,
    });

    return baseBrowserCost * 2;
  }

  /**
   * Process test result from agent
   */
  static async processTestResult(resultData: {
    testId: string;
    browser: BrowserType;
    status: string;
    screenshot?: string;
    dom?: string;
    logs: string[];
    networkLogs: any[];
    errors: any[];
    performance?: any;
  }): Promise<ApiResponse<TestResult>> {
    try {
      logger.info(`Processing test result: ${resultData.testId} (${resultData.browser})`);

      // Create test result record
      const testResult = await dbAdminService.createTestResult({
        test_id: resultData.testId,
        browser: resultData.browser,
        status: resultData.status as any,
        screenshot: resultData.screenshot,
        dom: resultData.dom,
        logs: resultData.logs,
        network_logs: resultData.networkLogs,
        errors: resultData.errors,
        performance: resultData.performance,
        completed_at: new Date().toISOString(),
      }) as any;

      // Add AI analysis job
      await QueueManager.addAIAnalysisJob(testResult.id, resultData.testId);

      // TODO: Auto-generate final report after AI analysis completes
      // After aiAnalysisQueue finishes, call:
      // await TestReportGeneratorService.generateFinalReport({
      //   testId: resultData.testId,
      //   testResult: testResult,
      //   testPlan: await getTestPlan(...),
      //   aiAnalysis: await getAIAnalysis(...),
      // });
      // Options:
      // 1. Add to AI analysis worker (recommended - after AI analysis)
      // 2. Add here (immediate - without AI analysis)
      // 3. User-triggered only (manual via API)

      // Check if test is complete and notify chat sessions
      await this.checkAndHandleTestCompletion(resultData.testId);

      logTestEvent('result_processed', resultData.testId, {
        browser: resultData.browser,
        status: resultData.status
      });

      return {
        success: true,
        data: testResult,
        message: 'Test result processed successfully',
        timestamp: new Date(),
      };

    } catch (error) {
      logger.error(`Failed to process test result: ${resultData.testId}`, error);
      throw error;
    }
  }

  /**
   * Check if test is complete and handle completion notifications
   * @param testId - The test ID to check
   */
  private static async checkAndHandleTestCompletion(testId: string): Promise<void> {
    try {
      logger.info('[MANUAL_TEST_SERVICE] Checking test completion', { testId });

      // Get test details
      const testResponse = await this.getTest(testId);
      if (!testResponse.success || !testResponse.data) {
        logger.warn('[MANUAL_TEST_SERVICE] Test not found for completion check', { testId });
        return;
      }

      const test = testResponse.data;

      // Get all results for this test
      const resultsResponse = await this.getTestResults(testId);
      const results = resultsResponse.data || [];

      // Check if all browsers have completed (either 'completed' or 'failed')
      const expectedBrowsers = test.browsers || [];
      const completedBrowsers = results.filter(result =>
        ['completed', 'failed'].includes(result.status)
      );

      const isTestComplete = expectedBrowsers.length > 0 &&
        expectedBrowsers.every(browser =>
          completedBrowsers.some(result => result.browser === browser)
        );

      logger.info('[MANUAL_TEST_SERVICE] Test completion check', {
        testId,
        expectedBrowsers: expectedBrowsers.length,
        completedBrowsers: completedBrowsers.length,
        isComplete: isTestComplete,
      });

      if (isTestComplete) {
        // Update test status to completed
        await dbService.updateTest(testId, {
          status: 'completed',
          completed_at: new Date().toISOString(),
        });

        logger.info('[MANUAL_TEST_SERVICE] Test marked as completed', { testId });

        // Notify all associated chat sessions
        await TestCompletionHandlerService.handleTestCompletion(testId);

        logTestEvent('completed', testId, {
          totalBrowsers: expectedBrowsers.length,
          completedBrowsers: completedBrowsers.length,
        });
      }

    } catch (error) {
      logger.error('[MANUAL_TEST_SERVICE] Error checking test completion', {
        error,
        testId,
      });
      // Don't throw error - this is a background process
    }
  }
}
