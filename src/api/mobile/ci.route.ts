/**
 * CI/CD Routes — project-API-key auth, NO Supabase JWT.
 *
 * Mounted at: /api/v1/mobile/ci  (see src/index.ts)
 *
 * WHY THIS IS A SEPARATE ROUTER
 * These endpoints used to live in `mobile.route.ts`, which is mounted behind
 * `requireAuth, requireApproved`. A `qai_ci_<hex>` key is not a Supabase JWT,
 * so `requireAuth` rejected every CI request with 401 BEFORE `requireCiApiKey`
 * ever ran — `POST /api/v1/mobile/ci/run` had never once worked with a CI key.
 * Auth here is applied PER ROUTE, and the mount in `index.ts` must stay ahead
 * of the JWT-gated `/mobile` mount.
 *
 * The terminal 404 at the bottom is load-bearing: without it an unmatched
 * `/mobile/ci/*` falls through to the authed `/mobile` mount and answers
 * `401 No token provided`, which reads as "your key is wrong" in a customer's
 * CI log. The flip side, stated so nobody re-derives it: `/mobile/ci/*` is now
 * permanently unreachable from `mobile.route.ts`, so a future AUTHED
 * `/ci/...` route added there would silently 404. Add it here instead.
 */

import { requireCiApiKey } from '@/middleware/api-key.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router, type Request, type Response } from 'express';
import {
  ciWhoami,
  ciWhoamiRateLimit,
  createCiAppUploadUrl,
  finalizeCiAppUpload,
} from './ci-app.controller';
import { getCiRunStatus, triggerCiRun } from './ci.controller';

const router = Router();

// ── Build publish ──────────────────────────────────────────────────
// Three calls: request a URL → PUT the binary with `requiredHeaders` → finalize.
// The binary never transits the backend.

/**
 * POST /api/v1/mobile/ci/app/upload-url
 * Auth: Authorization: Bearer qai_ci_<key>
 * Body: { filename, platform?, contentLength?, variant? }
 * → { uploadUrl, storagePath, requiredHeaders, variant }
 */
router.post('/app/upload-url', requireCiApiKey, asyncHandler(createCiAppUploadUrl));

/**
 * POST /api/v1/mobile/ci/app/finalize
 * Auth: Authorization: Bearer qai_ci_<key>
 * Body: { storagePath, platform?, commitSha? | versionName? | versionCode?, … }
 * → 201 { build, mobileApp, variant }
 */
router.post('/app/finalize', requireCiApiKey, asyncHandler(finalizeCiAppUpload));

/**
 * GET /api/v1/mobile/ci/whoami
 * Auth: Authorization: Bearer qai_ci_<key>
 * → { projectId }
 *
 * Key validation with no side effects. The per-IP limiter runs BEFORE
 * `requireCiApiKey` so an unauthed flood is capped before it reaches the DB.
 */
router.get('/whoami', asyncHandler(ciWhoamiRateLimit), requireCiApiKey, asyncHandler(ciWhoami));

// ── Test runs ──────────────────────────────────────────────────────

/**
 * POST /api/v1/mobile/ci/run
 * Trigger a mobile test run from a CI/CD pipeline.
 *
 * Auth: Authorization: Bearer qai_ci_<key>
 * Body: { savedTestCaseIds?, planId?, appUrl?, callbackUrl?, platform? }
 */
router.post('/run', requireCiApiKey, asyncHandler(triggerCiRun));

/**
 * GET /api/v1/mobile/ci/run/:runId/status
 * Poll for CI run results.
 *
 * Auth: Authorization: Bearer qai_ci_<key>
 */
router.get('/run/:runId/status', requireCiApiKey, asyncHandler(getCiRunStatus));

// ── Terminal 404 ───────────────────────────────────────────────────
// Must stay LAST. Answers for the whole /mobile/ci prefix so nothing leaks
// into the JWT-gated /mobile mount below it.
router.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `No CI endpoint at ${req.method} ${req.baseUrl}${req.path}`,
  });
});

export default router;
