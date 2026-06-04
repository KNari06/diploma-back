/**
 * Unit tests for the cron engine in ScheduleService.
 *
 * `parseCron` / `calculateNextRun` / `calculateNextRunOrNull` are pure (no DB),
 * so these need no mocks. They pin the contract the scheduler relies on every
 * minute: a valid cron yields a strictly-future next-run; POSIX DOM/DOW OR
 * semantics; unsatisfiable crons are rejected (not run daily); timezones honoured.
 */

import { ScheduleService } from '../schedule.service';

describe('ScheduleService.parseCron', () => {
  it('accepts a standard 5-field expression', () => {
    expect(ScheduleService.parseCron('0 9 * * 1')).not.toBeNull();
  });

  it('rejects expressions without exactly 5 fields', () => {
    expect(ScheduleService.parseCron('0 9 * *')).toBeNull();
    expect(ScheduleService.parseCron('0 9 * * 1 2')).toBeNull();
    expect(ScheduleService.parseCron('')).toBeNull();
  });

  it('rejects out-of-range field values', () => {
    expect(ScheduleService.parseCron('60 9 * * *')).toBeNull();
    expect(ScheduleService.parseCron('0 24 * * *')).toBeNull();
    expect(ScheduleService.parseCron('0 9 32 * *')).toBeNull();
    expect(ScheduleService.parseCron('0 9 * 13 *')).toBeNull();
  });

  it('materialises a wildcard into the full range', () => {
    const parsed = ScheduleService.parseCron('* * * * *');
    expect(parsed!.minutes.size).toBe(60);
    expect(parsed!.hours.size).toBe(24);
  });

  it('dow wildcard normalises to exactly 7 values (0..6) — the OR-detection sentinel', () => {
    // calculateNextRun uses dows.size !== 7 to detect "dow restricted".
    // '*' for dow must therefore be size 7 after the 7→0 normalisation.
    const parsed = ScheduleService.parseCron('* * * * *');
    expect(parsed!.dows.size).toBe(7);
    expect(parsed!.doms.size).toBe(31);
  });

  it('expands step values', () => {
    const parsed = ScheduleService.parseCron('*/15 * * * *');
    expect([...parsed!.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('expands ranges and comma lists', () => {
    const parsed = ScheduleService.parseCron('0 9 * * 1-3,5');
    expect([...parsed!.dows].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
  });

  it('normalises dow=7 (Sunday alias) to 0', () => {
    const parsed = ScheduleService.parseCron('0 9 * * 7');
    expect(parsed!.dows.has(0)).toBe(true);
    expect(parsed!.dows.has(7)).toBe(false);
  });
});

describe('ScheduleService.calculateNextRun', () => {
  it('always returns a timestamp strictly in the future for a valid cron', () => {
    const before = Date.now();
    const next = new Date(ScheduleService.calculateNextRun('* * * * *', 'UTC')).getTime();
    expect(next).toBeGreaterThan(before);
  });

  it('a daily cron lands on the right :00 second / minute / hour', () => {
    const next = new Date(ScheduleService.calculateNextRun('30 14 * * *', 'UTC'));
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMinutes()).toBe(30);
    expect(next.getUTCHours()).toBe(14);
  });

  it('honours a non-UTC timezone (Asia/Almaty, UTC+5)', () => {
    const next = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'Asia/Almaty'));
    expect(next.getUTCHours()).toBe(4);
  });

  it('falls back to UTC on an unknown timezone', () => {
    const utc = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'UTC')).getUTCHours();
    const bogus = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'Mars/Olympus')).getUTCHours();
    expect(bogus).toBe(utc);
  });
});

describe('ScheduleService — POSIX DOM/DOW OR semantics (Bug #1)', () => {
  // When BOTH day-of-month and day-of-week are restricted, a day matches if
  // EITHER matches. "0 0 13 * 5" = every 13th OR every Friday.
  it('fires on a Friday that is NOT the 13th (OR, not AND)', () => {
    // 2027-08-13 is a Friday the 13th; but the cron must also fire on, e.g.,
    // the very next matching day which could be a non-13th Friday or a
    // non-Friday 13th. Simplest pin: the next run from a fixed point is within
    // ~days, never requiring a Friday-AND-13th intersection (which is months out).
    const next = new Date(ScheduleService.calculateNextRun('0 0 13 * 5', 'UTC'));
    const isThe13th = next.getUTCDate() === 13;
    const isFriday = next.getUTCDay() === 5;
    expect(isThe13th || isFriday).toBe(true);
    // And it must NOT require both at once — the next match is at most a week
    // away (next Friday) or to the 13th, whichever is sooner — always < 32 days.
    expect(next.getTime() - Date.now()).toBeLessThan(32 * 24 * 60 * 60 * 1000);
  });

  it('with dom=* still ANDs correctly (dow alone gates)', () => {
    // "0 9 * * 1" = every Monday. dom unrestricted → dowMatch alone decides.
    const next = new Date(ScheduleService.calculateNextRun('0 9 * * 1', 'UTC'));
    expect(next.getUTCDay()).toBe(1);
  });

  it('with dow=* still ANDs correctly (dom alone gates)', () => {
    // "0 9 15 * *" = the 15th of every month.
    const next = new Date(ScheduleService.calculateNextRun('0 9 15 * *', 'UTC'));
    expect(next.getUTCDate()).toBe(15);
  });
});

describe('ScheduleService — unsatisfiable crons (Bug #2)', () => {
  it('calculateNextRunOrNull returns null for an impossible date (Feb 30)', () => {
    expect(ScheduleService.calculateNextRunOrNull('0 9 30 2 *', 'UTC')).toBeNull();
  });

  it('calculateNextRunOrNull returns null for April 31', () => {
    expect(ScheduleService.calculateNextRunOrNull('0 9 31 4 *', 'UTC')).toBeNull();
  });

  it('calculateNextRun THROWS (not +24h daily fallback) on an impossible cron', () => {
    expect(() => ScheduleService.calculateNextRun('0 9 30 2 *', 'UTC')).toThrow(/Unsatisfiable/);
  });

  it('a valid leap-day cron (Feb 29) still resolves within the 1500-day scan', () => {
    // Must NOT be flagged unsatisfiable — the next Feb 29 is <= ~1461 days out.
    const next = ScheduleService.calculateNextRunOrNull('0 9 29 2 *', 'UTC');
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getUTCMonth()).toBe(1); // February (0-indexed)
    expect(d.getUTCDate()).toBe(29);
  });
});
