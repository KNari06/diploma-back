import { handlePendingManageConfirmation } from '../manage-confirmation';
import { beginCompound, peekCurrentStep, type CompoundStep } from '../../../shared/compound-queue';

const mockGet = jest.fn();
const mockDel = jest.fn();
const mockSet = jest.fn();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: (...a: any[]) => mockGet(...a),
    del: (...a: any[]) => mockDel(...a),
    set: (...a: any[]) => mockSet(...a),
  },
}));

const mockExecuteTool = jest.fn();
jest.mock('@/services/skills/tool-executor', () => ({
  executeTool: (...a: any[]) => mockExecuteTool(...a),
}));

const mockClassify = jest.fn();
jest.mock('../../../shared/confirmation-classifier', () => ({
  classifyConfirmation: (...a: any[]) => mockClassify(...a),
}));

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const PENDING = JSON.stringify({
  toolName: 'qa_manage_schedule',
  args: { action: 'create', project_id: 'p1', name: 'Nightly', cron_expression: '0 9 * * *' },
  skillContext: { userId: 'u1', workspaceId: 'w1' },
  previewDescription: 'create schedule "Nightly"',
});

/** Key-aware get: manage key → given manage value, compound key → given compound value. */
function wireGet(manageValue: string | null, compoundValue: string | null = null) {
  mockGet.mockImplementation(async (key: string) => {
    if (key.startsWith('pending_manage:')) return manageValue;
    if (key.startsWith('pending_compound:')) return compoundValue;
    return null;
  });
}

describe('handlePendingManageConfirmation', () => {
  beforeEach(() => {
    mockGet.mockReset(); mockDel.mockReset(); mockSet.mockReset(); mockExecuteTool.mockReset(); mockClassify.mockReset();
    mockDel.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
  });

  it('returns false (no interception) when there is no pending op', async () => {
    wireGet(null);
    const res = mockRes();
    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');
    expect(handled).toBe(false);
    expect(res.json).not.toHaveBeenCalled();
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('executes the stored op with confirm:true on approval', async () => {
    wireGet(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'Schedule created' } });
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const callArg = mockExecuteTool.mock.calls[0][0];
    expect(callArg.toolName).toBe('qa_manage_schedule');
    expect(callArg.args.confirm).toBe(true);
    // re-runs the SAME stored args (no LLM re-inference)
    expect(callArg.args.name).toBe('Nightly');
    expect(callArg.args.cron_expression).toBe('0 9 * * *');
    expect(mockDel).toHaveBeenCalled(); // pending consumed
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, message: 'Schedule created' }));
  });

  it('cancels without executing on decline', async () => {
    wireGet(PENDING);
    mockClassify.mockResolvedValue('decline');
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'no', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('passes through (returns false) on an ambiguous reply and drops the pending op', async () => {
    wireGet(PENDING);
    mockClassify.mockResolvedValue('other');
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'actually change the time', 's1', 'u1');

    expect(handled).toBe(false);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalled(); // stale pending cleared
    expect(res.json).not.toHaveBeenCalled();
  });

  it('surfaces a 500 (not a crash) when the confirmed execution throws', async () => {
    wireGet(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockRejectedValue(new Error('boom'));
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── Two-queue interaction (manage-confirm × compound queue) ──────────────────
// Repro of the queue-desync bug: a compound step that is itself a write manage_*
// op. The write's confirm-preview stores pending_manage AND (correctly) leaves
// the compound queue un-advanced. The "yes" turn is intercepted here BEFORE the
// compound-continuation block, so this interceptor must advance the compound
// queue itself — otherwise the next user message is hijacked as a step retry.
describe('handlePendingManageConfirmation × pending compound', () => {
  // Real in-memory Redis shared by BOTH manage-confirmation and compound-queue,
  // so we observe the actual compound state transition, not a stubbed return.
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    mockGet.mockReset(); mockDel.mockReset(); mockSet.mockReset();
    mockExecuteTool.mockReset(); mockClassify.mockReset();
    mockGet.mockImplementation(async (k: string) => store.get(k) ?? null);
    mockSet.mockImplementation(async (k: string, v: string) => { store.set(k, v); return 'OK'; });
    mockDel.mockImplementation(async (k: string) => { store.delete(k); return 1; });
  });

  const COMPOUND: CompoundStep[] = [
    { text: 'create plan "Smoke"', order: 1, dependsOnPrevious: false },
    { text: 'test the login page', order: 2, dependsOnPrevious: true },
  ];

  /** Seed a pending_manage op for the CURRENT (write) compound step. */
  async function seedPendingManage(sessionId: string) {
    store.set(
      `pending_manage:${sessionId}`,
      JSON.stringify({
        toolName: 'qa_manage_plan',
        args: { action: 'create', project_id: 'p1', name: 'Smoke' },
        skillContext: { userId: 'u1', workspaceId: 'w1' },
        previewDescription: 'create plan "Smoke"',
      }),
    );
  }

  it('advances the compound queue when the confirmed write was the current step', async () => {
    await beginCompound('s1', COMPOUND);          // step 1 (the write) is current
    await seedPendingManage('s1');                 // its confirm-preview stored this
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'Plan created' } });
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool.mock.calls[0][0].args.confirm).toBe(true);

    // BUG FIX: compound advanced to step 2; the next user message drives it, NOT
    // a retry of the already-created plan.
    const next = await peekCurrentStep('s1');
    expect(next?.text).toBe('test the login page');
    expect(next?.index).toBe(2);
  });

  it('does NOT advance the compound when the confirmed write FAILS', async () => {
    await beginCompound('s1', COMPOUND);
    await seedPendingManage('s1');
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: false, message: 'name taken' } });
    const res = mockRes();

    await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');

    // Still on the write step so the user can retry it.
    const cur = await peekCurrentStep('s1');
    expect(cur?.text).toBe('create plan "Smoke"');
    expect(cur?.index).toBe(1);
  });

  it('abandons the whole compound when the user declines the write step', async () => {
    await beginCompound('s1', COMPOUND);
    await seedPendingManage('s1');
    mockClassify.mockResolvedValue('decline');
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'no', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    // Declining a step in the chain abandons the whole compound — no stuck queue.
    expect(await peekCurrentStep('s1')).toBeNull();
  });

  it('leaves a standalone (non-compound) confirmed write unaffected', async () => {
    await seedPendingManage('s1');                 // pending_manage but NO compound
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'Plan created' } });
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(await peekCurrentStep('s1')).toBeNull(); // nothing to advance, no crash
  });
});
