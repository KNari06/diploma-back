import {
  captureCheckpoint,
  restoreCheckpoint,
  getCheckpointInfo,
  clearCheckpoint,
} from '../preview-checkpoint.service';
import { getPreviewSessionService } from '../preview-session.service';

jest.mock('../preview-session.service', () => ({
  getPreviewSessionService: jest.fn(),
}));

const SESSION = 'session-1';
const USER = 'user-1';

function makeStorageState(overrides: Record<string, unknown> = {}) {
  return {
    cookies: [{ name: 'sid', value: 'before', domain: 'example.com', path: '/' }],
    origins: [
      {
        origin: 'https://example.com',
        localStorage: [{ name: 'cart', value: 'empty' }],
      },
    ],
    ...overrides,
  };
}

/**
 * Builds a fake live session. `context`/`page` are the two Playwright handles
 * the service reaches for; `navigate` stands in for the session service's own
 * navigation path.
 */
function mockLiveSession(options: {
  storageState?: unknown;
  storageStateError?: Error;
  url?: string;
  clearCookiesError?: Error;
  navigateError?: Error;
  /** Tabs the session reports. Defaults to a single tab: the active page. */
  pages?: unknown[];
} = {}) {
  const page = {
    url: jest.fn(() => options.url ?? 'https://example.com/checkout'),
    goto: jest.fn(async () => undefined),
    evaluate: jest.fn(async () => undefined),
  };
  const pages = options.pages ?? [page];
  const context = {
    storageState: jest.fn(async () => {
      if (options.storageStateError) throw options.storageStateError;
      return options.storageState ?? makeStorageState();
    }),
    clearCookies: jest.fn(async () => {
      if (options.clearCookiesError) throw options.clearCookiesError;
    }),
    addCookies: jest.fn(async () => undefined),
    pages: jest.fn(() => pages),
  };
  const navigate = jest.fn(async () => {
    if (options.navigateError) throw options.navigateError;
    return { url: options.url ?? 'https://example.com/checkout' };
  });
  const session = { pages: [...pages] };
  const closeTab = jest.fn(async (_sessionId: string, _userId: string, index: number) => {
    session.pages.splice(index, 1);
    return true;
  });

  (getPreviewSessionService as jest.Mock).mockReturnValue({
    getContext: jest.fn(() => context),
    getPage: jest.fn(() => page),
    getSession: jest.fn(() => session),
    closeTab,
    navigate,
  });

  return { context, page, navigate, session, closeTab };
}

