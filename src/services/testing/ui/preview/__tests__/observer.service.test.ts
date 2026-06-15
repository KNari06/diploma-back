/**
 * Tests for the background Observer (Stage 2). Page context + Gemini + AI
 * context are mocked so the suite runs offline and deterministically. Focus on
 * the off-hot-path guarantees: flag gating, debounce coalescing, rate-limit,
 * cache, and fail-open — plus correct verdict parsing.
 */

jest.mock('@/services/ai/core/gemini.service', () => ({
  generateTextWithGemini: jest.fn(),
}));
jest.mock('@/services/ai/tracking/ai-context', () => ({
  withAIContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
jest.mock('@/services/chat/editor-context.service', () => ({
  getPageContext: jest.fn(),
  formatPageContextForChat: (ctx: any) => `URL ${ctx.url}\n${ctx.domSummary}`,
}));
const mockEmitToRoom = jest.fn();
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitToRoom: (...args: unknown[]) => mockEmitToRoom(...args) },
}));

import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import { getPageContext } from '@/services/chat/editor-context.service';
import {
  observe,
  isObserverShadowEnabled,
  _resetObserverForTests,
} from '../observer.service';

const mockGemini = generateTextWithGemini as jest.MockedFunction<typeof generateTextWithGemini>;
const mockCtx = getPageContext as jest.MockedFunction<typeof getPageContext>;

function geminiOk(content: string) {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, model: 'gemini-2.5-flash-lite' },
  } as any;
}

const ctx = (over: Partial<any> = {}) => ({
  url: 'https://app.example.com/login',
  title: 'Login',
  domSummary: 'form with password + username',
  testSteps: [{ id: 's1', type: 'click', description: 'Sign in' }],
  ...over,
});

// observe() is fire-and-forget behind an 800ms debounce; flush real timers.
const flush = async () => {
  jest.advanceTimersByTime(900);
  // let the detached async chain settle
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
  _resetObserverForTests();
  mockGemini.mockReset();
  mockCtx.mockReset();
  mockEmitToRoom.mockReset();
  delete process.env.OBSERVER_LLM_SHADOW;
  delete process.env.OBSERVER_LLM_EMIT;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('flag gating', () => {
  it('is disabled by default — observe is a no-op, no context fetch, no LLM', async () => {
    expect(isObserverShadowEnabled()).toBe(false);
    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockCtx).not.toHaveBeenCalled();
    expect(mockGemini).not.toHaveBeenCalled();
  });
});

describe('with observer enabled', () => {
  beforeEach(() => {
    process.env.OBSERVER_LLM_SHADOW = 'true';
  });

  it('debounces a burst of events into a single LLM call', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"login_required","confidence":0.9,"message":"login gate"}'));

    observe('s1', 'step_added', 'u1');
    observe('s1', 'step_added', 'u1');
    observe('s1', 'apply_done', 'u1'); // 3 events in the debounce window
    await flush();

    expect(mockGemini).toHaveBeenCalledTimes(1); // coalesced
  });

  it('skips the LLM when the session has no page context', async () => {
    mockCtx.mockResolvedValue(null);
    observe('s1', 'navigation', 'u1');
    await flush();
    expect(mockGemini).not.toHaveBeenCalled();
  });

  it('pre-gate skips the LLM when there is nothing to observe (no steps, empty page, non-login URL)', async () => {
    mockCtx.mockResolvedValue({
      url: 'https://app.example.com/dashboard',
      title: '',
      domSummary: '',
      pageText: '',
      testSteps: [],
    } as any);
    observe('s1', 'navigation', 'u1');
    await flush();
    expect(mockGemini).not.toHaveBeenCalled();
  });

  it('pre-gate does NOT skip a bare /login URL even on a still-empty page', async () => {
    mockCtx.mockResolvedValue({
      url: 'https://app.example.com/login',
      title: '',
      domSummary: '',
      pageText: '',
      testSteps: [],
    } as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"login_required","confidence":0.9,"message":"login gate"}'));
    observe('s1', 'navigation', 'u1');
    await flush();
    expect(mockGemini).toHaveBeenCalledTimes(1); // LOGIN_URL_RE override
  });

  it('rate-limits: a second observation within the window makes no 2nd LLM call', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"none","confidence":0.9,"message":""}'));

    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockGemini).toHaveBeenCalledTimes(1);

    // Different page signature (avoid cache) but within rate-limit window.
    mockCtx.mockResolvedValue(ctx({ url: 'https://app.example.com/other', domSummary: 'x' }) as any);
    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockGemini).toHaveBeenCalledTimes(1); // rate-limited, not called again
  });

  it('fail-open: unparseable LLM output does not throw', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('garbage'));
    observe('s1', 'apply_done', 'u1');
    await expect(flush()).resolves.toBeUndefined();
  });

  it('fail-open: a rejected LLM call does not throw', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockRejectedValue(new Error('down'));
    observe('s1', 'apply_done', 'u1');
    await expect(flush()).resolves.toBeUndefined();
  });

  it('shadow-only (emit OFF): runs the LLM but never emits to the UI', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"login_required","confidence":0.95,"message":"login gate"}'));
    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockGemini).toHaveBeenCalledTimes(1);
    expect(mockEmitToRoom).not.toHaveBeenCalled(); // shadow does not surface
  });
});

describe('with emission enabled', () => {
  beforeEach(() => {
    process.env.OBSERVER_LLM_EMIT = 'true';
  });

  it('emits preview:observer:hint for an actionable verdict above the floor', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"login_required","confidence":0.95,"message":"login gate"}'));
    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockEmitToRoom).toHaveBeenCalledTimes(1);
    const [channel, sid, event, payload] = mockEmitToRoom.mock.calls[0];
    expect(channel).toBe('preview');
    expect(sid).toBe('s1');
    expect(event).toBe('preview:observer:hint');
    expect(payload).toEqual(expect.objectContaining({ kind: 'login_required', confidence: 0.95 }));
  });

  it('does NOT emit a none verdict', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"none","confidence":0.99,"message":""}'));
    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockEmitToRoom).not.toHaveBeenCalled();
  });

  it('does NOT emit below the confidence floor', async () => {
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"step_missing","confidence":0.5,"message":"open menu first"}'));
    observe('s1', 'apply_done', 'u1');
    await flush();
    expect(mockEmitToRoom).not.toHaveBeenCalled();
  });

  it('activates the pipeline even when only EMIT is set (shadow off)', async () => {
    // shadow flag absent; emit flag present → observer must still run.
    mockCtx.mockResolvedValue(ctx() as any);
    mockGemini.mockResolvedValue(geminiOk('{"kind":"blocked","confidence":0.9,"message":"captcha"}'));
    observe('s1', 'navigation', 'u1');
    await flush();
    expect(mockGemini).toHaveBeenCalledTimes(1);
    expect(mockEmitToRoom).toHaveBeenCalledTimes(1);
  });
});
