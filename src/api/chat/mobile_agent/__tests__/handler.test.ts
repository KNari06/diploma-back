/**
 * Unit tests for handleMobileAgent — Phase B2-B4 contract.
 *
 * Focus: the eager-inject wiring between handler and pipeline. We mock
 * `runMobileAgentPipeline` and `resolveMobileSessionContext` so we can
 * assert exactly what gets forwarded into the pipeline without actually
 * calling the LLM or the runner.
 *
 * Failure paths (no mobileSessionId, pipeline throws) get a smoke test
 * each to confirm the existing reply paths still fire.
 */

import { Response } from 'express';

// ── Mocks (must precede imports of the handler under test) ────────────────

jest.mock('@/services/chat/mobile-context.service', () => ({
  resolveMobileSessionContext: jest.fn(),
}));

jest.mock('@/services/chat/mobile-project-context.service', () => ({
  resolveMobileProjectContext: jest.fn().mockResolvedValue(null),
}));

jest.mock('../pipeline', () => ({
  runMobileAgentPipeline: jest.fn(),
}));

jest.mock('../shared', () => ({
  parseMobileContext: jest.fn((ctx: unknown) => ctx ?? null),
  saveMobileChatTurn: jest.fn().mockResolvedValue(undefined),
  NO_SESSION_REPLY: 'no-session-mock',
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// HIGH-1 fix: handler now calls assertMobileSessionOwnership against
// Redis. Default-allow in these mocks so the existing happy-path tests
// keep asserting their original contract. The dedicated authz suite
// at the bottom overrides this on a per-test basis.
jest.mock('@/services/mobile/mobile-session-authz', () => {
  class MobileSessionAuthzError extends Error {
    constructor(public readonly reason: string, message: string) {
      super(message);
      this.name = 'MobileSessionAuthzError';
    }
  }
  return {
    assertMobileSessionOwnership: jest.fn().mockResolvedValue(undefined),
    MobileSessionAuthzError,
  };
});

jest.mock('@/utils/core/mobile-chat-metrics', () => ({
  incCounter: jest.fn(),
  observeMs: jest.fn(),
}));

jest.mock('../progress', () => ({
  emitMobileAgentThinking: jest.fn(),
  emitMobileToolStep: jest.fn(),
}));

jest.mock('../reasoning-trace', () => ({
  isReasoningPersistEnabled: jest.fn(() => false),
}));

// AI-usage tracking — boundary-mocked so the suite doesn't pull the real
// Supabase-backed tracker (which throws on missing env at import time).
jest.mock('@/services/ai/tracking/ai-usage-tracker', () => ({
  AIUsageTracker: {
    beginSession: jest.fn(),
    recordPipelineMetrics: jest.fn(),
    endSession: jest.fn(async () => null),
  },
}));
jest.mock('@/services/ai/tracking/ai-context', () => ({
  withAIContext: jest.fn((_ctx: any, fn: () => any) => fn()),
}));

// Env flag — re-mock per test where needed.
const mockEnv = {
  MOBILE_CHAT_EAGER_SNAPSHOT: true,
};
jest.mock('@/config/environment/env', () => ({
  env: mockEnv,
}));

import { handleMobileAgent } from '../handler';
import { resolveMobileSessionContext } from '@/services/chat/mobile-context.service';
import { runMobileAgentPipeline } from '../pipeline';
import { emitMobileAgentThinking } from '../progress';

const mockedResolve = resolveMobileSessionContext as jest.MockedFunction<typeof resolveMobileSessionContext>;
const mockedPipeline = runMobileAgentPipeline as jest.MockedFunction<typeof runMobileAgentPipeline>;
const mockedEmit = emitMobileAgentThinking as jest.MockedFunction<typeof emitMobileAgentThinking>;

// ── Helpers ────────────────────────────────────────────────────────────────

function mockRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: null as unknown,
    headersSent: false,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; res.headersSent = true; return res; },
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

const baseSnapshot = {
  sessionId: 'sess-1',
  platform: 'android' as const,
  expectedApp: 'kz.kolesa',
  fingerprint: 'fp',
  screenSize: { width: 1080, height: 1920 },
  formattedTree: '## screen',
  foregroundMismatch: null,
  recentDisruption: null,
  capturedAt: '2026-05-25T10:00:00.000Z',
};

function happyPipelineResult() {
  return Promise.resolve({
    reply: 'Mocked reply',
    toolCallsMade: 0,
    observed: true,
    durationMs: 100,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnv.MOBILE_CHAT_EAGER_SNAPSHOT = true;
});

// ═══════════════════════════════════════════════════════════════════════════
// Eager snapshot — happy path
// ═══════════════════════════════════════════════════════════════════════════

describe('handleMobileAgent — eager snapshot', () => {
  it('fetches snapshot and forwards it to the pipeline when env flag is on', async () => {
    mockedResolve.mockResolvedValue(baseSnapshot);
    mockedPipeline.mockReturnValue(happyPipelineResult());

    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'hi what do you see',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    expect(mockedResolve).toHaveBeenCalledWith('sess-1', 'u1', expect.objectContaining({
      signal: undefined, // No abort in this test
    }));
    expect(mockedPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ snapshot: baseSnapshot }),
    );
    expect(res._status).toBe(200);
    expect((res._body as any).reply).toBe('Mocked reply');
  });

  it('emits "Observing the screen…" BEFORE the runner fetch (UX: no silent gap)', async () => {
    // We can't easily assert ordering across module boundaries without
    // jest.spyOn + a fake timer, so we assert: emit IS called, AND if
    // resolve is called too, emit's call happened before resolve's
    // (mock.invocationCallOrder lets us check this).
    mockedResolve.mockResolvedValue(baseSnapshot);
    mockedPipeline.mockReturnValue(happyPipelineResult());

    await handleMobileAgent({} as any, mockRes() as any, {
      message: 'go',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    const emitOrder = mockedEmit.mock.invocationCallOrder[0];
    const resolveOrder = mockedResolve.mock.invocationCallOrder[0];
    expect(emitOrder).toBeLessThan(resolveOrder);
    // And the emit message is the observing-screen one.
    expect(mockedEmit).toHaveBeenCalledWith(
      'chat-1',
      'Observing the screen…',
      expect.any(Number),
      expect.objectContaining({ kind: 'observing_screen' }),
    );
  });

  it('falls back to PULL (no snapshot) when resolve returns null', async () => {
    // resolveMobileSessionContext returns null for 404/403/503/timeout — see
    // its tests. The handler must NOT abort the turn; it just hands an empty
    // snapshot to the pipeline.
    mockedResolve.mockResolvedValue(null);
    mockedPipeline.mockReturnValue(happyPipelineResult());

    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'go',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    expect(mockedPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ snapshot: null }),
    );
    expect(res._status).toBe(200);
  });

  it('SKIPS the eager fetch when env flag is false (kill switch)', async () => {
    mockEnv.MOBILE_CHAT_EAGER_SNAPSHOT = false;
    mockedPipeline.mockReturnValue(happyPipelineResult());

    await handleMobileAgent({} as any, mockRes() as any, {
      message: 'go',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    expect(mockedResolve).not.toHaveBeenCalled();
    // Pipeline still runs, just without snapshot. `snapshot` is `null`
    // because the let-init is `null`; verify so legacy callers don't
    // get `undefined` (which is a different code path inside pipeline).
    expect(mockedPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ snapshot: null }),
    );
  });

  it('propagates AbortError from resolve through to the pipeline catch (request was cancelled)', async () => {
    // resolveMobileSessionContext throws on abort by design. Handler's
    // outer try/catch turns this into a fallback reply — we assert the
    // pipeline was NOT called and a JSON response was produced.
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    mockedResolve.mockRejectedValue(abortErr);

    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'go',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    expect(mockedPipeline).not.toHaveBeenCalled();
    // Handler catches the abort and replies with the fallback message.
    expect(res._status).toBe(200);
    expect((res._body as any).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Existing contracts (regression guard)
// ═══════════════════════════════════════════════════════════════════════════

describe('handleMobileAgent — existing contracts unchanged', () => {
  it('returns NO_SESSION_REPLY when mobileSessionId missing', async () => {
    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'hi',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileEditorMode: true }, // no mobileSessionId
    });

    expect(mockedPipeline).not.toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
    expect((res._body as any).reply).toBe('no-session-mock');
    expect((res._body as any).success).toBe(false);
  });

  it('catches pipeline failures and sends fallback reply', async () => {
    mockedResolve.mockResolvedValue(baseSnapshot);
    mockedPipeline.mockReturnValue(Promise.reject(new Error('boom')));

    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'go',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    expect(res._status).toBe(200);
    expect((res._body as any).success).toBe(false);
    expect((res._body as any).reply).toMatch(/Something went wrong/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-1: ownership guard — foreign mobileSessionId must NOT reach runner
// ═══════════════════════════════════════════════════════════════════════════

describe('handleMobileAgent — mobileSessionId ownership guard', () => {
  // Pull the mocked symbol fresh per describe so we can override the
  // default-allow behaviour set at module scope.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const authz = require('@/services/mobile/mobile-session-authz') as {
    assertMobileSessionOwnership: jest.Mock;
    MobileSessionAuthzError: new (reason: string, message: string) => Error;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  it('returns 403 + does NOT touch the runner when sessionId is not owned', async () => {
    authz.assertMobileSessionOwnership.mockRejectedValueOnce(
      new authz.MobileSessionAuthzError(
        'no_warmup',
        'No warmup binding found for user u1 → session foreign-sess',
      ),
    );

    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'tap login',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'foreign-sess', mobileEditorMode: true },
    });

    // 403 — authenticated but not authorised for THIS resource.
    expect(res._status).toBe(403);
    expect((res._body as any).success).toBe(false);

    // Critical: eager fetch and pipeline must NOT have run. A buggy
    // implementation could 403 the response but still leak a runner
    // observation against the foreign session — assert both stayed
    // untouched.
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedPipeline).not.toHaveBeenCalled();
  });

  it('proceeds normally when ownership check passes (regression guard)', async () => {
    authz.assertMobileSessionOwnership.mockResolvedValueOnce(undefined);
    mockedResolve.mockResolvedValue(baseSnapshot);
    mockedPipeline.mockReturnValue(happyPipelineResult());

    const res = mockRes();
    await handleMobileAgent({} as any, res as any, {
      message: 'hi',
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 'chat-1',
      context: { mobileSessionId: 'sess-1', mobileEditorMode: true },
    });

    expect(res._status).toBe(200);
    expect((res._body as any).success).toBe(true);
    expect(mockedPipeline).toHaveBeenCalled();
  });
});
