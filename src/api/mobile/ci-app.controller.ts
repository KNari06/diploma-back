/**
 * CI app-publish controller — thin HTTP layer for the three CI endpoints a
 * customer's pipeline calls:
 *
 *   POST /api/v1/mobile/ci/app/upload-url  → { uploadUrl, storagePath, requiredHeaders }
 *   POST /api/v1/mobile/ci/app/finalize    → { build, mobileApp, variant }
 *   GET  /api/v1/mobile/ci/whoami          → { projectId }
 *
 * Auth is `requireCiApiKey` (project API key, no JWT). Orchestration lives in
 * `ci-app-publish.service.ts`; this file parses, gates, and responds.
 *
 * `projectId` ALWAYS comes from `req.ciProject.id` — never the body or the
 * URL. The key IS the project claim, so accepting a caller-supplied project id
 * would be a straight IDOR.
 */

import { redisConnection } from '@/config/infrastructure/queues';
import { PAID_FEATURE_LABELS } from '@/config/features/feature-labels';
import { isPaidUser } from '@/services/core/plan-access.service';
import * as CiAppPublishService from '@/services/mobile/ci-app-publish.service';
import type { CiProject } from '@/services/mobile/ci-app-publish.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import {
  MobileAppStorageService,
  trimMobileBuildField,
} from '@/services/storage/mobile-app-storage.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

import {
  parseContentLength,
  parseVersionCode,
  pickPlatform,
  trimmedString,
} from './mobile-request.helpers';
import { sendMobileAppError } from './mobile-error-mapper';

// ── Rate limits ────────────────────────────────────────────────────
//
// `upload-url` reuses the project-wide APK upload lock (1 per project per
// 5 min) that `/ci/run`'s appUrl branch already takes — both are "this project
// is publishing a binary".
//
// SHARP EDGE, inherited and deliberately not papered over here: the lock is
// held for its full 300s TTL on the SUCCESS path too. A job that fails at the
// PUT and retries inside 5 minutes gets a 429 it cannot clear. Documented for
// customers in docs/ci/; changing it means separating "rate limit" from
// "in-flight mutex", which is a behaviour change to the existing /ci/run path.
const APK_UPLOAD_LOCK_PREFIX = 'ci_apk_upload:';
const APK_UPLOAD_LOCK_TTL = 300; // 5 minutes

// `finalize` is the expensive call — a download of up to 500 MB, an inflate,
// and a parse — so it gets its own MUTEX keyed per storagePath (not a rate
// limit: it is released on every terminal outcome). `isPaidUser` is a plan
// check, not a throttle, and does not substitute for this.
const FINALIZE_LOCK_PREFIX = 'ci_apk_finalize:';
const FINALIZE_LOCK_TTL = 600; // 10 minutes — ceiling for download+parse

// `whoami` is reachable pre-auth and runs a `projects` query BEFORE any
// credential is validated, and there is no global rate limiter in this app
// (index.ts's is commented out). That makes it an unmetered DB-load
// amplifier, so it carries a cheap per-IP limit. Keys are 256-bit, so brute
// force and enumeration are not the concern here — load is.
const WHOAMI_RATE_PREFIX = 'ci_whoami_rate:';
const WHOAMI_RATE_WINDOW = 60; // seconds
const WHOAMI_RATE_MAX = 30;

/** Paid-plan gate — mobile testing is a Pro feature, same as `/ci/run`. */
async function requirePaidCiUser(userId: string, res: Response): Promise<boolean> {
  if (await isPaidUser(userId)) return true;
  res.status(403).json({
    success: false,
    error: 'Upgrade required',
    code: 'UPGRADE_REQUIRED',
    message: `${PAID_FEATURE_LABELS.MOBILE_TESTING} is available on paid plans. Upgrade to publish builds from CI.`,
  });
  return false;
}

