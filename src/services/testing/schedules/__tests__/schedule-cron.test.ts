/**
 * Unit tests for the cron engine in ScheduleService.
 *
 * `parseCron` and `calculateNextRun` are pure (no DB / no clock injection
 * beyond `new Date()`), so these tests need no mocks. They pin the contract
 * that the scheduler relies on every minute: a valid cron always yields a
 * next-run STRICTLY in the future, invalid crons are rejected, and timezones
 * are honoured.
 *
 * The scheduler process itself was historically untested — these tests close
 * the gap that let cron regressions ship unnoticed.
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
    expect(ScheduleService.parseCron('60 9 * * *')).toBeNull(); // minute 60
    expect(ScheduleService.parseCron('0 24 * * *')).toBeNull(); // hour 24
    expect(ScheduleService.parseCron('0 9 32 * *')).toBeNull(); // dom 32
    expect(ScheduleService.parseCron('0 9 * 13 *')).toBeNull(); // month 13
  });

  it('materialises a wildcard into the full range', () => {
    const parsed = ScheduleService.parseCron('* * * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.minutes.size).toBe(60);
    expect(parsed!.hours.size).toBe(24);
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

  it('rejects malformed lists and reversed ranges', () => {
    expect(ScheduleService.parseCron('1,,3 9 * * *')).toBeNull();
    expect(ScheduleService.parseCron('5-1 9 * * *')).toBeNull();
  });
});

describe('ScheduleService.calculateNextRun', () => {
  it('always returns a timestamp strictly in the future for a valid cron', () => {
    const before = Date.now();
    const next = new Date(ScheduleService.calculateNextRun('* * * * *', 'UTC')).getTime();
    expect(next).toBeGreaterThan(before);
  });

  it('an every-minute cron schedules within the next minute', () => {
    const now = Date.now();
    const next = new Date(ScheduleService.calculateNextRun('* * * * *', 'UTC')).getTime();
    // Next minute boundary is at most 60s away.
    expect(next - now).toBeLessThanOrEqual(60_000);
    expect(next - now).toBeGreaterThan(0);
  });

  it('a daily cron lands on a :00:00 second boundary', () => {
    const next = new Date(ScheduleService.calculateNextRun('30 14 * * *', 'UTC'));
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMinutes()).toBe(30);
    expect(next.getUTCHours()).toBe(14);
  });

  it('honours a non-UTC timezone (Asia/Almaty, UTC+5)', () => {
    // 09:00 Almaty == 04:00 UTC.
    const next = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'Asia/Almaty'));
    expect(next.getUTCHours()).toBe(4);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it('falls back to +1h on an invalid cron instead of throwing', () => {
    const now = Date.now();
    const next = new Date(ScheduleService.calculateNextRun('not a cron', 'UTC')).getTime();
    // ~1h ahead (allow scheduling jitter).
    expect(next - now).toBeGreaterThan(59 * 60_000);
    expect(next - now).toBeLessThan(61 * 60_000);
  });

  it('falls back to UTC on an unknown timezone', () => {
    const utc = new Date(ScheduleService.calculateNextRun('0 9 * * *', 'UTC')).getUTCHours();
    const bogus = new Date(
      ScheduleService.calculateNextRun('0 9 * * *', 'Mars/Olympus'),
    ).getUTCHours();
    expect(bogus).toBe(utc);
  });
});
