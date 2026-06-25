/**
 * #11 — Warm up the live page before capture (pick / recording).
 *
 * Two bounded, best-effort steps so a target is present and STILL when the user
 * picks/records it:
 *   (1) pause autoplaying carousels + autoplay videos (visual-only, scoped to
 *       carousel-ish class hooks) so a slide isn't under the cursor at capture
 *       and gone at replay;
 *   (2) one-shot scroll through the page to materialize lazy (`loading=lazy` /
 *       IntersectionObserver) content, then restore the original scroll.
 *
 * Never throws, never blocks capture (hard-capped, fire-and-forget). Called
 * once on recording start; any failure is swallowed so it can never break the
 * recording flow.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

const MAX_SCROLL_STEPS = 30;
const SCROLL_STEP_DELAY_MS = 80;
const WARMUP_HARD_CAP_MS = 4000;

export async function warmupPageForCapture(page: Page): Promise<void> {
  const started = Date.now();
  try {
    // (1) Pause carousels / infinite animations. Injected stylesheet persists
    // for the session; scoped to carousel-ish hooks so the rest of the page
    // keeps its motion.
    await page
      .addStyleTag({
        content:
          '[class*="swiper"] *,[class*="carousel"] *,[class*="slick"] *,[class*="slider"] *,[class*="marquee"] *{animation-play-state:paused!important;}',
      })
      .catch(() => undefined);

    // Stop Swiper autoplay instances + pause autoplaying <video> (best-effort).
    await page
      .evaluate(() => {
        try {
          // @ts-expect-error - browser context
          document.querySelectorAll('.swiper, [class*="swiper-container"]').forEach((el: any) => {
            el?.swiper?.autoplay?.stop?.();
          });
          // @ts-expect-error - browser context
          document.querySelectorAll('video[autoplay]').forEach((v: any) => v?.pause?.());
        } catch {
          /* best-effort */
        }
      })
      .catch(() => undefined);

    // (2) Lazy-content warmup scroll (bounded by step count AND wall-clock),
    // then restore the original scroll position.
    await page
      .evaluate(
        async ({ maxSteps, delay, capMs }) => {
          // @ts-expect-error - browser context
          const w = window;
          // @ts-expect-error - browser context
          const d = document;
          const t0 = Date.now();
          const origY = w.scrollY;
          const step = Math.max(1, w.innerHeight);
          const total = d.body ? d.body.scrollHeight : 0;
          let steps = 0;
          for (let y = 0; y <= total && steps < maxSteps && Date.now() - t0 < capMs; y += step) {
            w.scrollTo(0, y);
            steps++;
            await new Promise((r) => setTimeout(r, delay));
          }
          w.scrollTo(0, origY);
        },
        { maxSteps: MAX_SCROLL_STEPS, delay: SCROLL_STEP_DELAY_MS, capMs: WARMUP_HARD_CAP_MS },
      )
      .catch(() => undefined);

    logger.debug('[CAPTURE_WARMUP] Page warmed for capture', { durationMs: Date.now() - started });
  } catch (e) {
    logger.debug('[CAPTURE_WARMUP] Warmup failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
