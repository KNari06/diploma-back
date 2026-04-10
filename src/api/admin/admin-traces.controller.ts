import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import type { Request, Response } from 'express';

const TAG = '[ADMIN_TRACES]';
const MAX_EVENTS_PER_RESPONSE = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ═══════════════════════════════════════════════════════════════════════════
// Browser column values → human-readable type mapping
// ═══════════════════════════════════════════════════════════════════════════

const BROWSER_TYPE_MAP: Record<string, string> = {
  'editor-trace': 'editor',
  'preview-run-trace': 'preview_run',
};

const TYPE_TO_BROWSER: Record<string, string> = {
  editor: 'editor-trace',
  preview_run: 'preview-run-trace',
};

// ═══════════════════════════════════════════════════════════════════════════
// LIST ALL TRACES (admin — cross-user)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/traces
 *
 * List trace files across all users with optional filters.
 * Query params:
 *   ?type=editor|preview_run|all (default: all)
 *   ?userId=UUID
 *   ?from=ISO&to=ISO (date range)
 *   ?page=1&limit=20
 */
export const listAllTraces = async (req: Request, res: Response): Promise<void> => {
  const type = (req.query.type as string) || 'all';
  const userId = req.query.userId as string | undefined;
  const search = req.query.search as string | undefined; // email search
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * limit;

  // Validate userId if provided
  if (userId && !isValidUUID(userId)) {
    res.status(400).json({ success: false, error: 'Invalid userId format' });
    return;
  }

  // If searching by email, resolve to user IDs first
  let resolvedUserIds: string[] | null = null;
  if (search && search.trim().length >= 2) {
    const { data: matchedUsers } = await supabaseAdmin
      .from('users')
      .select('id')
      .ilike('email', `%${search.trim()}%`)
      .limit(50);
    resolvedUserIds = matchedUsers?.map((u) => u.id) || [];
    if (resolvedUserIds.length === 0) {
      // No users match the search — return empty result early
      res.json({ success: true, data: [], total: 0, page, limit });
      return;
    }
  }

  // Build query
  let query = supabaseAdmin
    .from('trace_files')
    .select('id, user_id, file_name, file_size, browser, intent_test_case_id, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Filter by type
  if (type !== 'all') {
    const browserValue = TYPE_TO_BROWSER[type];
    if (browserValue) {
      query = query.eq('browser', browserValue);
    } else {
      // Also support filtering by raw browser value
      query = query.eq('browser', type);
    }
  } else {
    // Only show editor/preview traces (not legacy playwright .zip traces)
    query = query.in('browser', ['editor-trace', 'preview-run-trace']);
  }

  // Filter by userId (direct) or resolved from email search
  if (userId) {
    query = query.eq('user_id', userId);
  } else if (resolvedUserIds) {
    query = query.in('user_id', resolvedUserIds);
  }

  // Date range filters
  if (from) {
    query = query.gte('created_at', from);
  }
  if (to) {
    query = query.lte('created_at', to);
  }

  const { data: traces, error, count } = await query;

  if (error) {
    logger.error(`${TAG} Failed to list traces`, { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to list traces' });
    return;
  }

  if (!traces || traces.length === 0) {
    res.json({ success: true, data: [], total: 0, page, limit });
    return;
  }

  // Batch-fetch user info for all unique user_ids
  const uniqueUserIds = [...new Set(traces.map((t) => t.user_id).filter(Boolean))];
  const userMap = new Map<string, { email: string; name: string | null }>();

  if (uniqueUserIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, email, name')
      .in('id', uniqueUserIds);

    if (users) {
      for (const u of users) {
        userMap.set(u.id, { email: u.email, name: u.name });
      }
    }
  }

  // Merge user info into traces
  const enrichedTraces = traces.map((t) => {
    const user = userMap.get(t.user_id);
    return {
      id: t.id,
      fileName: t.file_name,
      userId: t.user_id,
      userEmail: user?.email || null,
      userName: user?.name || null,
      type: BROWSER_TYPE_MAP[t.browser] || t.browser,
      fileSize: t.file_size,
      intentTestCaseId: t.intent_test_case_id,
      createdAt: t.created_at,
    };
  });

  res.json({
    success: true,
    data: enrichedTraces,
    total: count ?? traces.length,
    page,
    limit,
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// GET TRACE EVENTS (admin — download + parse JSONL)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/admin/traces/:id/events
 *
 * Download and parse a JSONL trace file, returning events with summary.
 * Query params:
 *   ?stage=error|step_execution|apply|... (filter by stage)
 *   ?eventType=step_result|error|... (filter by eventType)
 *   ?errorsOnly=true (shortcut: only error/failure events)
 */
export const getTraceEvents = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const stageFilter = req.query.stage as string | undefined;
  const eventTypeFilter = req.query.eventType as string | undefined;
  const errorsOnly = req.query.errorsOnly === 'true';

  if (!id || !isValidUUID(id)) {
    res.status(400).json({ success: false, error: 'Invalid trace ID' });
    return;
  }

  // Fetch trace record (admin — no ownership check)
  const { data: traceFile, error: fetchError } = await supabaseAdmin
    .from('trace_files')
    .select('id, user_id, file_name, storage_path, browser, file_size, created_at')
    .eq('id', id)
    .maybeSingle();

  if (fetchError || !traceFile) {
    res.status(404).json({ success: false, error: 'Trace file not found' });
    return;
  }

  // Determine bucket (same logic as playwright.controller.ts)
  let bucketName = 'traces';
  if (
    traceFile.file_name?.endsWith('.jsonl') ||
    traceFile.browser === 'lite-trace-log' ||
    traceFile.browser === 'lite'
  ) {
    bucketName = 'lite-trace-logs';
  }
  // Editor/preview traces are always JSONL → caught by .endsWith('.jsonl')
  // But if somehow the filename doesn't end with .jsonl, check browser field
  if (traceFile.browser === 'editor-trace' || traceFile.browser === 'preview-run-trace') {
    bucketName = 'lite-trace-logs';
  }

  // Download file from storage
  const { data: fileBlob, error: downloadError } = await supabaseAdmin.storage
    .from(bucketName)
    .download(traceFile.storage_path);

  if (downloadError || !fileBlob) {
    logger.error(`${TAG} Failed to download trace file`, {
      traceId: id,
      storagePath: traceFile.storage_path,
      bucket: bucketName,
      error: downloadError?.message,
    });
    res.status(500).json({ success: false, error: 'Failed to download trace file' });
    return;
  }

  // Parse JSONL
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  const content = buffer.toString('utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  let events: Record<string, any>[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }

  // Build summary before filtering
  const stageCounts: Record<string, number> = {};
  let errorCount = 0;
  let failedStepCount = 0;
  const failedStepDetails: Array<{ stepIndex?: number; description?: string; error?: string }> = [];

  for (const evt of events) {
    // Count stages
    const stage = evt.stage || 'unknown';
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;

    // Count errors
    if (stage === 'error' || evt.eventType === 'error') {
      errorCount++;
    }

    // Count failed steps
    if (evt.eventType === 'step_result' && evt.payload?.status === 'fail') {
      failedStepCount++;
      if (failedStepDetails.length < 10) {
        failedStepDetails.push({
          stepIndex: evt.payload.stepIndex ?? evt.iteration,
          description: evt.payload.description,
          error: evt.payload.error,
        });
      }
    }

    // Capture run_error_summary if present
    if (evt.eventType === 'run_error_summary') {
      // Already have a structured summary — merge into our counts
      errorCount = Math.max(errorCount, evt.payload?.totalErrors ?? 0);
    }
  }

  const summary = {
    totalEvents: events.length,
    parseErrors,
    errors: errorCount,
    failedSteps: failedStepCount,
    failedStepDetails,
    stages: stageCounts,
  };

  // Apply filters
  if (errorsOnly) {
    events = events.filter(
      (evt) =>
        evt.stage === 'error' ||
        evt.eventType === 'error' ||
        (evt.eventType === 'step_result' && evt.payload?.status === 'fail') ||
        evt.eventType === 'run_error_summary',
    );
  } else {
    if (stageFilter) {
      events = events.filter((evt) => evt.stage === stageFilter);
    }
    if (eventTypeFilter) {
      events = events.filter((evt) => evt.eventType === eventTypeFilter);
    }
  }

  // Cap events
  const truncated = events.length > MAX_EVENTS_PER_RESPONSE;
  if (truncated) {
    events = events.slice(0, MAX_EVENTS_PER_RESPONSE);
  }

  res.json({
    success: true,
    data: {
      traceId: traceFile.id,
      fileName: traceFile.file_name,
      userId: traceFile.user_id,
      fileSize: traceFile.file_size,
      createdAt: traceFile.created_at,
      summary,
      events,
      truncated,
    },
  });
};