/** Translate a CI-only error tag, else defer to the shared mobile mapper. */
function sendCiPublishError(res: Response, err: CiAppPublishService.CiPublishError): void {
  if (err.kind === 'write_denied') {
    res.status(403).json({
      success: false,
      error: 'Write access denied',
      code: 'WRITE_DENIED',
      message:
        'The account this API key belongs to no longer has write access to the project. Re-grant access, or generate a new key from an account that has it.',
    });
    return;
  }
  if (err.kind === 'version_identity_required') {
    res.status(400).json({
      success: false,
      error: 'Build identity required',
      code: 'VERSION_IDENTITY_REQUIRED',
      message:
        'Send commitSha, or versionName / versionCode, so this build can be told apart from earlier ones. Without it every CI build looks identical in the audit trail and build pruning becomes destructive.',
    });
    return;
  }
  sendMobileAppError(res, err);
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /ci/app/upload-url
// ═══════════════════════════════════════════════════════════════════════════

export async function createCiAppUploadUrl(req: Request, res: Response): Promise<void> {
  const project = req.ciProject as unknown as CiProject;
  const userId = req.ciUserId!;

  if (!(await requirePaidCiUser(userId, res))) return;

  const filename = trimmedString(req.body?.filename);
  if (!filename) {
    res.status(400).json({ success: false, error: 'filename is required (non-empty string)' });
    return;
  }

  const lockKey = `${APK_UPLOAD_LOCK_PREFIX}${project.id}`;
  const lockResult = await redisConnection.set(lockKey, '1', 'EX', APK_UPLOAD_LOCK_TTL, 'NX');
  if (lockResult !== 'OK') {
    res.status(429).json({
      success: false,
      error: 'Build upload rate limited',
      code: 'RATE_LIMITED',
      message: 'Only one build upload per project per 5 minutes. Please wait and try again.',
    });
    return;
  }

  let result;
  try {
    result = await CiAppPublishService.createCiUploadUrl({
      project,
      filename,
      platform: pickPlatform(req.body?.platform),
      declaredSize: parseContentLength(req.body?.contentLength),
      variantLabel: trimmedString(req.body?.variant),
    });
  } catch (err) {
    // Free the lock on an unexpected failure too — otherwise a transient error
    // costs the project its whole 5-minute upload window for nothing.
    await redisConnection.del(lockKey);
    throw err;
  }

  if ('kind' in result) {
    // Free the lock — no URL was issued, so nothing is in flight.
    await redisConnection.del(lockKey);
    sendCiPublishError(res, result);
    return;
  }

  res.json({
    success: true,
    uploadUrl: result.uploadUrl,
    storagePath: result.storagePath,
    requiredHeaders: result.requiredHeaders,
    variant: result.variant,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /ci/app/finalize
// ═══════════════════════════════════════════════════════════════════════════

export async function finalizeCiAppUpload(req: Request, res: Response): Promise<void> {
  const project = req.ciProject as unknown as CiProject;
  const userId = req.ciUserId!;

  if (!(await requirePaidCiUser(userId, res))) return;

  const storagePath = trimmedString(req.body?.storagePath);
  if (!storagePath) {
    res.status(400).json({ success: false, error: 'storagePath is required (non-empty string)' });
    return;
  }

  const commitSha = trimMobileBuildField(req.body?.commitSha);
  const versionName = trimmedString(req.body?.versionName);
  const versionCode = parseVersionCode(req.body?.versionCode);

  // Identity is required so builds stay distinguishable — same contract
  // `/ci/run` already enforces for `appUrl`. `commitSha` alone satisfies it:
  // it is the one thing every pipeline has.
  if (!commitSha && !versionName && versionCode === undefined) {
    sendCiPublishError(res, { kind: 'version_identity_required' });
    return;
  }

  const platform: MobilePlatform = pickPlatform(req.body?.platform);
  const originalName = trimmedString(req.body?.originalName)
    ?? (storagePath.includes('/') ? storagePath.slice(storagePath.lastIndexOf('/') + 1) : storagePath);

  // Per-object mutex, not a rate limit — released on every terminal outcome.
  const lockKey = `${FINALIZE_LOCK_PREFIX}${storagePath}`;
  const lockResult = await redisConnection.set(lockKey, '1', 'EX', FINALIZE_LOCK_TTL, 'NX');
  if (lockResult !== 'OK') {
    res.status(429).json({
      success: false,
      error: 'Finalize already in progress',
      code: 'FINALIZE_IN_PROGRESS',
      message: 'This upload is already being finalized. Wait for the first call to return.',
    });
    return;
  }

  try {
    const result = await CiAppPublishService.finalizeCiUpload({
      project,
      storagePath,
      platform,
      originalName,
      packageName: trimmedString(req.body?.packageName),
      versionName,
      versionCode,
      branch: trimMobileBuildField(req.body?.branch),
      commitSha,
      buildNumber: trimMobileBuildField(req.body?.buildNumber),
      ciRunId: trimMobileBuildField(req.body?.ciRunId),
      variantLabel: trimmedString(req.body?.variant),
    });

    if ('kind' in result) {
      if (result.kind === 'build_record_failed' && result.code === '23505') {
        // Unique on (project_id, platform, variant_label, commit_sha) — the
        // pipeline re-ran for a commit already published. A conflict, not an
        // error the customer needs to fix.
        res.status(409).json({
          success: false,
          error: 'Build already published',
          code: 'DUPLICATE_COMMIT',
          message: `A build for commit ${commitSha ?? '(unknown)'} already exists in this project, platform and variant.`,
        });
        return;
      }
      sendCiPublishError(res, result);
      return;
    }

    res.status(201).json({
      success: true,
      build: result.build,
      mobileApp: result.mobileApp,
      variant: result.variant,
    });

    // Fire-and-forget: prune the SAME lane the build landed in. `autoBootAndInstall`
    // is deliberately NOT fired — there is no emulator at publish time.
    MobileAppStorageService.pruneOldBuilds(project.id, result.platform, result.variant).catch((err) => {
      logger.warn('[CI_APP] pruneOldBuilds failed (non-fatal)', {
        projectId: project.id,
        platform: result.platform,
        variant: result.variant,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } finally {
    await redisConnection.del(lockKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /ci/whoami
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate a key without side effects.
 *
 * This exists so an installer or a customer debugging a pipeline can check a
 * key. Validating via `upload-url` instead would orphan a storage object and
 * burn the 5-minute lock, so the first REAL build of the day would 429.
 *
 * Returns `projectId` ONLY. `projectName` is customer data, and whoami's
 * output lands in CI logs — which are public for OSS repositories.
 */
export async function ciWhoami(req: Request, res: Response): Promise<void> {
  res.json({ success: true, projectId: req.ciProject!.id });
}

/**
 * Per-IP limiter for `whoami`. Runs BEFORE `requireCiApiKey` so an unauthed
 * flood is capped before it reaches the DB. Fails OPEN on a Redis error — the
 * endpoint is harmless, and losing it because Redis blinked is worse.
 */
export async function ciWhoamiRateLimit(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
): Promise<void> {
  try {
    const key = `${WHOAMI_RATE_PREFIX}${req.ip ?? 'unknown'}`;
    const count = await redisConnection.incr(key);
    if (count === 1) await redisConnection.expire(key, WHOAMI_RATE_WINDOW);
    if (count > WHOAMI_RATE_MAX) {
      res.status(429).json({
        success: false,
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        message: `Limit is ${WHOAMI_RATE_MAX} requests per ${WHOAMI_RATE_WINDOW}s.`,
      });
      return;
    }
    next();
  } catch (err) {
    logger.warn('[CI_APP] whoami rate limit unavailable — failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    next();
  }
}
