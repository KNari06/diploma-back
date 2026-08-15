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

import { PAID_FEATURE_LABELS } from '@/config/features/feature-labels';
import {
  CI_FINALIZE_LOCK,
  CI_PUBLISH_LOCK,
  ciPublishRateLimit,
  CI_WHOAMI_RATE_LIMIT,
} from '@/config/features/ci-publish-limits';
import {
  consumeRateLimit,
  createRedisRateLimiter,
  sendRateLimited,
  sendRateLimiterUnavailable,
} from '@/middleware/redis-rate-limit.middleware';
import { isPaidUser } from '@/services/core/plan-access.service';
import { RedisMutexUnavailableError, withRedisMutex } from '@/utils/core/redis-mutex';
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

// Limits and mutex shapes live in `config/features/ci-publish-limits.ts` —
// `/ci/run`'s appUrl branch needs the same ones, and a constant exported from
// one controller into another couples two HTTP layers for no reason.
//
// The short version of what they replaced: ONE `SET NX EX 300` key
// (`ci_apk_upload:`) served as both a rate limit and an in-flight mutex, and
// was never released on the success path — so a SUCCESSFUL publish locked the
// project out for the next five minutes.
//
// The quota is counted ONCE per publish, at the admission point (`upload-url`,
// and `/ci/run`'s appUrl branch, which is a whole publish in one call). It is
// NOT counted again at `finalize` — that is the second half of an
// already-counted publish.

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

  // Counted AFTER the auth and plan gates, so an unentitled caller cannot
  // burn an entitled project's quota. Every accepted attempt costs a slot,
  // including ones that go on to fail validation: reaching this point has
  // already cost several database reads, which is exactly the load the limit
  // exists to bound.
  const publishLimit = ciPublishRateLimit();
  const verdict = await consumeRateLimit(publishLimit, project.id);
  if (verdict.outcome === 'limited') {
    sendRateLimited(
      res,
      verdict.retryAfterSec,
      `Limit is ${publishLimit.max} build publishes per project per hour.`,
    );
    return;
  }
  if (verdict.outcome === 'unavailable') {
    sendRateLimiterUnavailable(res, 'Build publishing is briefly unavailable. Try again shortly.');
    return;
  }

  const result = await CiAppPublishService.createCiUploadUrl({
    project,
    filename,
    platform: pickPlatform(req.body?.platform),
    declaredSize: parseContentLength(req.body?.contentLength),
    variantLabel: trimmedString(req.body?.variant),
  });

  if ('kind' in result) {
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

  // Everything the locked section needs, parsed HERE so the helper is a pure
  // function of its input and needs no `req`.
  const finalizeInput: CiAppPublishService.CiFinalizeInput = {
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
  };

  // Two nested mutexes, each answering a different question.
  //
  // OUTER, per storagePath: "is this exact upload already being finalized?"
  // Rejects immediately — a resubmission is a duplicate, not a queue.
  //
  // A Redis failure while ACQUIRING propagates as `RedisMutexUnavailableError`
  // (a mutex that silently degrades to no mutex defeats itself), so map THAT to
  // the same 503 the rate limiter uses for the same dependency. Errors raised
  // by the body are deliberately NOT caught here: a dead database or a failed
  // parse must keep its own status and reach error monitoring, not be reported
  // to the customer as "the mutex is briefly unavailable".
  let objectLock;
  try {
    objectLock = await withRedisMutex(
      {
        key: `${CI_FINALIZE_LOCK.prefix}${storagePath}`,
        ttlSec: CI_FINALIZE_LOCK.ttlSec,
        logTag: 'CI_APP',
      },
      async () => {
        // INNER, per project: "is another publish for this project mid-flight?"
        // Waits, because parallel lanes of one pipeline are the normal case.
        // Serialises the settings read-modify-write and the variant-cap check.
        const projectLock = await withRedisMutex(
          {
            key: `${CI_PUBLISH_LOCK.prefix}${project.id}`,
            ttlSec: CI_PUBLISH_LOCK.ttlSec,
            waitMs: CI_PUBLISH_LOCK.waitMs,
            logTag: 'CI_APP',
          },
          () => finalizeUnderLock(res, finalizeInput),
        );

        if (!projectLock.acquired) {
          sendRateLimited(
            res,
            projectLock.retryAfterSec,
            'Another build for this project is still being published. Retry shortly.',
          );
        }
      },
    );
  } catch (err) {
    if (!(err instanceof RedisMutexUnavailableError)) throw err;
    logger.error('[CI_APP] Publish mutex unavailable', {
      projectId: project.id,
      error: err.message,
    });
    if (!res.headersSent) {
      sendRateLimiterUnavailable(res, 'Build publishing is briefly unavailable. Try again shortly.');
    }
    return;
  }

  if (!objectLock.acquired) {
    res.status(429).json({
      success: false,
      error: 'Finalize already in progress',
      code: 'FINALIZE_IN_PROGRESS',
      message: 'This upload is already being finalized. Wait for the first call to return.',
    });
  }
}

/** The finalize body proper — runs holding both mutexes. */
async function finalizeUnderLock(
  res: Response,
  input: CiAppPublishService.CiFinalizeInput,
): Promise<void> {
  const { project, commitSha } = input;

  const result = await CiAppPublishService.finalizeCiUpload(input);

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
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /ci/whoami
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate a key without side effects.
 *
 * This exists so an installer or a customer debugging a pipeline can check a
 * key. Validating via `upload-url` instead would orphan a storage object and
 * consume one of the project's hourly publish slots.
 *
 * Returns `projectId` ONLY. `projectName` is customer data, and whoami's
 * output lands in CI logs — which are public for OSS repositories.
 */
export async function ciWhoami(req: Request, res: Response): Promise<void> {
  res.json({ success: true, projectId: req.ciProject!.id });
}

/**
 * Per-IP limiter for `whoami`. Runs BEFORE `requireCiApiKey` so an unauthed
 * flood is capped before it reaches the DB.
 */
export const ciWhoamiRateLimit = createRedisRateLimiter({
  ...CI_WHOAMI_RATE_LIMIT,
  keyOf: (req) => req.ip ?? 'unknown',
  limitMessage: `Limit is ${CI_WHOAMI_RATE_LIMIT.max} requests per ${CI_WHOAMI_RATE_LIMIT.windowSec}s.`,
});
