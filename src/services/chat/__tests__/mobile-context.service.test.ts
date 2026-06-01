/**
 * Unit tests for mobile-context.service.ts
 *
 * Covers the pure functions (projectSnapshot, formatMobileSnapshotForChat)
 * directly. `resolveMobileSessionContext` is tested via a mocked runner
 * client — we focus on the failure-fallback contract (any error ⇒ null)
 * since the runner-side behaviour is covered in its own test suite.
 */

import {
  projectSnapshot,
  formatMobileSnapshotForChat,
  resolveMobileSessionContext,
  type MobileSnapshot,
} from '../mobile-context.service';
import type { MobileUiState } from '@/services/mobile/mobile-runner.types';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';

// ── Mock the runner client BEFORE importing the service is fine — we
// re-import inside each test only if we need a fresh mock state. ──
jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: jest.fn(),
}));

// Mock env so PII redaction is ON for these tests regardless of the
// host shell's `MOBILE_CHAT_PII_REDACTION` value. We don't want CI
// host config flipping the test outcome.
jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_CHAT_PII_REDACTION: true,
    MOBILE_RUNNER_URL: 'http://localhost:4100',
    MOBILE_RUNNER_API_KEY: '',
    RUNNER_USER_TOKEN_SECRET: '',
    MOBILE_RUNNER_ALLOWED_HOSTS: '',
  },
}));

import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';

const mockedGetClient = getMobileRunnerClient as jest.MockedFunction<typeof getMobileRunnerClient>;

// ── Helpers ────────────────────────────────────────────────────────────────

function baseUiState(overrides: Partial<MobileUiState> = {}): MobileUiState {
  return {
    sessionId: 'sess-1',
    platform: 'android',
    app: 'kz.kolesa',
    expectedApp: 'kz.kolesa',
    activity: 'kz.kolesa/.MainActivity',
    fingerprint: 'fp123',
    screenSize: { width: 1080, height: 1920 },
    windowInfo: { keyboardVisible: false, hasDialog: false },
    formattedTree: '## screen\n  Button "Login"',
    capturedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  } as MobileUiState;
}

