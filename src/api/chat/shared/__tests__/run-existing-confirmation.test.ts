import {
  handlePendingRunExistingConfirmation,
  storePendingRunExisting,
} from '../run-existing-confirmation';

const mockGet = jest.fn();
const mockGetdel = jest.fn();
const mockDel = jest.fn();
const mockSet = jest.fn();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: (...a: any[]) => mockGet(...a),
    getdel: (...a: any[]) => mockGetdel(...a),
    del: (...a: any[]) => mockDel(...a),
    set: (...a: any[]) => mockSet(...a),
  },
}));

const mockRunSaved = jest.fn();
jest.mock('@/services/testing/regression/regression-run.service', () => ({
  RegressionRunService: {
    runSavedTestCase: (...a: any[]) => mockRunSaved(...a),
  },
}));

jest.mock('@/services/utils/chat.service', () => ({
  ChatService: { saveChatMessages: jest.fn().mockResolvedValue([]) },
}));

const mockClassify = jest.fn();
jest.mock('../confirmation-classifier', () => ({
  classifyConfirmation: (...a: any[]) => mockClassify(...a),
}));

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const SINGLE = JSON.stringify({
  candidates: [{ id: 'tc1', name: 'Login flow', platform: 'web' }],
});
const MULTI = JSON.stringify({
  candidates: [
    { id: 'tc1', name: 'Login flow', platform: 'web' },
    { id: 'tc2', name: 'Checkout', platform: 'mobile_android' },
  ],
});

describe('handlePendingRunExistingConfirmation', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGetdel.mockReset();
    mockDel.mockReset();
    mockSet.mockReset();
    mockRunSaved.mockReset();
    mockClassify.mockReset();
    mockDel.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    // The handler claims the pending payload atomically via getdel(); route it
    // to whatever a test stages in mockGet so existing setups keep working.
    mockGetdel.mockImplementation((...a: any[]) => mockGet(...a));
  });

  it('returns false (no interception) when there is no pending confirmation', async () => {
    mockGet.mockResolvedValue(null);
    const res = mockRes();
    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');
    expect(handled).toBe(false);
    expect(res.json).not.toHaveBeenCalled();
    expect(mockRunSaved).not.toHaveBeenCalled();
  });

  it('runs the single matched test case on "yes"', async () => {
    mockGet.mockResolvedValue(SINGLE);
    mockClassify.mockResolvedValue('confirm');
    mockRunSaved.mockResolvedValue({ runId: 'r1', testId: 't1' });
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockRunSaved).toHaveBeenCalledWith(
      expect.objectContaining({ savedTestCaseId: 'tc1', userId: 'u1', trigger: 'chat' }),
    );
    expect(mockGetdel).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, mode: 'run_existing', runId: 'r1' }),
    );
  });

  it('claims the pending payload atomically via getdel', async () => {
    mockGet.mockResolvedValue(SINGLE);
    mockClassify.mockResolvedValue('confirm');
    mockRunSaved.mockResolvedValue({ runId: 'r1', testId: 't1' });
    const res = mockRes();

    await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');

    // Consumption is a single atomic getdel — no separate get+del.
    expect(mockGetdel).toHaveBeenCalledWith('pending_run_existing:s1');
    expect(mockRunSaved).toHaveBeenCalledTimes(1);
  });

  it('a second near-simultaneous confirm finds nothing (getdel returned null) and does not run', async () => {
    // Simulate the race: the first request already claimed+deleted the payload,
    // so this second request's getdel returns null → no interception, no run.
    mockGet.mockResolvedValue(null);
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(false);
    expect(mockRunSaved).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('writes the pending list back on a bare "yes" to a multi-match (re-ask keeps state)', async () => {
    mockGet.mockResolvedValue(MULTI);
    mockClassify.mockResolvedValue('confirm');
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockRunSaved).not.toHaveBeenCalled();
    // Payload was claimed by getdel, so it must be written BACK for the re-ask.
    expect(mockSet).toHaveBeenCalledWith('pending_run_existing:s1', MULTI, 'EX', expect.any(Number));
    const reply = res.json.mock.calls[0][0].reply as string;
    expect(reply).toMatch(/which one/i);
  });

  it('suggests exploration (does not run) on "no"', async () => {
    mockGet.mockResolvedValue(SINGLE);
    mockClassify.mockResolvedValue('decline');
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'no', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockRunSaved).not.toHaveBeenCalled();
    expect(mockGetdel).toHaveBeenCalled();
    const reply = res.json.mock.calls[0][0].reply as string;
    expect(reply).toMatch(/Explore/);
  });

  it('picks by number from a multi-match list without calling the classifier', async () => {
    mockGet.mockResolvedValue(MULTI);
    mockRunSaved.mockResolvedValue({ runId: 'r2', testId: 't2' });
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, '2', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockRunSaved).toHaveBeenCalledWith(
      expect.objectContaining({ savedTestCaseId: 'tc2' }),
    );
  });

  it('re-asks for the number when a multi-match gets a bare "yes"', async () => {
    mockGet.mockResolvedValue(MULTI);
    mockClassify.mockResolvedValue('confirm');
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(mockRunSaved).not.toHaveBeenCalled();
    // pending list kept (not deleted) so the next numbered reply still resolves
    expect(mockDel).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].reply).toMatch(/number/i);
  });

  it('passes through (returns false) and clears pending on an ambiguous reply', async () => {
    mockGet.mockResolvedValue(SINGLE);
    mockClassify.mockResolvedValue('other');
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation(
      {} as any, res, 'actually test something else', 's1', 'u1',
    );

    expect(handled).toBe(false);
    expect(mockRunSaved).not.toHaveBeenCalled();
    expect(mockGetdel).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('surfaces a clean message (not a crash) when the test was deleted between ask and confirm', async () => {
    const { NotFoundError } = jest.requireActual('@/types');
    mockGet.mockResolvedValue(SINGLE);
    mockClassify.mockResolvedValue('confirm');
    mockRunSaved.mockRejectedValue(new NotFoundError('gone'));
    const res = mockRes();

    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'yes', 's1', 'u1');

    expect(handled).toBe(true);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });
});

