/**
 * Unit tests for the in-page lint highlight service. We can't run a real browser
 * here, so we mock the Playwright Page and assert:
 *   - the injected script targets the element by data-agent-ref,
 *   - the script is paint-only (pointer-events:none, no input-blocking listeners),
 *   - showLintHighlight reports `drawn` from the page's evaluate return,
 *   - clear/teardown evaluate runs and is idempotent.
 */

import {
  showLintHighlight,
  clearLintHighlight,
} from '../preview-lint-highlight.service';

type EvalCall = { script: string };

function makePage(evalReturn: boolean = true) {
  const evalCalls: EvalCall[] = [];
  const listeners: Record<string, Function[]> = {};
  const page: any = {
    _closed: false,
    isClosed: () => page._closed,
    evaluate: async (scriptOrFn: any) => {
      evalCalls.push({ script: String(scriptOrFn) });
      return evalReturn;
    },
    on: (ev: string, fn: Function) => { (listeners[ev] ||= []).push(fn); },
    once: (ev: string, fn: Function) => { (listeners[ev] ||= []).push(fn); },
    off: () => undefined,
    mainFrame: () => ({}),
  };
  return { page, evalCalls };
}

describe('preview-lint-highlight.service', () => {
  afterEach(async () => {
    // Ensure no session leaks between tests.
    await clearLintHighlight('t-sess');
  });

  it('injects a script that targets the element by data-agent-ref', async () => {
    const { page, evalCalls } = makePage(true);
    await showLintHighlight('t-sess', page, 'e100', 'success');

    expect(evalCalls.length).toBeGreaterThan(0);
    const script = evalCalls[evalCalls.length - 1].script;
    expect(script).toContain('data-agent-ref');
    expect(script).toContain('e100'); // the ref is baked into the script
    expect(script).toContain('querySelector');
  });

  it('is paint-only: pointer-events:none and no preventDefault / click blocking', async () => {
    const { page, evalCalls } = makePage(true);
    await showLintHighlight('t-sess', page, 'e1', 'success');
    const script = evalCalls[0].script;
    expect(script).toContain('pointer-events:none');
    expect(script).not.toContain('preventDefault');
    expect(script).not.toContain('stopPropagation');
    // Only scroll/resize listeners, all passive — never a click/mousedown handler.
    expect(script).toContain('passive: true');
    expect(script).not.toContain("addEventListener('click'");
    expect(script).not.toContain("addEventListener('mousedown'");
  });

  it('reports drawn=true when the page reports the element was found', async () => {
    const { page } = makePage(true);
    const res = await showLintHighlight('t-sess', page, 'e1', 'success');
    expect(res.drawn).toBe(true);
  });

  it('reports drawn=false when the element is not in the (main) frame', async () => {
    const { page } = makePage(false); // simulates cross-origin iframe / not found
    const res = await showLintHighlight('t-sess', page, 'e-in-iframe', 'success');
    expect(res.drawn).toBe(false);
  });

  it('returns drawn=false and does not throw when the page is closed', async () => {
    const { page } = makePage(true);
    page._closed = true;
    const res = await showLintHighlight('t-sess', page, 'e1', 'success');
    expect(res.drawn).toBe(false);
  });

  it('bakes the colour type into the script (warning vs success)', async () => {
    const { page, evalCalls } = makePage(true);
    await showLintHighlight('t-sess', page, 'e1', 'warning');
    expect(evalCalls[0].script).toContain('warning');
  });

  it('clearLintHighlight is idempotent (no throw on a never-shown session)', async () => {
    await expect(clearLintHighlight('never-shown')).resolves.toBeUndefined();
  });
});
