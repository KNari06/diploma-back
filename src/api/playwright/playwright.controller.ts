import { supabaseAdmin } from '@/db/supabase';
import { TraceFile, TraceFileListItem, TraceStep, TraceStepsResponse, TraceUploadRequest, TraceUploadResponse } from '@/types';
import { logger } from '@/utils/core/logger';
import AdmZip from 'adm-zip';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handle Playwright trace file upload to Supabase Storage
 * ✅ FIX #24: Use authenticated user ID instead of client-provided userId
 */
export const uploadTrace = async (
  req: Request,
  res: Response<TraceUploadResponse>
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        message: 'No trace file provided',
        error: 'FILE_MISSING',
      });
      return;
    }

    // ✅ FIX #24: Use authenticated user ID from JWT token
    const userId = req.user!.id;
    const { testId, browser } = req.body as Omit<TraceUploadRequest, 'userId'>;

    // Validate testId format if provided (UUID)
    if (testId && !UUID_REGEX.test(testId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid testId format',
        error: 'INVALID_TEST_ID',
      });
      return;
    }

    // ✅ FIX #28: If testId is provided, verify it belongs to the authenticated user
    if (testId) {
      const { data: testRow, error: testError } = await supabaseAdmin
        .from('tests')
        .select('user_id')
        .eq('id', testId)
        .single();

      if (testError || !testRow) {
        res.status(404).json({
          success: false,
          message: 'Test not found',
          error: 'TEST_NOT_FOUND',
        });
        return;
      }

      if (!testRow.user_id || testRow.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'Access denied',
          error: 'FORBIDDEN',
        });
        return;
      }
    }

    // Validate file size (max 100MB)
    if (req.file.size > 100 * 1024 * 1024) {
      res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 100MB',
        error: 'FILE_TOO_LARGE',
      });
      return;
    }

    const timestamp = Date.now();
    const traceId = uuidv4();
    const fileName = `trace_${timestamp}_${userId}_${testId || 'standalone'}_${browser || 'chrome'}.zip`;
    const storagePath = `traces/${userId}/${fileName}`;
    const fileSize = req.file.size;

    logger.info('Uploading trace to Supabase Storage', {
      fileName,
      fileSize,
      userId,
      testId,
      browser,
      storagePath,
    });

    // Upload to Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from('traces')
      .upload(storagePath, req.file.buffer, {
        contentType: 'application/zip',
        upsert: false,
        cacheControl: '3600',
      });

    if (uploadError) {
      logger.error('Supabase storage upload error', {
        error: uploadError,
        storagePath,
      });

      res.status(500).json({
        success: false,
        message: 'Failed to upload trace to storage',
        error: 'STORAGE_UPLOAD_FAILED',
      });
      return;
    }

    // Get public URL (or signed URL for private buckets)
    const { data: urlData } = supabaseAdmin.storage
      .from('traces')
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;

    // Save metadata to database
    const traceRecord: Partial<TraceFile> = {
      id: traceId,
      user_id: userId,
      test_id: testId || undefined,
      file_name: fileName,
      storage_path: storagePath,
      file_size: fileSize,
      browser: browser || undefined,
      status: 'uploaded',
      public_url: publicUrl,
      created_at: new Date().toISOString(),
    };

    const { error: insertError } = await supabaseAdmin
      .from('trace_files')
      .insert(traceRecord);

    if (insertError) {
      logger.error('Failed to save trace metadata to database', {
        error: insertError,
        traceRecord,
      });

      // Try to clean up uploaded file
      await supabaseAdmin.storage.from('traces').remove([storagePath]);

      res.status(500).json({
        success: false,
        message: 'Failed to save trace metadata',
        error: 'DATABASE_INSERT_FAILED',
      });
      return;
    }

    // NOTE: We no longer update test_results with trace_file/trace_uploaded_at columns.
    // The trace_files table is the single source of truth for trace metadata.
    // Linking is done via trace_files.test_id FK to tests.id.

    logger.info('Trace uploaded successfully', {
      traceId,
      fileName,
      publicUrl,
    });

    res.status(200).json({
      success: true,
      message: 'Trace file uploaded successfully',
      data: {
        id: traceId,
        fileName,
        storagePath,
        publicUrl,
        fileSize,
        uploadedAt: new Date().toISOString(),
        testId,
        userId,
      },
    });
  } catch (error) {
    logger.error('Trace upload error', { error });

    if (res.headersSent) {
      logger.warn('[PLAYWRIGHT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to upload trace file',
      error: 'UPLOAD_FAILED',
    });
  }
};

