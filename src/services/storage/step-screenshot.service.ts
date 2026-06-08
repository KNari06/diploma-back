/**
 * Per-step screenshot storage.
 *
 * Captures for EVERY step (web + mobile regression replay) are encoded
 * (webp via sharp, or jpeg) and uploaded to the artifacts bucket as URLs —
 * never stored as base64 in the DB. Kept SEPARATE from the bulk
 * filesystem-artifact uploads (video / trace) in `test-artifacts-storage.service.ts`
 * so each file owns one concern.
 *
 * Storage layout: `${userId}/step-screenshots/${testId}/[fail/]step-N-<ts>.<ext>`
 * — a dedicated prefix the artifact-retention job can prune without touching
 * final/bug screenshots (`${userId}/screenshots/...`). Failure-step shots live
 * under a `fail/` subfolder so a future retention policy can keep them longer.
 */

import { env } from '@/config/environment/env';
import { ScreenshotCaptureFeature } from '@/config/features/screenshot-capture';
import { supabaseAdmin } from '@/db/supabase';
import type { MobileStepResult } from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';

/**
 * Build the storage path for a per-step screenshot. Single source of truth for
 * the `step-screenshots/` prefix + `fail/` subfolder the retention job targets.
 */
export function buildStepScreenshotPath(
  userId: string,
  testId: string,
  stepIndex: number,
  ext: string,
  isFailure: boolean,
  ts: number,
): string {
  const sub = isFailure ? 'fail/' : '';
  return `${userId}/step-screenshots/${testId}/${sub}step-${stepIndex}-${ts}.${ext}`;
}

/**
 * Re-encode a raw screenshot buffer to the configured per-step format
 * (webp via sharp, or jpeg). Falls back to the raw buffer (tagged with
 * `sourceExt`) if sharp is unavailable or encoding throws — so a broken
 * native sharp build never costs us ALL screenshots, only the re-compression.
 */
export async function encodeStepScreenshot(
  raw: Buffer,
  sourceExt: 'jpg' | 'png',
): Promise<{ buffer: Buffer; ext: 'webp' | 'jpg' | 'png'; contentType: string }> {
  const quality = ScreenshotCaptureFeature.getQuality();
  const format = ScreenshotCaptureFeature.getFormat();
  try {
    const sharp = (await import('sharp')).default;
    if (format === 'webp') {
      const buffer = await sharp(raw).webp({ quality }).toBuffer();
      return { buffer, ext: 'webp', contentType: 'image/webp' };
    }
    const buffer = await sharp(raw).jpeg({ quality }).toBuffer();
    return { buffer, ext: 'jpg', contentType: 'image/jpeg' };
  } catch (err) {
    logger.warn('[STORAGE] sharp re-encode failed — storing raw screenshot', {
      error: err instanceof Error ? err.message : String(err),
      sourceExt,
    });
    const contentType = sourceExt === 'jpg' ? 'image/jpeg' : 'image/png';
    return { buffer: raw, ext: sourceExt, contentType };
  }
}

/**
 * Upload a per-step screenshot buffer (webp/jpeg) to Supabase Storage and
 * return its public URL. Used by the per-step capture path (web + mobile).
 */
/**
 * Public URL for a storage path. Pure string construction (no network) — the
 * artifacts bucket is public, so the URL is valid the instant the upload lands.
 * This is what lets the deferred path return a usable URL before the upload
 * finishes.
 */
function stepScreenshotPublicUrl(storagePath: string): string {
  return supabaseAdmin.storage
    .from(env.SUPABASE_BUCKET_NAME)
    .getPublicUrl(storagePath).data.publicUrl;
}

/** Raw upload of an already-encoded buffer to an exact storage path. Throws on failure. */
async function putStepScreenshot(
  buffer: Buffer,
  storagePath: string,
  contentType: string,
): Promise<void> {
  if (!buffer || buffer.length === 0) {
    throw new Error('Step screenshot buffer is empty');
  }
  const { error } = await supabaseAdmin.storage
    .from(env.SUPABASE_BUCKET_NAME)
    .upload(storagePath, buffer, { contentType, upsert: false, cacheControl: '3600' });
  if (error) {
    throw new Error(`Failed to upload step screenshot: ${error.message}`);
  }
}

export async function uploadStepScreenshotToStorage(
  buffer: Buffer,
  opts: {
    testId: string;
    userId: string;
    stepIndex: number;
    ext: 'webp' | 'jpg' | 'png';
    contentType: string;
    isFailure?: boolean;
    ts: number;
  },
): Promise<string> {
  const storagePath = buildStepScreenshotPath(
    opts.userId,
    opts.testId,
    opts.stepIndex,
    opts.ext,
    !!opts.isFailure,
    opts.ts,
  );
  await putStepScreenshot(buffer, storagePath, opts.contentType);
  return stepScreenshotPublicUrl(storagePath);
}

