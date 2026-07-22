/**
 * Tests for the mobile clarification routing registry — the map that lets an
 * `exploration:clarification:response` (which only carries {questionId, answer})
 * find the runner runId to POST the answer back to. It must: store keyed by
 * questionId, read-and-delete one-shot (a replayed answer can't double-route),
 * return null on a miss, and never throw on a Redis failure (fail-closed).
 */
const mockGet = jest.fn();
const mockDel = jest.fn();
const mockSet = jest.fn();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: (...a: unknown[]) => mockGet(...a),
    del: (...a: unknown[]) => mockDel(...a),
    set: (...a: unknown[]) => mockSet(...a),
  },
}));

import {
  storeMobileClarificationRoute,
  takeMobileClarificationRoute,
} from '../mobile-clarification-route.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockDel.mockResolvedValue(1);
});

describe('mobile clarification route registry', () => {
  it('stores the route keyed by questionId with a TTL', async () => {
    mockSet.mockResolvedValue('OK');
    await storeMobileClarificationRoute('q1', { runId: 'run-1', userId: 'u1' }, 90);
    expect(mockSet).toHaveBeenCalledWith(
      'mobile:clarification:route:q1',
      JSON.stringify({ runId: 'run-1', userId: 'u1' }),
      'EX',
      90,
    );
  });

  it('reads and one-shot-deletes the route for the owning user', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ runId: 'run-1', userId: 'u1' }));
    const route = await takeMobileClarificationRoute('q1', 'u1');
    expect(route).toEqual({ runId: 'run-1', userId: 'u1' });
    expect(mockDel).toHaveBeenCalledWith('mobile:clarification:route:q1');
  });

  it('refuses a non-owner and does NOT delete the entry (no DoS of the owner)', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ runId: 'run-1', userId: 'u1' }));
    const route = await takeMobileClarificationRoute('q1', 'attacker');
    expect(route).toBeNull();
    expect(mockDel).not.toHaveBeenCalled(); // owner's pending answer survives
  });

  it('refuses an identified user answering an anonymous-owned run', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ runId: 'run-1' })); // no userId
    expect(await takeMobileClarificationRoute('q1', 'u1')).toBeNull();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('allows an anonymous socket to answer its own anonymous run', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ runId: 'run-1' })); // no userId
    const route = await takeMobileClarificationRoute('q1', undefined);
    expect(route).toEqual({ runId: 'run-1' });
    expect(mockDel).toHaveBeenCalled();
  });

  it('returns null on a miss (web captcha/2FA question)', async () => {
    mockGet.mockResolvedValue(null);
    expect(await takeMobileClarificationRoute('nope', 'u1')).toBeNull();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('never throws when Redis read fails — returns null (fail-closed)', async () => {
    mockGet.mockRejectedValue(new Error('redis down'));
    expect(await takeMobileClarificationRoute('q1', 'u1')).toBeNull();
  });

  it('never throws when Redis write fails', async () => {
    mockSet.mockRejectedValue(new Error('redis down'));
    await expect(
      storeMobileClarificationRoute('q1', { runId: 'run-1' }),
    ).resolves.toBeUndefined();
  });

  it('clamps a sub-second TTL to at least 1', async () => {
    mockSet.mockResolvedValue('OK');
    await storeMobileClarificationRoute('q1', { runId: 'r' }, 0.2);
    expect(mockSet).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 1);
  });
});
