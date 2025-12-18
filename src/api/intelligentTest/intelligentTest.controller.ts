import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { IntelligentTestStorageService } from '@/services/testing/results/intelligent-test-storage.service';

/**
 * Get intelligent test session with full details for visualization
 */
export const getTestSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const userId = req.user!.id;

    logger.info('[INTELLIGENT_TEST_API] Getting test session', {
      sessionId,
      userId,
    });

    const data = await IntelligentTestStorageService.getTestSession(sessionId);

    // Verify ownership
    if (data.session.user_id !== userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have permission to view this test session',
      });
      return;
    }

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTELLIGENT_TEST_API] Error getting test session', {
      error,
      sessionId: req.params.sessionId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get test session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get test flow for visualization (simplified view)
 * ✅ FIX #22: Added ownership check to prevent sessionId enumeration
 */
export const getTestFlow = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const userId = req.user!.id;

    logger.info('[INTELLIGENT_TEST_API] Getting test flow', {
      sessionId,
      userId,
    });

    // NOTE: Service typings are loose; force object shape to avoid TS treating it as any[]
    const flow: any = await IntelligentTestStorageService.getTestFlow(sessionId);

    // ✅ FIX #22: Verify ownership before returning data
    if (flow.session.user_id !== userId) {
      logger.warn('[INTELLIGENT_TEST_API] Unauthorized test flow access attempt', {
        sessionId,
        userId,
        actualUserId: flow.session.user_id,
      });
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have permission to view this test flow',
      });
      return;
    }

    res.json({
      success: true,
      data: flow,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTELLIGENT_TEST_API] Error getting test flow', {
      error,
      sessionId: req.params.sessionId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get test flow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get intelligent test sessions for a test
 */
export const getTestSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { testId } = req.params;
    const userId = req.user!.id;

    logger.info('[INTELLIGENT_TEST_API] Getting test sessions', {
      testId,
      userId,
    });

    const { supabaseAdmin } = await import('@/db/supabase');

    const { data, error } = await supabaseAdmin
      .from('intelligent_test_sessions')
      .select('*')
      .eq('test_id', testId)
      .eq('user_id', userId)
      .order('started_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTELLIGENT_TEST_API] Error getting test sessions', {
      error,
      testId: req.params.testId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get test sessions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get test findings (bugs discovered during testing)
 * ✅ FIX #23: Added ownership check to prevent sessionId enumeration
 */
export const getTestFindings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const userId = req.user!.id;
    const { severity, type, status } = req.query;

    logger.info('[INTELLIGENT_TEST_API] Getting test findings', {
      sessionId,
      userId,
      filters: { severity, type, status },
    });

    const { supabaseAdmin } = await import('@/db/supabase');

    // ✅ FIX #23: First verify session ownership
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('intelligent_test_sessions')
      .select('user_id')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.warn('[INTELLIGENT_TEST_API] Session not found', {
        sessionId,
        error: sessionError?.message,
      });
      res.status(404).json({
        success: false,
        error: 'Session not found',
        message: 'The requested test session does not exist',
      });
      return;
    }

    if (session.user_id !== userId) {
      logger.warn('[INTELLIGENT_TEST_API] Unauthorized findings access attempt', {
        sessionId,
        userId,
        actualUserId: session.user_id,
      });
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have permission to view these findings',
      });
      return;
    }

    // Now fetch findings
    let query = supabaseAdmin
      .from('intelligent_test_findings')
      .select('*')
      .eq('session_id', sessionId);

    if (severity) {
      query = query.eq('severity', severity);
    }

    if (type) {
      query = query.eq('finding_type', type);
    }

    if (status) {
      query = query.eq('status', status);
    }

    query = query.order('severity', { ascending: false }).order('found_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTELLIGENT_TEST_API] Error getting test findings', {
      error,
      sessionId: req.params.sessionId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get test findings',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
