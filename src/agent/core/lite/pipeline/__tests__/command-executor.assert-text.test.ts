/**
 * Unit tests for the `assert_text` command handler (deterministic-assertion
 * authoring, editor-scoped). The handler is GROUNDED + read-only: it succeeds
 * only when the element's LIVE text contains the expected value, and returns the
 * resolved element so the extractor can freeze a compiled locator plan. These
 * tests exercise the grounding contract without a real browser.
 */

import { CommandExecutor } from '../command-executor';
import type { LiteSnapshot } from '../../lite-types';

function makeSnapshot(): LiteSnapshot {
  return {
    url: 'https://x.test/shop',
    title: 'Shop',
    timestamp: 0,
    elements: [
      { ref: 'e10', tag: 'h2', role: 'heading', name: '1 result', testIdAttr: 'result-count' } as any,
    ],
  } as LiteSnapshot;
}

/** Build a CommandExecutor whose page reports `liveText` for any locator. */
function makeExecutor(liveText: string, snapshot: LiteSnapshot = makeSnapshot()) {
  const page = {
    locator: () => ({ first: () => ({ textContent: async () => liveText }) }),
  } as any;
  const blackboard = { getCurrentPageSnapshot: () => snapshot } as any;
  const config = { enableHybridSafety: false } as any;
  return new CommandExecutor(page, {} as any, config, blackboard, {});
}

describe('assert_text command — grounded deterministic assertion', () => {
  it('passes when the element live text contains the expected value, and returns the resolved element', async () => {
    const exec = makeExecutor('1 result');
    const res = await exec.execute('assert_text', { ref: 'e10', expected: '1 result' });
    expect(res.success).toBe(true);
    expect(res.resolvedElement).toBeDefined(); // → freezes the compiled plan for replay
    expect((res.resolvedElement as any).testIdAttr).toBe('result-count');
  });

  it('tolerates SURROUNDING whitespace in the DOM text (substring search, matching replay)', async () => {
    const exec = makeExecutor('\n  1 result \n');
    const res = await exec.execute('assert_text', { ref: 'e10', expected: '1 result' });
    expect(res.success).toBe(true);
  });

  it('does NOT collapse INTERNAL whitespace — grounding must mirror replay, not be more lenient', async () => {
    // Replay does rawTextContent.toLowerCase().includes(expected) with no
    // whitespace collapse; grounding must reject here too, else the authored
    // assert would false-RED on a clean replay.
    const exec = makeExecutor('1  result'); // two spaces, expected has one
    const res = await exec.execute('assert_text', { ref: 'e10', expected: '1 result' });
    expect(res.success).toBe(false);
  });

  it('FAILS (grounding) when the live text does not contain the expected value, and reports the real text', async () => {
    const exec = makeExecutor('2 results');
    const res = await exec.execute('assert_text', { ref: 'e10', expected: '1 result' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('2 results'); // agent sees reality and can correct
    expect(res.resolvedElement).toBeUndefined();
  });

  it('rejects an empty expected value (never authors a useless/throwing assert)', async () => {
    const exec = makeExecutor('1 result');
    const res = await exec.execute('assert_text', { ref: 'e10', expected: '   ' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/non-empty/i);
  });

  it('fails cleanly when the ref does not exist on the page', async () => {
    const exec = makeExecutor('1 result');
    const res = await exec.execute('assert_text', { ref: 'e99', expected: '1 result' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('e99');
  });
});