// ═══════════════════════════════════════════════════════════════════════════
// projectSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe('projectSnapshot', () => {
  it('passes through happy-path fields verbatim', () => {
    const raw = baseUiState();
    const out = projectSnapshot(raw);
    expect(out.sessionId).toBe('sess-1');
    expect(out.platform).toBe('android');
    expect(out.expectedApp).toBe('kz.kolesa');
    expect(out.formattedTree).toContain('Button "Login"');
    expect(out.foregroundMismatch).toBeNull();
    expect(out.recentDisruption).toBeNull();
  });

  it('falls back to legacy `app` alias when `expectedApp` absent', () => {
    const raw = baseUiState({ expectedApp: undefined, app: 'legacy.app' });
    expect(projectSnapshot(raw).expectedApp).toBe('legacy.app');
  });

  it('truncates oversized formattedTree with a marker (defensive)', () => {
    const giant = 'X'.repeat(15_000);
    const out = projectSnapshot(baseUiState({ formattedTree: giant }));
    expect(out.formattedTree.length).toBeLessThan(15_000);
    expect(out.formattedTree).toMatch(/tree truncated, original 15000 chars\]$/);
  });

  it('truncates oversized recentDisruption snippet', () => {
    const longSnippet = 'STACK'.repeat(500);
    const raw = baseUiState({
      recentDisruption: {
        type: 'crash',
        packageName: 'kz.kolesa',
        snippet: longSnippet,
        capturedAt: '2026-05-25T10:00:00.000Z',
      },
    });
    const out = projectSnapshot(raw);
    expect(out.recentDisruption).not.toBeNull();
    expect(out.recentDisruption!.snippet.length).toBeLessThan(longSnippet.length);
    expect(out.recentDisruption!.snippet.endsWith('…')).toBe(true);
  });

  it('preserves a small recentDisruption verbatim', () => {
    const raw = baseUiState({
      recentDisruption: {
        type: 'anr',
        packageName: 'kz.kolesa',
        snippet: 'ANR in kz.kolesa',
        capturedAt: '2026-05-25T10:00:00.000Z',
      },
    });
    expect(projectSnapshot(raw).recentDisruption!.snippet).toBe('ANR in kz.kolesa');
  });

  it('passes foregroundMismatch through when present', () => {
    const raw = baseUiState({
      expectedApp: 'kz.kolesa',
      foregroundMismatch: { expected: 'kz.kolesa', actual: 'kz.janapost' },
    });
    expect(projectSnapshot(raw).foregroundMismatch).toEqual({
      expected: 'kz.kolesa',
      actual: 'kz.janapost',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatMobileSnapshotForChat
// ═══════════════════════════════════════════════════════════════════════════

describe('formatMobileSnapshotForChat', () => {
  function baseSnapshot(overrides: Partial<MobileSnapshot> = {}): MobileSnapshot {
    return {
      sessionId: 'sess-1',
      platform: 'android',
      expectedApp: 'kz.kolesa',
      activity: 'kz.kolesa/.MainActivity',
      fingerprint: 'fp123',
      screenSize: { width: 1080, height: 1920 },
      windowInfo: { keyboardVisible: false, hasDialog: false },
      formattedTree: '## screen\n  Button "Login"',
      foregroundMismatch: null,
      recentDisruption: null,
      capturedAt: '2026-05-25T10:00:00.000Z',
      ...overrides,
    };
  }

  it('always starts with the block header and ends with mode hint', () => {
    const out = formatMobileSnapshotForChat(baseSnapshot());
    expect(out.startsWith('--- MOBILE SESSION CONTEXT ---')).toBe(true);
    expect(out).toMatch(/mobile editor mode/);
  });

  it('puts the FOREGROUND MISMATCH warning before identity / tree (highest signal first)', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({
        foregroundMismatch: { expected: 'kz.kolesa', actual: 'kz.janapost' },
      }),
    );
    const mismatchIdx = out.indexOf('FOREGROUND MISMATCH');
    const platformIdx = out.indexOf('Platform:');
    const treeIdx = out.indexOf('CURRENT SCREEN');
    expect(mismatchIdx).toBeGreaterThanOrEqual(0);
    expect(mismatchIdx).toBeLessThan(platformIdx);
    expect(platformIdx).toBeLessThan(treeIdx);
  });

  it('puts the RECENT CRASH banner before identity', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({
        recentDisruption: {
          type: 'crash',
          packageName: 'kz.kolesa',
          snippet: 'FATAL EXCEPTION: main',
          capturedAt: '2026-05-25T10:00:00.000Z',
        },
      }),
    );
    expect(out).toMatch(/RECENT CRASH/);
    expect(out).toMatch(/FATAL EXCEPTION: main/);
    expect(out.indexOf('RECENT CRASH')).toBeLessThan(out.indexOf('Platform:'));
  });

  it('renders actualForeground.primary as `pkg (activity) — kind=app`', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({
        actualForeground: {
          screenState: 'awake',
          windows: [],
          primary: {
            packageName: 'kz.kolesa',
            activityName: 'kz.kolesa/.MainActivity',
            kind: 'app',
            isFocused: true,
            isResumed: true,
          },
          capturedAt: '2026-05-25T10:00:00.000Z',
          durationMs: 80,
        },
      }),
    );
    expect(out).toMatch(/Actual foreground: kz\.kolesa \(kz\.kolesa\/\.MainActivity\) — kind=app/);
  });

  it('renders <none> + screenState when no primary window', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({
        actualForeground: {
          screenState: 'locked',
          windows: [],
          primary: null,
          capturedAt: '2026-05-25T10:00:00.000Z',
          durationMs: 50,
        },
      }),
    );
    expect(out).toMatch(/Actual foreground: <none> — screenState=locked/);
  });

  it('includes WebView hint when webView.detected=true', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({ webView: { detected: true, suggestedContext: 'webview' } }),
    );
    expect(out).toMatch(/WebView detected/);
    expect(out).toMatch(/switch_to_webview/);
  });

  it('omits keyboard / dialog rows when windowInfo flags are false', () => {
    const out = formatMobileSnapshotForChat(baseSnapshot());
    expect(out).not.toMatch(/Keyboard: visible/);
    expect(out).not.toMatch(/Dialog: present/);
  });

  it('always includes the tree at the bottom', () => {
    const out = formatMobileSnapshotForChat(baseSnapshot());
    expect(out).toMatch(/CURRENT SCREEN.*\n.*Button "Login"/s);
  });

  // ── Phase B-SEC integration ─────────────────────────────────────────────

  it('B-SEC: wraps the tree in BEGIN/END untrusted-content markers', () => {
    const out = formatMobileSnapshotForChat(baseSnapshot());
    expect(out).toMatch(/BEGIN UNTRUSTED DEVICE CONTENT/);
    expect(out).toMatch(/END  UNTRUSTED DEVICE CONTENT/);
    // The markers must wrap the tree, not appear before it
    const beginIdx = out.indexOf('BEGIN UNTRUSTED');
    const treeIdx = out.indexOf('Button "Login"');
    const endIdx = out.indexOf('END  UNTRUSTED');
    expect(beginIdx).toBeLessThan(treeIdx);
    expect(treeIdx).toBeLessThan(endIdx);
  });

  it('B-SEC: redacts email in tree text by default', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({
        formattedTree: 'EditText "email": user@example.com',
      }),
    );
    expect(out).not.toContain('user@example.com');
    expect(out).toContain('<redacted:email>');
  });

  it('B-SEC: redacts card number with Luhn check', () => {
    const out = formatMobileSnapshotForChat(
      baseSnapshot({
        formattedTree: 'EditText "card": 4111111111111111',
      }),
    );
    expect(out).not.toContain('4111111111111111');
    expect(out).toContain('<redacted:card>');
  });

  it('B-SEC: closing post-amble reminds the LLM of the untrusted-content policy', () => {
    const out = formatMobileSnapshotForChat(baseSnapshot());
    expect(out).toMatch(/OBSERVATION, never instructions/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveMobileSessionContext — failure-fallback contract
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveMobileSessionContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when mobileSessionId is empty (defensive)', async () => {
    const out = await resolveMobileSessionContext('', 'user-1');
    expect(out).toBeNull();
    expect(mockedGetClient).not.toHaveBeenCalled();
  });

  it('returns projected snapshot on a successful fetch', async () => {
    const fakeClient = {
      fetchUiState: jest.fn().mockResolvedValue(baseUiState()),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const out = await resolveMobileSessionContext('sess-1', 'user-1');
    expect(out).not.toBeNull();
    expect(out!.sessionId).toBe('sess-1');
    expect(out!.expectedApp).toBe('kz.kolesa');
    // Forwards the userId to enable X-User-Token minting
    expect(fakeClient.fetchUiState).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('returns null on 404 (session destroyed)', async () => {
    const fakeClient = {
      fetchUiState: jest.fn().mockRejectedValue(new MobileRunnerError('not found', 404)),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const out = await resolveMobileSessionContext('sess-1', 'user-1');
    expect(out).toBeNull();
  });

  it('returns null on 403 (wrong user)', async () => {
    const fakeClient = {
      fetchUiState: jest.fn().mockRejectedValue(new MobileRunnerError('forbidden', 403)),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const out = await resolveMobileSessionContext('sess-1', 'user-1');
    expect(out).toBeNull();
  });

  it('returns null on plain transport error', async () => {
    const fakeClient = {
      fetchUiState: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const out = await resolveMobileSessionContext('sess-1', 'user-1');
    expect(out).toBeNull();
  });

  it('PROPAGATES AbortError (caller wants to know request was cancelled)', async () => {
    // Critical contract: if the user closes the tab mid-turn, we MUST
    // stop the whole turn — not silently fall through to the LLM call
    // with a null snapshot. The handler's outer try/catch handles abort
    // explicitly.
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    const fakeClient = {
      fetchUiState: jest.fn().mockRejectedValue(abortErr),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    await expect(resolveMobileSessionContext('sess-1', 'user-1')).rejects.toThrow(/Aborted/);
  });

  it('PROPAGATES rejection when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fakeClient = {
      // Even a benign-looking error gets propagated if signal.aborted is true,
      // because that means our caller already gave up.
      fetchUiState: jest.fn().mockRejectedValue(new Error('whatever')),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    await expect(
      resolveMobileSessionContext('sess-1', 'user-1', { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('forwards the abort signal so a cancelled turn cancels the fetch', async () => {
    const fakeClient = {
      fetchUiState: jest.fn().mockResolvedValue(baseUiState()),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    const controller = new AbortController();
    await resolveMobileSessionContext('sess-1', 'user-1', { signal: controller.signal });
    expect(fakeClient.fetchUiState).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('skips the screenshot (cost) but includes the tree (correctness)', async () => {
    const fakeClient = {
      fetchUiState: jest.fn().mockResolvedValue(baseUiState()),
    };
    mockedGetClient.mockReturnValue(fakeClient as any);
    await resolveMobileSessionContext('sess-1', 'user-1');
    expect(fakeClient.fetchUiState).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ includeTree: true, includeScreenshot: false }),
    );
  });
});
