import { handleEditorSaveRequest, isEditorSaveRequest } from '../editor-save';

const mockExecuteTool = jest.fn();
jest.mock('@/services/skills/tool-executor', () => ({
  executeTool: (...a: any[]) => mockExecuteTool(...a),
}));

const mockStorePending = jest.fn();
jest.mock('../editor-confirmation', () => ({
  storePendingEditorConfirmation: (...a: any[]) => mockStorePending(...a),
}));

const mockSaveMessages = jest.fn();
jest.mock('@/services/utils/chat-persistence', () => ({
  ChatPersistence: { saveMessages: (...a: any[]) => mockSaveMessages(...a) },
}));

jest.mock('@/api/chat/shared/utils', () => ({ emitProcessingStep: jest.fn() }));

const mockDraftGet = jest.fn();
jest.mock('@/services/testing/ui/preview/draft-steps-cache', () => ({
  DraftStepsCache: { get: (...a: any[]) => mockDraftGet(...a) },
}));

function mockRes() {
  const res: any = { headersSent: false };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const CTX = {
  userId: 'u1',
  workspaceId: 'w1',
  chatSessionId: 's1',
  storeKind: 'testcase' as const,
  testCaseId: 'tc1',
};

const draft = (over: Record<string, any> = {}) => ({
  userId: 'u1',
  steps: [{}, {}, {}, {}],
  resourceBindings: [{ kind: 'secret', resource_id: 'r1', required: true }],
  ...over,
});

/**
 * The classifier is not a reliable trigger here — the SAME bare "save", in the
 * same surface, classified as `save_test` on 2026-07-26 and `general_chat` on
 * 2026-07-27. Hence two signals.
 */
describe('isEditorSaveRequest', () => {
  it('fires on the intent flag alone', () => {
    expect(isEditorSaveRequest('persist that for me please', true)).toBe(true);
  });

  it('fires on a bare "save" even when the classifier missed it', () => {
    expect(isEditorSaveRequest('save', false)).toBe(true);
    expect(isEditorSaveRequest('save it', false)).toBe(true);
  });

  it('covers ru and kk, not just en', () => {
    expect(isEditorSaveRequest('сохрани', false)).toBe(true);
    expect(isEditorSaveRequest('сақта', false)).toBe(true);
  });

  it('tolerates trailing punctuation on a bare command', () => {
    expect(isEditorSaveRequest('save.', false)).toBe(true);
    expect(isEditorSaveRequest('Save!', false)).toBe(true);
  });

  it('is not a passing mention of saving', () => {
    expect(isEditorSaveRequest("I don't want to save yet", false)).toBe(false);
    expect(isEditorSaveRequest('why did the save fail?', false)).toBe(false);
  });

  it('does not fire on a longer word that merely starts with the keyword', () => {
    expect(isEditorSaveRequest('saved searches are broken', false)).toBe(false);
  });

  it('leaves "save as a NEW test" to the model — that targets a different test case', () => {
    expect(isEditorSaveRequest('save this as a new separate test', false)).toBe(false);
    expect(isEditorSaveRequest('save it as another test case', false)).toBe(false);
  });
});

describe('handleEditorSaveRequest', () => {
  beforeEach(() => {
    mockExecuteTool.mockReset(); mockStorePending.mockReset();
    mockSaveMessages.mockReset(); mockDraftGet.mockReset();
    mockSaveMessages.mockResolvedValue([]);
    mockStorePending.mockResolvedValue(undefined);
  });

  it('falls through when nothing was authored — general chat answers "save what?" better', async () => {
    mockDraftGet.mockReturnValue(undefined);
    const res = mockRes();
    expect(await handleEditorSaveRequest(res, 'save', 's1', 'tc1', 'Login', CTX)).toBe(false);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('ignores a draft belonging to a different user', async () => {
    mockDraftGet.mockReturnValue(draft({ userId: 'someone-else' }));
    expect(await handleEditorSaveRequest(mockRes(), 'save', 's1', 'tc1', 'Login', CTX)).toBe(false);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('issues the write itself, targeting the OPEN test case', async () => {
    mockDraftGet.mockReturnValue(draft());
    mockExecuteTool.mockResolvedValue({
      toolResult: { success: false, needsConfirmation: true, message: 'WRITE operation requires confirmation…' },
    });

    expect(await handleEditorSaveRequest(mockRes(), 'save', 's1', 'tc1', 'Login', CTX)).toBe(true);

    const call = mockExecuteTool.mock.calls[0][0];
    expect(call.toolName).toBe('qa_update_test_case_steps');
    expect(call.args).toEqual({ test_case_id: 'tc1', confirm: false });
  });

  it('caches the refused write so the user\'s "yes" replays it', async () => {
    mockDraftGet.mockReturnValue(draft());
    mockExecuteTool.mockResolvedValue({
      toolResult: { success: false, needsConfirmation: true, message: 'WRITE operation requires confirmation…' },
    });

    await handleEditorSaveRequest(mockRes(), 'save', 's1', 'tc1', 'Login', CTX);

    expect(mockStorePending).toHaveBeenCalledWith('s1', expect.objectContaining({
      toolName: 'qa_update_test_case_steps',
    }));
  });

  it('shows a human preview, never the gate\'s model-facing prose', async () => {
    mockDraftGet.mockReturnValue(draft());
    mockExecuteTool.mockResolvedValue({
      toolResult: { success: false, needsConfirmation: true, message: 'WRITE operation requires confirmation. You MUST first describe…' },
    });

    const res = mockRes();
    await handleEditorSaveRequest(res, 'save', 's1', 'tc1', 'Login flow', CTX);

    const reply = res.json.mock.calls[0][0].reply as string;
    expect(reply).not.toContain('WRITE operation requires confirmation');
    expect(reply).toContain('4 step');
    expect(reply).toContain('Login flow');
    expect(reply).toContain('yes');
  });

  it('mentions the bound login only when the draft actually carries one', async () => {
    mockDraftGet.mockReturnValue(draft({ resourceBindings: [] }));
    mockExecuteTool.mockResolvedValue({
      toolResult: { success: false, needsConfirmation: true, message: 'gate' },
    });

    const res = mockRes();
    await handleEditorSaveRequest(res, 'save', 's1', 'tc1', 'Login', CTX);
    expect(res.json.mock.calls[0][0].reply).not.toContain('saved login');
  });

  it('reports the tool\'s own result when the gate did not refuse', async () => {
    mockDraftGet.mockReturnValue(draft());
    mockExecuteTool.mockResolvedValue({
      toolResult: { success: true, message: 'Updated test case: 0 → 4 steps' },
    });

    const res = mockRes();
    expect(await handleEditorSaveRequest(res, 'save', 's1', 'tc1', 'Login', CTX)).toBe(true);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, reply: 'Updated test case: 0 → 4 steps' }),
    );
    expect(mockStorePending).not.toHaveBeenCalled();
  });

  it('falls through without caching anything when the tool call throws', async () => {
    mockDraftGet.mockReturnValue(draft());
    mockExecuteTool.mockRejectedValue(new Error('boom'));

    const res = mockRes();
    expect(await handleEditorSaveRequest(res, 'save', 's1', 'tc1', 'Login', CTX)).toBe(false);
    expect(mockStorePending).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('persists the exchange to the test-case chat tables', async () => {
    mockDraftGet.mockReturnValue(draft());
    mockExecuteTool.mockResolvedValue({
      toolResult: { success: false, needsConfirmation: true, message: 'gate' },
    });

    await handleEditorSaveRequest(mockRes(), 'save', 's1', 'tc1', 'Login', CTX);

    const [store, sessionId, messages] = mockSaveMessages.mock.calls[0];
    expect(store.kind).toBe('testcase');
    expect(sessionId).toBe('s1');
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'ai']);
  });
});
