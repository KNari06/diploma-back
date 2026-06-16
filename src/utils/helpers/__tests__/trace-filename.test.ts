import { localTraceFilenameParts } from '../trace-filename';

describe('localTraceFilenameParts', () => {
  it('formats local date and time with zero-padding', () => {
    // Constructed in LOCAL time; the helper reads local getters, so this is
    // deterministic regardless of the machine timezone.
    const date = new Date(2026, 0, 5, 9, 3, 7); // 2026-01-05 09:03:07 local
    expect(localTraceFilenameParts(date)).toEqual({ datePart: '2026-01-05', timePart: '09-03-07' });
  });

  it('handles two-digit month/day/time', () => {
    const date = new Date(2026, 11, 31, 22, 23, 35); // 2026-12-31 22:23:35 local
    expect(localTraceFilenameParts(date)).toEqual({ datePart: '2026-12-31', timePart: '22-23-35' });
  });

  it('produces a colon-free, filesystem-safe time part', () => {
    const { timePart } = localTraceFilenameParts(new Date(2026, 5, 16, 22, 23, 35));
    expect(timePart).not.toContain(':');
    expect(timePart).toMatch(/^\d{2}-\d{2}-\d{2}$/);
  });
});
