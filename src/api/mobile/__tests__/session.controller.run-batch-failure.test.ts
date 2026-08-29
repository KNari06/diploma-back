/**
 * `runTestCaseOnSession` — a failed command inside a runner batch must fail the
 * STEP, not be discarded.
 *
 * CLAUDE.md Hard invariant #18: the runner never signals a command failure
 * through the transport. `executeBatch` turns a thrown handler into
 * `{ success: false, error }` and the route answers HTTP 200 either way, so
 * `executeBatchCommands` RESOLVES on failure. Awaiting it without reading
 * `results[]` cannot tell a working command from a broken one.
 *
 * This loop did exactly that — `await executeBatchCommands(...)` followed by an
 * unconditional `stepResults.push({ success: true })`.
 *
 * LIVE EVIDENCE (Klara `com.itsapp.klaraai.dev`, editor Run, 2026-08-28):
 * a `type` step is dispatched as [tap, type_text]. The focus tap failed with
 * "tap: finder found nothing and no coordinate fallback", so the batch stopped
 * and **the type_text was never sent**. The step was recorded green with the
 * phone-number field still empty; the two steps after it then ran against a
 * screen the test believed it had filled in, and the run reported 6/6 passed
 * while the app sat on the login page.
 */

jest.mock('@/config/environment/env', () => ({ env: {} }));
jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {}, QueueManager: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {}, supabase: {} }));
jest.mock('@/services/mobile/dedicated-device.service', () => ({ resolveDedicatedDevice: jest.fn() }));
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
  IntentTestCaseService: {
    getByIdInternal: jest.fn(),
    updateStepFromPreviewApply: jest.fn(),
  },
}));

import { getMobileRunnerClientForSession } from '@/services/mobile/session-runner-routing';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { runTestCaseOnSession } from '../session.controller';

const getClientForSession = getMobileRunnerClientForSession as jest.Mock;
const getByIdInternal = (IntentTestCaseService as unknown as { getByIdInternal: jest.Mock }).getByIdInternal;

const lintResolved = {
  status: 'resolved',
  boundingBox: { x: 70, y: 968, width: 1300, height: 259 },
  resolvedVia: 'llm',
  confidence: 0.95,
  visionMode: false,
};

/** The Klara step 4 shape: a `type` step, which dispatches as [tap, type_text]. */
function makeReqRes() {
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
  getByIdInternal.mockResolvedValue({
    id: 'tc-1',
    stepsJson: [{
      id: 'step-4',
      type: 'type',
      value: '99900010011',
      description: 'Phone number',
      options: { replaceContent: true },
    }],
  });
  return { req, res };
}

/** The run streams newline-delimited JSON events through `res.write`. */
function events(res: { write: jest.Mock }): Array<Record<string, unknown>> {
  expect(res.write).toHaveBeenCalled();
  return res.write.mock.calls
    .map((c) => String(c[0]).trim())
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return {}; } });
}

function stepResults(res: { write: jest.Mock }): Array<Record<string, unknown>> {
  return events(res).filter((e) => e.type === 'step_result');
}

describe('runTestCaseOnSession — a failed command inside the batch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails the step when the focus tap failed and the type never ran', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    // Exactly what the runner returned live: the tap failed, so the batch
    // stopped and the type_text has no result at all.
    const executeBatchCommands = jest.fn().mockResolvedValue({
      results: [{ success: false, error: 'tap: finder found nothing and no coordinate fallback' }],
    });
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes();
    await runTestCaseOnSession(req, res as never);

    const results = stepResults(res);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ stepId: 'step-4', status: 'fail' });
    expect(String(results[0].error)).toContain('finder found nothing');
  });

  it('still passes the step when every command in the batch succeeded', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({
      results: [{ success: true }, { success: true }],
    });
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes();
    await runTestCaseOnSession(req, res as never);

    expect(stepResults(res)).toEqual([expect.objectContaining({ stepId: 'step-4', status: 'pass' })]);
  });

  it('does not invent a failure when the runner answers without a results array', async () => {
    // An older runner, or a shape the helper cannot read, must not turn every
    // step red — the helper is policy-free and reports nothing it cannot see.
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({});
    getClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const { req, res } = makeReqRes();
    await runTestCaseOnSession(req, res as never);

    expect(stepResults(res)).toEqual([expect.objectContaining({ stepId: 'step-4', status: 'pass' })]);
  });
});
