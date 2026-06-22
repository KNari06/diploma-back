import {
  convertRoleForOpenAI,
  convertMessagesForOpenAI,
  convertRoleForDatabase,
  formatRelativeGap,
  injectTemporalMarkers,
} from '../chat-helpers';

describe('convertRoleForOpenAI', () => {
  it("maps the database 'ai' role to OpenAI 'assistant'", () => {
    expect(convertRoleForOpenAI('ai')).toBe('assistant');
  });

  it('passes through roles that are already valid OpenAI roles', () => {
    expect(convertRoleForOpenAI('user')).toBe('user');
    expect(convertRoleForOpenAI('assistant')).toBe('assistant');
    expect(convertRoleForOpenAI('system')).toBe('system');
    expect(convertRoleForOpenAI('tool')).toBe('tool');
    expect(convertRoleForOpenAI('function')).toBe('function');
    expect(convertRoleForOpenAI('developer')).toBe('developer');
  });

  it("falls back to 'user' for an unknown role", () => {
    expect(convertRoleForOpenAI('robot')).toBe('user');
    expect(convertRoleForOpenAI('')).toBe('user');
  });
});

describe('convertMessagesForOpenAI', () => {
  it('converts roles and keeps content for every message', () => {
    const result = convertMessagesForOpenAI([
      { role: 'ai', content: 'hi' },
      { role: 'user', content: 'hello' },
    ]);
    expect(result).toEqual([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('drops extra fields, keeping only role and content', () => {
    const result = convertMessagesForOpenAI([
      { role: 'ai', content: 'x', id: 1, created_at: 'now' },
    ]);
    expect(result).toEqual([{ role: 'assistant', content: 'x' }]);
  });
});

describe('convertRoleForDatabase', () => {
  it("maps OpenAI 'assistant' back to database 'ai'", () => {
    expect(convertRoleForDatabase('assistant')).toBe('ai');
  });

  it("passes through 'user' and 'system'", () => {
    expect(convertRoleForDatabase('user')).toBe('user');
    expect(convertRoleForDatabase('system')).toBe('system');
  });

  it("maps function/tool/developer to 'system'", () => {
    expect(convertRoleForDatabase('function')).toBe('system');
    expect(convertRoleForDatabase('tool')).toBe('system');
    expect(convertRoleForDatabase('developer')).toBe('system');
  });
});

describe('formatRelativeGap', () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('formats sub-hour gaps in minutes', () => {
    expect(formatRelativeGap(25 * MIN)).toBe('25m');
    expect(formatRelativeGap(0)).toBe('0m');
  });

  it('formats sub-day gaps in hours', () => {
    expect(formatRelativeGap(3 * HOUR)).toBe('3h');
  });

  it('formats sub-week gaps in days', () => {
    expect(formatRelativeGap(2 * DAY)).toBe('2d');
  });

  it('formats week-plus gaps in weeks', () => {
    expect(formatRelativeGap(14 * DAY)).toBe('2w');
  });
});

describe('injectTemporalMarkers', () => {
  it('returns an empty array for no messages', () => {
    expect(injectTemporalMarkers([])).toEqual([]);
  });

  it('always prefixes the first message with a date marker', () => {
    const result = injectTemporalMarkers([
      { role: 'user', content: 'first', created_at: '2026-02-25T14:30:00.000Z' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toMatch(/^\[.+\] first$/);
  });

  it('leaves messages within the threshold unchanged (no token overhead)', () => {
    const result = injectTemporalMarkers([
      { role: 'user', content: 'a', created_at: '2026-02-25T14:30:00.000Z' },
      { role: 'assistant', content: 'b', created_at: '2026-02-25T14:35:00.000Z' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ role: 'assistant', content: 'b' });
  });

  it('inserts a separator and date prefix when the gap exceeds the threshold', () => {
    const result = injectTemporalMarkers(
      [
        { role: 'user', content: 'a', created_at: '2026-02-25T14:30:00.000Z' },
        { role: 'assistant', content: 'b', created_at: '2026-02-27T14:30:00.000Z' },
      ],
      4 * 60 * 60 * 1000,
    );
    // first (prefixed) + separator + second (prefixed) = 3 entries
    expect(result).toHaveLength(3);
    expect(result[1].role).toBe('system');
    expect(result[1].content).toBe('── 2d later ──');
    expect(result[2].content).toMatch(/^\[.+\] b$/);
  });
});
