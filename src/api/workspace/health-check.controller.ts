import { Request, Response } from 'express';
import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * GET /api/v1/workspaces/config-check
 * Check workspace invite configuration (admin only)
 */
export const checkInviteConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    const checks = {
      frontendUrl: {
        configured: !!env.FRONTEND_URL,
        value: env.FRONTEND_URL,
        valid: env.FRONTEND_URL?.startsWith('http'),
      },
      supabase: {
        configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
        url: env.SUPABASE_URL,
      },
      smtp: {
        note: 'SMTP must be configured in Supabase Dashboard → Settings → Auth → SMTP Settings',
        testUrl: `${env.SUPABASE_URL}/dashboard/project/_/settings/auth`,
      },
    };

    // Test Supabase connection
    let supabaseConnected = false;
    try {
      const { error } = await supabaseAdmin.from('workspaces').select('id').limit(1);
      supabaseConnected = !error;
    } catch (error) {
      logger.error('[CONFIG_CHECK] Supabase connection test failed', { error });
    }

    const allGood =
      checks.frontendUrl.configured &&
      checks.frontendUrl.valid &&
      checks.supabase.configured &&
      supabaseConnected;

    res.json({
      success: true,
      status: allGood ? 'ready' : 'needs_configuration',
      checks: {
        ...checks,
        supabaseConnection: {
          connected: supabaseConnected,
        },
      },
      recommendations: allGood ? [] : [
        !checks.frontendUrl.configured && 'Set FRONTEND_URL in .env',
        !checks.frontendUrl.valid && 'FRONTEND_URL must start with http:// or https://',
        !checks.supabase.configured && 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env',
        !supabaseConnected && 'Check Supabase credentials',
        'Configure SMTP in Supabase Dashboard',
      ].filter(Boolean),
    });
  } catch (error) {
    logger.error('[CONFIG_CHECK] Error checking config', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to check configuration',
    });
  }
};
