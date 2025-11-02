import { supabase } from '@/db/supabase';
import { TraceFile, TraceUploadRequest, TraceUploadResponse, TraceFileListItem, TraceStepsResponse, TraceStep } from '@/types';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import AdmZip from 'adm-zip';

/**
 * Handle Playwright trace file upload to Supabase Storage
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

    const { userId, testId, browser, metadata } = req.body as TraceUploadRequest;

    // Validation
    if (!userId) {
      res.status(400).json({
        success: false,
        message: 'userId is required',
        error: 'MISSING_USER_ID',
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
    const { error: uploadError } = await supabase.storage
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
    const { data: urlData } = supabase.storage
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

    const { error: insertError } = await supabase
      .from('trace_files')
      .insert(traceRecord);

    if (insertError) {
      logger.error('Failed to save trace metadata to database', {
        error: insertError,
        traceRecord,
      });

      // Try to clean up uploaded file
      await supabase.storage.from('traces').remove([storagePath]);

      res.status(500).json({
        success: false,
        message: 'Failed to save trace metadata',
        error: 'DATABASE_INSERT_FAILED',
      });
      return;
    }

    // Update test_results table if testId is provided
    if (testId && browser) {
      const { error: testResultError } = await supabase
        .from('test_results')
        .update({
          trace_file: fileName,
          trace_uploaded_at: new Date().toISOString(),
        })
        .eq('test_id', testId)
        .eq('browser', browser);

      if (testResultError) {
        logger.warn('Failed to update test_results with trace info', {
          error: testResultError,
          testId,
          browser,
        });
      }
    }

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
export const getTrace = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    if (!id) {
      res.status(400).json({
        success: false,
        message: 'Trace ID is required',
        error: 'MISSING_TRACE_ID',
      });
      return;
    }

    // Get trace metadata from database
    let query = supabase
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

    // Generate signed URL for private bucket (valid for 1 hour)
    const { data: signedUrlData, error: urlError } = await supabase.storage
      .from('traces')
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
    const { testId, userId } = req.query;

    if (!testId && !userId) {
      res.status(400).json({
        success: false,
        message: 'testId or userId is required',
        error: 'MISSING_FILTER',
      });
      return;
    }

    let query = supabase
      .from('trace_files')
      .select('*')
      .order('created_at', { ascending: false });

    if (testId) {
      query = query.eq('test_id', testId);
    }

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: traces, error: fetchError } = await query;

    if (fetchError) {
      logger.error('Failed to fetch traces', { error: fetchError, testId, userId });
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
      userId,
    });

    res.json({
      success: true,
      data: traces || [],
      message: `Found ${traces?.length || 0} trace file(s)`,
      count: traces?.length || 0,
    });
  } catch (error) {
    logger.error('List traces error', { error });
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
    const { userId } = req.body;

    if (!id) {
      res.status(400).json({
        success: false,
        message: 'Trace ID is required',
        error: 'MISSING_TRACE_ID',
      });
      return;
    }

    // Get trace metadata
    let query = supabase
      .from('trace_files')
      .select('*')
      .eq('id', id);

    if (userId) {
      query = query.eq('user_id', userId);
    }

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

    // Delete from storage
    const { error: storageError } = await supabase.storage
      .from('traces')
      .remove([traceFile.storage_path]);

    if (storageError) {
      logger.error('Failed to delete trace from storage', {
        error: storageError,
        storagePath: traceFile.storage_path,
      });
    }

    // Delete from database
    const { error: deleteError } = await supabase
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
    const { userId } = req.query;

    if (!userId) {
      res.status(400).json({
        success: false,
        message: 'userId is required',
        error: 'MISSING_USER_ID',
      });
      return;
    }

    // Fetch all trace files for the user
    const { data: traceFiles, error: fetchError } = await supabase
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

    if (!testId) {
      res.status(400).json({
        success: false,
        message: 'testId is required',
        error: 'MISSING_TEST_ID',
      });
      return;
    }

    // Find trace file for this test
    const { data: traceFiles, error: fetchError } = await supabase
      .from('trace_files')
      .select('*')
      .eq('test_id', testId)
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

    // Download trace file from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('traces')
      .download(traceFile.storage_path);

    if (downloadError || !fileData) {
      logger.error('Failed to download trace file', {
        error: downloadError,
        storagePath: traceFile.storage_path,
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

    // Parse ZIP file
    let steps: TraceStep[] = [];
    try {
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
    } catch (parseError) {
      logger.error('Failed to parse trace file', {
        error: parseError,
        testId,
        fileName: traceFile.file_name,
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
    const { error: updateError } = await supabase
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
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve trace steps',
      error: 'RETRIEVAL_FAILED',
    });
  }
};

/**
 * Helper function to generate human-readable step description
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
