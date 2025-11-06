import { v4 as uuidv4 } from 'uuid';
import { logger, logTestEvent } from '@/utils/logger';
import { ValidationError, NotFoundError } from '@/types';
import { dbAdminService, dbService, supabaseAdmin } from '@/db/supabase';
import { QueueManager } from '@/config/queues';
import { TestRunRequest, Test, TestResult, BrowserType, ApiResponse, PaginatedResponse } from '@/types';
import { webSocketService } from '@/websocket/websocket.service';
import { TestCreatedPayload } from '@/websocket/types';

export class ManualTestService {
  /**
   * Create and run a new test
   */
  static async runTest(testRequest: TestRunRequest): Promise<ApiResponse<Test>> {
    try {
      logger.info(`Creating new test for URL: ${testRequest.url}`);

      // Validate test request
      this.validateTestRequest(testRequest);

      // Check user credits if userId provided AND is valid UUID
      if (testRequest.userId) {
        const isValidUserUUID = testRequest.userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        if (isValidUserUUID) {
          await this.checkUserCredits(testRequest.userId, testRequest.browsers);
        } else {
          logger.info('Skipping credit check for anonymous user', { userId: testRequest.userId });
        }
      }

      // Create test record
      const test = await this.createTest(testRequest);

      // Add jobs to queue for each browser
      for (const browser of testRequest.browsers) {
        await QueueManager.addTestRunJob({
          testId: test.id,
          url: testRequest.url,
          browser,
          options: testRequest.options,
          projectId: testRequest.projectId,
          userId: testRequest.userId,
          // Pass Playwright commands if available
          commands: (testRequest as any).commands,
          intent: (testRequest as any).intent,
        });
      }

      // Deduct credits if userId provided AND is valid UUID
      if (testRequest.userId) {
        const isValidUserUUID = testRequest.userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        if (isValidUserUUID) {
          await this.deductCredits(testRequest.userId, testRequest.browsers);
        }
      }

      logTestEvent('created', test.id, { url: testRequest.url, browsers: testRequest.browsers });

      // Emit WebSocket event for test creation
      const testCreatedPayload: TestCreatedPayload = {
        testId: test.id,
        url: testRequest.url,
        browsers: testRequest.browsers,
        userId: testRequest.userId,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitTestCreated(test.id, testCreatedPayload);

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
  static   async getTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
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
   */
  static   async cancelTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
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

      // Update test status
      const updatedTest = await dbService.updateTest(testId, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      }) as any;

      // TODO: Cancel running jobs in queue
      // This would require implementing job cancellation in BullMQ

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
   * Retry a failed test
   */
  static   async retryTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    try {
      const test = await dbService.getTest(testId) as any;
      if (!test) {
        throw new NotFoundError('Test', testId);
      }

      if (userId && test.user_id && test.user_id !== userId) {
        throw new ValidationError('Access denied to this test');
      }

      if (test.status !== 'failed') {
        throw new ValidationError('Can only retry failed tests');
      }

      // Check user credits if userId provided
      if (userId) {
        await this.checkUserCredits(userId, test.browsers);
      }

      // Reset test status
      const updatedTest = await dbService.updateTest(testId, {
        status: 'pending',
        started_at: null,
        completed_at: null,
      }) as any;

      // Add jobs to queue for each browser
      for (const browser of test.browsers) {
        await QueueManager.addTestRunJob({
          testId: test.id,
          url: test.url,
          browser,
          options: test.options,
          projectId: test.project_id,
          userId: test.user_id,
        });
      }

      // Deduct credits if userId provided
      if (userId) {
        await this.deductCredits(userId, test.browsers);
      }

      logTestEvent('retried', testId, { userId, browsers: test.browsers });

      return {
        success: true,
        data: updatedTest,
        message: 'Test retry initiated successfully',
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
    // Validate userId is a valid UUID, otherwise use null
    const isValidUUID = testRequest.userId && testRequest.userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const validUserId = isValidUUID ? testRequest.userId : null;

    // Validate projectId is a valid UUID, otherwise get/create default project
    const isValidProjectUUID = testRequest.projectId && testRequest.projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    let validProjectId = isValidProjectUUID ? testRequest.projectId : null;

    if (!validProjectId) {
      logger.warn('Invalid projectId provided, getting default project', { projectId: testRequest.projectId });
      validProjectId = await this.getOrCreateDefaultProject();
    }

    const testData = {
      id: uuidv4(),
      url: testRequest.url,
      project_id: validProjectId,
      user_id: validUserId,
      status: 'pending' as const,
      browsers: testRequest.browsers,
      options: testRequest.options || {},
    };

    logger.info('[CREATE_TEST] Attempting to create test in DB', {
      testId: testData.id,
      projectId: validProjectId,
      userId: validUserId,
    });

    const createdTest = await dbAdminService.createTest(testData);

    logger.info('[CREATE_TEST] Test created successfully in DB', {
      testId: (createdTest as any).id,
    });

    return createdTest;
  }

  /**
   * Get or create default project for anonymous users
   */
  private static async getOrCreateDefaultProject(): Promise<string> {
    const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
    const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

    try {
      // Check if default project exists
      const { data: existingProject } = await supabaseAdmin
        .from('projects')
        .select('id')
        .eq('id', DEFAULT_PROJECT_ID)
        .single();

      if (existingProject) {
        return DEFAULT_PROJECT_ID;
      }

      // Check if workspaces table exists
      const { error: workspaceTableError } = await supabaseAdmin
        .from('workspaces')
        .select('id')
        .limit(1);

      let workspaceId: string | undefined = undefined;

      // Only use workspace if table exists
      if (!workspaceTableError || workspaceTableError.code !== '42P01') {
        // Ensure default workspace exists
        const { data: existingWorkspace } = await supabaseAdmin
          .from('workspaces')
          .select('id')
          .eq('id', DEFAULT_WORKSPACE_ID)
          .maybeSingle();

        workspaceId = DEFAULT_WORKSPACE_ID;

        if (!existingWorkspace) {
          // Create default workspace for system/anonymous users
          const { error: workspaceError } = await supabaseAdmin
            .from('workspaces')
            .insert({
              id: DEFAULT_WORKSPACE_ID,
              name: 'Default Workspace (Anonymous)',
              user_id: DEFAULT_PROJECT_ID, // System user ID
              platforms: ['web(chrome, safari, firefox)'],
              api_testing: false,
              dev_base_url: null,
              prod_base_url: null,
              settings: {},
            })
            .select()
            .single();

          if (workspaceError) {
            logger.error('Failed to create default workspace', workspaceError);
            throw workspaceError;
          }

          logger.info('Created default workspace for anonymous users', { id: DEFAULT_WORKSPACE_ID });
        }
      } else {
        logger.warn('Workspaces table not found, creating project without workspace_id (legacy mode)');
      }

      // Create default project for anonymous users
      const projectData: any = {
        id: DEFAULT_PROJECT_ID,
        name: 'Default Project (Anonymous)',
        description: 'Default project for anonymous test users',
        user_id: DEFAULT_PROJECT_ID, // Self-reference for system project
        settings: {},
      };

      // Only add workspace_id if table exists
      if (workspaceId) {
        projectData.workspace_id = workspaceId;
      }

      const { error } = await supabaseAdmin
        .from('projects')
        .insert(projectData)
        .select()
        .single();

      if (error) {
        logger.error('Failed to create default project', error);
        throw error;
      }

      logger.info('Created default project for anonymous users', { id: DEFAULT_PROJECT_ID, workspaceId });
      return DEFAULT_PROJECT_ID;
    } catch (error) {
      logger.error('Error getting/creating default project', error);
      throw error;
    }
  }

  /**
   * Check user credits
   */
  private static async checkUserCredits(userId: string, browsers: BrowserType[]): Promise<void> {
    const user = await dbService.getUser(userId) as any;
    if (!user) {
      throw new NotFoundError('User', userId);
    }

    // Calculate required credits
    const requiredCredits = this.calculateRequiredCredits(browsers);

    if (user.credits < requiredCredits) {
      throw new ValidationError(`Insufficient credits. Required: ${requiredCredits}, Available: ${user.credits}`);
    }
  }

  /**
   * Deduct user credits
   */
  private static async deductCredits(userId: string, browsers: BrowserType[]): Promise<void> {
    const requiredCredits = this.calculateRequiredCredits(browsers);

    // Deduct credits using Supabase function
    const { data, error } = await dbService.supabaseAdmin
      .rpc('deduct_test_credits', {
        user_uuid: userId,
        test_uuid: 'temp', // This will be updated with actual test ID
        credit_amount: requiredCredits,
      });

    if (error) throw error;

    if (!data) {
      throw new ValidationError('Failed to deduct credits');
    }
  }

  /**
   * Calculate required credits for browsers
   */
  private static calculateRequiredCredits(browsers: BrowserType[]): number {
    const creditCosts: Record<BrowserType, number> = {
      'chrome': 1,
      'firefox': 1,
      'safari': 1,
      'edge': 1,
      'mobile-chrome': 2,
      'mobile-safari': 2,
    };

    return browsers.reduce((total, browser) => total + (creditCosts[browser] || 1), 0);
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
}
