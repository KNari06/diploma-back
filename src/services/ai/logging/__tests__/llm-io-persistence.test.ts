/**
 * Unit tests for persistLLMCall — the ai_call_logs writer.
 * Mocks: env flag, supabaseAdmin insert, getAIContext.
 */

const mockInsert = jest.fn();
let mockFlagEnabled = true;
let mockCtx: any = { workspaceId: 'ws-1', userId: 'u-1', runId: 'run-9', operationType: 'analysis' };

jest.mock('@/config/environment/env', () => ({
  get env() {
    return { LLM_IO_PERSIST_ENABLED: mockFlagEnabled };
  },
}));
jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ insert: (row: any) => mockInsert(row) }),
  },
}));
jest.mock('../../tracking/ai-context', () => ({
  getAIContext: () => mockCtx,
}));

import { persistLLMCall, isLLMIOPersistEnabled } from '../llm-io-persistence';

beforeEach(() => {
  jest.clearAllMocks();
  mockFlagEnabled = true;
  mockCtx = { workspaceId: 'ws-1', userId: 'u-1', runId: 'run-9', operationType: 'analysis' };
  // insert resolves to no error by default
  mockInsert.mockResolvedValue({ error: null });
});

describe('isLLMIOPersistEnabled', () => {
  it('reflects the env flag', () => {
    mockFlagEnabled = true;
    expect(isLLMIOPersistEnabled()).toBe(true);
    mockFlagEnabled = false;
    expect(isLLMIOPersistEnabled()).toBe(false);
  });
});

describe('persistLLMCall', () => {
  it('is a no-op when the flag is OFF', () => {
    mockFlagEnabled = false;
    persistLLMCall({ provider: 'openai', model: 'gpt', status: 'succeeded', prompt: 'hi', completion: 'yo' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no workspace context', () => {
    mockCtx = { userId: 'u-1' }; // no workspaceId
    persistLLMCall({ provider: 'openai', model: 'gpt', status: 'succeeded', prompt: 'hi', completion: 'yo' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('inserts a row with correlation fields from context', () => {
    persistLLMCall({ provider: 'openai', model: 'gpt-5', status: 'succeeded', prompt: 'hello', completion: 'world' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row.workspace_id).toBe('ws-1');
    expect(row.user_id).toBe('u-1');
    expect(row.run_id).toBe('run-9');
    expect(row.operation_type).toBe('analysis');
    expect(row.provider).toBe('openai');
    expect(row.status).toBe('succeeded');
  });

  it('redacts secrets/PII before storing', () => {
    persistLLMCall({
      provider: 'openai',
      model: 'gpt',
      status: 'succeeded',
      prompt: 'login with password=Sup3rSecret email a@b.com',
      completion: 'used api_key=AKIA999999',
    });
    const row = mockInsert.mock.calls[0][0];
    expect(row.prompt_redacted).not.toContain('Sup3rSecret');
    expect(row.prompt_redacted).not.toContain('a@b.com');
    expect(row.completion_redacted).not.toContain('AKIA999999');
  });

  it('serializes a messages array into a readable prompt', () => {
    persistLLMCall({
      provider: 'openai',
      model: 'gpt',
      status: 'succeeded',
      prompt: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'run the test' },
      ] as any,
    });
    const row = mockInsert.mock.calls[0][0];
    expect(row.prompt_redacted).toContain('[system] be helpful');
    expect(row.prompt_redacted).toContain('[user] run the test');
  });

  it('stores failed calls with error message and null completion', () => {
    persistLLMCall({
      provider: 'gemini',
      model: 'flash',
      status: 'failed',
      prompt: 'x',
      errorMessage: 'timeout',
    });
    const row = mockInsert.mock.calls[0][0];
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('timeout');
    expect(row.completion_redacted).toBeNull();
  });

  it('never throws when the insert rejects', () => {
    mockInsert.mockRejectedValue(new Error('db down'));
    expect(() =>
      persistLLMCall({ provider: 'openai', model: 'gpt', status: 'succeeded', prompt: 'hi', completion: 'yo' }),
    ).not.toThrow();
  });
});
