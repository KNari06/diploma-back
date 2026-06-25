/**
 * #11 — Capture warmup is best-effort: it must NEVER throw and NEVER block the
 * capture flow, even when every page call rejects.
 */

import { warmupPageForCapture } from '../warmup-capture.util';

describe('warmupPageForCapture', () => {
  it('resolves (does not throw) when every page call rejects', async () => {
    const page = {
      addStyleTag: jest.fn().mockRejectedValue(new Error('cross-origin CSP blocks style injection')),
      evaluate: jest.fn().mockRejectedValue(new Error('execution context destroyed')),
    };
    await expect(warmupPageForCapture(page as any)).resolves.toBeUndefined();
  });

  it('runs the carousel-pause style + two evaluate passes on the happy path', async () => {
    const page = {
      addStyleTag: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
    };
    await warmupPageForCapture(page as any);
    expect(page.addStyleTag).toHaveBeenCalledTimes(1);
    // one evaluate to stop swiper/video autoplay, one for the bounded scroll.
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.addStyleTag.mock.calls[0][0].content).toContain('animation-play-state:paused');
  });
});
