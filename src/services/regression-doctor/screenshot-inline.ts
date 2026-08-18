/**
 * Regression Doctor — getting a failure screenshot in front of the model.
 *
 * Split out of `step-fix-agent.ts`: this is IO with its own failure modes and
 * its own bounds, and it is the piece most likely to be reused when a second
 * caller wants the same "inline the artefact, never link it" behaviour.
 *
 * **This module makes an outbound request driven by stored data, so it treats
 * that data as untrusted.** `runtimeMeta.stepScreenshotUrl` is normally a URL
 * this backend minted while uploading the image, but the mobile path only
 * rewrites the runner's value when it is base64 —
 * `uploadMobileStepScreenshots` returns early for anything already starting
 * with `http` (step-screenshot.service.ts:222). A runner that returns a URL
 * therefore gets that string persisted verbatim. Fetching it unconditionally
 * would let a remote runner make this backend issue arbitrary GETs — including
 * to link-local metadata endpoints and internal services — and ship the
 * response to a third-party model. Hence the origin pin below.
 */

import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import type { FailedStepEvidence } from './types';

/**
 * Bounds on inlining. Deliberately conservative: base64 inflates a payload by
 * ~4/3, and up to two images ride in one request, so a 3 MB ceiling keeps the
 * worst case near 8 MB rather than at the provider's limit — where the call
 * fails outright and the analysis falls back to text-only, which is the
 * degradation this module exists to avoid.
 */
const SCREENSHOT_FETCH_TIMEOUT_MS = 8000;
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

export interface InlinedScreenshot {
  label: string;
  dataUrl: string;
  /**
   * `high` for the failure itself — that image is read forensically. `low` for
   * the prior frame, which is only asked "what changed?", and at high detail
   * would double the vision cost of every finding for no extra answer.
   */
  detail: 'high' | 'low';
}

/**
 * Fail screenshot first, "what it looked like a moment earlier" second. Order
 * matters — the model anchors on the first image, and the failure state is the
 * subject; the prior frame is context for what changed.
 *
 * **Images are inlined as base64, never passed as URLs.** Handing the provider
 * a storage URL makes it fetch our bucket, and that fetch fails often enough to
 * matter — observed live as `400 Timeout while downloading …`, which costs the
 * whole call and drops the analysis to a text-only "unclear". Every other
 * vision path in this codebase (ai-check, vision-analyzer, tool-executor)
 * inlines for the same reason.
 */
export async function collectScreenshots(
  evidence: FailedStepEvidence,
): Promise<InlinedScreenshot[]> {
  const candidates: Array<{ label: string; url?: string; detail: 'high' | 'low' }> = [
    { label: 'SCREENSHOT AT FAILURE:', url: evidence.failScreenshotUrl, detail: 'high' },
    {
      label: 'SCREENSHOT AFTER THE LAST SUCCESSFUL STEP:',
      url: evidence.priorScreenshotUrl,
      detail: 'low',
    },
  ];

  const fetched = await Promise.all(
    candidates
      .filter((c) => isOwnStorageUrl(c.url))
      .map(async (c) => {
        const dataUrl = await fetchAsDataUrl(c.url!);
        return dataUrl ? { label: c.label, dataUrl, detail: c.detail } : null;
      }),
  );

  return fetched.filter((s): s is InlinedScreenshot => s !== null);
}

/**
 * Only artefacts on our own storage host are fetched.
 *
 * The host is derived from `SUPABASE_URL`, the same source
 * `stepScreenshotPublicUrl` builds upload URLs from, so a legitimately uploaded
 * screenshot always passes and anything else never does. Fail-closed: an
 * unparseable or foreign URL yields no image, and the analysis proceeds on the
 * text evidence rather than reaching out to it.
 */
function isOwnStorageUrl(url?: string): boolean {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;

  try {
    const candidate = new URL(url);
    const storage = new URL(env.SUPABASE_URL);
    if (candidate.host === storage.host) return true;

    logger.warn('[STEP_FIX_AGENT] Refusing to fetch a screenshot outside our storage host', {
      host: candidate.host,
    });
    return false;
  } catch {
    return false;
  }
}

/**
 * Download a screenshot and inline it. Bounded on both axes because this runs
 * per finding in a background job: a slow bucket must not hold the job open,
 * and an unexpectedly large artefact must not blow the request budget.
 * Any failure returns null — the analysis proceeds without that image.
 */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCREENSHOT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      logger.debug('[STEP_FIX_AGENT] Screenshot fetch returned non-OK', {
        status: response.status,
      });
      return null;
    }

    const contentType = response.headers.get('content-type') ?? guessMimeFromUrl(url);
    if (!contentType.startsWith('image/')) {
      // Submitting a non-image as an `image_url` fails the whole completion,
      // which costs the analysis its evidence and forces the text-only retry.
      // Dropping the frame here degrades far more gracefully.
      logger.debug('[STEP_FIX_AGENT] Screenshot is not an image — skipping', { contentType });
      return null;
    }

    // Size is checked BEFORE the body is read where the header allows it —
    // `arrayBuffer()` materialises the whole response, so a post-hoc check
    // bounds what we send but not what we hold. Supabase storage always sets
    // content-length; the post-read check below is the backstop for a chunked
    // response that does not.
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SCREENSHOT_BYTES) {
      logger.debug('[STEP_FIX_AGENT] Screenshot too large to inline', { bytes: declaredLength });
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
      logger.debug('[STEP_FIX_AGENT] Screenshot too large to inline', {
        bytes: buffer.byteLength,
      });
      return null;
    }

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    logger.debug('[STEP_FIX_AGENT] Screenshot fetch failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function guessMimeFromUrl(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  return 'image/jpeg';
}

/** @internal — exported for unit tests only. */
export const __testing = { isOwnStorageUrl };
