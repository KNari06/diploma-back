import {
  priorityRank,
  resolveTestCasePriorityForTestId,
  _resetPriorityCacheForTests,
  _getPriorityCacheSizeForTests,
} from '../resolve-test-case-priority.util';
import { fetchPriorityByTestId } from '../db/regression.db';

jest.mock('../db/regression.db', () => ({
  fetchPriorityByTestId: jest.fn(),
}));

const mockFetch = fetchPriorityByTestId as jest.MockedFunction<typeof fetchPriorityByTestId>;

beforeEach(() => {
  _resetPriorityCacheForTests();
  mockFetch.mockReset();
});

describe('priorityRank', () => {
  it('ranks known priorities critical=0 … low=3', () => {
    expect(priorityRank('critical')).toBe(0);
    expect(priorityRank('high')).toBe(1);
    expect(priorityRank('medium')).toBe(2);
    expect(priorityRank('low')).toBe(3);
  });

  it('is case-insensitive', () => {
    expect(priorityRank('CRITICAL')).toBe(0);
  });

  it('collapses null / undefined / unknown to the medium bucket', () => {
    expect(priorityRank(null)).toBe(2);
    expect(priorityRank(undefined)).toBe(2);
    expect(priorityRank('')).toBe(2);
    expect(priorityRank('bogus')).toBe(2);
  });
});

describe('resolveTestCasePriorityForTestId', () => {
  it('returns undefined for an empty testId without hitting the db', async () => {
    expect(await resolveTestCasePriorityForTestId('')).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a valid priority from the db', async () => {
    mockFetch.mockResolvedValue('high' as any);
    expect(await resolveTestCasePriorityForTestId('t1')).toBe('high');
  });

  it('coerces an invalid db value to undefined', async () => {
    mockFetch.mockResolvedValue('garbage' as any);
    expect(await resolveTestCasePriorityForTestId('t1')).toBeUndefined();
  });

  it('fails open (undefined) when the db throws', async () => {
    mockFetch.mockRejectedValue(new Error('db down'));
    expect(await resolveTestCasePriorityForTestId('t1')).toBeUndefined();
  });

  it('caches the result so a repeated lookup does not hit the db again', async () => {
    mockFetch.mockResolvedValue('critical' as any);
    await resolveTestCasePriorityForTestId('t1');
    await resolveTestCasePriorityForTestId('t1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches an undefined result too (ad-hoc runs)', async () => {
    mockFetch.mockResolvedValue(null as any);
    expect(await resolveTestCasePriorityForTestId('t1')).toBeUndefined();
    expect(await resolveTestCasePriorityForTestId('t1')).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('singleflights concurrent lookups for the same id', async () => {
    mockFetch.mockResolvedValue('low' as any);
    const [a, b] = await Promise.all([
      resolveTestCasePriorityForTestId('t1'),
      resolveTestCasePriorityForTestId('t1'),
    ]);
    expect(a).toBe('low');
    expect(b).toBe('low');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('populates the cache and _resetPriorityCacheForTests clears it', async () => {
    mockFetch.mockResolvedValue('high' as any);
    await resolveTestCasePriorityForTestId('t1');
    expect(_getPriorityCacheSizeForTests()).toBe(1);
    _resetPriorityCacheForTests();
    expect(_getPriorityCacheSizeForTests()).toBe(0);
  });
});