function mockDeadSession() {
  (getPreviewSessionService as jest.Mock).mockReturnValue({
    getContext: jest.fn(() => null),
    getPage: jest.fn(() => null),
    navigate: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearCheckpoint(SESSION);
});

describe('PreviewCheckpointService', () => {
  describe('captureCheckpoint', () => {
    it('reports a restore point after snapshotting the live session', async () => {
      mockLiveSession({ url: 'https://example.com/cart' });

      const info = await captureCheckpoint(SESSION, USER, { id: 'step-7', label: 'Click Pay' });

      expect(info).toMatchObject({
        available: true,
        url: 'https://example.com/cart',
        stepId: 'step-7',
        stepLabel: 'Click Pay',
      });
      expect(getCheckpointInfo(SESSION).available).toBe(true);
    });

    it('reports no restore point when the session is already gone', async () => {
      mockDeadSession();

      const info = await captureCheckpoint(SESSION, USER);

      expect(info.available).toBe(false);
    });

    it('drops a previous checkpoint when a later capture fails', async () => {
      mockLiveSession();
      await captureCheckpoint(SESSION, USER, { id: 'step-1' });
      expect(getCheckpointInfo(SESSION).available).toBe(true);

      // A stale checkpoint would claim to be "one step back" while actually
      // predating the step before last.
      mockLiveSession({ storageStateError: new Error('CDP detached') });
      const info = await captureCheckpoint(SESSION, USER, { id: 'step-2' });

      expect(info.available).toBe(false);
      expect(getCheckpointInfo(SESSION).available).toBe(false);
    });

    it('does not throw when the snapshot fails, so the step can still run', async () => {
      mockLiveSession({ storageStateError: new Error('CDP detached') });

      await expect(captureCheckpoint(SESSION, USER)).resolves.toEqual({
        previewSessionId: SESSION,
        available: false,
      });
    });

    it('does not throw when resolving the session itself blows up', async () => {
      // Capture runs before every step of a run. If reaching into the session
      // service can throw out of this function, a snapshot problem takes the
      // whole run down with it — which is exactly backwards.
      (getPreviewSessionService as jest.Mock).mockImplementation(() => {
        throw new TypeError('session service unavailable');
      });

      await expect(captureCheckpoint(SESSION, USER)).resolves.toEqual({
        previewSessionId: SESSION,
        available: false,
      });
    });

    it('keeps only the most recent checkpoint', async () => {
      mockLiveSession({ url: 'https://example.com/one' });
      await captureCheckpoint(SESSION, USER, { id: 'step-1' });

      mockLiveSession({ url: 'https://example.com/two' });
      await captureCheckpoint(SESSION, USER, { id: 'step-2' });

      expect(getCheckpointInfo(SESSION)).toMatchObject({
        url: 'https://example.com/two',
        stepId: 'step-2',
      });
    });
  });

  describe('restoreCheckpoint', () => {
    it('refuses when nothing was captured', async () => {
      mockLiveSession();

      const result = await restoreCheckpoint(SESSION, USER);

      expect(result).toMatchObject({ ok: false, reason: 'no_checkpoint' });
    });

    it('clears cookies before re-seeding so the step cannot leave one behind', async () => {
      const live = mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      await restoreCheckpoint(SESSION, USER);

      expect(live.context.clearCookies).toHaveBeenCalled();
      expect(live.context.addCookies).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'sid', value: 'before' }),
      ]);
      const clearOrder = live.context.clearCookies.mock.invocationCallOrder[0];
      const addOrder = live.context.addCookies.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(addOrder);
    });

    it('re-seeds localStorage for each captured origin', async () => {
      const live = mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      await restoreCheckpoint(SESSION, USER);

      expect(live.page.evaluate).toHaveBeenCalledWith(expect.any(Function), [
        { name: 'cart', value: 'empty' },
      ]);
    });

    it('clears localStorage on an origin the step visited for the first time', async () => {
      const live = mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      // The step navigated somewhere new and wrote storage there. That origin
      // is absent from the checkpoint, so restoring only the captured ones
      // would leave the step's data behind — a merge, not a replace.
      live.context.storageState.mockResolvedValue(
        makeStorageState({
          origins: [
            { origin: 'https://example.com', localStorage: [{ name: 'cart', value: 'full' }] },
            { origin: 'https://checkout.example.com', localStorage: [{ name: 'token', value: 'x' }] },
          ],
        }),
      );

      await restoreCheckpoint(SESSION, USER);

      // Captured origin re-seeded with its captured contents...
      expect(live.page.evaluate).toHaveBeenCalledWith(expect.any(Function), [
        { name: 'cart', value: 'empty' },
      ]);
      // ...and the step's new origin wiped.
      expect(live.page.evaluate).toHaveBeenCalledWith(expect.any(Function), []);
    });

    it('navigates back to the captured URL through the session service', async () => {
      const live = mockLiveSession({ url: 'https://example.com/cart' });
      await captureCheckpoint(SESSION, USER);

      const result = await restoreCheckpoint(SESSION, USER);

      expect(live.navigate).toHaveBeenCalledWith(SESSION, 'https://example.com/cart', USER);
      expect(result).toEqual({ ok: true, url: 'https://example.com/cart' });
    });

    it('closes tabs the step opened, so the tab strip matches the restored state', async () => {
      const original = { url: () => 'https://example.com/cart', goto: jest.fn(), evaluate: jest.fn() };
      mockLiveSession({ pages: [original] });
      await captureCheckpoint(SESSION, USER);

      // The step opened a popup (target=_blank, cross-origin click, …).
      const opened = { url: () => 'https://other.example/promo', goto: jest.fn(), evaluate: jest.fn() };
      const live = mockLiveSession({ pages: [original, opened] });
      // Re-capture would overwrite the checkpoint, so restore against the one
      // taken above by re-seeding only the session view.
      live.session.pages = [original, opened];

      await restoreCheckpoint(SESSION, USER);

      expect(live.closeTab).toHaveBeenCalledWith(SESSION, USER, 1);
      expect(live.session.pages).toEqual([original]);
    });

    it('does not close tabs that already existed at capture time', async () => {
      const first = { url: () => 'https://example.com/a', goto: jest.fn(), evaluate: jest.fn() };
      const second = { url: () => 'https://example.com/b', goto: jest.fn(), evaluate: jest.fn() };
      const live = mockLiveSession({ pages: [first, second] });
      await captureCheckpoint(SESSION, USER);

      await restoreCheckpoint(SESSION, USER);

      expect(live.closeTab).not.toHaveBeenCalled();
    });

    it('still restores when tab cleanup fails', async () => {
      const live = mockLiveSession();
      await captureCheckpoint(SESSION, USER);
      live.closeTab.mockRejectedValue(new Error('tab is busy'));

      const result = await restoreCheckpoint(SESSION, USER);

      expect(result).toMatchObject({ ok: true });
    });

    it('consumes the checkpoint so a second restore has nothing to do', async () => {
      mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      await restoreCheckpoint(SESSION, USER);
      const second = await restoreCheckpoint(SESSION, USER);

      expect(getCheckpointInfo(SESSION).available).toBe(false);
      expect(second).toMatchObject({ ok: false, reason: 'no_checkpoint' });
    });

    it('keeps the checkpoint when the restore fails so the author can retry', async () => {
      mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      mockLiveSession({ clearCookiesError: new Error('browser closed') });
      const result = await restoreCheckpoint(SESSION, USER);

      expect(result).toMatchObject({ ok: false, reason: 'restore_failed' });
      expect(getCheckpointInfo(SESSION).available).toBe(true);
    });

    it('reports the session as gone and drops the checkpoint when the browser died', async () => {
      mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      mockDeadSession();
      const result = await restoreCheckpoint(SESSION, USER);

      expect(result).toMatchObject({ ok: false, reason: 'session_gone' });
      expect(getCheckpointInfo(SESSION).available).toBe(false);
    });
  });

  describe('clearCheckpoint', () => {
    it('removes the stored state, which holds live auth cookies', async () => {
      mockLiveSession();
      await captureCheckpoint(SESSION, USER);

      clearCheckpoint(SESSION);

      expect(getCheckpointInfo(SESSION).available).toBe(false);
    });
  });
});
