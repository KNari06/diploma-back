import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// In-memory cache for IP → country to avoid hitting rate limits
const ipCountryCache = new Map<string, string>();

async function lookupCountry(ip: string | null): Promise<string | null> {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
    return null;
  }
  if (ipCountryCache.has(ip)) return ipCountryCache.get(ip) || null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://api.country.is/${ip}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json() as { country?: string };
    const country = data.country || null;
    if (country) ipCountryCache.set(ip, country);
    return country;
  } catch {
    return null;
  }
}

async function backfillCountry(visitId: string, ip: string | null) {
  const country = await lookupCountry(ip);
  if (!country) return;
  try {
    await supabaseAdmin.from('investor_visits').update({ country }).eq('id', visitId);
  } catch {
    // ignore
  }
}

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

    const trimmedName = name.trim();
    const month = reportMonth || 'unknown';
    const DEDUP_WINDOW_HOURS = 24;
    const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    // Dedup: if same IP + same name visited the same report within 24h,
    // reuse the existing row — update its session_id so the next PATCH
    // (engagement beacon) accumulates onto it.
    let existingId: string | null = null;
    if (ip) {
      const { data: existing } = await supabaseAdmin
        .from('investor_visits')
        .select('id')
        .eq('ip_address', ip)
        .ilike('visitor_name', trimmedName)
        .eq('report_month', month)
        .gte('visited_at', since)
        .order('visited_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing?.id) {
        existingId = existing.id;
      }
    }

    if (existingId) {
      // Reuse existing visit — update session_id so future PATCH lands here,
      // and bump visited_at to now so it reflects the most recent open.
      const { error: updateErr } = await supabaseAdmin
        .from('investor_visits')
        .update({
          session_id: sessionId,
          visited_at: new Date().toISOString(),
          user_agent: userAgent || null,
          screen_width: screenWidth || null,
          screen_height: screenHeight || null,
        })
        .eq('id', existingId);

      if (updateErr) throw updateErr;

      logger.info('[INVESTOR] Visit deduped (reusing existing)', {
        name: trimmedName,
        ip,
        visitId: existingId,
      });

      res.status(200).json({
        success: true,
        visitId: existingId,
        deduped: true,
      });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('investor_visits')
      .insert({
        visitor_name: trimmedName,
        report_month: month,
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
      name: trimmedName,
      reportMonth: month,
      sessionId,
      visitId: data?.id,
    });

    // Fire-and-forget country lookup
    if (data?.id && ip) {
      backfillCountry(data.id, ip).catch(() => {});
    }

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
    const incomingTime = typeof timeOnPageSec === 'number'
      ? Math.min(MAX_TIME_SEC, Math.max(0, Math.round(timeOnPageSec)))
      : null;
    const incomingScroll = typeof maxScrollPct === 'number'
      ? Math.min(100, Math.max(0, Math.round(maxScrollPct)))
      : null;

    if (incomingTime == null && incomingScroll == null) {
      res.status(200).json({ success: true, message: 'Nothing to update' });
      return;
    }

    // Read current values so we can take MAX (not overwrite) —
    // important because dedup may reuse a row across sessions, and the
    // incoming beacon only reflects the current session's engagement.
    const { data: current } = await supabaseAdmin
      .from('investor_visits')
      .select('time_on_page_sec, max_scroll_pct')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (!current) {
      // Session not found — likely dedup moved it to a new session_id.
      // No-op rather than 404 (best-effort engagement tracking).
      res.status(200).json({ success: true, message: 'Session not found' });
      return;
    }

    const updateData: Record<string, any> = {};
    if (incomingTime != null) {
      updateData.time_on_page_sec = Math.max(current.time_on_page_sec || 0, incomingTime);
    }
    if (incomingScroll != null) {
      updateData.max_scroll_pct = Math.max(current.max_scroll_pct || 0, incomingScroll);
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

/**
 * DELETE /api/v1/investor/visits/:id
 * Delete a single visit by UUID. Admin-only (auth handled at route level).
 */
export const deleteVisit = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ success: false, error: 'Visit ID is required' });
      return;
    }

    // Validate UUID shape loosely — prevents accidental mass-delete if route misused
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ success: false, error: 'Invalid visit ID format' });
      return;
    }

    const { error, count } = await supabaseAdmin
      .from('investor_visits')
      .delete({ count: 'exact' })
      .eq('id', id);

    if (error) throw error;

    logger.info('[INVESTOR] Visit deleted', { id, count });

    res.status(200).json({ success: true, deleted: count || 0 });
  } catch (error: any) {
    logger.error('[INVESTOR] Error deleting visit', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to delete visit',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * DELETE /api/v1/investor/visits/by-visitor
 * Delete all visits matching (name + optional IP). Body: { name, ip?, month? }
 * Admin-only. Requires name at minimum; scope by IP/month to avoid broad deletes.
 */
export const deleteVisitsByVisitor = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, ip, month } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Name is required' });
      return;
    }

    let query = supabaseAdmin
      .from('investor_visits')
      .delete({ count: 'exact' })
      .ilike('visitor_name', name.trim());

    if (ip && typeof ip === 'string') query = query.eq('ip_address', ip);
    if (month && typeof month === 'string') query = query.eq('report_month', month);

    const { error, count } = await query;

    if (error) throw error;

    logger.info('[INVESTOR] Visits bulk deleted', { name: name.trim(), ip, month, count });

    res.status(200).json({ success: true, deleted: count || 0 });
  } catch (error: any) {
    logger.error('[INVESTOR] Error bulk deleting visits', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to delete visits',
      timestamp: new Date().toISOString(),
    });
  }
};
