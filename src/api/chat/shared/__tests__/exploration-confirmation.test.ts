import {
  handlePendingExplorationConfirmation,
  MAX_EXPLORATION_CLARIFY_REASKS,
} from '../exploration-confirmation';

/**
 * Focus: the ambiguous-reply ("other") re-ask loop is BOUNDED. Before the cap,
 * a user who kept saying unrelated things was trapped answering the same yes/no
 * prompt until the 10-min TTL expired. After MAX_EXPLORATION_CLARIFY_REASKS
 * consecutive "other" replies the pending is dropped and the message falls
 * through to normal chat (handler returns false).
 */

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: (...a: any[]) => mockGet(...a),
    set: (...a: any[]) => mockSet(...a),
    del: (...a: any[]) => mockDel(...a),
  },
  QueueManager: { addExplorationJob: jest.fn() },
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

const pending = (otherCount?: number) =>
  JSON.stringify({ entryUrl: 'https://app.test', projectId: 'p1', userId: 'u1', otherCount });

describe('handlePendingExplorationConfirmation — ambiguous re-ask cap', () => {
  beforeEach(() => {
    mockGet.mockReset(); mockSet.mockReset(); mockDel.mockReset(); mockClassify.mockReset();
    mockSet.mockResolvedValue('OK');
    mockDel.mockResolvedValue(1);
    mockClassify.mockResolvedValue('other');
  });

  it('re-asks (keeps pending, bumps otherCount) on the first ambiguous reply', async () => {
    mockGet.mockResolvedValue(pending(undefined));
    const res = mockRes();

    const handled = await handlePendingExplorationConfirmation({} as any, res, 'what does it cost?', 's1', 'u1', 'w1');

    expect(handled).toBe(true);
    expect(mockDel).not.toHaveBeenCalled();
    // re-armed with otherCount incremented to 1
    const stored = JSON.parse(mockSet.mock.calls[0][1]);
    expect(stored.otherCount).toBe(1);
    expect(res.json.mock.calls[0][0].reply).toMatch(/should I start/i);
  });

  it('drops the pending and falls through once the cap is exceeded', async () => {
    // Already at the cap → this ambiguous reply is one too many.
    mockGet.mockResolvedValue(pending(MAX_EXPLORATION_CLARIFY_REASKS));
    const res = mockRes();

    const handled = await handlePendingExplorationConfirmation({} as any, res, 'tell me a joke', 's1', 'u1', 'w1');

    expect(handled).toBe(false);          // falls through to normal chat
    expect(mockDel).toHaveBeenCalled();   // pending cleared
    expect(mockSet).not.toHaveBeenCalled(); // NOT re-armed
    expect(res.json).not.toHaveBeenCalled();
  });

  it('a confirm reply still starts exploration regardless of prior otherCount', async () => {
    mockGet.mockResolvedValue(pending(1));
    mockClassify.mockResolvedValue('confirm');
    const res = mockRes();

    const handled = await handlePendingExplorationConfirmation({} as any, res, 'yes go', 's1', 'u1', 'w1');

    expect(handled).toBe(true);
    expect(mockDel).toHaveBeenCalled(); // pending consumed
  });
});
