/**
 * Post-timeout re-observe in dispatchSingleCommand.
 *
 * An interactive command that fires a network flow (tap "Login" → sends OTP
 * and navigates) can blow the 8s fail-fast budget even though the action
 * LANDED. Without a re-observe the agent reports "could not tap Login" while
 * the OTP screen is already on-screen (false negative). These tests pin the
 * three branches:
 *   1. timeout (408) + screen fingerprint CHANGED → uncertain-success (ok:true)
 *   2. timeout (408) + screen fingerprint UNCHANGED → hard failure (ok:false)
 *   3. user abort (499) → hard failure, NO re-observe attempted
 *
 * We mock the session→client router (`getMobileRunnerClientForSession`, the
 * boundary dispatchSingleCommand uses) and drive it through the public
 * `executeTool('tap_element', …)` entrypoint. The blackboard is real so its
 * snapshot + recordToolCall logic participates.
 */

import { executeTool } from '../tools';
import { MobileBlackboard } from '../blackboard';
import { MobileRunnerError, type MobileUiState } from '@/services/mobile/mobile-runner.types';

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

function snapshot(fingerprint: string): MobileUiState {
  return {
    sessionId: 'sess-1',
    platform: 'android',
    app: 'com.example.app',
    activity: '.LoginActivity',
    fingerprint,
    screenSize: { width: 1080, height: 1920 },
    formattedTree: '<tree/>',
    capturedAt: '2026-07-10T10:00:00.000Z',
  };
}

function makeBlackboard(preFingerprint: string): MobileBlackboard {
  const bb = new MobileBlackboard({
    goal: 'log in',
    mobileSessionId: 'sess-1',
    userId: 'user-1',
  });
  // Seed the pre-command screen so dispatchSingleCommand can diff against it.
  bb.setSnapshot(snapshot(preFingerprint));
  return bb;
}

const timeout = () => new MobileRunnerError('Request timed out after 8000ms', 408, 'TIMEOUT');
const networkErr = () => new MobileRunnerError('Failed to reach mobile runner', 0, 'NETWORK_ERROR');
const aborted = () => new MobileRunnerError('Request aborted by caller', 499, 'ABORTED');

beforeEach(() => jest.clearAllMocks());

describe('dispatchSingleCommand — inconclusive-error re-observe', () => {
  it('treats a timeout as success when the screen changed afterward', async () => {
    const fetchUiState = jest.fn().mockResolvedValue(snapshot('AFTER-login-otp'));
    const executeBatchCommands = jest.fn().mockRejectedValue(timeout());
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE-login-form'),
    );

    expect(fetchUiState).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/screen changed|most likely succeeded/i);
  });

  it('treats a timeout as failure when the screen did NOT change', async () => {
    const fetchUiState = jest.fn().mockResolvedValue(snapshot('BEFORE-login-form'));
    const executeBatchCommands = jest.fn().mockRejectedValue(timeout());
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE-login-form'),
    );

    expect(fetchUiState).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/did not change|may not have registered/i);
  });

  it('treats a NETWORK_ERROR (statusCode 0) after the action as success when screen changed', async () => {
    const fetchUiState = jest.fn().mockResolvedValue(snapshot('AFTER-otp'));
    const executeBatchCommands = jest.fn().mockRejectedValue(networkErr());
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE-login-form'),
    );

    expect(fetchUiState).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/screen changed|most likely succeeded/i);
  });

  it('re-observes on an EMPTY results array (200, no throw) and rescues when screen changed', async () => {
    const fetchUiState = jest.fn().mockResolvedValue(snapshot('AFTER-empty-results'));
    // 200 OK but results is empty — no per-command result returned.
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [] });
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE-login-form'),
    );

    expect(fetchUiState).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/screen changed|most likely succeeded/i);
  });

  it('does NOT rescue a present-but-failed result (success:false is a real failure)', async () => {
    const fetchUiState = jest.fn().mockResolvedValue(snapshot('AFTER'));
    const executeBatchCommands = jest
      .fn()
      .mockResolvedValue({ results: [{ success: false, error: 'element not found' }] });
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE'),
    );

    expect(fetchUiState).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/element not found/i);
  });

  it('does NOT re-observe on a user abort (499)', async () => {
    const fetchUiState = jest.fn().mockResolvedValue(snapshot('AFTER'));
    const executeBatchCommands = jest.fn().mockRejectedValue(aborted());
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE'),
    );

    expect(fetchUiState).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/cancelled by the user/i);
  });

  it('falls through to failure when the re-observe itself errors', async () => {
    const fetchUiState = jest.fn().mockRejectedValue(new MobileRunnerError('gone', 404, 'NOT_FOUND'));
    const executeBatchCommands = jest.fn().mockRejectedValue(timeout());
    mockedGetClient.mockResolvedValue({ executeBatchCommands, fetchUiState } as any);

    const out = await executeTool(
      'tap_element',
      { targetDescription: 'Login button' },
      makeBlackboard('BEFORE'),
    );

    expect(fetchUiState).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
  });
});