/**
 * Get trace file from Supabase Storage
 */
/**
 * ✅ FIX #24: Added ownership check
 */
export const getTrace = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user!.id; // ✅ FIX #24: Use authenticated user ID

    if (!id) {
      res.status(400).json({
        success: false,
        message: 'Trace ID is required',
        error: 'MISSING_TRACE_ID',
      });
      return;
    }

    // Validate trace ID format (UUID)
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({
        success: false,
        message: 'Invalid trace ID format',
        error: 'INVALID_TRACE_ID',
      });
      return;
    }

    // Validate userId format if provided (UUID)
    if (userId && !UUID_REGEX.test(userId as string)) {
      res.status(400).json({
        success: false,
        message: 'Invalid userId format',
        error: 'INVALID_USER_ID',
      });
      return;
    }

    // Get trace metadata from database
    let query = supabaseAdmin
      .from('trace_files')
      .select('*')
      .eq('id', id);

    // Optional: filter by userId for security
    if (userId) {
      query = query.eq('user_id', userId as string);
    }

    const { data: traceFiles, error: fetchError } = await query;
    const traceFile = traceFiles && traceFiles.length > 0 ? traceFiles[0] : null;

    if (fetchError || !traceFile) {
      logger.warn('Trace file not found', { id, userId, error: fetchError });
      res.status(404).json({
        success: false,
        message: 'Trace file not found',
        error: 'FILE_NOT_FOUND',
      });
      return;
    }

    // Determine bucket based on file type
    // Lite trace logs: .jsonl files or browser='lite-trace-log'/'lite' → bucket 'lite-trace-logs'
    // Playwright traces: .zip files → bucket 'traces'
    let bucketName = 'traces'; // Default for Playwright .zip traces

    if (
      traceFile.file_name?.endsWith('.jsonl') ||
      traceFile.browser === 'lite-trace-log' ||
      traceFile.browser === 'lite'
    ) {
      bucketName = 'lite-trace-logs';
    }

    logger.debug('Selecting storage bucket for trace', {
      traceId: id,
      fileName: traceFile.file_name,
      browser: traceFile.browser,
      selectedBucket: bucketName,
    });

    // Generate signed URL for private bucket (valid for 1 hour)
    const { data: signedUrlData, error: urlError } = await supabaseAdmin.storage
      .from(bucketName)
      .createSignedUrl(traceFile.storage_path, 3600);

    if (urlError || !signedUrlData) {
      logger.error('Failed to generate signed URL', {
        error: urlError,
        storagePath: traceFile.storage_path,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to generate download URL',
        error: 'URL_GENERATION_FAILED',
      });
      return;
    }

    logger.info('Trace download URL generated', {
      traceId: id,
      userId: traceFile.user_id,
    });

    res.json({
      success: true,
      data: {
        id: traceFile.id,
        fileName: traceFile.file_name,
        downloadUrl: signedUrlData.signedUrl,
        expiresIn: 3600,
        fileSize: traceFile.file_size,
        createdAt: traceFile.created_at,
      },
    });
  } catch (error) {
    logger.error('Get trace error', { error });

    if (res.headersSent) {
      logger.warn('[PLAYWRIGHT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve trace file',
      error: 'RETRIEVAL_FAILED',
    });
  }
};

/**
 * List all traces for a test or user
 */
