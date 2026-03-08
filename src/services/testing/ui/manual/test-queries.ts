import { dbAdminService, dbService } from '@/db/supabase';
import { ApiResponse, NotFoundError, PaginatedResponse, Test, TestResult, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/core/logger';

/**
 * Get test by ID with results
 * Uses admin client to bypass RLS, consistent with getTestsByUser()
 */
export async function getTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
  try {
    // Use admin client to bypass RLS (consistent with getTestsByUser)
    const test = await dbAdminService.getTest(testId) as any;

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
 * Uses admin client to bypass RLS, consistent with getTest()
 */
export async function getTestResults(testId: string, userId?: string): Promise<ApiResponse<TestResult[]>> {
  try {
    // First check if test exists and user has access
    // Use admin client for consistency
    const test = await dbAdminService.getTest(testId) as any;
    if (!test) {
      throw new NotFoundError('Test', testId);
    }

    if (userId && test.user_id && test.user_id !== userId) {
      throw new ValidationError('Access denied to this test');
    }

    // Use admin client to get results
    const results = await dbAdminService.getTestResults(testId) as any[];

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
 * Get all tests for user with pagination
 */
export async function getTestsByUser(
  userId: string,
  page: number = 1,
  limit: number = 20,
  runId?: string,
): Promise<PaginatedResponse<Test>> {
  try {
    const offset = (page - 1) * limit;

    // If runId is provided, filter tests to only those in the regression run
    let testIdFilter: string[] | undefined;
    let runInfo: { runId: string; planName: string | null } | undefined;
    if (runId) {
      const { data: run } = await dbService.supabaseAdmin
        .from('regression_runs')
        .select('id, test_id, test_ids, regression_plans(name)')
        .eq('id', runId)
        .eq('user_id', userId)
        .maybeSingle();

      if (run) {
        // Handle both array (plan runs) and single (legacy runs)
        const ids: string[] = [];
        if (run.test_ids && Array.isArray(run.test_ids)) {
          ids.push(...run.test_ids);
        } else if (run.test_id) {
          ids.push(run.test_id);
        }

        if (ids.length > 0) {
          testIdFilter = ids;
          runInfo = {
            runId: run.id,
            planName: (run.regression_plans as any)?.name || null,
          };
        }
      }
    }

    // Build query
    let query = dbService.supabaseAdmin
      .from('tests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    let countQuery = dbService.supabaseAdmin
      .from('tests')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (testIdFilter) {
      query = query.in('id', testIdFilter);
      countQuery = countQuery.in('id', testIdFilter);
    }

    const { data: tests, error: testsError } = await query.range(offset, offset + limit - 1);

    if (testsError) {
      throw new Error(`Failed to get tests: ${testsError.message}`);
    }

    // Get total count for pagination
    const { count, error: countError } = await countQuery;

    if (countError) {
      throw new Error(`Failed to get test count: ${countError.message}`);
    }

    const totalPages = Math.ceil((count || 0) / limit);

    // Enrich with regression run info if filtering by runId
    let enrichedTests = tests || [];
    if (runInfo) {
      enrichedTests = enrichedTests.map((t: any) => ({
        ...t,
        regressionRunId: runInfo!.runId,
        regressionPlanName: runInfo!.planName,
      }));
    }

    logTestEvent('user_tests_retrieved', userId, {
      userId,
      page,
      limit,
      total: count,
      runId,
    });

    const total = count || 0;
    return {
      success: true,
      data: enrichedTests,
      pagination: {
        page,
        limit,
        offset,
        total,
        totalPages,
        has_more: offset + limit < total,
      },
      timestamp: new Date(),
    };
  } catch (error) {
    logger.error(`Failed to get tests for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Get tests by project with pagination
 */
export async function getTestsByProject(
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
 * Get test statistics
 */
export async function getTestStats(projectId: string, userId: string): Promise<ApiResponse<any>> {
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
