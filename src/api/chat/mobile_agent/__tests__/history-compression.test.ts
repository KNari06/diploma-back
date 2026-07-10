import { compressHistoryTurns, type HistoryTurn } from '../history-compression';

const turn = (role: 'user' | 'assistant', content: string): HistoryTurn => ({ role, content });

describe('compressHistoryTurns', () => {
  it('returns [] for empty history', () => {
    expect(compressHistoryTurns([])).toEqual([]);
  });

  it('keeps everything verbatim when at or under the verbatim count', () => {
    const turns = Array.from({ length: 6 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `m${i}`));
    const out = compressHistoryTurns(turns, { verbatimCount: 8 });
    expect(out).toHaveLength(6);
    expect(out.every((m) => m.role !== 'system')).toBe(true);
  });

  it('compresses older turns into ONE leading system block and keeps the recent tail verbatim', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `msg-${i}`));
    const out = compressHistoryTurns(turns, { verbatimCount: 8 });
    // 1 summary + 8 verbatim = 9.
    expect(out).toHaveLength(9);
    expect(out[0].role).toBe('system');
    expect(String(out[0].content)).toMatch(/Earlier conversation/);
    // The summary must reference an OLD turn (msg-0), proving ~20-back is reachable.
    expect(String(out[0].content)).toContain('msg-0');
    // The tail is the last 8, verbatim, in order.
    const tail = out.slice(1);
    expect(tail).toHaveLength(8);
    expect(String(tail[tail.length - 1].content)).toBe('msg-19');
    expect(tail.every((m) => m.role !== 'system')).toBe(true);
  });

  it('truncates long older turns in the summary to previewChars', () => {
    const long = 'x'.repeat(500);
    const turns = [turn('user', long), ...Array.from({ length: 8 }, (_, i) => turn('user', `t${i}`))];
    const out = compressHistoryTurns(turns, { verbatimCount: 8, previewChars: 50 });
    const summary = String(out[0].content);
    // 500-char turn is truncated with an ellipsis, not shipped whole.
    expect(summary).toContain('…');
    expect(summary).not.toContain('x'.repeat(200));
  });

  it('labels roles as User / Assistant in the summary', () => {
    const turns = [
      turn('user', 'old ask'),
      turn('assistant', 'old reply'),
      ...Array.from({ length: 8 }, (_, i) => turn('user', `t${i}`)),
    ];
    const out = compressHistoryTurns(turns, { verbatimCount: 8 });
    const summary = String(out[0].content);
    expect(summary).toContain('User: old ask');
    expect(summary).toContain('Assistant: old reply');
  });
});
