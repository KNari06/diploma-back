/**
 * Maps `MobileAppError` tags (returned by `mobile-app.service.ts`) to
 * HTTP responses. Kept in the api/ layer so the service stays free of
 * Express/HTTP concerns and the mapping table is in one place.
 */

import type { Response } from 'express';
import type { MobileAppError } from '@/services/mobile/mobile-app.service';
import { MAX_UPLOAD_SIZE_BYTES, ALLOWED_UPLOAD_EXTENSIONS } from '@/services/mobile/mobile-app.service';

const MB = 1024 * 1024;

/** Write the appropriate HTTP response for a tagged service error. */
export function sendMobileAppError(res: Response, err: MobileAppError): void {
  switch (err.kind) {
    case 'project_not_found':
      res.status(404).json({ success: false, error: 'Project not found or access denied' });
      return;

    case 'invalid_filename':
      res.status(400).json({
        success: false,
        error: `Invalid file type: ${err.ext}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
      });
      return;

    case 'file_too_large':
      // Preserve original wording — frontend / CI clients may match on these strings.
      res.status(413).json({
        success: false,
        error: err.source === 'uploaded'
          ? `Uploaded file too large (${(err.sizeBytes / MB).toFixed(1)} MB). Max: ${MAX_UPLOAD_SIZE_BYTES / MB} MB.`
          : `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / MB}MB, declared ${(err.sizeBytes / MB).toFixed(1)}MB`,
      });
      return;

    case 'invalid_storage_path':
      res.status(400).json({ success: false, error: 'storagePath does not belong to this project' });
      return;

    case 'object_missing':
      res.status(404).json({
        success: false,
        error: 'Object not found at storagePath — was the PUT to the upload URL successful?',
      });
      return;

    case 'object_empty':
      res.status(400).json({ success: false, error: 'Uploaded object is empty (0 bytes)' });
      return;

    case 'package_name_required':
      res.status(400).json({
        success: false,
        error: 'packageName is required and could not be read from the binary. Pass it explicitly (Android: package id e.g. com.example.app; iOS: bundle ID).',
      });
      return;

    case 'build_record_failed':
      res.status(409).json({
        success: false,
        error: 'Failed to record build in version history (likely duplicate commit_sha for this project+platform).',
      });
      return;

    case 'app_not_uploaded':
      res.status(404).json({
        success: false,
        error: 'No uploaded app to update — upload an APK/IPA first',
      });
      return;

    case 'no_app_to_delete':
      // Caller treats this as a 200 (idempotent delete) — we don't write here.
      res.json({
        success: true,
        message: err.platform ? `No ${err.platform} app to delete` : 'No app to delete',
      });
      return;
  }
}
