/**
 * Phase B5 — tests for the cheap observation tool executors:
 *   - get_foreground
 *   - get_step_history
 *   - get_recent_logs
 *   - take_screenshot (incl. per-turn budget)
 *
 * We mock `getMobileRunnerClient()` so the executor talks to a stub
 * instead of real HTTP. The blackboard is a real instance — we want
 * its recordToolCall + screenshot budget logic to participate in the
 * test (catches contract drift).
 */

import { executeTool } from '../tools';
import { MobileBlackboard } from '../blackboard';

jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: jest.fn(),
}));

// PII redactor + wrapper run on REAL implementations — we want to see
// their effect on the logs tool's output. Env defaults the flag ON.
// Also include the Supabase / OpenAI envs the module-init chain expects
// when `tools.ts` pulls in planner → openai service → tracker → supabase.
// Values are throwaway — none of these clients are ever exercised here
// because we mock the runner client at the boundary that matters.
jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_CHAT_PII_REDACTION: true,
    MOBILE_RUNNER_URL: 'http://localhost:4100',
    MOBILE_RUNNER_API_KEY: '',
    RUNNER_USER_TOKEN_SECRET: '',
    MOBILE_RUNNER_ALLOWED_HOSTS: '',
    SUPABASE_URL: 'http://supabase.invalid',
    SUPABASE_ANON_KEY: 'anon-key-test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key-test',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL_FAST: 'gpt-4.1-mini',
  },
}));

// The Supabase module DOES validate env at import time — but our mocked
// env above provides all three keys, so `createClient` would still
// instantiate a real client we don't actually want to call. Mock the
// module so the import resolves to a no-op surface.
jest.mock('@/db/supabase', () => ({
  supabase: {},
  supabaseAdmin: {},
}));

import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
const mockedGetClient = getMobileRunnerClient as jest.MockedFunction<typeof getMobileRunnerClient>;

