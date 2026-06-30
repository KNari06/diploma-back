/**
 * Iframe ref resolution — pure helpers shared by the action executor.
 *
 * The snapshot collector emits same-origin iframe element refs as
 * `ifr{frameIndex}_{idx}` and stamps the matching `data-agent-ref` INSIDE that
 * frame (see snapshot-collector.ts iframe pass). At action time the executor
 * must scope its Playwright locator to that Frame — `page.locator()` does not
 * cross frame boundaries — so it resolves the ref back to a Frame using these
 * helpers. Kept pure (no Playwright import) so the logic is unit-testable
 * without a real browser.
 */

/** Minimal Frame shape the resolver needs — structurally satisfied by Playwright's Frame. */
export interface FrameLike {
  name(): string;
  url(): string;
  isDetached(): boolean;
}

/** Minimal Page shape — structurally satisfied by Playwright's Page. */
export interface PageFramesLike<F extends FrameLike> {
  frames(): F[];
  mainFrame(): F;
}

const IFRAME_REF_RE = /^ifr(\d+)_/;

/**
 * Valid element-ref shapes the action executor accepts:
 *   - `e{N}`        light-DOM main-frame element
 *   - `s{N}`        open-shadow-DOM element
 *   - `ifr{N}_{M}`  same-origin iframe element (frame index N, element index M)
 * Single source of truth for `validateCommand` (ref + targetRef) so the iframe
 * shape can never be forgotten in one site and rejected there.
 */
export const VALID_REF_RE = /^(?:[es]\d+|ifr\d+_\d+)$/;

/** Frame index encoded in an iframe ref, or null for a main-page ref. */
export function parseIframeRefIndex(ref: string | undefined): number | null {
  if (!ref) return null;
  const m = IFRAME_REF_RE.exec(ref);
  return m ? parseInt(m[1], 10) : null;
}

/** True when a frame's name or url-tail matches the collector's `iframeSource`. */
export function frameMatchesSource(frame: FrameLike, source: string): boolean {
  if (frame.name() === source) return true;
  try {
    return new URL(frame.url()).pathname.slice(-30) === source;
  } catch {
    return false;
  }
}

/**
 * Resolve the Frame an iframe-scoped ref targets.
 *
 * Strategy: positional match on the index encoded in the ref (stable within a
 * single observe→act cycle), validated against the recorded `iframeSource`
 * (name/url) when available; on index drift, fall back to matching purely by
 * source. Returns null for main-page refs or any miss — the caller then keeps
 * its default context (and the existing fallback chain takes over).
 */
export function resolveIframeFrame<F extends FrameLike>(
  page: PageFramesLike<F>,
  ref: string | undefined,
  expectedSource: string | undefined,
): F | null {
  const frameIndex = parseIframeRefIndex(ref);
  if (frameIndex === null) return null;

  const frames = page.frames();
  const mainFrame = page.mainFrame();

  const byIndex = frames[frameIndex];
  if (byIndex && byIndex !== mainFrame && !byIndex.isDetached()) {
    if (!expectedSource || frameMatchesSource(byIndex, expectedSource)) {
      return byIndex;
    }
  }

  if (expectedSource) {
    const bySource = frames.find(
      (f) => f !== mainFrame && !f.isDetached() && frameMatchesSource(f, expectedSource),
    );
    if (bySource) return bySource;
  }

  return null;
}
