import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export type WaitlistRole = 'qa_engineer' | 'software_engineer' | 'founder_cto' | 'product_manager' | 'other';

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string;
  role: WaitlistRole;
  created_at: string;
  updated_at: string;
}

export interface JoinWaitlistParams {
  name: string;
  email: string;
  role: WaitlistRole;
}

/**
 * Waitlist Service
 * Handles waitlist signups for early access
 */
export class WaitlistService {
  /**
   * Join waitlist
   * @param params - Waitlist entry data
   * @returns Waitlist entry or null if error
   */
  static async joinWaitlist(params: JoinWaitlistParams): Promise<WaitlistEntry | null> {
    try {
      // Validate inputs
      if (!params.email || typeof params.email !== 'string') {
        logger.warn('[WAITLIST] Invalid email', { email: params.email });
        throw new Error('Email is required');
      }

      if (!params.name || typeof params.name !== 'string') {
        logger.warn('[WAITLIST] Invalid name', { name: params.name });
        throw new Error('Name is required');
      }

      if (!params.role || typeof params.role !== 'string') {
        logger.warn('[WAITLIST] Invalid role', { role: params.role });
        throw new Error('Role is required');
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(params.email.trim())) {
        logger.warn('[WAITLIST] Invalid email format', { email: params.email.substring(0, 5) + '***' });
        throw new Error('Invalid email format');
      }

      // Validate role
      const validRoles: WaitlistRole[] = ['qa_engineer', 'software_engineer', 'founder_cto', 'product_manager', 'other'];
      if (!validRoles.includes(params.role)) {
        logger.warn('[WAITLIST] Invalid role value', { role: params.role });
        throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
      }

      // Normalize email (lowercase, trim)
      const normalizedEmail = params.email.trim().toLowerCase();
      const normalizedName = params.name.trim();

      // Check if email already exists
      const { data: existing, error: checkError } = await supabaseAdmin
        .from('waitlist')
        .select('id, email, name, role, created_at')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (checkError && checkError.code !== 'PGRST116') {
        // PGRST116 = not found (expected), other errors are real errors
        logger.error('[WAITLIST] Error checking existing email', {
          error: checkError.message,
          code: checkError.code,
          email: normalizedEmail.substring(0, 5) + '***',
        });
        throw new Error('Failed to check existing email');
      }

      if (existing) {
        logger.info('[WAITLIST] Email already exists', {
          email: normalizedEmail.substring(0, 5) + '***',
          existingId: existing.id,
        });
        throw new Error('EMAIL_ALREADY_EXISTS');
      }

      // Insert new waitlist entry
      const { data, error } = await supabaseAdmin
        .from('waitlist')
        .insert({
          email: normalizedEmail,
          name: normalizedName,
          role: params.role,
        })
        .select('id, email, name, role, created_at, updated_at')
        .single();

      if (error) {
        logger.error('[WAITLIST] Error inserting waitlist entry', {
          error: error.message,
          code: error.code,
          email: normalizedEmail.substring(0, 5) + '***',
        });

        // Handle unique constraint violation
        if (error.code === '23505') {
          throw new Error('EMAIL_ALREADY_EXISTS');
        }

        throw new Error('Failed to join waitlist');
      }

      if (!data) {
        logger.error('[WAITLIST] No data returned after insert', {
          email: normalizedEmail.substring(0, 5) + '***',
        });
        throw new Error('Failed to join waitlist');
      }

      logger.info('[WAITLIST] Successfully joined waitlist', {
        id: data.id,
        email: normalizedEmail.substring(0, 5) + '***',
        role: params.role,
      });

      return data;
    } catch (error) {
      logger.error('[WAITLIST] Exception in joinWaitlist', {
        error: error instanceof Error ? error.message : String(error),
        email: params?.email?.substring(0, 5) + '***',
      });

      // Re-throw known errors
      if (error instanceof Error && (error.message === 'EMAIL_ALREADY_EXISTS' || error.message.includes('required') || error.message.includes('Invalid'))) {
        throw error;
      }

      throw new Error('Failed to join waitlist');
    }
  }

  /**
   * Check if email exists in waitlist
   * @param email - Email to check
   * @returns true if exists, false otherwise
   */
  static async emailExists(email: string): Promise<boolean> {
    try {
      if (!email || typeof email !== 'string') {
        return false;
      }

      const normalizedEmail = email.trim().toLowerCase();

      const { data, error } = await supabaseAdmin
        .from('waitlist')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        logger.error('[WAITLIST] Error checking email', {
          error: error.message,
          email: normalizedEmail.substring(0, 5) + '***',
        });
        return false;
      }

      return !!data;
    } catch (error) {
      logger.error('[WAITLIST] Exception in emailExists', {
        error: error instanceof Error ? error.message : String(error),
        email: email?.substring(0, 5) + '***',
      });
      return false;
    }
  }

  /**
   * Get waitlist entries with pagination
   * @param params - Pagination parameters
   * @returns List of entries and total count
   */
  static async getWaitlistEntries(params: {
    page?: number;
    limit?: number;
  }): Promise<{
    entries: WaitlistEntry[];
    total: number;
    page: number;
    limit: number;
    has_more: boolean;
  }> {
    try {
      const page = Math.max(1, params.page || 1);
      const limit = Math.min(100, Math.max(1, params.limit || 20));
      const offset = (page - 1) * limit;

      // Get total count
      const { count, error: countError } = await supabaseAdmin
        .from('waitlist')
        .select('*', { count: 'exact', head: true });

      if (countError) {
        logger.error('[WAITLIST] Error getting count', {
          error: countError.message,
        });
        throw new Error('Failed to get waitlist count');
      }

      const total = count || 0;

      // Get entries
      const { data, error } = await supabaseAdmin
        .from('waitlist')
        .select('id, email, name, role, created_at, updated_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        logger.error('[WAITLIST] Error getting entries', {
          error: error.message,
          page,
          limit,
        });
        throw new Error('Failed to get waitlist entries');
      }

      return {
        entries: data || [],
        total,
        page,
        limit,
        has_more: offset + (data?.length || 0) < total,
      };
    } catch (error) {
      logger.error('[WAITLIST] Exception in getWaitlistEntries', {
        error: error instanceof Error ? error.message : String(error),
        page: params.page,
        limit: params.limit,
      });
      throw error;
    }
  }
}
