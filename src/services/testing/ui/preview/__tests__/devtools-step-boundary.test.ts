/**
 * Step-boundary windowing for console assertions in the EDITOR (preview) path.
 *
 * Why this exists: the editor read the WHOLE session's console history, so an
 * error logged on first paint would fail (or be fed to the model by) a console
 * assertion placed fifteen steps later. The replay executor already windowed
 * per step, so the two paths disagreed about the same test.
 *
 * The subtle part is WHERE the window opens. An `ai_check` /
 * `assert_no_console_errors` step performs no page action of its own — it runs
 * immediately after the step that DID act. So the window must start at the
 * PREVIOUS step boundary, not at this step's own start; otherwise it is empty
 * almost every time and the assertion reports a clean console for a page that
 * had just thrown.
 */

import { PreviewDevToolsCollector } from '../preview-devtools-collector.service';
import type { PreviewConsoleEntry } from '@/websocket/types/types';

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Push an entry straight into the underlying collector's buffer. */
const seed = (
  devtools: PreviewDevToolsCollector,
  text: string,
  timestamp: string,
  level: PreviewConsoleEntry['level'] = 'error',
): void => {
  const inner = (devtools as unknown as { consoleCollector: { entries: PreviewConsoleEntry[] } })
    .consoleCollector;
  inner.entries.push({ level, text, timestamp });
};

const make = () => new PreviewDevToolsCollector('sess-1', 'room-1');

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

describe('PreviewDevToolsCollector — console step boundary', () => {
  it('returns the WHOLE history before any boundary is recorded', () => {
    // First console assertion of a session: there is no previous step, so
    // "since the previous step" can only honestly mean "everything so far".
    const d = make();
    seed(d, 'early error', iso(-60_000));

    expect(d.hasStepBoundary()).toBe(false);
    expect(d.getConsoleEntriesSinceStepBoundary().map((e) => e.text)).toEqual(['early error']);
  });

  it('excludes entries logged before the boundary', () => {
    const d = make();
    seed(d, 'from an earlier step', iso(-60_000));

    d.markStepBoundary();
    seed(d, 'from the current step', iso(10));

    expect(d.getConsoleEntriesSinceStepBoundary().map((e) => e.text)).toEqual([
      'from the current step',
    ]);
  });

  it('keeps the full history available for the run-scoped read', () => {
    // scope:'run' and the DevTools panel must still see everything.
    const d = make();
    seed(d, 'old', iso(-60_000));
    d.markStepBoundary();
    seed(d, 'new', iso(10));

    expect(d.getConsoleEntries()).toHaveLength(2);
    expect(d.getConsoleEntriesSinceStepBoundary()).toHaveLength(1);
  });

  it('advances the window on each boundary', () => {
    const d = make();
    d.markStepBoundary();
    seed(d, 'step one error', iso(-5));

    d.markStepBoundary();
    seed(d, 'step two error', iso(10));

    expect(d.getConsoleEntriesSinceStepBoundary().map((e) => e.text)).toEqual(['step two error']);
  });

  it('KEEPS an entry whose timestamp cannot be parsed', () => {
    // An error we cannot place in time must not silently vanish from an
    // assertion — dropping it would under-report and produce a false pass.
    const d = make();
    d.markStepBoundary();
    seed(d, 'malformed timestamp', 'not-a-date');

    expect(d.getConsoleEntriesSinceStepBoundary().map((e) => e.text)).toEqual([
      'malformed timestamp',
    ]);
  });

  it('includes an entry landing exactly on the boundary', () => {
    const d = make();
    const now = new Date();
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    d.markStepBoundary();
    seed(d, 'exactly on boundary', now.toISOString());

    expect(d.getConsoleEntriesSinceStepBoundary()).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('reports that a boundary exists once marked', () => {
    const d = make();
    expect(d.hasStepBoundary()).toBe(false);
    d.markStepBoundary();
    expect(d.hasStepBoundary()).toBe(true);
  });
});
