import { RegressionSaveService } from '../regression-save.service';
import { NotFoundError, ValidationError } from '@/types';
import * as regressionDb from '../db/regression.db';

jest.mock('../db/regression.db', () => ({
  getProjectForSave: jest.fn(),
  insertIntentTestCase: jest.fn(),
  getSourceTestForSave: jest.fn(),
  getIntelligentSessionForTest: jest.fn(),
}));

jest.mock('../intent-step-dispatch.service', () => ({
  normaliseIntentStep: jest.fn((raw: any, i: number) => ({
    id: raw?.id ?? `step_${i + 1}`,
    type: raw?.type ?? 'click',
    description: raw?.description ?? `Step ${i + 1}`,
  })),
}));

const mockDb = regressionDb as jest.Mocked<typeof regressionDb>;

function validProject() {
  return { id: 'proj-1', user_id: 'user-1' };
}

function validSavedCase() {
  return { id: 'tc-new' };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.getProjectForSave.mockResolvedValue(validProject());
  mockDb.insertIntentTestCase.mockResolvedValue(validSavedCase());
});

// ── saveFromRecording: validation ─────────────────────────────────────────────

describe('saveFromRecording validation (via saveTestCase without sourceTestId)', () => {
  const base = {
    userId: 'user-1',
    name: 'My test',
    steps: [{ type: 'click', description: 'tap' }],
    projectId: 'proj-1',
    platform: 'web' as const,
  };

  it('throws ValidationError when projectId is missing', async () => {
    await expect(
      RegressionSaveService.saveTestCase({ ...base, projectId: undefined }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when name is empty string', async () => {
    await expect(
      RegressionSaveService.saveTestCase({ ...base, name: '  ' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when steps is empty array', async () => {
    await expect(
      RegressionSaveService.saveTestCase({ ...base, steps: [] }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when steps is not an array', async () => {
    await expect(
      RegressionSaveService.saveTestCase({ ...base, steps: undefined }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for invalid platform', async () => {
    await expect(
      RegressionSaveService.saveTestCase({ ...base, platform: 'ios' as any }),
    ).rejects.toThrow(ValidationError);
  });

  it('ValidationError for invalid platform lists the valid values', async () => {
    await expect(
      RegressionSaveService.saveTestCase({ ...base, platform: 'ios' as any }),
    ).rejects.toThrow(/web.*mobile_android.*mobile_ios.*mobile_flutter/);
  });

  it('throws NotFoundError when project is not found (db returns null)', async () => {
    mockDb.getProjectForSave.mockResolvedValue(null);
    await expect(
      RegressionSaveService.saveTestCase(base),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when userId does not match project owner', async () => {
    mockDb.getProjectForSave.mockResolvedValue({ id: 'proj-1', user_id: 'other-user' });
    await expect(
      RegressionSaveService.saveTestCase(base),
    ).rejects.toThrow(ValidationError);
  });
});

// ── saveFromRecording: strategy & URL ────────────────────────────────────────

describe('saveFromRecording strategy and URL sentinel', () => {
  const steps = [{ type: 'click', description: 'tap' }];

  it('web platform → replayStrategy=steps_editor', async () => {
    const result = await RegressionSaveService.saveTestCase({
      userId: 'user-1',
      name: 'T',
      projectId: 'proj-1',
      platform: 'web',
      steps,
    });
    expect(result.replayStrategy).toBe('steps_editor');
  });

  it('mobile_android → replayStrategy=mobile_steps', async () => {
    const result = await RegressionSaveService.saveTestCase({
      userId: 'user-1',
      name: 'T',
      projectId: 'proj-1',
      platform: 'mobile_android',
      steps,
    });
    expect(result.replayStrategy).toBe('mobile_steps');
  });

  it('mobile platform → url sentinel = mobile://<short platform>', async () => {
    await RegressionSaveService.saveTestCase({
      userId: 'user-1',
      name: 'T',
      projectId: 'proj-1',
      platform: 'mobile_android',
      steps,
    });
    const insertCall = mockDb.insertIntentTestCase.mock.calls[0][0];
    expect(insertCall.url).toBe('mobile://android');
    expect(insertCall.start_url).toBe('mobile://android');
  });

  it('web platform → url is null', async () => {
    await RegressionSaveService.saveTestCase({
      userId: 'user-1',
      name: 'T',
      projectId: 'proj-1',
      platform: 'web',
      steps,
    });
    const insertCall = mockDb.insertIntentTestCase.mock.calls[0][0];
    expect(insertCall.url).toBeNull();
  });

  it('returns savedTestCaseId from the insert result', async () => {
    const result = await RegressionSaveService.saveTestCase({
      userId: 'user-1',
      name: 'T',
      projectId: 'proj-1',
      platform: 'web',
      steps,
    });
    expect(result.savedTestCaseId).toBe('tc-new');
  });
});

// ── saveTestCase: mode dispatch ───────────────────────────────────────────────

describe('saveTestCase mode dispatch', () => {
  it('with sourceTestId=undefined it delegates to saveFromRecording path', async () => {
    // This implicitly tests mode dispatch by checking the save happened
    const result = await RegressionSaveService.saveTestCase({
      userId: 'user-1',
      name: 'T',
      projectId: 'proj-1',
      platform: 'web',
      steps: [{ type: 'click' }],
    });
    expect(result.savedTestCaseId).toBe('tc-new');
    expect(mockDb.insertIntentTestCase).toHaveBeenCalledTimes(1);
  });
});

// ── saveTestCase: mode A (from completed test) ────────────────────────────────

describe('saveTestCase from completed test (mode A)', () => {
  function completedTest(overrides: any = {}) {
    return {
      id: 'test-src',
      url: 'https://example.com',
      project_id: 'proj-1',
      status: 'completed',
      commands: [{ action: 'click', selector: '#btn', value: null }],
      projects: { user_id: 'user-1' },
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDb.getSourceTestForSave.mockResolvedValue(completedTest());
    mockDb.getIntelligentSessionForTest.mockResolvedValue(null);
  });

  it('throws NotFoundError when source test is not found', async () => {
    mockDb.getSourceTestForSave.mockRejectedValue(new Error('not found'));
    await expect(
      RegressionSaveService.saveTestCase({
        sourceTestId: 'missing',
        userId: 'user-1',
        name: 'T',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when source test status is not completed', async () => {
    mockDb.getSourceTestForSave.mockResolvedValue(completedTest({ status: 'running' }));
    await expect(
      RegressionSaveService.saveTestCase({
        sourceTestId: 'test-src',
        userId: 'user-1',
        name: 'T',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when source test user does not match', async () => {
    mockDb.getSourceTestForSave.mockResolvedValue(
      completedTest({ projects: { user_id: 'other' } }),
    );
    await expect(
      RegressionSaveService.saveTestCase({
        sourceTestId: 'test-src',
        userId: 'user-1',
        name: 'T',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('uses commands strategy when test has commands', async () => {
    const result = await RegressionSaveService.saveTestCase({
      sourceTestId: 'test-src',
      userId: 'user-1',
      name: 'Login test',
    });
    expect(result.replayStrategy).toBe('commands');
  });

  it('uses graph_extract strategy when no commands but session has graph nodes', async () => {
    mockDb.getSourceTestForSave.mockResolvedValue(completedTest({ commands: [] }));
    mockDb.getIntelligentSessionForTest.mockResolvedValue({
      id: 'sess-1',
      graph_data: {
        nodes: [{ type: 'action', stepType: 'click', selector: '#a', label: 'click A' }],
      },
    });
    const result = await RegressionSaveService.saveTestCase({
      sourceTestId: 'test-src',
      userId: 'user-1',
      name: 'T',
    });
    expect(result.replayStrategy).toBe('graph_extract');
  });

  it('throws ValidationError when test has no url', async () => {
    mockDb.getSourceTestForSave.mockResolvedValue(
      completedTest({ url: null }),
    );
    await expect(
      RegressionSaveService.saveTestCase({
        sourceTestId: 'test-src',
        userId: 'user-1',
        name: 'T',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── sanitizeCommands (via mode A with commands) ───────────────────────────────

describe('sanitizeCommands', () => {
  function testWithCommands(commands: any[]) {
    mockDb.getSourceTestForSave.mockResolvedValue({
      id: 'test-src',
      url: 'https://example.com',
      project_id: 'proj-1',
      status: 'completed',
      commands,
      projects: { user_id: 'user-1' },
    });
    mockDb.getIntelligentSessionForTest.mockResolvedValue(null);
    return RegressionSaveService.saveTestCase({
      sourceTestId: 'test-src',
      userId: 'user-1',
      name: 'T',
    });
  }

  it('non-sensitive command values are left unchanged', async () => {
    await testWithCommands([{ action: 'click', selector: '#search', value: 'hello' }]);
    const inserted = mockDb.insertIntentTestCase.mock.calls[0][0] as any;
    expect(inserted.commands[0].value).toBe('hello');
  });

  it('value is replaced with {{paramName}} when context contains "password"', async () => {
    await testWithCommands([{ action: 'fill', selector: '#password', value: 'secret123' }]);
    const inserted = mockDb.insertIntentTestCase.mock.calls[0][0] as any;
    expect(inserted.commands[0].value).toMatch(/^\{\{.+\}\}$/);
  });

  it('value is replaced when description contains "token"', async () => {
    await testWithCommands([{ action: 'fill', description: 'Enter token', value: 'tok_abc' }]);
    const inserted = mockDb.insertIntentTestCase.mock.calls[0][0] as any;
    expect(inserted.commands[0].value).toMatch(/^\{\{.+\}\}$/);
  });

  it('oversized commands (>10000 chars) are skipped', async () => {
    const bigValue = 'x'.repeat(10001);
    await testWithCommands([
      { action: 'fill', selector: '#a', value: bigValue },
      { action: 'click', selector: '#btn', value: null },
    ]);
    const inserted = mockDb.insertIntentTestCase.mock.calls[0][0] as any;
    // Only the non-oversized command should survive
    expect(inserted.commands).toHaveLength(1);
    expect(inserted.commands[0].selector).toBe('#btn');
  });
});
