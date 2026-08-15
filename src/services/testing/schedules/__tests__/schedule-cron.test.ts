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

  it('resolves midnight in UTC', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T12:00:00Z'));

    const next = new Date(ScheduleService.calculateNextRun('0 0 * * *', 'UTC'));

    expect(next.toISOString()).toBe('2026-06-16T00:00:00.000Z');
    jest.useRealTimers();
  });

  it('resolves midnight in a non-UTC timezone', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T12:00:00Z'));

    const next = new Date(ScheduleService.calculateNextRun('0 0 * * *', 'Asia/Almaty'));

    expect(next.toISOString()).toBe('2026-06-15T19:00:00.000Z');
    jest.useRealTimers();
  });

  // Regression (Bug #3): a LATE-hour cron in a positive-offset tz used to be
  // misclassified "unsatisfiable" because the DST-gap guard compared the
  // calendar DAY instead of HOUR:MINUTE — the Newton correction legitimately
  // rolls 23:00 Asia/Almaty to the NEXT UTC day (18:00Z), which the guard read
  // as a non-existent local time and returned EPOCH for every candidate.
  // Effect: any schedule at hour >= (24 - offset) silently never fired
  // ("I set 23:00 and nothing runs"). Guard now verifies HOUR:MINUTE.
  it('resolves a late-hour cron in a +offset tz (23:00 Asia/Almaty → 18:00 UTC), not unsatisfiable', () => {
    const iso = ScheduleService.calculateNextRun('0 23 * * *', 'Asia/Almaty');
    const d = new Date(iso);
    expect(d.getUTCHours()).toBe(18); // 23:00 +05:00 == 18:00Z
    expect(d.getUTCMinutes()).toBe(0);
    // and it actually reads back as 23:00 in Almaty
    const hh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Almaty', hour: '2-digit', hour12: false }).format(d);
    expect(hh).toBe('23');
  });

  it('resolves the boundary hour 19:00 Asia/Almaty (= 14:00 UTC)', () => {
    const d = new Date(ScheduleService.calculateNextRun('0 19 * * *', 'Asia/Almaty'));
    expect(d.getUTCHours()).toBe(14);
  });

  it('falls back to UTC on an unknown timezone', () => {
    const utc = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'UTC')).getUTCHours();
    const bogus = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'Mars/Olympus')).getUTCHours();
    expect(bogus).toBe(utc);
  });
});

describe('ScheduleService — day-wrap in the timezone Newton correction (Bug #4)', () => {
  // The Newton diff in buildDateInTimezone used ONLY hour*60+minute. When the
  // UTC guess's wall clock rolls into an adjacent local day, the minute-only
  // diff is off by exactly 1440 — e.g. a 21:30 Asia/Almaty guess shows 02:30
  // the NEXT local day, so UTC+5 was read as UTC-19 and the returned instant
  // landed 24h late. First computation after create/update therefore skipped
  // a whole day whenever today's late-hour occurrence was still ahead.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('late-hour cron in a +offset tz still ahead today resolves to TODAY (21:30 Asia/Almaty)', () => {
    // 05:00Z = 10:00 in Almaty (UTC+5) — today's 21:30 local (16:30Z) is ahead.
    jest.setSystemTime(new Date('2026-06-15T05:00:00Z'));
    const next = ScheduleService.calculateNextRun('30 21 * * *', 'Asia/Almaty');
    expect(new Date(next).toISOString()).toBe('2026-06-15T16:30:00.000Z');
  });

  it('early-hour dow-restricted cron in a -offset tz fires on the right local day (Mon 02:00 America/New_York)', () => {
    // Symmetric case: the guess shows the PREVIOUS local day, landing 24h
    // early. For a daily cron the scan loop masked that, but a dow-restricted
    // cron returned an instant that is the wrong weekday locally and skipped
    // this week's occurrence entirely.
    // 2026-06-15 is a Monday. 01:00Z = Sun 21:00 in NY (EDT, UTC-4) —
    // Monday 02:00 local (06:00Z) is still ahead.
    jest.setSystemTime(new Date('2026-06-15T01:00:00Z'));
    const next = ScheduleService.calculateNextRun('0 2 * * 1', 'America/New_York');
    expect(new Date(next).toISOString()).toBe('2026-06-15T06:00:00.000Z');
  });

  it('DST spring-forward gap guard intact: non-existent local time is skipped, not fired', () => {
    // NY 2026-03-08 02:30 does not exist (clock jumps 2:00 → 3:00). POSIX cron
    // skips it; the next 03-08 02:30 that exists is 2027 (EST, UTC-5 → 07:30Z).
    jest.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    const next = ScheduleService.calculateNextRunOrNull('30 2 8 3 *', 'America/New_York');
    expect(next).not.toBeNull();
    expect(new Date(next!).toISOString()).toBe('2027-03-08T07:30:00.000Z');
  });

  // The day scan must enumerate LOCAL calendar days, not raw 24h UTC steps.
  // On 2026-03-08 NY springs forward (local day is only 23h). Stepping by exactly
  // 24h UTC drifts and could skip that local day entirely, dropping a late-hour
  // daily run that DOES exist (23:30 is after the gap, so it occurs normally).
  it('late-hour daily cron does NOT skip the 23h spring-forward local day (23:30 NY, 2026-03-08)', () => {
    // Anchor just after the Mar 7 23:30 fire so the next is Mar 8 23:30 — which
    // must NOT be skipped despite Mar 8 being a 23h local day.
    jest.setSystemTime(new Date('2026-03-08T05:00:00Z')); // Mar 8 00:00 EST, before 23:30 local
    const next = ScheduleService.calculateNextRun('30 23 * * *', 'America/New_York');
    // Mar 8 23:30 EDT (UTC-4 after the jump) = 2026-03-09T03:30Z.
    expect(new Date(next).toISOString()).toBe('2026-03-09T03:30:00.000Z');
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