export const listTraces = async (req: Request, res: Response): Promise<void> => {
  try {
    // ✅ FIX #24: Always scope listing to authenticated user
    const authUserId = req.user!.id;
    const { testId, type } = req.query as { testId?: string; type?: string };

    // Validate testId format if provided (UUID)
    if (testId && !UUID_REGEX.test(testId as string)) {
      res.status(400).json({
        success: false,
        message: 'Invalid testId format',
        error: 'INVALID_TEST_ID',
      });
      return;
    }

    let query = supabaseAdmin
      .from('trace_files')
      .select('*')
      .eq('user_id', authUserId)
      .order('created_at', { ascending: false });

    if (testId) {
      query = query.eq('test_id', testId);
    }

    // Filter by type (lite or playwright)
    if (type === 'lite') {
      // Lite trace logs are marked explicitly via browser field (avoid fragile ilike/or encoding)
      query = query.in('browser', ['lite-trace-log', 'lite']);
    } else if (type === 'playwright') {
      // Playwright traces: .zip files
      query = query.ilike('file_name', '%.zip');
    }

    const { data: traces, error: fetchError } = await query;

    if (fetchError) {
      logger.error('Failed to fetch traces', { error: fetchError, testId, userId: authUserId });
      res.status(500).json({
        success: false,
        message: 'Failed to fetch traces',
        error: 'FETCH_FAILED',
      });
      return;
    }

    logger.info('Traces listed', {
      count: traces?.length || 0,
      testId,
      userId: authUserId,
    });

    res.json({
      success: true,
      data: traces || [],
      message: `Found ${traces?.length || 0} trace file(s)`,
      count: traces?.length || 0,
    });
  } catch (error) {
    logger.error('List traces error', { error });

    if (res.headersSent) {
      logger.warn('[PLAYWRIGHT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to list trace files',
      error: 'LIST_FAILED',
    });
  }
};

/**
 * Delete a trace file
 */
export const deleteTrace = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    // ✅ FIX #24: Use authenticated user ID, never trust client-provided userId
    const userId = req.user!.id;

    if (!id) {
      res.status(400).json({
        success: false,
        message: 'Trace ID is required',
        error: 'MISSING_TRACE_ID',
      });
      return;
    }

    // Validate trace ID format (UUID)
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({
        success: false,
        message: 'Invalid trace ID format',
        error: 'INVALID_TRACE_ID',
      });
      return;
    }

    // Get trace metadata
    const query = supabaseAdmin
      .from('trace_files')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId);

    const { data: traceFiles, error: fetchError } = await query;
    const traceFile = traceFiles && traceFiles.length > 0 ? traceFiles[0] : null;

    if (fetchError || !traceFile) {
      res.status(404).json({
        success: false,
        message: 'Trace file not found',
        error: 'FILE_NOT_FOUND',
      });
      return;
    }

    // Determine bucket based on file type (same logic as getTrace)
    let bucketName = 'traces'; // Default for Playwright .zip traces

    if (
      traceFile.file_name?.endsWith('.jsonl') ||
      traceFile.browser === 'lite-trace-log' ||
      traceFile.browser === 'lite'
    ) {
      bucketName = 'lite-trace-logs';
    }

    logger.debug('Selecting storage bucket for deletion', {
      traceId: id,
      fileName: traceFile.file_name,
      browser: traceFile.browser,
      selectedBucket: bucketName,
    });

    // Delete from storage
    const { error: storageError } = await supabaseAdmin.storage
      .from(bucketName)
      .remove([traceFile.storage_path]);

    if (storageError) {
      logger.error('Failed to delete trace from storage', {
        error: storageError,
        storagePath: traceFile.storage_path,
      });
    }

    // Delete from database
    const { error: deleteError } = await supabaseAdmin
      .from('trace_files')
      .delete()
      .eq('id', id);

    if (deleteError) {
      logger.error('Failed to delete trace metadata', {
        error: deleteError,
        traceId: id,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to delete trace metadata',
        error: 'DELETE_FAILED',
      });
      return;
    }

    logger.info('Trace deleted successfully', {
      traceId: id,
      userId: traceFile.user_id,
    });

    res.json({
      success: true,
      message: 'Trace file deleted successfully',
    });
  } catch (error) {
    logger.error('Delete trace error', { error });

    if (res.headersSent) {
      logger.warn('[PLAYWRIGHT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to delete trace file',
      error: 'DELETE_FAILED',
    });
  }
};

