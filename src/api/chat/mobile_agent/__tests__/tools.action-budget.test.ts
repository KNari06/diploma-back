/**
 * The authoring path's per-action budget.
 *
 * This pins three things that were each learned on a live device, and that a
 * well-meaning refactor could silently undo:
 *
 *  1. the agent must NOT get the runner client's 8s "interactive" budget — that
 *     exists so a human clicking Point/Find doesn't wait, and it 408'd taps that
 *     had already landed (TC-32);
 *  2. the agent must still get `noRetry` — re-sending a mutating tap is its own
 *     bug — which is why `interactive` and `noRetry` are separate flags;
 *  3. the budget must be passed EXPLICITLY, not inherited from the client's 30s
 *     default, because one runner command on a large Flutter screen was measured
 *     at >30s of forced tree rebuilds while the tap itself had already succeeded
 *     (TC-33, 2026-08-13 — 82 rebuilds in 30s on a 1123-node screen; see
 *     `.claude/deferred/20260813-one-runner-command-rebuilds-the-flutter-tree-dozens-of-times.md`).
 *
 * A regression here means an agent action can be reported as failed after it
 * worked — the exact defect that made the agent abandon authoring turns.
 */

import { executeTool } from '../tools';
import { MobileBlackboard } from '../blackboard';
import type { MobileUiState } from '@/services/mobile/mobile-runner.types';

jest.mock('@/services/mobile/session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getMobileRunnerClientForSession } from '@/services/mobile/session-runner-routing';
const mockedGetClient = getMobileRunnerClientForSession as jest.MockedFunction<
  typeof getMobileRunnerClientForSession
>;

function snapshot(): MobileUiState {
  return {
    sessionId: 'sess-1',
    platform: 'android',
    app: 'com.example.app',
    activity: '.MainActivity',
    fingerprint: 'SCREEN-1',
    screenSize: { width: 1080, height: 1920 },
    formattedTree: '<tree/>',
    capturedAt: '2026-08-13T10:00:00.000Z',
  };
}

function makeBlackboard(): MobileBlackboard {
  const bb = new MobileBlackboard({
    goal: 'author the FAQ flow',
    mobileSessionId: 'sess-1',
    userId: 'user-1',
  });
  // `swipe` and `scroll` derive gesture coordinates from the screen size and
  // bail BEFORE dispatch if they cannot read it (`ensureScreenDims`). Without a
  // seeded snapshot they never reach the runner, and this file would silently
  // assert nothing for them.
  bb.setSnapshot(snapshot());
  return bb;
}

/** Options object `dispatchSingleCommand` handed to the runner client. */
async function dispatchOptsFor(
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
  const fetchUiState = jest.fn();
  mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

  await executeTool(tool, args, makeBlackboard());

  if (executeBatchCommands.mock.calls.length === 0) return null;
  return executeBatchCommands.mock.calls[0][2] as Record<string, unknown>;
}

beforeEach(() => jest.clearAllMocks());

describe('authoring per-action budget', () => {
  it('sends an explicit 60s timeout instead of inheriting the client default', async () => {
    const opts = await dispatchOptsFor('tap_element', { targetDescription: 'Profile tab' });
    expect(opts?.timeoutMs).toBe(60_000);
  });

  it('never marks an agent action interactive — that is the 8s human budget', async () => {
    const opts = await dispatchOptsFor('tap_element', { targetDescription: 'Profile tab' });
    expect(opts?.interactive).toBe(false);
  });

  it('still suppresses transport retry — a resent mutating tap is its own bug', async () => {
    const opts = await dispatchOptsFor('tap_element', { targetDescription: 'Profile tab' });
    expect(opts?.noRetry).toBe(true);
  });

  it('applies the same budget to every device-driving tool, not just tap', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['tap_element', { targetDescription: 'Profile tab' }],
      ['type_text', { targetDescription: 'Search field', text: 'hello' }],
      ['swipe', { direction: 'up' }],
      ['scroll', { direction: 'down' }],
    ];

    for (const [tool, args] of cases) {
      const opts = await dispatchOptsFor(tool, args);
      // Report which tool drifted rather than a bare `undefined !== 60000`.
      expect([tool, opts?.timeoutMs]).toEqual([tool, 60_000]);
    }
  });
});
