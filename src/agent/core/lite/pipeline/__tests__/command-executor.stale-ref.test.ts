/**
 * Unit tests for the stale-ref guidance in `checkRefExists`. A ref that fits the
 * snapshot `eNN` shape but is absent from the current snapshot is almost always
 * STALE (the DOM re-rendered since the last observe_page), which is the single
 * most common exploration flow failure. The returned error must be an actionable
 * "call observe_page and re-pick" directive so the agent recovers within its
 * round budget instead of re-guessing another stale ref until timeout.
 *
 * Exercised through the public `click_element` command, which runs
 * `checkRefExists` before touching the page — so no real browser is needed.
 */

import { CommandExecutor } from '../command-executor';
import type { LiteSnapshot } from '../../lite-types';

function makeSnapshot(): LiteSnapshot {
  return {
    url: 'https://x.test/app',
    title: 'App',
    timestamp: 0,
    elements: [
      { ref: 'e10', tag: 'button', role: 'button', name: 'Save' } as any,
      { ref: 'e11', tag: 'a', role: 'link', name: 'Cancel' } as any,
    ],
  } as LiteSnapshot;
}

function makeExecutor(snapshot: LiteSnapshot = makeSnapshot()) {
  // Page is never touched — the ref check fails before any interaction.
  const page = { url: () => snapshot.url } as any;
  const blackboard = { getCurrentPageSnapshot: () => snapshot, getCurrentUrl: () => snapshot.url } as any;
  const config = { enableHybridSafety: false } as any;
  return new CommandExecutor(page, {} as any, config, blackboard, {});
}

describe('checkRefExists — stale-ref recovery guidance', () => {
  it('tells the agent to observe_page and re-pick when an eNN ref is stale', async () => {
    const exec = makeExecutor();
    const res = await exec.execute('click_element', { ref: 'e47' }); // eNN shape, absent
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/stale ref/i);
    expect(res.error).toMatch(/observe_page/i);
    // Must warn off reusing the same dead ref.
    expect(res.error).toContain('e47');
    expect(res.error).toMatch(/do not reuse/i);
    // Still surfaces the live refs so the model can re-pick immediately.
    expect(res.error).toContain('e10');
  });

  it('does NOT claim "stale ref" for a malformed / hallucinated ref shape', async () => {
    const exec = makeExecutor();
    const res = await exec.execute('click_element', { ref: 'submit-button' }); // not eNN
    expect(res.success).toBe(false);
    expect(res.error).not.toMatch(/stale ref/i);
    expect(res.error).toMatch(/not found/i);
  });

  it('passes the check for a ref that IS in the current snapshot (no false stale)', async () => {
    const exec = makeExecutor();
    // e10 exists; click proceeds past checkRefExists. With no real page the action
    // itself won't "succeed", but the error must NOT be the ref-existence error.
    const res = await exec.execute('click_element', { ref: 'e10' });
    if (!res.success) {
      expect(res.error || '').not.toMatch(/stale ref|not found on page/i);
    }
  });
});