/**
 * Get trace files by user ID
 */
export const getTraceFilesByUser = async (req: Request, res: Response): Promise<void> => {
  try {
    // ✅ FIX #24: Use authenticated user ID, ignore any query param
    const userId = req.user!.id;

    // Fetch all trace files for the user
    const { data: traceFiles, error: fetchError } = await supabaseAdmin
      .from('trace_files')
      .select('*')
      .eq('user_id', userId as string)
      .order('created_at', { ascending: false });

    if (fetchError) {
      logger.error('Failed to fetch trace files', { error: fetchError, userId });
      res.status(500).json({
        success: false,
        message: 'Failed to fetch trace files',
        error: 'FETCH_FAILED',
      });
      return;
    }

    // Transform to list format
    const files: TraceFileListItem[] = (traceFiles || []).map((file) => ({
      id: file.id,
      fileName: file.file_name,
      testId: file.test_id || undefined,
      uploadedAt: file.created_at,
      size: file.file_size || 0,
      status: file.status as any,
      browser: file.browser || undefined,
      publicUrl: file.public_url || undefined,
    }));

    logger.info('Trace files fetched by user', {
      userId,
      count: files.length,
    });

    res.json({
      success: true,
      data: files,
      count: files.length,
      message: `Found ${files.length} trace file(s)`,
    });
  } catch (error) {
    logger.error('Get trace files by user error', { error });

    if (res.headersSent) {
      logger.warn('[PLAYWRIGHT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve trace files',
      error: 'RETRIEVAL_FAILED',
    });
  }
};

/**
 * Parse trace file and extract test steps
 */
