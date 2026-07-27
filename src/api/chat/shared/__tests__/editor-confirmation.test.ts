import {
  clearPendingEditorConfirmation,
  handlePendingEditorConfirmation,
  isReplayableConfirmTool,
  storePendingEditorConfirmation,
} from '../editor-confirmation';

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

const mockRecordPreview = jest.fn();
jest.mock('@/services/skills/skill-registry', () => ({
  SkillRegistry: { recordConfirmationPreview: (...a: any[]) => mockRecordPreview(...a) },
}));

const mockSaveMessages = jest.fn();
jest.mock('@/services/utils/chat-persistence', () => ({
  ChatPersistence: { saveMessages: (...a: any[]) => mockSaveMessages(...a) },
}));

const mockClassify = jest.fn();
jest.mock('../confirmation-classifier', () => ({
  classifyConfirmation: (...a: any[]) => mockClassify(...a),
}));

const mockEmitStep = jest.fn();
jest.mock('../utils', () => ({ emitProcessingStep: (...a: any[]) => mockEmitStep(...a) }));

function mockRes() {
  const res: any = { headersSent: false };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const SKILL_CONTEXT = {
  userId: 'u1',
  workspaceId: 'w1',
  chatSessionId: 's1',
  storeKind: 'testcase',
  testCaseId: 'tc1',
};

const PENDING = JSON.stringify({
  toolName: 'qa_update_test_case_steps',
  args: { test_case_id: 'tc1' },
  skillContext: SKILL_CONTEXT,
});

describe('editor confirmation — replay eligibility', () => {
  it('replays the test-case persistence tools', () => {
    expect(isReplayableConfirmTool('qa_update_test_case_steps')).toBe(true);
    expect(isReplayableConfirmTool('qa_create_test_case')).toBe(true);
  });

  it('does NOT replay iterative authoring — it confirms correctly on its own and reruns a live 20-60s preview job', () => {
    expect(isReplayableConfirmTool('qa_author_test_iteratively')).toBe(false);
  });
});

describe('storePendingEditorConfirmation', () => {
  beforeEach(() => {
    mockSet.mockReset();
    mockSet.mockResolvedValue('OK');
  });

  it('keys the pending op by chatSessionId only, never by userId', async () => {
    await storePendingEditorConfirmation('s1', {
      toolName: 'qa_create_test_case',
      args: { name: 'X', confirm: false },
      skillContext: SKILL_CONTEXT as any,
    });
    const [key] = mockSet.mock.calls[0];
    expect(key).toBe('pending_editor_confirm:s1');
    expect(key).not.toContain('u1');
  });

  it('strips confirm from the stored args so the replay supplies it', async () => {
    await storePendingEditorConfirmation('s1', {
      toolName: 'qa_create_test_case',
      args: { name: 'X', confirm: false },
      skillContext: SKILL_CONTEXT as any,
    });
    const stored = JSON.parse(mockSet.mock.calls[0][1]);
    expect(stored.args).toEqual({ name: 'X' });
    expect(stored.args).not.toHaveProperty('confirm');
  });

  it('expires the op after 30 minutes, matching the draft-steps cache it depends on', async () => {
    await storePendingEditorConfirmation('s1', {
      toolName: 'qa_create_test_case',
      args: {},
      skillContext: SKILL_CONTEXT as any,
    });
    expect(mockSet.mock.calls[0].slice(2)).toEqual(['EX', 1800]);
  });

  it('ignores a tool that is not replayable', async () => {
    await storePendingEditorConfirmation('s1', {
      toolName: 'qa_author_test_iteratively',
      args: {},
      skillContext: SKILL_CONTEXT as any,
    });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('swallows a Redis failure rather than breaking the turn in progress', async () => {
    mockSet.mockRejectedValue(new Error('redis down'));
    await expect(
      storePendingEditorConfirmation('s1', {
        toolName: 'qa_create_test_case',
        args: {},
        skillContext: SKILL_CONTEXT as any,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('handlePendingEditorConfirmation', () => {
  beforeEach(() => {
    mockGet.mockReset(); mockDel.mockReset(); mockSet.mockReset();
    mockExecuteTool.mockReset(); mockClassify.mockReset();
    mockRecordPreview.mockReset(); mockSaveMessages.mockReset(); mockEmitStep.mockReset();
    mockDel.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    mockSaveMessages.mockResolvedValue([]);
  });

  it('does not intercept when nothing is pending', async () => {
    mockGet.mockResolvedValue(null);
    const res = mockRes();
    expect(await handlePendingEditorConfirmation(res, 'yes', 's1', 'u1')).toBe(false);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('re-issues the SAME cached call with confirm=true on an affirmative', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'Updated 3 steps' } });

    const res = mockRes();
    expect(await handlePendingEditorConfirmation(res, 'yes', 's1', 'u1')).toBe(true);

    const call = mockExecuteTool.mock.calls[0][0];
    expect(call.toolName).toBe('qa_update_test_case_steps');
    expect(call.args).toEqual({ test_case_id: 'tc1', confirm: true });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, reply: 'Updated 3 steps' }),
    );
  });

  it('re-arms the registry preview before replaying, so a slow user reply is still honoured', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'ok' } });

    await handlePendingEditorConfirmation(mockRes(), 'yes', 's1', 'u1');

    expect(mockRecordPreview).toHaveBeenCalledWith('s1', 'qa_update_test_case_steps');
    expect(mockRecordPreview.mock.invocationCallOrder[0])
      .toBeLessThan(mockExecuteTool.mock.invocationCallOrder[0]);
  });

  it('routes the progress emit to the test-case room, never chat:<sessionId>', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'ok' } });

    await handlePendingEditorConfirmation(mockRes(), 'yes', 's1', 'u1');

    // Last arg is the testCaseId that pins the emit to `chat:tc:<tcid>`.
    expect(mockEmitStep.mock.calls[0][5]).toBe('tc1');
  });

  it('skips the progress emit entirely when the cached op has no testCaseId — a leak beats no spinner', async () => {
    mockGet.mockResolvedValue(JSON.stringify({
      toolName: 'qa_update_test_case_steps',
      args: { test_case_id: 'tc1' },
      skillContext: { userId: 'u1', workspaceId: 'w1', chatSessionId: 's1' },
    }));
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'ok' } });

    await handlePendingEditorConfirmation(mockRes(), 'yes', 's1', 'u1');

    expect(mockEmitStep).not.toHaveBeenCalled();
  });

  it('persists the exchange to the test-case chat tables', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({ toolResult: { success: true, message: 'Updated 3 steps' } });

    await handlePendingEditorConfirmation(mockRes(), 'yes', 's1', 'u1');

    const [store, sessionId, messages] = mockSaveMessages.mock.calls[0];
    expect(store.kind).toBe('testcase');
    expect(sessionId).toBe('s1');
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'ai']);
  });

  it('clears the op and cancels without writing on a decline', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('decline');

    const res = mockRes();
    expect(await handlePendingEditorConfirmation(res, 'no', 's1', 'u1')).toBe(true);
    expect(mockDel).toHaveBeenCalledWith('pending_editor_confirm:s1');
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('drops the op and falls through when the reply is unrelated', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('other');

    const res = mockRes();
    expect(await handlePendingEditorConfirmation(res, 'what does step 2 do?', 's1', 'u1')).toBe(false);
    expect(mockDel).toHaveBeenCalledWith('pending_editor_confirm:s1');
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('refuses to replay an op cached under a different user', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');

    expect(await handlePendingEditorConfirmation(mockRes(), 'yes', 's1', 'someone-else')).toBe(false);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('never echoes the gate\'s model-facing prose when the replay is refused again', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockResolvedValue({
      toolResult: {
        success: false,
        needsConfirmation: true,
        message: 'WRITE operation requires confirmation. You MUST first describe…',
      },
    });

    const res = mockRes();
    expect(await handlePendingEditorConfirmation(res, 'yes', 's1', 'u1')).toBe(true);
    const reply = res.json.mock.calls[0][0].reply as string;
    expect(reply).not.toContain('WRITE operation requires confirmation');
    // …and re-caches, so the next "yes" completes rather than dead-ending.
    expect(mockSet).toHaveBeenCalled();
  });

  it('clears the pending op on a tool crash instead of leaving it to fire later', async () => {
    mockGet.mockResolvedValue(PENDING);
    mockClassify.mockResolvedValue('confirm');
    mockExecuteTool.mockRejectedValue(new Error('boom'));

    const res = mockRes();
    expect(await handlePendingEditorConfirmation(res, 'yes', 's1', 'u1')).toBe(true);
    expect(mockDel).toHaveBeenCalledWith('pending_editor_confirm:s1');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('clearPendingEditorConfirmation', () => {
  beforeEach(() => { mockDel.mockReset(); mockDel.mockResolvedValue(1); });

  it('deletes the session key', async () => {
    await clearPendingEditorConfirmation('s1');
    expect(mockDel).toHaveBeenCalledWith('pending_editor_confirm:s1');
  });

  it('no-ops without a session id', async () => {
    await clearPendingEditorConfirmation(undefined);
    expect(mockDel).not.toHaveBeenCalled();
  });
});
