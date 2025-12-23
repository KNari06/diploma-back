import { supabaseAdmin } from '@/db/supabase';
import { WaitlistRole, WaitlistService } from '@/services/waitlist/waitlist.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * POST /api/v1/waitlist/join
 * Join waitlist
 */
export const joinWaitlist = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, role } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          name: 'Name is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          email: 'Email is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!role || typeof role !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          role: 'Role is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          email: 'Invalid email format',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate role
    const validRoles = ['qa_engineer', 'software_engineer', 'founder_cto', 'product_manager', 'other'];
    if (!validRoles.includes(role)) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          role: `Invalid role. Must be one of: ${validRoles.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Join waitlist
    const entry = await WaitlistService.joinWaitlist({
      name: name.trim(),
      email: email.trim(),
      role: role as WaitlistRole,
    });

    if (!entry) {
      res.status(500).json({
        success: false,
        error: 'Failed to join waitlist',
        code: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Success response
    res.status(200).json({
      success: true,
      message: 'Successfully joined the waitlist',
      data: {
        id: entry.id,
        email: entry.email,
        name: entry.name,
        role: entry.role,
        joinedAt: entry.created_at,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('[WAITLIST_CONTROLLER] Error joining waitlist', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Handle email already exists error
    if (error.message === 'EMAIL_ALREADY_EXISTS') {
      res.status(409).json({
        success: false,
        error: 'Email already registered',
        code: 'EMAIL_ALREADY_EXISTS',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Handle validation errors
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          message: error.message,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Generic error
    res.status(500).json({
      success: false,
      error: 'Failed to join waitlist',
      code: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/waitlist
 * Get waitlist entries (admin only)
 */
export const getWaitlist = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if user is admin
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (userError || !userData || userData.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Parse pagination params
    const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;

    // Validate pagination
    if (isNaN(page) || page < 1) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          page: 'Page must be a positive integer',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (isNaN(limit) || limit < 1 || limit > 100) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: {
          limit: 'Limit must be between 1 and 100',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get waitlist entries
    const result = await WaitlistService.getWaitlistEntries({ page, limit });

    res.status(200).json({
      success: true,
      data: result.entries,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        has_more: result.has_more,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('[WAITLIST_CONTROLLER] Error getting waitlist', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get waitlist',
      code: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    });
  }
};
