/**
 * A blind gesture that moved nothing must SAY so.
 *
 * The runner implements `scroll` as an `adb swipe` from the centre of the
 * screen. `adb swipe` reports success as soon as the gesture is injected — it
 * knows nothing about whether any content responded. So "Scrolled down."
 * is true in the sense of "the gesture was sent" and useless in the sense the
 * agent needs: did I get closer to the thing I am looking for?
 *
 * Measured on JanaPost TC-33 (2026-08-13). The agent wanted the feedback
 * control that sits below a long FAQ answer. `direction` on this path is the
 * direction the FINGER travels, so "up" reveals content further down the page —
 * the inverse of the viewport sense the model was reasoning in. It asked for
 * "down" ten times, each one a no-op against a page already at its top, each
 * one answered "Scrolled down.", while the Flutter tree stayed byte-identical.
 * Ten scrolls plus the observes between them consumed 24 of the turn's 30 tool
 * rounds and the turn died at the cap. One "up" reaches the control.
 *
 * Two independent defects, so two independent guards, and this file pins the
 * second: whatever the agent believes about direction, a gesture that changes
 * nothing has to come back saying it changed nothing. Without that, a wrong
 * guess costs the whole round budget instead of one round.
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

const TREE_BEFORE = 'FAQ answer, top of page';
const TREE_AFTER = 'FAQ answer, feedback control visible';

function snapshot(formattedTree: string): MobileUiState {
  return {
    sessionId: 'sess-1',
    platform: 'android',
    app: 'com.example.app',
    activity: '.MainActivity',
    fingerprint: 'SCREEN-1',
    screenSize: { width: 1080, height: 1920 },
    formattedTree,
    capturedAt: '2026-08-13T10:00:00.000Z',
  };
}

function makeBlackboard(): MobileBlackboard {
  const bb = new MobileBlackboard({
    goal: 'author the FAQ flow',
    mobileSessionId: 'sess-1',
    userId: 'user-1',
  });
  // `scroll`/`swipe` derive gesture coordinates from the screen size, so they
  // need a seeded snapshot to reach the runner at all. It doubles as the
  // "before" tree the no-op check compares against.
  bb.setSnapshot(snapshot(TREE_BEFORE));
  return bb;
}

/** Runs one tool against a runner whose post-gesture screen read is `after`. */
async function runGesture(
  tool: string,
  args: Record<string, unknown>,
  after: MobileUiState | undefined,
) {
  const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
  const fetchUiState = jest.fn().mockResolvedValue(after);
  mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

  const bb = makeBlackboard();
  const res = await executeTool(tool, args, bb);
  return { res, bb, fetchUiState };
}

beforeEach(() => jest.clearAllMocks());

describe('scroll that changes nothing', () => {
  it('warns the agent that the gesture did nothing when the screen is unchanged', async () => {
    const { res } = await runGesture('scroll', { direction: 'down' }, snapshot(TREE_BEFORE));

    expect(res.ok).toBe(true);
    expect(res.content).toContain('did not change');
    expect(res.content).toContain('did nothing');
  });

  it('names the opposite direction, because an inverted guess is the likely cause', async () => {
    const { res } = await runGesture('scroll', { direction: 'down' }, snapshot(TREE_BEFORE));

    // The whole point of the TC-33 failure: the agent wanted content further
    // down the page and needed "up". Telling it only "that did nothing" would
    // leave it guessing at the fix.
    expect(res.content).toContain('"up"');
  });

  it('inverts the other way too, so the advice is never hardcoded to one direction', async () => {
    const { res } = await runGesture('scroll', { direction: 'up' }, snapshot(TREE_BEFORE));

    expect(res.content).toContain('"down"');
  });

  it('stays silent when the screen actually moved', async () => {
    const { res } = await runGesture('scroll', { direction: 'up' }, snapshot(TREE_AFTER));

    expect(res.ok).toBe(true);
    expect(res.content).toContain('Scrolled up');
    expect(res.content).not.toContain('did nothing');
  });

  it('applies to swipe as well — it is the same blind gesture', async () => {
    const { res } = await runGesture('swipe', { direction: 'down' }, snapshot(TREE_BEFORE));

    expect(res.content).toContain('did nothing');
  });
});

describe('the no-op check never makes things worse', () => {
  it('reports plain success when the screen cannot be re-read', async () => {
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    const fetchUiState = jest.fn().mockRejectedValue(new Error('session gone'));
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const res = await executeTool('scroll', { direction: 'down' }, makeBlackboard());

    // A broken advisory must never turn a successful action into a failure.
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Scrolled down');
    expect(res.content).not.toContain('did nothing');
  });

  it('reports plain success when the re-read comes back without a tree', async () => {
    const { res } = await runGesture('scroll', { direction: 'down' }, undefined);

    expect(res.ok).toBe(true);
    expect(res.content).not.toContain('did nothing');
  });

  it('caches the fresh screen so the agent does not spend a round re-observing', async () => {
    // A mutating dispatch invalidates the cached snapshot, so the agent's next
    // observe would otherwise pay for a second ui-state read. Storing the one
    // we just took is what makes this check effectively free in round terms.
    const { bb } = await runGesture('scroll', { direction: 'up' }, snapshot(TREE_AFTER));

    expect(bb.getSnapshot()?.formattedTree).toBe(TREE_AFTER);
  });
});