export const getTraceSteps = async (req: Request, res: Response<TraceStepsResponse>): Promise<void> => {
  try {
    const { testId } = req.params;
    const userId = req.user!.id;

    if (!testId) {
      res.status(400).json({
        success: false,
        message: 'testId is required',
        error: 'MISSING_TEST_ID',
      });
      return;
    }

    // Validate testId format (UUID)
    if (!UUID_REGEX.test(testId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid testId format',
        error: 'INVALID_TEST_ID',
      });
      return;
    }

    // ✅ FIX #24: Verify test ownership before accessing trace steps
    const { data: testRow, error: testError } = await supabaseAdmin
      .from('tests')
      .select('user_id')
      .eq('id', testId)
      .single();

    if (testError || !testRow) {
      logger.warn('Test not found for trace steps', { testId, error: testError });
      res.status(404).json({
        success: false,
        message: 'Test not found',
        error: 'TEST_NOT_FOUND',
      });
      return;
    }

    if (!testRow.user_id || testRow.user_id !== userId) {
      logger.warn('Unauthorized trace steps access attempt', { testId, userId });
      res.status(403).json({
        success: false,
        message: 'Access denied',
        error: 'FORBIDDEN',
      });
      return;
    }

    // Find trace file for this test
    const { data: traceFiles, error: fetchError } = await supabaseAdmin
      .from('trace_files')
      .select('*')
      .eq('test_id', testId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (fetchError || !traceFiles || traceFiles.length === 0) {
      logger.warn('Trace file not found for test', { testId, error: fetchError });
      res.status(404).json({
        success: false,
        message: 'Trace file not found for this test',
        error: 'FILE_NOT_FOUND',
      });
      return;
    }

    const traceFile = traceFiles[0];

    // Check if already parsed
    if (traceFile.parsed_data && traceFile.status === 'parsed') {
      logger.info('Returning cached parsed steps', { testId });

      res.json({
        success: true,
        data: {
          testId,
          userId: traceFile.user_id,
          fileName: traceFile.file_name,
          totalSteps: traceFile.parsed_data.steps?.length || 0,
          steps: traceFile.parsed_data.steps || [],
          parsedAt: traceFile.parsed_at || traceFile.updated_at,
        },
      });
      return;
    }

    // Determine file type: Lite JSONL or Playwright ZIP
    const isLiteTrace = traceFile.file_name?.endsWith('.jsonl') ||
                        traceFile.browser === 'lite-trace-log' ||
                        traceFile.browser === 'lite';

    const bucketName = isLiteTrace ? 'lite-trace-logs' : 'traces';

    logger.debug('Trace file type detected', {
      testId,
      fileName: traceFile.file_name,
      browser: traceFile.browser,
      isLiteTrace,
      bucketName,
    });

    // Download trace file from Supabase Storage
    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from(bucketName)
      .download(traceFile.storage_path);

    if (downloadError || !fileData) {
      logger.error('Failed to download trace file', {
        error: downloadError,
        storagePath: traceFile.storage_path,
        bucketName,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to download trace file',
        error: 'DOWNLOAD_FAILED',
      });
      return;
    }

    // Convert blob to buffer
    const buffer = Buffer.from(await fileData.arrayBuffer());

    // Parse trace file based on type
    let steps: TraceStep[] = [];
    try {
      if (isLiteTrace) {
        // Parse Lite JSONL trace
        steps = parseLiteTraceSteps(buffer);
      } else {
        // Parse Playwright ZIP trace
        steps = parsePlaywrightTraceSteps(buffer);
      }
    } catch (parseError) {
      logger.error('Failed to parse trace file', {
        error: parseError,
        testId,
        fileName: traceFile.file_name,
        isLiteTrace,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to parse trace file',
        error: 'PARSE_FAILED',
      });
      return;
    }

    // Save parsed data to database
    const parsedAt = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('trace_files')
      .update({
        status: 'parsed',
        parsed_data: { steps },
        parsed_at: parsedAt,
      })
      .eq('id', traceFile.id);

    if (updateError) {
      logger.warn('Failed to save parsed data', {
        error: updateError,
        traceId: traceFile.id,
      });
    }

    logger.info('Trace parsed successfully', {
      testId,
      totalSteps: steps.length,
    });

    res.json({
      success: true,
      data: {
        testId,
        userId: traceFile.user_id,
        fileName: traceFile.file_name,
        totalSteps: steps.length,
        steps,
        parsedAt,
      },
    });
  } catch (error) {
    logger.error('Get trace steps error', { error });

    if (res.headersSent) {
      logger.warn('[PLAYWRIGHT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve trace steps',
      error: 'RETRIEVAL_FAILED',
    });
  }
};

/**
 * Parse Lite JSONL trace into TraceStep[]
 * Reads action_execute_start/end events from JSONL trace
 */
function parseLiteTraceSteps(buffer: Buffer): TraceStep[] {
  const steps: TraceStep[] = [];
  const text = buffer.toString('utf8');
  const lines = text.split('\n').filter((line) => line.trim());

  let stepId = 1;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // Prefer action_execute_start events: they contain payload.command in LiteEngine
      if (event.eventType === 'action_execute_start') {
        const cmd = event.payload?.command;
        const action = cmd?.action || 'unknown';
        const ref = cmd?.ref || cmd?.targetRef;
        const url = cmd?.url;
        const hasValue = typeof cmd?.value === 'string' && cmd.value.length > 0;

        const ts = Date.parse(event.ts);
        const timestamp = Number.isFinite(ts) ? ts : Date.now();

        const step: TraceStep = {
          stepId: stepId++,
          type: action,
          timestamp,
        };

        if (url) step.url = url;
        if (ref) step.selector = ref;
        if (hasValue) step.text = '[value provided]'; // Redacted

        // Generate description based on action type
        step.description = generateStepDescriptionFromLite(action, ref, url, hasValue ? '[redacted]' : undefined);

        steps.push(step);
        continue;
      }

      // Fallback: action_* detail events (LiteEngine writes these via traceHook)
      // Only use if we couldn't get action_execute_start for some reason.
      if (steps.length === 0 && typeof event.eventType === 'string' && event.eventType.startsWith('action_')) {
        const action = event.payload?.action || 'unknown';
        const ref = event.payload?.details?.ref;
        const url = event.payload?.details?.url;

        const ts = Date.parse(event.ts);
        const timestamp = Number.isFinite(ts) ? ts : Date.now();

        const step: TraceStep = {
          stepId: stepId++,
          type: action,
          timestamp,
        };

        if (url) step.url = url;
        if (ref) step.selector = ref;
        step.description = generateStepDescriptionFromLite(action, ref, url);
        steps.push(step);
      }
    } catch (parseError) {
      // Skip invalid lines
      continue;
    }
  }

  return steps;
}