/**
 * Encode + upload a per-step screenshot in one call. Used by both the web
 * (Playwright Page) and mobile (base64 from runner) capture paths.
 */
export async function processAndUploadStepScreenshot(
  raw: Buffer,
  sourceExt: 'jpg' | 'png',
  opts: { testId: string; userId: string; stepIndex: number; isFailure?: boolean; ts: number },
): Promise<string> {
  const { buffer, ext, contentType } = await encodeStepScreenshot(raw, sourceExt);
  return uploadStepScreenshotToStorage(buffer, {
    testId: opts.testId,
    userId: opts.userId,
    stepIndex: opts.stepIndex,
    ext,
    contentType,
    isFailure: opts.isFailure,
    ts: opts.ts,
  });
}

/**
 * Like {@link processAndUploadStepScreenshot}, but FIRE-AND-FORGET on the upload.
 *
 * Encoding (cheap CPU) is awaited so the file extension — and therefore the
 * deterministic public URL — is known; the network upload is started but NOT
 * awaited, so the caller (the web replay step loop) is never blocked on a
 * per-step storage round-trip. The returned URL is valid the moment the upload
 * lands (public bucket, path-derived URL). Uploads run on the long-lived worker
 * event loop and complete well before the report is read; an upload failure is
 * swallowed (best-effort visual evidence). The mobile path keeps using the
 * awaited+batched {@link uploadMobileStepScreenshots}.
 */
export async function processAndDeferStepScreenshot(
  raw: Buffer,
  sourceExt: 'jpg' | 'png',
  opts: { testId: string; userId: string; stepIndex: number; isFailure?: boolean; ts: number },
): Promise<string> {
  const { buffer, ext, contentType } = await encodeStepScreenshot(raw, sourceExt);
  const storagePath = buildStepScreenshotPath(
    opts.userId,
    opts.testId,
    opts.stepIndex,
    ext,
    !!opts.isFailure,
    opts.ts,
  );
  const url = stepScreenshotPublicUrl(storagePath);
  // Fire-and-forget: do NOT await the upload in the hot path.
  void putStepScreenshot(buffer, storagePath, contentType).catch((err) => {
    logger.debug('[STORAGE] deferred step screenshot upload failed (non-fatal)', {
      testId: opts.testId,
      stepIndex: opts.stepIndex,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return url;
}

/**
 * Upload a mobile run's per-step screenshots (base64 from the runner) to the
 * artifacts bucket and replace each `step.screenshot` with the resulting URL
 * (mutates in place). Bounded concurrency so a long test doesn't fan out
 * hundreds of uploads. Already-URL screenshots are left untouched. On per-step
 * failure the screenshot is dropped (never persist base64 blobs). Never throws.
 *
 * `uploader` is injectable for unit testing; defaults to the real encode+upload.
 */
export async function uploadMobileStepScreenshots(
  steps: MobileStepResult[],
  testId: string,
  userId: string,
  uploader: typeof processAndUploadStepScreenshot = processAndUploadStepScreenshot,
): Promise<void> {
  const CONCURRENCY = 5;
  for (let start = 0; start < steps.length; start += CONCURRENCY) {
    const slice = steps.slice(start, start + CONCURRENCY);
    await Promise.all(
      slice.map(async (step, j) => {
        const index = start + j;
        const shot = step.screenshot;
        if (!shot || typeof shot !== 'string') return;
        // Already uploaded (URL) — leave as-is.
        if (shot.startsWith('http://') || shot.startsWith('https://')) return;
        try {
          const isJpeg = shot.startsWith('data:image/jpeg') || shot.startsWith('/9j/');
          const base64 = shot.replace(/^data:image\/[a-z]+;base64,/, '');
          const raw = Buffer.from(base64, 'base64');
          step.screenshot = await uploader(raw, isJpeg ? 'jpg' : 'png', {
            testId,
            userId: userId || 'anonymous',
            stepIndex: index + 1,
            isFailure: !step.success,
            ts: Date.now(),
          });
        } catch (err) {
          logger.debug('[MOBILE-TEST] per-step screenshot upload failed (non-fatal)', {
            testId,
            stepIndex: index + 1,
            error: err instanceof Error ? err.message : String(err),
          });
          // Drop base64 so we never persist a huge blob in the DB.
          step.screenshot = undefined;
        }
      }),
    );
  }
}
