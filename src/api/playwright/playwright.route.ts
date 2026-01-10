import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { deleteTrace, getTrace, getTraceFilesByUser, getTraceSteps, listTraces, uploadTrace } from './playwright.controller';

const router = Router();

// ✅ FIX #24: Protect all Playwright trace endpoints with authentication
router.use(requireAuth);

// Configure multer to use memory storage (for Supabase Storage upload)
const storage = multer.memoryStorage();

// File filter - only accept .zip files
const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedExtensions = ['.zip'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only .zip files are allowed'));
  }
};

// Multer configuration
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
});

/**
 * @swagger
 * /api/v1/playwright/upload-trace:
 *   post:
 *     summary: Upload Playwright trace file to Supabase Storage
 *     description: Upload a Playwright trace .zip file with metadata to Supabase Storage
 *     tags: [Playwright]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - trace
 *               - userId
 *             properties:
 *               trace:
 *                 type: string
 *                 format: binary
 *                 description: The trace .zip file
 *               userId:
 *                 type: string
 *                 description: User ID who ran the test (required)
 *                 example: "user_123"
 *               testId:
 *                 type: string
 *                 description: Test ID associated with this trace (optional)
 *                 example: "test_456"
 *               browser:
 *                 type: string
 *                 description: Browser used for the test (optional)
 *                 example: "chrome"
 *               metadata:
 *                 type: object
 *                 description: Additional metadata (optional)
 *     responses:
 *       200:
 *         description: Trace uploaded successfully to Supabase Storage
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Trace file uploaded successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "550e8400-e29b-41d4-a716-446655440000"
 *                     fileName:
 *                       type: string
 *                       example: "trace_1699123456_user_123_test_456_chrome.zip"
 *                     storagePath:
 *                       type: string
 *                       example: "traces/user_123/trace_1699123456_user_123_test_456_chrome.zip"
 *                     publicUrl:
 *                       type: string
 *                       example: "https://xxx.supabase.co/storage/v1/object/public/traces/..."
 *                     fileSize:
 *                       type: number
 *                       example: 1024000
 *                     uploadedAt:
 *                       type: string
 *                       format: date-time
 *                     testId:
 *                       type: string
 *                     userId:
 *                       type: string
 *       400:
 *         description: Bad request - missing file or userId
 *       500:
 *         description: Server error during upload
 */
router.post('/upload-trace', upload.single('trace'), asyncHandler(uploadTrace));

/**
 * @swagger
 * /api/v1/playwright/trace/{id}:
 *   get:
 *     summary: Get signed URL for trace file download
 *     description: |
 *       Generate a signed URL to download trace file from Supabase Storage.
 *       Supports both Playwright ZIP traces and Lite JSONL trace logs.
 *       User ID is automatically extracted from authentication token.
 *     tags: [Playwright]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The trace file ID (UUID from trace_files table)
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Signed download URL generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Trace file ID
 *                     fileName:
 *                       type: string
 *                       description: Original file name (e.g., trace-xxx.zip or lite_trace_xxx.jsonl)
 *                     downloadUrl:
 *                       type: string
 *                       description: Signed URL valid for 1 hour (use this to download the file)
 *                     expiresIn:
 *                       type: number
 *                       description: URL expiration time in seconds
 *                       example: 3600
 *                     fileSize:
 *                       type: number
 *                       description: File size in bytes
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Trace file not found or access denied
 *       500:
 *         description: Server error
 */
router.get('/trace/:id', asyncHandler(getTrace));

/**
 * @swagger
 * /api/v1/playwright/traces:
 *   get:
 *     summary: List trace files
 *     description: Get a list of trace files filtered by testId, userId, or type (lite/playwright)
 *     tags: [Playwright]
 *     parameters:
 *       - in: query
 *         name: testId
 *         schema:
 *           type: string
 *         description: Filter by test ID
 *         example: "test_456"
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Filter by user ID
 *         example: "user_123"
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [lite, playwright]
 *         description: Filter by trace type (lite for JSONL logs, playwright for ZIP traces)
 *         example: "lite"
 *     responses:
 *       200:
 *         description: List of trace files
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       user_id:
 *                         type: string
 *                       test_id:
 *                         type: string
 *                       file_name:
 *                         type: string
 *                       storage_path:
 *                         type: string
 *                       file_size:
 *                         type: number
 *                       browser:
 *                         type: string
 *                       status:
 *                         type: string
 *                       public_url:
 *                         type: string
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                 message:
 *                   type: string
 *                 count:
 *                   type: number
 *       400:
 *         description: Bad request - testId or userId required
 *       500:
 *         description: Server error
 */
router.get('/traces', asyncHandler(listTraces));

/**
 * @swagger
 * /api/v1/playwright/trace-files:
 *   get:
 *     summary: Get all trace files for a user
 *     description: Retrieve list of all trace files uploaded by a specific user
 *     tags: [Playwright]
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to filter trace files
 *         example: "user_123"
 *     responses:
 *       200:
 *         description: List of trace files
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       fileName:
 *                         type: string
 *                       testId:
 *                         type: string
 *                       uploadedAt:
 *                         type: string
 *                         format: date-time
 *                       size:
 *                         type: number
 *                       status:
 *                         type: string
 *                         enum: [uploaded, parsing, parsed, failed]
 *                       browser:
 *                         type: string
 *                 count:
 *                   type: number
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request - userId required
 *       500:
 *         description: Server error
 */
router.get('/trace-files', asyncHandler(getTraceFilesByUser));

/**
 * @swagger
 * /api/v1/playwright/trace/{testId}/steps:
 *   get:
 *     summary: Parse trace file and get test steps
 *     description: Extract and return all test steps from Playwright trace file
 *     tags: [Playwright]
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *         description: Test ID
 *         example: "test_456"
 *     responses:
 *       200:
 *         description: Test steps extracted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     testId:
 *                       type: string
 *                     userId:
 *                       type: string
 *                     fileName:
 *                       type: string
 *                     totalSteps:
 *                       type: number
 *                     steps:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           stepId:
 *                             type: number
 *                           type:
 *                             type: string
 *                           selector:
 *                             type: string
 *                           text:
 *                             type: string
 *                           url:
 *                             type: string
 *                           timestamp:
 *                             type: number
 *                           description:
 *                             type: string
 *                     parsedAt:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Trace file not found
 *       500:
 *         description: Server error
 */
router.get('/trace/:testId/steps', asyncHandler(getTraceSteps));

/**
 * @swagger
 * /api/v1/playwright/trace/{id}:
 *   delete:
 *     summary: Delete a trace file
 *     description: Delete trace file from Supabase Storage and database
 *     tags: [Playwright]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The trace file ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID for security check (optional)
 *     responses:
 *       200:
 *         description: Trace file deleted successfully
 *       404:
 *         description: Trace file not found
 *       500:
 *         description: Server error
 */
router.delete('/trace/:id', asyncHandler(deleteTrace));

// Error handling middleware for multer
router.use((error: any, req: any, res: any, next: any) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 100MB',
        error: 'FILE_TOO_LARGE',
      });
    }
    return res.status(400).json({
      success: false,
      message: error.message,
      error: 'MULTER_ERROR',
    });
  }

  if (error.message === 'Only .zip files are allowed') {
    return res.status(400).json({
      success: false,
      message: 'Only .zip files are allowed',
      error: 'INVALID_FILE_TYPE',
    });
  }

  next(error);
});

export default router;
