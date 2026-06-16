/**
 * Unit tests for the preview dirty-observer service (Phase 2: event-driven
 * snapshot trigger). The in-page MutationObserver script itself runs in a real
 * browser and isn't unit-testable here; these tests cover the server-side
 * lifecycle: inject, expose, re-inject on navigation, teardown, idempotency,
 * and the page→server signal routing into `onDirty`.
 */

import {
  startDirtyObserver,
  cancelDirtyObserverForSession,
  isDirtyObserverActive,
  isDirtyObserverShadowOnly,
} from '../preview-dirty-observer.service';

const FRAMENAVIGATED = 'framenavigated';
const CLOSE = 'close';

function makeMockPage() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const exposed: Record<string, (...args: any[]) => any> = {};
  const mainFrame = { id: 'MAIN' };
  const page = {
    isClosed: jest.fn(() => false),
    mainFrame: jest.fn(() => mainFrame),
    exposeFunction: jest.fn(async (name: string, fn: (...args: any[]) => any) => {
      exposed[name] = fn;
    }),
    evaluate: jest.fn(async () => undefined),
    on: jest.fn((evt: string, fn: (...args: any[]) => void) => {
      (listeners[evt] ||= []).push(fn);
    }),
    once: jest.fn((evt: string, fn: (...args: any[]) => void) => {
      (listeners[evt] ||= []).push(fn);
    }),
    off: jest.fn((evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
    }),
    // test helpers
    __exposed: exposed,
    __listeners: listeners,
    __mainFrame: mainFrame,
  };
  return page;
}

describe('preview-dirty-observer service', () => {
  // Keep the module-level session map clean between tests.
  const started: string[] = [];
  afterEach(async () => {
    for (const id of started.splice(0)) {
      await cancelDirtyObserverForSession(id);
    }
    jest.clearAllMocks();
  });

  describe('flags (default OFF)', () => {
    it('is inactive by default (no env flags set)', () => {
      expect(isDirtyObserverActive()).toBe(false);
      expect(isDirtyObserverShadowOnly()).toBe(false);
    });
  });

  describe('startDirtyObserver', () => {
    it('exposes the signal callback, injects the script, and attaches lifecycle listeners', async () => {
      const page = makeMockPage();
      const onDirty = jest.fn();
      started.push('s1');

      const ok = await startDirtyObserver({ previewSessionId: 's1', page: page as any, onDirty });

      expect(ok).toBe(true);
      expect(page.exposeFunction).toHaveBeenCalledWith('__qai_dirty_signal', expect.any(Function));
      expect(page.evaluate).toHaveBeenCalledTimes(1); // script injection
      expect(page.on).toHaveBeenCalledWith(FRAMENAVIGATED, expect.any(Function));
      expect(page.once).toHaveBeenCalledWith(CLOSE, expect.any(Function));
    });

    it('routes the in-page signal to onDirty', async () => {
      const page = makeMockPage();
      const onDirty = jest.fn();
      started.push('s2');

      await startDirtyObserver({ previewSessionId: 's2', page: page as any, onDirty });
      // Simulate the page calling the exposed function.
      page.__exposed['__qai_dirty_signal']();

      expect(onDirty).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — a second start for the same session is a no-op', async () => {
      const page = makeMockPage();
      started.push('s3');

      const first = await startDirtyObserver({ previewSessionId: 's3', page: page as any, onDirty: jest.fn() });
      const second = await startDirtyObserver({ previewSessionId: 's3', page: page as any, onDirty: jest.fn() });

      expect(first).toBe(true);
      expect(second).toBe(true); // already running → reported active, but not re-injected
      expect(page.exposeFunction).toHaveBeenCalledTimes(1);
      expect(page.evaluate).toHaveBeenCalledTimes(1);
    });

    it('skips when the page is already closed', async () => {
      const page = makeMockPage();
      page.isClosed.mockReturnValue(true);

      const ok = await startDirtyObserver({ previewSessionId: 's4', page: page as any, onDirty: jest.fn() });

      expect(ok).toBe(false);
      expect(page.exposeFunction).not.toHaveBeenCalled();
      expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('tolerates an "already registered" exposeFunction error and still injects', async () => {
      const page = makeMockPage();
      page.exposeFunction.mockRejectedValueOnce(new Error('Function "__qai_dirty_signal" has been already registered'));
      started.push('s5');

      const ok = await startDirtyObserver({ previewSessionId: 's5', page: page as any, onDirty: jest.fn() });

      // Did not abort: script injection + listeners still happened.
      expect(ok).toBe(true);
      expect(page.evaluate).toHaveBeenCalledTimes(1);
      expect(page.on).toHaveBeenCalledWith(FRAMENAVIGATED, expect.any(Function));
    });

    it('re-injects the observer script on main-frame navigation', async () => {
      const page = makeMockPage();
      started.push('s6');

      await startDirtyObserver({ previewSessionId: 's6', page: page as any, onDirty: jest.fn() });
      expect(page.evaluate).toHaveBeenCalledTimes(1);

      // Fire the framenavigated handler with the main frame.
      const navHandler = page.__listeners[FRAMENAVIGATED][0];
      navHandler(page.__mainFrame);
      // Allow the fire-and-forget evaluate to schedule.
      await Promise.resolve();

      expect(page.evaluate).toHaveBeenCalledTimes(2);
    });

    it('ignores navigation events for sub-frames', async () => {
      const page = makeMockPage();
      started.push('s7');

      await startDirtyObserver({ previewSessionId: 's7', page: page as any, onDirty: jest.fn() });
      const navHandler = page.__listeners[FRAMENAVIGATED][0];
      navHandler({ id: 'SUBFRAME' }); // not the main frame
      await Promise.resolve();

      expect(page.evaluate).toHaveBeenCalledTimes(1); // no re-inject
    });
  });

  describe('cancelDirtyObserverForSession', () => {
    it('detaches listeners, runs the teardown script, and stops routing signals', async () => {
      const page = makeMockPage();
      const onDirty = jest.fn();
      await startDirtyObserver({ previewSessionId: 's8', page: page as any, onDirty });
      const signal = page.__exposed['__qai_dirty_signal'];
      page.evaluate.mockClear();

      await cancelDirtyObserverForSession('s8');

      expect(page.off).toHaveBeenCalledWith(FRAMENAVIGATED, expect.any(Function));
      expect(page.off).toHaveBeenCalledWith(CLOSE, expect.any(Function));
      expect(page.evaluate).toHaveBeenCalledTimes(1); // teardown script

      // A late in-page signal after teardown must NOT reach onDirty.
      signal();
      expect(onDirty).not.toHaveBeenCalled();
    });

    it('is idempotent and safe when nothing was started', async () => {
      await expect(cancelDirtyObserverForSession('never-started')).resolves.toBeUndefined();
    });
  });
});
