/**
 * Mobile API Routes
 *
 * Endpoints for mobile app management (APK/IPA upload, info, delete).
 * Mounted at: /api/v1/mobile
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import multer from 'multer';
import { deleteMobileApp, getMobileApp, uploadMobileApp } from './mobile.controller';

// ── Multer config for APK/IPA uploads ────────────────────────────

const appUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.android.package-archive', // .apk
      'application/octet-stream',                // .ipa / .aab
      'application/x-ios-app',                   // .ipa alt
    ];
    // Also check by extension since mime type detection is unreliable for APKs
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.apk') || ext.endsWith('.ipa') || ext.endsWith('.aab') || allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: .apk, .ipa, .aab`));
    }
  },
});

// ── Routes ───────────────────────────────────────────────────────

const router = Router();

/**
 * POST /api/v1/mobile/projects/:projectId/app
 * Upload APK/IPA for a project (replaces previous if exists)
 *
 * Body: multipart/form-data
 *   - file: APK/IPA/AAB file (required)
 *   - platform: 'android' | 'ios' (optional, default: 'android')
 *   - packageName: app package/bundle ID (optional)
 */
router.post(
  '/projects/:projectId/app',
  requireAuth,
  appUpload.single('file'),
  asyncHandler(uploadMobileApp),
);

/**
 * GET /api/v1/mobile/projects/:projectId/app
 * Get mobile app info for a project
 */
router.get(
  '/projects/:projectId/app',
  requireAuth,
  asyncHandler(getMobileApp),
);

/**
 * DELETE /api/v1/mobile/projects/:projectId/app
 * Delete mobile app from project
 */
router.delete(
  '/projects/:projectId/app',
  requireAuth,
  asyncHandler(deleteMobileApp),
);

export default router;
