/**
 * `runTestCaseOnSession` — "Use screenshot to find element" must survive the
 * editor's FULL RUN, not just Find and Apply.
 *
 * CLAUDE.md Hard invariant #7 requires the flag on BOTH hops of a mobile
 * resolution: the `lintElement` call (which resolves the element) AND the
 * dispatched command (`_useScreenshotOnly`). The second hop matters because a
 * vision resolve returns coordinates below the runner's TRUST_COORDS_THRESHOLD
 * (0.9), so the runner re-resolves before tapping — and an unflagged
 * re-resolve falls back to the TEXT pipeline, re-picking the element the
 * toggle exists to avoid.
 *
 * This run loop is a second, inline copy of the lint-then-tap logic in
 * `MobileStepApplyService` (covered by
 * `services/mobile/__tests__/mobile-step-apply.use-screenshot-only.test.ts`).
 * It forwarded the flag to the lint call but not onto the command, so Find
 * highlighted the right element and a full Run tapped a different one.
 *
 * Live evidence (JanaPost TC-13, unlabeled settings gear at [1230,194][1384,348]):
 * Find resolved via vision at confidence 0.9 and highlighted the gear; the full
 * Run tapped the `EN` language button 182 px away and reported PASS.
 */

jest.mock('@/config/environment/env', () => ({ env: {} }));
jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {}, QueueManager: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {}, supabase: {} }));
jest.mock('@/services/mobile/dedicated-device.service', () => ({ resolveDedicatedDevice: jest.fn() }));
// Keep the real module's constants (RESOLVE_DISPATCH_TIMEOUT_MS is asserted
// below) — stubbing them here would let the test agree with itself while the
// production value drifted back to the 30s default.
jest.mock('@/services/mobile/mobile-runner-client', () => ({
  ...jest.requireActual('@/services/mobile/mobile-runner-client'),
  getMobileRunnerClient: jest.fn(),
}));
jest.mock('@/services/mobile/mobile-runner.types', () => ({ MobileRunnerError: class extends Error {} }));
jest.mock('@/services/core/project.service', () => ({ ProjectService: {} }));
jest.mock('@/services/mobile/project-mobile-app.helper', () => ({ getProjectMobileApp: jest.fn() }));
jest.mock('@/services/testing/ui/preview/editor-trace.service', () => ({ EditorTraceService: { getOrCreate: jest.fn() } }));
jest.mock('@/services/testing/ui/preview/editor-trace-upload', () => ({ uploadEditorTrace: jest.fn() }));
jest.mock('@/services/mobile/mobile-idle.service', () => ({ refreshIdle: jest.fn(), cancelIdle: jest.fn() }));
jest.mock('@/websocket/core/websocket.service', () => ({ webSocketService: {} }));
jest.mock('@/websocket/core/server', () => ({ getIO: jest.fn() }));
jest.mock('@/services/mobile/mobile-app-prep.service', () => ({ MobileAppPrepService: {} }));
jest.mock('@/services/storage/mobile-app-storage.service', () => ({ MobileAppStorageService: {} }));
jest.mock('@/services/mobile/permission-policy.service', () => ({ applyProjectPolicyToSession: jest.fn() }));
jest.mock('@/services/mobile/session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));
jest.mock('@/services/testing/ui/preview/intent-test-case.service', () => ({
  IntentTestCaseService: { getByIdInternal: jest.fn(), updateStepsCompiled: jest.fn() },
}));

import { getMobileRunnerClientForSession } from '@/services/mobile/session-runner-routing';
import { RESOLVE_DISPATCH_TIMEOUT_MS } from '@/services/mobile/mobile-runner-client';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { runTestCaseOnSession } from '../session.controller';

const getClientForSession = getMobileRunnerClientForSession as jest.Mock;
const getByIdInternal = (IntentTestCaseService as unknown as { getByIdInternal: jest.Mock }).getByIdInternal;

/** A vision resolve lands right on the trust threshold — the runner still re-resolves. */
const lintResolved = {
  status: 'resolved',
  boundingBox: { x: 1230, y: 194, width: 154, height: 154 },
  resolvedVia: 'vision_coordinates',
  confidence: 0.9,
  visionMode: true,
};

function makeReqRes(step: Record<string, unknown>) {
  const req = {
    user: { id: 'user-1' },
    params: { sessionId: 'sess-1' },
    body: { intentTestCaseId: 'tc-1' },
  } as never;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  getByIdInternal.mockResolvedValue({ id: 'tc-1', stepsJson: [step] });
  return { req, res };
}

function firstDispatchedCommands(executeBatchCommands: jest.Mock): Array<Record<string, unknown>> {
  expect(executeBatchCommands).toHaveBeenCalled();
  return executeBatchCommands.mock.calls[0][1];
}

describe('runTestCaseOnSession — useScreenshotOnly on the full-run path', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stamps _useScreenshotOnly on the dispatched command so the runner re-validation stays vision-led', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes({
      id: 'step-2',
      type: 'click',
      description: 'settings icon on the right top side, gear icon settings',
      options: { useScreenshotOnly: true },
    });

    await runTestCaseOnSession(req, res as never);

    expect(firstDispatchedCommands(executeBatchCommands)[0]).toMatchObject({
      type: 'tap',
      _useScreenshotOnly: true,
    });
  });

  it('forwards useScreenshotOnly to the lint call that resolves the element', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes({
      id: 'step-2',
      type: 'click',
      description: 'settings icon on the right top side, gear icon settings',
      options: { useScreenshotOnly: true },
    });

    await runTestCaseOnSession(req, res as never);

    expect(lintElement).toHaveBeenCalledWith(
      'sess-1',
      'settings icon on the right top side, gear icon settings',
      'tap',
      undefined,
      expect.objectContaining({ useScreenshotOnly: true }),
    );
  });

  it('gives the dispatch a resolve budget, not the 30s default', async () => {
    // The runner re-resolves (demoted coordsConfidence) and then runs its
    // post-action stability wait inside this one request. On the default the
    // client abandons a request the runner has already completed, and the
    // catch re-runs the step against the screen the first tap navigated to —
    // measured live on TC-13 as a second tap on the Settings back arrow.
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes({
      id: 'step-2',
      type: 'click',
      description: 'settings icon on the right top side, gear icon settings',
      options: { useScreenshotOnly: true },
    });

    await runTestCaseOnSession(req, res as never);

    expect(executeBatchCommands).toHaveBeenCalledWith(
      'sess-1',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: RESOLVE_DISPATCH_TIMEOUT_MS }),
    );
  });

  it('leaves the command unflagged when the step did not opt in', async () => {
    const lintElement = jest.fn().mockResolvedValue({ ...lintResolved, visionMode: false });
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes({
      id: 'step-2',
      type: 'click',
      description: 'Profile',
      options: {},
    });

    await runTestCaseOnSession(req, res as never);

    expect(firstDispatchedCommands(executeBatchCommands)[0]).not.toHaveProperty('_useScreenshotOnly');
  });
});
