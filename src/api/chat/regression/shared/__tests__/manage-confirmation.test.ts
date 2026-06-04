import { handlePendingManageConfirmation } from '../manage-confirmation';

const mockGet = jest.fn();
const mockDel = jest.fn();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: (...a: any[]) => mockGet(...a),
    del: (...a: any[]) => mockDel(...a),
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

describe('handlePendingManageConfirmation', () => {
  beforeEach(() => {
    mockGet.mockReset(); mockDel.mockReset(); mockExecuteTool.mockReset(); mockClassify.mockReset();
    mockDel.mockResolvedValue(1);
  });

  it('returns false (no interception) when there is no pending op', async () => {
    mockGet.mockResolvedValue(null);
    const res = mockRes();
    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');
    expect(handled).toBe(false);
    expect(res.json).not.toHaveBeenCalled();
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('executes the stored op with confirm:true on approval', async () => {
    mockGet.mockResolvedValue(PENDING);
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
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('decline');
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'no', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('passes through (returns false) on an ambiguous reply and drops the pending op', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('other');
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'actually change the time', 's1', 'u1');

    expect(handled).toBe(false);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalled(); // stale pending cleared
    expect(res.json).not.toHaveBeenCalled();
  });

  it('surfaces a 500 (not a crash) when the confirmed execution throws', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockRejectedValue(new Error('boom'));
    const res = mockRes();

    const handled = await handlePendingManageConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