// ── parsePick edge cases (exercised through the public handler) ──────────────
// Realistic saved-test fixtures with overlapping / numeric-ish names so the
// number-vs-name disambiguation is actually tested.
describe('handlePendingRunExistingConfirmation — pick disambiguation', () => {
  const THREE = JSON.stringify({
    candidates: [
      { id: 'tcA', name: 'Login', platform: 'web' },
      { id: 'tcB', name: 'Login Test', platform: 'web' },
      { id: 'tcC', name: 'Checkout v2', platform: 'mobile_android' },
    ],
  });

  beforeEach(() => {
    mockGet.mockReset(); mockDel.mockReset(); mockSet.mockReset();
    mockRunSaved.mockReset(); mockClassify.mockReset();
    mockDel.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    mockGet.mockResolvedValue(THREE);
    mockRunSaved.mockResolvedValue({ runId: 'r', testId: 't' });
  });

  it('exact name match wins over a partial ("Login Test" → tcB, not tcA)', async () => {
    const res = mockRes();
    const handled = await handlePendingRunExistingConfirmation({} as any, res, 'Login Test', 's1', 'u1');
    expect(handled).toBe(true);
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockRunSaved).toHaveBeenCalledWith(expect.objectContaining({ savedTestCaseId: 'tcB' }));
  });

  it('longest partial wins when the reply contains a name ("run the Login Test now" → tcB)', async () => {
    const res = mockRes();
    await handlePendingRunExistingConfirmation({} as any, res, 'run the Login Test now', 's1', 'u1');
    expect(mockRunSaved).toHaveBeenCalledWith(expect.objectContaining({ savedTestCaseId: 'tcB' }));
  });

  it('out-of-range number is NOT a silent off-by-one — falls back to classifier', async () => {
    mockClassify.mockResolvedValue('other'); // "10" with 3 candidates → no pick, then ambiguous
    const res = mockRes();
    const handled = await handlePendingRunExistingConfirmation({} as any, res, '10', 's1', 'u1');
    expect(mockRunSaved).not.toHaveBeenCalled();
    // ambiguous → passes through
    expect(handled).toBe(false);
  });

  it('mid-word digit ("test2b") does NOT select candidate 2', async () => {
    mockClassify.mockResolvedValue('other');
    const res = mockRes();
    await handlePendingRunExistingConfirmation({} as any, res, 'test2b', 's1', 'u1');
    expect(mockRunSaved).not.toHaveBeenCalled();
  });

  it('a clean in-range number still picks ("3" → tcC, mobile)', async () => {
    const res = mockRes();
    await handlePendingRunExistingConfirmation({} as any, res, '3', 's1', 'u1');
    expect(mockRunSaved).toHaveBeenCalledWith(expect.objectContaining({ savedTestCaseId: 'tcC' }));
  });
});

describe('storePendingRunExisting', () => {
  beforeEach(() => {
    mockSet.mockReset();
    mockSet.mockResolvedValue('OK');
  });

  it('stores the candidate list under the session key and returns a yes/no prompt + Yes/No chips for a single match', async () => {
    const { reply, actions } = await storePendingRunExisting('s1', [{ id: 'tc1', name: 'Login flow', platform: 'web' }]);
    expect(mockSet).toHaveBeenCalledWith(
      'pending_run_existing:s1',
      expect.stringContaining('tc1'),
      'EX',
      expect.any(Number),
    );
    expect(reply).toMatch(/Login flow/);
    // Asks a confirmation question (no longer the literal "reply yes" copy —
    // confirmation is LLM-classified now, so the prompt is phrased naturally).
    expect(reply).toMatch(/run it\?/i);
    // Clickable chips re-send "yes"/"no" as chat messages (kind:'chat').
    expect(actions.every((a) => a.kind === 'chat')).toBe(true);
    expect(actions.map((a) => (a.kind === 'chat' ? a.prompt : undefined))).toEqual(['yes', 'no']);
  });

  it('returns a numbered list + one pick chip per candidate plus a No chip for multiple matches', async () => {
    const { reply, actions } = await storePendingRunExisting('s1', [
      { id: 'tc1', name: 'Login flow', platform: 'web' },
      { id: 'tc2', name: 'Checkout', platform: 'mobile_ios' },
    ]);
    expect(reply).toMatch(/1\./);
    expect(reply).toMatch(/2\./);
    expect(reply).toMatch(/mobile \(iOS\)/);
    // A chip per candidate ("1","2") plus a trailing "no".
    expect(actions.map((a) => (a.kind === 'chat' ? a.prompt : undefined))).toEqual(['1', '2', 'no']);
  });
});
