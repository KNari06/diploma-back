import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Create Supabase client
const supabaseUrl = env.SUPABASE_URL;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
  throw new Error('Missing required Supabase environment variables');
}

// Client for public operations (with RLS)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
  },
});

// Admin client for server-side operations (bypasses RLS)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Test Supabase connection (database)
 */
export const testSupabaseConnection = async (): Promise<boolean> => {
  try {
    // Simple query to test connection - just select one row
    const { error } = await supabaseAdmin
      .from('tests')
      .select('id')
      .limit(1);

    if (error) {
      logger.error('[DB] Supabase connection test failed', {
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return false;
    }

    logger.info('[DB] ✅ Supabase connection successful');
    return true;
  } catch (error) {
    logger.error('[DB] Supabase connection test exception', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/**
 * Test Supabase Auth health
 * Returns true if Auth service is healthy, false otherwise
 */
export const testSupabaseAuthHealth = async (): Promise<{
  healthy: boolean;
  error?: string;
  latency?: number;
}> => {
  const startTime = Date.now();

  try {
    // Attempt a lightweight auth operation (get session)
    // This will fail gracefully if auth is down
    const { error } = await supabase.auth.getSession();

    const latency = Date.now() - startTime;

    if (error) {
      // Check for HTML error response (503/500)
      const errorMessage = error.message || '';
      const isSupabaseDown = errorMessage.includes('not valid JSON') ||
        errorMessage.includes('Unexpected token') ||
        errorMessage.includes('Internal server error') ||
        errorMessage.includes('Service Unavailable');

      if (isSupabaseDown) {
        logger.error('[AUTH_HEALTH] Supabase Auth service is down', {
          error: errorMessage,
          latency,
        });
        return { healthy: false, error: 'Auth service unavailable', latency };
      }

      // Other errors (not necessarily downtime)
      logger.warn('[AUTH_HEALTH] Auth health check returned error', {
        error: errorMessage,
        latency,
      });
      return { healthy: true, latency }; // Still consider healthy for non-critical errors
    }

    logger.debug('[AUTH_HEALTH] ✅ Supabase Auth healthy', { latency });
    return { healthy: true, latency };
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('[AUTH_HEALTH] Supabase Auth health check exception', {
      error: errorMessage,
      latency,
    });

    return {
      healthy: false,
      error: errorMessage,
      latency,
    };
  }
};

// Simplified database types
export interface Database {
  public: {
    Tables: {
      [key: string]: {
        Row: any;
        Insert: any;
        Update: any;
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
}

// Typed Supabase client
export type TypedSupabaseClient = SupabaseClient<Database>;

// Helper functions for common operations
export class SupabaseService {
  private client: TypedSupabaseClient;
  public supabaseAdmin = supabaseAdmin;

  constructor(useAdmin = false) {
    this.client = useAdmin ? supabaseAdmin : supabase;
  }

  // Test operations
  async createTest(testData: any) {
    // Validate input
    if (!testData || !testData.url || !testData.project_id) {
      throw new Error('Invalid test data: url and project_id are required');
    }

    logger.info('[DB] Creating test in database', {
      testId: testData.id,
      projectId: testData.project_id,
      userId: testData.user_id,
      url: testData.url,
    });

    const { data, error } = await this.client
      .from('tests')
      .insert(testData)
      .select()
      .maybeSingle(); // Use maybeSingle() to avoid errors

    if (error) {
      logger.error('[DB] Failed to create test', {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        testId: testData.id,
        projectId: testData.project_id,
      });
      throw error;
    }

    if (!data) {
      logger.error('[DB] Test insert returned no data', {
        testId: testData.id,
        projectId: testData.project_id,
      });
      throw new Error('Test insert returned no data');
    }

    logger.info('[DB] Test created successfully', { testId: (data as any).id });
    return data as any;
  }

  async getTest(id: string) {
    // Validate input
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid test id: must be a non-empty string');
    }

    const { data, error } = await this.client
      .from('tests')
      .select(`
        *,
        test_results (*)
      `)
      .eq('id', id)
      .maybeSingle(); // Use maybeSingle() instead of single() - returns null if not found, doesn't throw

    if (error) {
      logger.error('[DB] Error fetching test', {
        id,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data as any;
  }

  async updateTest(id: string, updates: any) {
    // Validate inputs
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid test id: must be a non-empty string');
    }
    if (!updates || typeof updates !== 'object') {
      throw new Error('Invalid updates: must be an object');
    }

    logger.info('[DB] Updating test', { testId: id });

    const { data, error } = await (this.client as any)
      .from('tests')
      .update(updates) // Don't add updated_at - tests table doesn't have it
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[DB] Failed to update test', {
        testId: id,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    if (!data) {
      logger.warn('[DB] Test update returned no data', { testId: id });
    }

    return data as any;
  }

  /**
   * Update test only if it is not cancelled.
   * This helps avoid races where a cancelled test is overwritten back to running.
   */
  async updateTestIfNotCancelled(id: string, updates: any) {
    // Validate inputs
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid test id: must be a non-empty string');
    }
    if (!updates || typeof updates !== 'object') {
      throw new Error('Invalid updates: must be an object');
    }

    logger.info('[DB] Updating test (if not cancelled)', { testId: id });

    const { data, error } = await (this.client as any)
      .from('tests')
      .update(updates)
      .eq('id', id)
      .neq('status', 'cancelled')
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[DB] Failed to update test (if not cancelled)', {
        testId: id,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data as any; // Can be null if test is cancelled or not found
  }

  async getTestsByProject(projectId: string, limit = 50, offset = 0) {
    // Validate inputs
    if (!projectId || typeof projectId !== 'string') {
      throw new Error('Invalid project id: must be a non-empty string');
    }
    if (limit < 1 || limit > 100) {
      throw new Error('Invalid limit: must be between 1 and 100');
    }
    if (offset < 0) {
      throw new Error('Invalid offset: must be non-negative');
    }

    const { data, error } = await this.client
      .from('tests')
      .select(`
        *,
        test_results (*)
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[DB] Failed to get tests by project', {
        projectId,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data;
  }

  // Test result operations
  async createTestResult(resultData: any) {
    // Validate input
    if (!resultData || !resultData.test_id || !resultData.browser) {
      throw new Error('Invalid test result data: test_id and browser are required');
    }

    logger.info('[DB] Creating test result', {
      testId: resultData.test_id,
      browser: resultData.browser,
      status: resultData.status,
    });

    const insertOnce = async (payload: any) =>
      this.client
        .from('test_results')
        .insert(payload)
        .select()
        .maybeSingle(); // Use maybeSingle() for safety

    const { data, error } = await insertOnce(resultData);

    if (error) {
      // Backward-compatible fallback: some Supabase instances may not have the artifact columns yet.
      // PostgREST returns PGRST204 when a column is missing.
      const errorCode = (error as any)?.code;
      if (errorCode === 'PGRST204' && (resultData?.video_url !== undefined || resultData?.trace_url !== undefined || resultData?.replay_trace_url !== undefined)) {
        const { video_url: _videoUrl, trace_url: _traceUrl, replay_trace_url: _replayTraceUrl, ...withoutArtifacts } = resultData || {};
        // Keep explicit destructuring for clarity, but avoid unused-vars lint errors
        void _videoUrl;
        void _traceUrl;
        void _replayTraceUrl;
        logger.warn('[DB] test_results schema missing artifact columns; retrying insert without video_url/trace_url/replay_trace_url', {
          testId: resultData.test_id,
          browser: resultData.browser,
          originalError: (error as any)?.message,
          hint: 'Apply DB migration adding video_url/trace_url (supabase-migrations/20260121_test_results_artifact_columns.sql) and restart Supabase API to refresh PostgREST schema cache.',
        });

        const retry = await insertOnce(withoutArtifacts);
        if (retry.error) {
          logger.error('[DB] Failed to create test result (retry without artifacts also failed)', {
            testId: resultData.test_id,
            browser: resultData.browser,
            error: retry.error.message,
            code: (retry.error as any)?.code,
          });
          throw retry.error;
        }
        if (!retry.data) {
          logger.error('[DB] Test result insert retry returned no data', {
            testId: resultData.test_id,
            browser: resultData.browser,
          });
          throw new Error('Test result insert returned no data');
        }
        logger.info('[DB] Test result created successfully (without artifacts)', { resultId: (retry.data as any).id });
        return retry.data;
      }

      logger.error('[DB] Failed to create test result', {
        testId: resultData.test_id,
        browser: resultData.browser,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    if (!data) {
      logger.error('[DB] Test result insert returned no data', {
        testId: resultData.test_id,
        browser: resultData.browser,
      });
      throw new Error('Test result insert returned no data');
    }

    logger.info('[DB] Test result created successfully', { resultId: (data as any).id });
    return data;
  }

  /**
   * Mobile-only counterpart to {@link createTestResult}. Writes to the
   * forked `mobile_test_results` table (created by
   * 20260508_mobile_regression_tables.sql).
   *
   * Why a separate method:
   *   - The shared `test_results` table doesn't have the mobile-only
   *     aggregate columns (`duration`, `steps_total`, `steps_passed`,
   *     `steps_failed`, `pass_rate`, `metadata`, `user_id`,
   *     `workspace_id`) and we explicitly chose NOT to add them
   *     (see migration header). Writing the mobile payload to
   *     `test_results` would surface PGRST204 "missing column" errors
   *     on every mobile run.
   *   - `mobile_test_results.browser` accepts only `mobile-android` /
   *     `mobile-ios` (TEXT + CHECK). Pass those values; other browsers
   *     will fail the constraint.
   *   - `mobile_test_results.status` is TEXT (decoupled from the
   *     `test_status` enum) so mobile can extend statuses without
   *     touching the shared enum.
   *
   * No artifact-column fallback is needed here — we own the schema and
   * every column the worker writes is part of the migration.
   */
  async createMobileTestResult(resultData: any) {
    if (!resultData || !resultData.test_id || !resultData.browser) {
      throw new Error('Invalid mobile test result data: test_id and browser are required');
    }

    logger.info('[DB] Creating mobile test result', {
      testId: resultData.test_id,
      browser: resultData.browser,
      status: resultData.status,
    });

    const { data, error } = await this.client
      .from('mobile_test_results')
      .insert(resultData)
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[DB] Failed to create mobile test result', {
        testId: resultData.test_id,
        browser: resultData.browser,
        error: error.message,
        code: (error as any)?.code,
      });
      throw error;
    }

    if (!data) {
      logger.error('[DB] Mobile test result insert returned no data', {
        testId: resultData.test_id,
        browser: resultData.browser,
      });
      throw new Error('Mobile test result insert returned no data');
    }

    logger.info('[DB] Mobile test result created successfully', { resultId: (data as any).id });
    return data;
  }

  // A test result id lives in EITHER the shared web table (test_results) or the
  // forked mobile table (mobile_test_results). ids are unique UUIDs, so try web
  // first, then fall back to mobile — mirroring the read fallback in
  // AIAnalysisJobHandler.getTestResult. Without the mobile branch, an ai_summary
  // written for a mobile run matched 0 rows in test_results and was silently
  // dropped, so the report assembler surfaced no bugs for mobile runs.
  //
  // CONSTRAINT: `updates` must reference only columns common to BOTH tables (the
  // sole caller sets `ai_summary`). A web-only column would throw on the mobile
  // fallback when the id isn't in test_results.
  async updateTestResult(id: string, updates: any) {
    // Validate inputs
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid test result id: must be a non-empty string');
    }
    if (!updates || typeof updates !== 'object') {
      throw new Error('Invalid updates: must be an object');
    }

    logger.info('[DB] Updating test result', { resultId: id });

    const web = await this.updateResultInTable('test_results', id, updates);
    if (web) {
      return web as any;
    }

    // Not found in test_results — the id belongs to a mobile run.
    const mobile = await this.updateResultInTable('mobile_test_results', id, updates);
    if (!mobile) {
      logger.warn('[DB] Test result update matched no row in either table', { resultId: id });
    }
    return mobile as any;
  }

  // Update one result table by id; returns the updated row, or null on a 0-row
  // match. Throws (after logging table + code) on a real DB error.
  private async updateResultInTable(
    table: 'test_results' | 'mobile_test_results',
    id: string,
    updates: any,
  ) {
    const res = await (this.client as any)
      .from(table)
      .update(updates) // Don't add updated_at - column doesn't exist in test_results
      .eq('id', id)
      .select()
      .maybeSingle(); // Use maybeSingle() for safety

    if (res.error) {
      logger.error(`[DB] Failed to update test result (${table})`, {
        resultId: id,
        error: res.error.message,
        code: res.error.code,
      });
      throw res.error;
    }
    return res.data ?? null;
  }

  async getTestResults(testId: string) {
    // Validate input
    if (!testId || typeof testId !== 'string') {
      throw new Error('Invalid test id: must be a non-empty string');
    }

    const { data, error } = await this.client
      .from('test_results')
      .select('*')
      .eq('test_id', testId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[DB] Failed to get test results', {
        testId,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data as any;
  }

  async getTestResultByTestAndBrowser(testId: string, browser: string) {
    // Validate inputs
    if (!testId || typeof testId !== 'string') {
      throw new Error('Invalid test id: must be a non-empty string');
    }
    if (!browser || typeof browser !== 'string') {
      throw new Error('Invalid browser: must be a non-empty string');
    }

    const { data, error } = await this.client
      .from('test_results')
      .select('*')
      .eq('test_id', testId)
      .eq('browser', browser)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(); // Use maybeSingle() instead of single() - returns null if not found

    if (error) {
      logger.error('[DB] Failed to get test result by test and browser', {
        testId,
        browser,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data as any; // Returns null if not found, which is fine
  }

  // Project operations
  async createProject(projectData: any) {
    // Check if workspaces table exists (for backward compatibility during migration)
    const { error: tableCheckError } = await this.client
      .from('workspaces')
      .select('id')
      .limit(1);

    // If workspaces table doesn't exist (error code 42P01 = relation does not exist), use legacy mode
    if (tableCheckError && (tableCheckError.code === '42P01' || tableCheckError.message?.includes('does not exist'))) {
      logger.warn('[DB] Workspaces table not found, creating project without workspace_id (legacy mode)');
      // Remove workspace_id if it was provided but table doesn't exist
      delete projectData.workspace_id;

      const { data, error } = await this.client
        .from('projects')
        .insert(projectData)
        .select()
        .single();

      if (error) throw error;
      return data;
    }

    // Validate workspace_id is provided
    if (!projectData.workspace_id) {
      throw new Error('workspace_id is required. Project must belong to a workspace.');
    }

    // Verify workspace exists and belongs to the user
    const { data: workspace, error: workspaceError } = await this.client
      .from('workspaces')
      .select('id, user_id')
      .eq('id', projectData.workspace_id)
      .single();

    if (workspaceError || !workspace) {
      throw new Error(`Workspace with id ${projectData.workspace_id} not found`);
    }

    // Type assertion for workspace (we know it has user_id from select)
    const workspaceData = workspace as { id: string; user_id: string };

    // Verify user_id matches workspace owner (if user_id is provided)
    if (projectData.user_id && workspaceData.user_id !== projectData.user_id) {
      throw new Error('Project user_id must match workspace owner');
    }

    // Ensure projectData.user_id matches workspace owner
    projectData.user_id = workspaceData.user_id;

    const { data, error } = await this.client
      .from('projects')
      .insert(projectData)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getProject(id: string) {
    // Validate input
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid project id: must be a non-empty string');
    }

    const { data, error } = await this.client
      .from('projects')
      .select('*')
      .eq('id', id)
      .maybeSingle(); // Use maybeSingle() for safety

    if (error) {
      logger.error('[DB] Failed to get project', {
        projectId: id,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data;
  }

  async getUserProjects(userId: string) {
    // Validate input
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user id: must be a non-empty string');
    }

    const { data, error } = await this.client
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[DB] Failed to get user projects', {
        userId,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data;
  }

  // User operations
  async getUser(id: string) {
    // Validate input
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid user id: must be a non-empty string');
    }

    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle(); // Use maybeSingle() for safety

    if (error) {
      logger.error('[DB] Failed to get user', {
        userId: id,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data;
  }

  /**
   * @deprecated Use UserCreditsService.addCredits() instead
   * This method is kept for backwards compatibility but now uses user_credits table
   */
  async updateUserCredits(userId: string, amount: number) {
    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user id: must be a non-empty string');
    }
    if (typeof amount !== 'number' || isNaN(amount)) {
      throw new Error('Invalid amount: must be a valid number');
    }

    logger.warn('[DB] updateUserCredits is deprecated, use UserCreditsService.addCredits() instead', { userId });

    // Use UserCreditsService instead of direct update
    const { UserCreditsService } = await import('@/services/core/user-credits.service');
    const userCredits = await UserCreditsService.getOrCreateUserCredits(userId);
    const currentBalance = Number.isFinite(userCredits.credits_balance) ? (userCredits.credits_balance || 0) : 0;
    const difference = amount - currentBalance;

    if (difference > 0) {
      // Add credits
      const result = await UserCreditsService.addCredits(
        userId,
        difference,
        'bonus',
        `Updated credits via deprecated updateUserCredits method`,
        {}
      );
      return { credits: result.newBalance };
    } else if (difference < 0) {
      // This shouldn't happen with this method, but handle it
      logger.warn('[DB] updateUserCredits called with amount less than current balance', {
        userId,
        amount,
        currentBalance,
      });
      return { credits: currentBalance };
    }

    return { credits: currentBalance };
  }

  // Credit transaction operations
  async createCreditTransaction(transactionData: any) {
    // Validate input
    if (!transactionData || !transactionData.user_id || typeof transactionData.amount !== 'number') {
      throw new Error('Invalid transaction data: user_id and amount are required');
    }

    logger.info('[DB] Creating credit transaction', {
      userId: transactionData.user_id,
      amount: transactionData.amount,
      type: transactionData.type,
    });

    const { data, error } = await this.client
      .from('credit_transactions')
      .insert(transactionData)
      .select()
      .maybeSingle(); // Use maybeSingle() for safety

    if (error) {
      logger.error('[DB] Failed to create credit transaction', {
        userId: transactionData.user_id,
        amount: transactionData.amount,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    if (!data) {
      logger.error('[DB] Credit transaction insert returned no data', {
        userId: transactionData.user_id,
      });
      throw new Error('Credit transaction insert returned no data');
    }

    return data;
  }

  async getUserCreditTransactions(userId: string, limit = 50, offset = 0) {
    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user id: must be a non-empty string');
    }
    if (limit < 1 || limit > 100) {
      throw new Error('Invalid limit: must be between 1 and 100');
    }
    if (offset < 0) {
      throw new Error('Invalid offset: must be non-negative');
    }

    const { data, error } = await this.client
      .from('credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[DB] Failed to get user credit transactions', {
        userId,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data;
  }

  // Storage operations
  async uploadScreenshot(testId: string, browser: string, screenshotBase64: string) {
    // Validate inputs
    if (!testId || typeof testId !== 'string') {
      throw new Error('Invalid test id: must be a non-empty string');
    }
    if (!browser || typeof browser !== 'string') {
      throw new Error('Invalid browser: must be a non-empty string');
    }
    if (!screenshotBase64 || typeof screenshotBase64 !== 'string') {
      throw new Error('Invalid screenshot data: must be a base64 string');
    }

    logger.info('[DB] Uploading screenshot', {
      testId,
      browser,
      dataLength: screenshotBase64.length,
    });

    try {
      const fileName = `${testId}/${browser}-${Date.now()}.png`;
      const buffer = Buffer.from(screenshotBase64, 'base64');

      const { data, error } = await this.client.storage
        .from(env.SUPABASE_BUCKET_NAME)
        .upload(fileName, buffer, {
          contentType: 'image/png',
          upsert: false,
        });

      if (error) {
        logger.error('[DB] Failed to upload screenshot', {
          testId,
          browser,
          fileName,
          error: error.message,
        });
        throw error;
      }

      logger.info('[DB] Screenshot uploaded successfully', {
        testId,
        browser,
        fileName: data.path,
      });

      return data;
    } catch (error) {
      logger.error('[DB] Exception during screenshot upload', {
        testId,
        browser,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getScreenshotUrl(fileName: string) {
    // Validate input
    if (!fileName || typeof fileName !== 'string') {
      throw new Error('Invalid file name: must be a non-empty string');
    }

    try {
      // getPublicUrl is synchronous and always returns { data: { publicUrl: string } }
      // It doesn't validate if file exists, just generates URL
      const { data } = this.client.storage
        .from(env.SUPABASE_BUCKET_NAME)
        .getPublicUrl(fileName);

      if (!data || !data.publicUrl) {
        logger.warn('[DB] Failed to generate screenshot URL', { fileName });
        throw new Error('Failed to generate public URL');
      }

      return data.publicUrl;
    } catch (error) {
      logger.error('[DB] Exception during get screenshot URL', {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// Export singleton instances
export const dbService = new SupabaseService(false); // Public client
export const dbAdminService = new SupabaseService(true); // Admin client
