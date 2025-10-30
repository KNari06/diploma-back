import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

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

// Test connection
export const testSupabaseConnection = async (): Promise<boolean> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tests')
      .select('count')
      .limit(1);
    
    if (error) {
      logger.error('Supabase connection test failed:', error);
      return false;
    }
    
    logger.info('✅ Supabase connection successful');
    return true;
  } catch (error) {
    logger.error('Supabase connection test failed:', error);
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
    const { data, error } = await this.client
      .from('tests')
      .insert(testData)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getTest(id: string) {
    const { data, error } = await this.client
      .from('tests')
      .select(`
        *,
        test_results (*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data as any;
  }

  async updateTest(id: string, updates: any) {
    const { data, error } = await (this.client as any)
      .from('tests')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data as any;
  }

  async getTestsByProject(projectId: string, limit = 50, offset = 0) {
    const { data, error } = await this.client
      .from('tests')
      .select(`
        *,
        test_results (*)
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  }

  // Test result operations
  async createTestResult(resultData: any) {
    const { data, error } = await this.client
      .from('test_results')
      .insert(resultData)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateTestResult(id: string, updates: any) {
    const { data, error } = await (this.client as any)
      .from('test_results')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data as any;
  }

  async getTestResults(testId: string) {
    const { data, error } = await this.client
      .from('test_results')
      .select('*')
      .eq('test_id', testId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as any;
  }

  // Project operations
  async createProject(projectData: any) {
    const { data, error } = await this.client
      .from('projects')
      .insert(projectData)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getProject(id: string) {
    const { data, error } = await this.client
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  async getUserProjects(userId: string) {
    const { data, error } = await this.client
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  // User operations
  async getUser(id: string) {
    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  async updateUserCredits(userId: string, amount: number) {
    const { data, error } = await (this.client as any)
      .from('users')
      .update({ 
        credits: amount,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data as any;
  }

  // Credit transaction operations
  async createCreditTransaction(transactionData: any) {
    const { data, error } = await this.client
      .from('credit_transactions')
      .insert(transactionData)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getUserCreditTransactions(userId: string, limit = 50, offset = 0) {
    const { data, error } = await this.client
      .from('credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  }

  // Storage operations
  async uploadScreenshot(testId: string, browser: string, screenshotBase64: string) {
    const fileName = `${testId}/${browser}-${Date.now()}.png`;
    const buffer = Buffer.from(screenshotBase64, 'base64');

    const { data, error } = await this.client.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(fileName, buffer, {
        contentType: 'image/png',
        upsert: false,
      });

    if (error) throw error;
    return data;
  }

  async getScreenshotUrl(fileName: string) {
    const { data } = this.client.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .getPublicUrl(fileName);

    return data.publicUrl;
  }
}

// Export singleton instances
export const dbService = new SupabaseService(false); // Public client
export const dbAdminService = new SupabaseService(true); // Admin client