function makeBlackboard(): MobileBlackboard {
  return new MobileBlackboard({
    goal: 'test',
    mobileSessionId: 'sess-1',
    userId: 'user-1',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// get_foreground
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTool get_foreground', () => {
  it('returns identity + state from the runner response', async () => {
    const fakeClient = {
      fetchForeground: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        expectedApp: 'kz.kolesa',
        foreground: {
          screenState: 'awake',
          windows: [],
          primary: {
            packageName: 'kz.kolesa',
            activityName: 'kz.kolesa/.Main',
            kind: 'app',
            isFocused: true,
            isResumed: true,
          },
          capturedAt: '2026-05-25T10:00:00.000Z',
          durationMs: 80,
        },
        mismatch: null,
        capturedAt: '2026-05-25T10:00:00.000Z',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);

    const out = await executeTool('get_foreground', {}, makeBlackboard());

    expect(out.ok).toBe(true);
    expect(out.content).toContain('expected: kz.kolesa');
    expect(out.content).toContain('primary: kz.kolesa');
    expect(out.content).toContain('kind=app');
    expect(out.content).toContain('screenState: awake');
  });

  it('puts the foreground-mismatch warning FIRST (highest signal)', async () => {
    const fakeClient = {
      fetchForeground: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        expectedApp: 'kz.kolesa',
        foreground: {
          screenState: 'awake',
          windows: [],
          primary: { packageName: 'kz.janapost', activityName: null, kind: 'app', isFocused: true, isResumed: true },
          capturedAt: 't',
          durationMs: 80,
        },
        mismatch: { expected: 'kz.kolesa', actual: 'kz.janapost' },
        capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);

    const out = await executeTool('get_foreground', {}, makeBlackboard());

    const warnIdx = out.content.indexOf('FOREGROUND MISMATCH');
    const stateIdx = out.content.indexOf('screenState');
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeLessThan(stateIdx);
  });

  it('surfaces runner errors as ok=false with a readable message', async () => {
    const fakeClient = {
      fetchForeground: jest.fn().mockRejectedValue(new Error('AbortError')),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);

    const out = await executeTool('get_foreground', {}, makeBlackboard());
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/get_foreground failed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// get_step_history
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTool get_step_history', () => {
  it('forwards limit (clamped) and includeRawInputs=false to the runner', async () => {
    const fakeClient = {
      fetchStepHistory: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        steps: [],
        redacted: true,
        capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);

    await executeTool('get_step_history', { limit: 999 }, makeBlackboard());
    expect(fakeClient.fetchStepHistory).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ limit: 50, includeRawInputs: false }),
    );
  });

  it('clamps limit to >=1', async () => {
    const fakeClient = {
      fetchStepHistory: jest.fn().mockResolvedValue({ sessionId: 'sess-1', steps: [], redacted: true, capturedAt: 't' }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    await executeTool('get_step_history', { limit: -5 }, makeBlackboard());
    expect(fakeClient.fetchStepHistory).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('returns "no steps recorded" sentinel when array is empty', async () => {
    const fakeClient = {
      fetchStepHistory: jest.fn().mockResolvedValue({ sessionId: 'sess-1', steps: [], redacted: true, capturedAt: 't' }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const out = await executeTool('get_step_history', {}, makeBlackboard());
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/No steps recorded/);
  });

  it('compactly serialises each step (one line each) with status', async () => {
    const fakeClient = {
      fetchStepHistory: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        steps: [
          {
            stepIndex: 0,
            commandType: 'tap',
            paramsSummary: { x: 100, y: 200 },
            success: true,
            durationMs: 80,
            startedAt: 1, completedAt: 81,
          },
          {
            stepIndex: 1,
            commandType: 'type_text',
            paramsSummary: { selector: '#pw', inputLength: 13, inputClass: 'mixed' },
            success: false,
            durationMs: 50,
            errorMessage: 'element not found',
            startedAt: 100, completedAt: 150,
          },
        ],
        redacted: true,
        capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);

    const out = await executeTool('get_step_history', {}, makeBlackboard());
    expect(out.content).toMatch(/\[0\] tap .* → OK \(80ms\)/);
    expect(out.content).toMatch(/\[1\] type_text .* → FAIL .* — element not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// get_recent_logs (PII redaction + untrusted-content wrap)
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTool get_recent_logs', () => {
  it('applies PII redaction to lines before injection (defence-in-depth)', async () => {
    const fakeClient = {
      fetchRecentLogs: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        level: 'error',
        lines: [
          'E/Auth: failed for user@example.com',
          'E/Net: token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aaaaaaaaaaaaaaaaa',
        ],
        truncated: false,
        capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);

    const out = await executeTool('get_recent_logs', { level: 'error' }, makeBlackboard());
    expect(out.content).not.toContain('user@example.com');
    expect(out.content).toContain('<redacted:email>');
    expect(out.content).toContain('<redacted:jwt>');
  });

  it('wraps the body in untrusted-content markers (prompt-injection defence)', async () => {
    const fakeClient = {
      fetchRecentLogs: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        level: 'warn',
        lines: ['W/Foo: hello'],
        truncated: false,
        capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const out = await executeTool('get_recent_logs', {}, makeBlackboard());
    expect(out.content).toMatch(/BEGIN UNTRUSTED DEVICE CONTENT/);
    expect(out.content).toMatch(/END  UNTRUSTED DEVICE CONTENT/);
  });

  it('clamps invalid level to "warn"', async () => {
    const fakeClient = {
      fetchRecentLogs: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        level: 'warn',
        lines: [],
        truncated: false,
        capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    await executeTool('get_recent_logs', { level: 'fatal' }, makeBlackboard());
    expect(fakeClient.fetchRecentLogs).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ level: 'warn' }),
    );
  });

  it('clamps limit to 1-500', async () => {
    const fakeClient = {
      fetchRecentLogs: jest.fn().mockResolvedValue({
        sessionId: 'sess-1', platform: 'android', level: 'warn', lines: [], truncated: false, capturedAt: 't',
      }),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    await executeTool('get_recent_logs', { limit: 9999 }, makeBlackboard());
    expect(fakeClient.fetchRecentLogs).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ limit: 500 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// take_screenshot (incl. per-turn budget)
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTool take_screenshot', () => {
  function mockUiStateOk() {
    return {
      fetchUiState: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        screenSize: { width: 1080, height: 1920 },
        screenshotBase64: 'BASE64DATA',
        capturedAt: 't',
      }),
    };
  }

  it('returns base64 screenshot on first call', async () => {
    mockedGetClient.mockReturnValue(mockUiStateOk() as any);
    const bb = makeBlackboard();
    const out = await executeTool('take_screenshot', {}, bb);
    expect(out.ok).toBe(true);
    expect((out.data as any).screenshotBase64).toBe('BASE64DATA');
    expect(out.content).toMatch(/1\/2 of this turn's screenshot budget/);
  });

  it('counts against budget on success', async () => {
    mockedGetClient.mockReturnValue(mockUiStateOk() as any);
    const bb = makeBlackboard();
    await executeTool('take_screenshot', {}, bb);
    expect(bb.screenshotsTakenThisTurn()).toBe(1);
  });

  it('rejects the third call within a turn (budget = 2)', async () => {
    mockedGetClient.mockReturnValue(mockUiStateOk() as any);
    const bb = makeBlackboard();
    await executeTool('take_screenshot', {}, bb);
    await executeTool('take_screenshot', {}, bb);

    const third = await executeTool('take_screenshot', {}, bb);
    expect(third.ok).toBe(false);
    expect(third.content).toMatch(/budget exceeded/i);
    // Critical: budget rejection MUST NOT increment the counter
    // (already maxed, no point) and MUST NOT call the runner.
    expect(bb.screenshotsTakenThisTurn()).toBe(2);
  });

  it('does NOT count a failed runner call against the budget', async () => {
    mockedGetClient.mockReturnValue({
      fetchUiState: jest.fn().mockRejectedValue(new Error('network down')),
    } as any);
    const bb = makeBlackboard();
    const out = await executeTool('take_screenshot', {}, bb);
    expect(out.ok).toBe(false);
    expect(bb.screenshotsTakenThisTurn()).toBe(0);
  });

  it('does NOT count when runner returns no screenshot (driver failure)', async () => {
    mockedGetClient.mockReturnValue({
      fetchUiState: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        platform: 'android',
        screenSize: { width: 1, height: 1 },
        capturedAt: 't',
        screenshotBase64: '',
      }),
    } as any);
    const bb = makeBlackboard();
    const out = await executeTool('take_screenshot', {}, bb);
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/no screenshot/);
    expect(bb.screenshotsTakenThisTurn()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sanity: dispatcher routes the new tool names correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTool dispatcher — B5 routes', () => {
  it.each(['get_foreground', 'get_step_history', 'get_recent_logs', 'take_screenshot'])(
    'recognises %s (no UNKNOWN-tool fallthrough)',
    async (toolName) => {
      // Hook any runner method, even if not used — just ensure no
      // unknown-tool path is hit.
      mockedGetClient.mockReturnValue({
        fetchForeground: jest.fn().mockResolvedValue({
          sessionId: 'sess-1', platform: 'android', foreground: {
            screenState: 'awake', windows: [], primary: null, capturedAt: 't', durationMs: 1,
          }, mismatch: null, capturedAt: 't',
        }),
        fetchStepHistory: jest.fn().mockResolvedValue({ sessionId: 'sess-1', steps: [], redacted: true, capturedAt: 't' }),
        fetchRecentLogs: jest.fn().mockResolvedValue({ sessionId: 'sess-1', platform: 'android', level: 'warn', lines: [], truncated: false, capturedAt: 't' }),
        fetchUiState: jest.fn().mockResolvedValue({ sessionId: 'sess-1', platform: 'android', screenSize: { width: 1, height: 1 }, capturedAt: 't', screenshotBase64: 'X' }),
      } as any);

      const out = await executeTool(toolName, {}, makeBlackboard());
      expect(out.content).not.toMatch(/Unknown tool/);
    },
  );
});