/**
 * Parse Playwright ZIP trace into TraceStep[]
 * Extracts trace.trace JSONL from ZIP and parses Playwright events
 */
function parsePlaywrightTraceSteps(buffer: Buffer): TraceStep[] {
  const steps: TraceStep[] = [];
  const zip = new AdmZip(buffer);
  const zipEntries = zip.getEntries();

  // Look for trace file (trace.trace or similar)
  const traceEntry = zipEntries.find(
    (entry) => entry.entryName.includes('trace') && !entry.isDirectory
  );

  if (!traceEntry) {
    throw new Error('No trace file found in ZIP');
  }

  // Extract trace data
  const traceData = traceEntry.getData().toString('utf8');
  const traceLines = traceData.split('\n').filter((line) => line.trim());

  // Parse trace lines into steps
  let stepId = 1;
  for (const line of traceLines) {
    try {
      // Trace format is typically JSONL (one JSON object per line)
      const event = JSON.parse(line);

      // Filter and transform relevant events
      if (event.type === 'action' || event.type === 'apiCall') {
        const step: TraceStep = {
          stepId: stepId++,
          type: event.apiName || event.method || 'unknown',
          timestamp: event.time || Date.now(),
        };

        // Extract additional info based on action type
        if (event.params) {
          if (event.params.url) {
            step.url = event.params.url;
          }
          if (event.params.selector) {
            step.selector = event.params.selector;
          }
          if (event.params.text) {
            step.text = event.params.text;
          }
        }

        // Add description
        step.description = generateStepDescription(step);

        steps.push(step);
      }
    } catch (parseError) {
      // Skip invalid lines
      continue;
    }
  }

  return steps;
}

/**
 * Generate human-readable description for Lite trace action
 */
function generateStepDescriptionFromLite(
  action: string,
  ref?: string,
  url?: string,
  value?: string
): string {
  switch (action) {
    case 'goto':
      return `Navigate to ${url || 'page'}`;
    case 'click':
      return `Click on ${ref || 'element'}`;
    case 'fill':
      return `Fill input ${ref || 'field'}`;
    case 'select':
      return `Select option in ${ref || 'dropdown'}`;
    case 'hover':
      return `Hover over ${ref || 'element'}`;
    case 'scroll':
      return `Scroll page`;
    case 'press':
      return `Press key`;
    case 'wait':
      return `Wait`;
    default:
      return `${action}${ref ? ` (${ref})` : ''}`;
  }
}

/**
 * Helper function to generate human-readable step description (Playwright)
 */
function generateStepDescription(step: TraceStep): string {
  switch (step.type) {
    case 'goto':
    case 'navigate':
      return `Navigate to ${step.url}`;
    case 'click':
      return `Click on ${step.selector || 'element'}`;
    case 'fill':
    case 'type':
      return `Fill "${step.text}" into ${step.selector || 'input'}`;
    case 'check':
    case 'uncheck':
      return `${step.type} ${step.selector || 'checkbox'}`;
    case 'select':
      return `Select "${step.text}" in ${step.selector || 'dropdown'}`;
    case 'waitForSelector':
      return `Wait for ${step.selector}`;
    case 'screenshot':
      return 'Take screenshot';
    case 'expect':
    case 'assert':
      return `Assert: ${step.text || step.selector}`;
    default:
      return `${step.type}${step.selector ? ` (${step.selector})` : ''}`;
  }
}
