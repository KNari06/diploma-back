/**
 * Upload Controller (V6)
 *
 * POST /api/v1/preview/upload-file
 * Uploads a file for use with the upload step type (file picker flow).
 */

import { TestFileStorageService } from '@/services/storage/test-file-storage.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * POST /api/v1/preview/upload-file
 * Upload a file for use in upload steps
 */
export const uploadTestFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const file = req.file;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!file) {
      res.status(400).json({
        success: false,
        error: 'Missing file',
        message: 'No file provided. Use multipart/form-data with field name "file".',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[UPLOAD_API] Uploading test file', {
      userId,
      fileName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });

    const { publicUrl, fileName, storagePath } =
      await TestFileStorageService.uploadFile(userId, file);

    res.status(200).json({
      success: true,
      data: {
        publicUrl,
        fileName,
        fileSize: file.size,
        storagePath,
        uploadedAt: new Date().toISOString(),
      },
      message: 'File uploaded successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[UPLOAD_API] Upload error', { error });

    if (res.headersSent) return;

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload file',
      timestamp: new Date().toISOString(),
    });
  }
};
