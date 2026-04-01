/**
 * Mobile API Routes
 *
 * Endpoints for:
 *   - Mobile app management (APK/IPA upload, info, delete)
 *   - CI/CD API key management
 *   - CI/CD test run trigger + status polling
 *
 * Mounted at: /api/v1/mobile
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { requireCiApiKey } from '@/middleware/api-key.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import multer from 'multer';
import { deleteMobileApp, getMobileApp, uploadMobileApp } from './mobile.controller';
import { generateCiKey, revokeCiKey, getCiKeyStatus } from './ci-key.controller';
import { triggerCiRun, getCiRunStatus } from './ci.controller';
import { warmupSession, destroySession, tapSession, swipeSession, goHomeSession, goBackSession, typeSession, keySession, lintSession, applySession, commandSession } from './session.controller';

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

// ═══════════════════════════════════════════════════════════════════════════
// EMULATOR SESSION MANAGEMENT (eager warm-up)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/warmup
 * Warm up an emulator session for a project (eager start)
 *
 * Body: { projectId, platform: 'android' | 'ios' }
 */
router.post(
  '/sessions/warmup',
  requireAuth,
  asyncHandler(warmupSession),
);

/**
 * DELETE /api/v1/mobile/sessions/:sessionId
 * Destroy a warmed emulator session
 *
 * Query: ?projectId=<uuid>
 */
router.delete(
  '/sessions/:sessionId',
  requireAuth,
  asyncHandler(destroySession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/tap
 * Forward tap at (x, y) to emulator for interactive preview
 *
 * Body: { x: number, y: number }
 */
router.post(
  '/sessions/:sessionId/tap',
  requireAuth,
  asyncHandler(tapSession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/swipe
 * Forward swipe gesture to emulator
 *
 * Body: { startX, startY, endX, endY, durationMs? }
 */
router.post(
  '/sessions/:sessionId/swipe',
  requireAuth,
  asyncHandler(swipeSession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/go-home
 * Send Home button to emulator
 */
router.post(
  '/sessions/:sessionId/go-home',
  requireAuth,
  asyncHandler(goHomeSession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/go-back
 * Send Back button to emulator
 */
router.post(
  '/sessions/:sessionId/go-back',
  requireAuth,
  asyncHandler(goBackSession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/type
 * Type text into the emulator
 *
 * Body: { text: string }
 */
router.post(
  '/sessions/:sessionId/type',
  requireAuth,
  asyncHandler(typeSession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/key
 * Send an Android keycode to the emulator
 *
 * Body: { keycode: string }  e.g. "KEYCODE_ENTER"
 */
router.post(
  '/sessions/:sessionId/key',
  requireAuth,
  asyncHandler(keySession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/lint
 * Resolve element description on the mobile emulator UI
 *
 * Body: { stepDraft: { kind, elementDescription, value? } }
 */
router.post(
  '/sessions/:sessionId/lint',
  requireAuth,
  asyncHandler(lintSession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/apply
 * Execute a step on the mobile emulator
 *
 * Body: { stepDraft: { kind, elementDescription, value?, ... } }
 */
router.post(
  '/sessions/:sessionId/apply',
  requireAuth,
  asyncHandler(applySession),
);

/**
 * POST /api/v1/mobile/sessions/:sessionId/command
 * Execute a single raw command on the emulator
 *
 * Body: { type: string, params?: object }
 */
router.post(
  '/sessions/:sessionId/command',
  requireAuth,
  asyncHandler(commandSession),
);

// ═══════════════════════════════════════════════════════════════════════════
// CI/CD API KEY MANAGEMENT (requires JWT auth)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/projects/:projectId/ci-key
 * Generate a new CI API key for a project (replaces existing)
 */
router.post(
  '/projects/:projectId/ci-key',
  requireAuth,
  asyncHandler(generateCiKey),
);

/**
 * GET /api/v1/mobile/projects/:projectId/ci-key
 * Check if a CI API key exists for the project
 */
router.get(
  '/projects/:projectId/ci-key',
  requireAuth,
  asyncHandler(getCiKeyStatus),
);

/**
 * DELETE /api/v1/mobile/projects/:projectId/ci-key
 * Revoke CI API key for a project
 */
router.delete(
  '/projects/:projectId/ci-key',
  requireAuth,
  asyncHandler(revokeCiKey),
);

// ═══════════════════════════════════════════════════════════════════════════
// CI/CD RUN ENDPOINTS (requires project API key, no JWT)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/ci/run
 * Trigger a mobile test run from CI/CD pipeline
 *
 * Auth: Authorization: Bearer qai_ci_<key>
 * Body: { savedTestCaseIds?, planId?, appUrl?, callbackUrl?, platform? }
 */
router.post(
  '/ci/run',
  requireCiApiKey,
  asyncHandler(triggerCiRun),
);

/**
 * GET /api/v1/mobile/ci/run/:runId/status
 * Poll for CI run results
 *
 * Auth: Authorization: Bearer qai_ci_<key>
 */
router.get(
  '/ci/run/:runId/status',
  requireCiApiKey,
  asyncHandler(getCiRunStatus),
);

export default router;
