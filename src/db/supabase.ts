import { env } from '@/config/env';
import { logger } from '@/utils/logger';
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
 * Test Supabase connection
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

    const { data, error } = await this.client
      .from('test_results')
      .insert(resultData)
      .select()
      .maybeSingle(); // Use maybeSingle() for safety

    if (error) {
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

  async updateTestResult(id: string, updates: any) {
    // Validate inputs
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid test result id: must be a non-empty string');
    }
    if (!updates || typeof updates !== 'object') {
      throw new Error('Invalid updates: must be an object');
    }

    logger.info('[DB] Updating test result', { resultId: id });

    const { data, error } = await (this.client as any)
      .from('test_results')
      .update(updates) // Don't add updated_at - column doesn't exist in test_results
      .eq('id', id)
      .select()
      .maybeSingle(); // Use maybeSingle() for safety

    if (error) {
      logger.error('[DB] Failed to update test result', {
        resultId: id,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    if (!data) {
      logger.warn('[DB] Test result update returned no data', { resultId: id });
    }

    return data as any;
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

  async updateUserCredits(userId: string, amount: number) {
    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user id: must be a non-empty string');
    }
    if (typeof amount !== 'number' || isNaN(amount)) {
      throw new Error('Invalid amount: must be a valid number');
    }

    logger.info('[DB] Updating user credits', { userId, amount });

    const { data, error } = await (this.client as any)
      .from('users')
      .update({
        credits: amount,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .maybeSingle(); // Use maybeSingle() for safety

    if (error) {
      logger.error('[DB] Failed to update user credits', {
        userId,
        amount,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    if (!data) {
      logger.warn('[DB] User credits update returned no data', { userId });
    }

    return data as any;
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
