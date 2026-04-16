import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * POST /api/v1/investor/visit
 * Record an investor visit to the report page
 */
export const recordVisit = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, reportMonth, sessionId, userAgent, screenWidth, screenHeight } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Name is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Session ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get IP from request
    const ip = req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : req.socket?.remoteAddress || null;

    const { data, error } = await supabaseAdmin
      .from('investor_visits')
      .insert({
        visitor_name: name.trim(),
        report_month: reportMonth || 'unknown',
        session_id: sessionId,
        user_agent: userAgent || null,
        screen_width: screenWidth || null,
        screen_height: screenHeight || null,
        ip_address: ip,
      })
      .select('id')
      .single();

    if (error) {
      // Duplicate session_id — already tracked, just return success
      if (error.code === '23505') {
        res.status(200).json({ success: true, message: 'Already recorded' });
        return;
      }
      throw error;
    }

    logger.info('[INVESTOR] Visit recorded', {
      name: name.trim(),
      reportMonth,
      sessionId,
      visitId: data?.id,
    });

    res.status(201).json({
      success: true,
      visitId: data?.id,
    });
  } catch (error: any) {
    logger.error('[INVESTOR] Error recording visit', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to record visit',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * PATCH /api/v1/investor/visit/:sessionId
 * Update engagement metrics (scroll depth, time on page)
 */
export const updateVisitEngagement = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const { timeOnPageSec, maxScrollPct } = req.body;

    if (!sessionId) {
      res.status(400).json({ success: false, error: 'Session ID is required' });
      return;
    }

    const MAX_TIME_SEC = 86400; // 24h cap
    const updateData: Record<string, any> = {};
    if (typeof timeOnPageSec === 'number') updateData.time_on_page_sec = Math.min(MAX_TIME_SEC, Math.max(0, Math.round(timeOnPageSec)));
    if (typeof maxScrollPct === 'number') updateData.max_scroll_pct = Math.min(100, Math.max(0, Math.round(maxScrollPct)));

    if (Object.keys(updateData).length === 0) {
      res.status(200).json({ success: true, message: 'Nothing to update' });
      return;
    }

    const { error } = await supabaseAdmin
      .from('investor_visits')
      .update(updateData)
      .eq('session_id', sessionId);

    if (error) throw error;

    res.status(200).json({ success: true });
  } catch (error: any) {
    logger.error('[INVESTOR] Error updating engagement', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to update engagement',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/investor/visits
 * List all investor visits — protected by admin password hash
 * Query params: ?key=<sha256-of-admin-password>&month=<optional-filter>
 */
export const getVisits = async (req: Request, res: Response): Promise<void> => {
  try {
    const { month } = req.query;

    let query = supabaseAdmin
      .from('investor_visits')
      .select('*')
      .order('visited_at', { ascending: false });

    if (month && typeof month === 'string') {
      query = query.eq('report_month', month);
    }

    const { data, error } = await query.limit(200);

    if (error) throw error;

    res.status(200).json({
      success: true,
      data: data || [],
      count: (data || []).length,
    });
  } catch (error: any) {
    logger.error('[INVESTOR] Error listing visits', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to list visits',
      timestamp: new Date().toISOString(),
    });
  }
};
