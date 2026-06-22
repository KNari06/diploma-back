import { logBuffer, type BufferedLogEntry } from '../log-buffer';

// logBuffer is a process-wide singleton with no reset method, so each test
// anchors on the seq cursor captured at its start to stay independent of any
// entries left by earlier tests.
const push = (over: Partial<Omit<BufferedLogEntry, 'seq'>> = {}) =>
  logBuffer.push({
    timestamp: '2026-06-17T00:00:00.000Z',
    level: 'info',
    message: 'msg',
    ...over,
  });

describe('logBuffer', () => {
  it('assigns a strictly increasing seq to each pushed entry', () => {
    const before = logBuffer.latestSeq();
    push();
    push();
    const recent = logBuffer.query({ sinceSeq: before });
    expect(recent).toHaveLength(2);
    // query returns newest-first
    expect(recent[0].seq).toBe(before + 2);
    expect(recent[1].seq).toBe(before + 1);
  });

  it('returns only entries newer than the cursor, newest first', () => {
    const cursor = logBuffer.latestSeq();
    push({ message: 'a' });
    push({ message: 'b' });
    const result = logBuffer.query({ sinceSeq: cursor });
    expect(result.map((e) => e.message)).toEqual(['b', 'a']);
  });

  it('filters by exact level', () => {
    const cursor = logBuffer.latestSeq();
    push({ level: 'info', message: 'i' });
    push({ level: 'error', message: 'e' });
    push({ level: 'warn', message: 'w' });
    const errors = logBuffer.query({ sinceSeq: cursor, level: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('e');
  });

  it('caps results at the requested limit', () => {
    const cursor = logBuffer.latestSeq();
    for (let i = 0; i < 5; i++) push({ message: `m${i}` });
    const result = logBuffer.query({ sinceSeq: cursor, limit: 2 });
    expect(result).toHaveLength(2);
  });

  it('clamps an over-large limit to 1000 and a non-positive limit to at least 1', () => {
    const cursor = logBuffer.latestSeq();
    push();
    expect(logBuffer.query({ sinceSeq: cursor, limit: 99999 }).length).toBeLessThanOrEqual(1000);
    expect(logBuffer.query({ sinceSeq: cursor, limit: 0 }).length).toBeGreaterThanOrEqual(1);
  });

  it('reports latestSeq as the highest stored seq', () => {
    push();
    const latest = logBuffer.latestSeq();
    push();
    expect(logBuffer.latestSeq()).toBe(latest + 1);
  });

  it('notifies subscribers on push and stops after unsubscribe', () => {
    const seen: string[] = [];
    const unsub = logBuffer.subscribe((e) => seen.push(e.message));
    push({ message: 'first' });
    unsub();
    push({ message: 'second' });
    expect(seen).toContain('first');
    expect(seen).not.toContain('second');
  });

  it('keeps logging even when a subscriber throws', () => {
    const cursor = logBuffer.latestSeq();
    const unsub = logBuffer.subscribe(() => {
      throw new Error('listener boom');
    });
    expect(() => push({ message: 'safe' })).not.toThrow();
    unsub();
    expect(logBuffer.query({ sinceSeq: cursor }).some((e) => e.message === 'safe')).toBe(true);
  });
});
