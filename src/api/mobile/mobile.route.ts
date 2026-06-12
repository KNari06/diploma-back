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
import {
  createMobileAppUploadUrl,
  deleteMobileApp,
  finalizeMobileAppUpload,
  getMobileApp,
  getProjectPermissionPolicy,
  listMobileAppBuilds,
  patchMobileApp,
  probeDriverExtension,
  setProjectPermissionPolicy,
} from './mobile.controller';
import { generateCiKey, revokeCiKey, getCiKeyStatus } from './ci-key.controller';
import { triggerCiRun, getCiRunStatus } from './ci.controller';
import { warmupSession, destroySession, tapSession, swipeSession, goHomeSession, goBackSession, typeSession, keySession, lintSession, applySession, commandSession, runTestCaseOnSession, explorationReadiness, startMobileExploration } from './session.controller';

// ── Routes ───────────────────────────────────────────────────────
//
// APK/IPA upload uses a signed-URL flow (POST /app/upload-url then
// POST /app/finalize) so the binary travels client → Supabase Storage
// directly. The previous multipart POST /app route was hard-capped at
// 32 MiB by Cloud Run's request-body limit and has been removed.

const router = Router();

/**
 * POST /api/v1/mobile/projects/:projectId/app/upload-url
 * Step 1 of the signed-URL upload flow. Body: { filename, platform?, contentLength? }.
 * Returns: { uploadUrl, token, storagePath }.
 */
router.post(
  '/projects/:projectId/app/upload-url',
  requireAuth,
  asyncHandler(createMobileAppUploadUrl),
);

/**
 * POST /api/v1/mobile/projects/:projectId/app/finalize
 * Step 3 of the signed-URL upload flow. Body: { storagePath, packageName,
 * platform?, originalName?, branch?, commitSha?, buildNumber?, ciRunId? }.
 *
 * Verifies the object exists in Supabase Storage and writes metadata into
 * `projects.settings.mobileApp` (and optionally `mobile_app_builds`).
 */
router.post(
  '/projects/:projectId/app/finalize',
  requireAuth,
  asyncHandler(finalizeMobileAppUpload),
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
 * PATCH /api/v1/mobile/projects/:projectId/app
 * Update only the packageName on the already-uploaded app (no file re-upload).
 *
 * Body: { packageName: string }
 */
router.patch(
  '/projects/:projectId/app',
  requireAuth,
  asyncHandler(patchMobileApp),
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

/**
 * POST /api/v1/mobile/projects/:projectId/app/probe-driver-extension
 * User-triggered probe — boots an emulator, installs the stored Flutter
 * APK, watches logcat for the Dart VM Service URL. Returns the verdict
 * and persists it on `projects.settings.mobileApp` for later reads.
 */
router.post(
  '/projects/:projectId/app/probe-driver-extension',
  requireAuth,
  asyncHandler(probeDriverExtension),
);

/**
 * GET  /api/v1/mobile/projects/:projectId/permission-policy
 * PUT  /api/v1/mobile/projects/:projectId/permission-policy
 *
 * Project-level default runtime-permission policy for Android sessions:
 *   - auto_allow (default): pre-grant on install + auto-tap Allow on any dialog
 *   - auto_deny: auto-tap Don't allow
 *   - manual: no automation; explicit permission_dialog steps only
 *
 * Individual test cases may override this default.
 */
router.get(
  '/projects/:projectId/permission-policy',
  requireAuth,
  asyncHandler(getProjectPermissionPolicy),
);
router.put(
  '/projects/:projectId/permission-policy',
  requireAuth,
  asyncHandler(setProjectPermissionPolicy),
);

/**
 * GET /api/v1/mobile/projects/:projectId/builds?platform=android&limit=20
 *
 * Phase 5 — list versioned APK/IPA builds for this project. Used by the
 * plan settings UI to pick which build a regression should pin to, and by
 * the mobile editor to show upload history.
 */
router.get(
  '/projects/:projectId/builds',
  requireAuth,
  asyncHandler(listMobileAppBuilds),
);

// ═══════════════════════════════════════════════════════════════════════════
// MOBILE EXPLORATION (backend-brokered — runner key stays server-side)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/exploration/readiness
 * Probe runner LLM keys + capacity without exposing the runner API key.
 */
router.get(
  '/exploration/readiness',
  requireAuth,
  asyncHandler(explorationReadiness),
);

/**
 * POST /api/v1/mobile/projects/:projectId/exploration/start
 * Kick off a backend-brokered mobile exploration on a warmed session.
 * Body: { platform, appId, runnerSessionId, goal?, budget? }
 */
router.post(
  '/projects/:projectId/exploration/start',
  requireAuth,
  asyncHandler(startMobileExploration),
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

/**
 * POST /api/v1/mobile/sessions/:sessionId/run-test-case
 * Run all steps of an intent test case on the mobile emulator
 *
 * Body: { intentTestCaseId: string }
 */
router.post(
  '/sessions/:sessionId/run-test-case',
  requireAuth,
  asyncHandler(runTestCaseOnSession),
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
