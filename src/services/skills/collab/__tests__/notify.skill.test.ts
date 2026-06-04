/**
 * Unit tests for the notify skill (notify_owner).
 * Mocks at the service boundary: telegram/slack senders, NotificationService,
 * and the Redis connection used for dedup.
 */

import type { SkillContext } from '../../types';

// ── Mocks (must be declared before importing the skill) ──────────────────────
const mockGetTelegramToken = jest.fn();
const mockSendTelegramMessage = jest.fn();
const mockGetSlackToken = jest.fn();
const mockSendSlackMessage = jest.fn();
const mockCreateNotification = jest.fn();
const mockRedisSet = jest.fn();

jest.mock('@/services/api/telegram.service', () => ({
  getTelegramToken: (...a: any[]) => mockGetTelegramToken(...a),
  sendMessage: (...a: any[]) => mockSendTelegramMessage(...a),
}));
jest.mock('@/services/api/slack.service', () => ({
  getSlackToken: (...a: any[]) => mockGetSlackToken(...a),
  sendSlackMessage: (...a: any[]) => mockSendSlackMessage(...a),
}));
jest.mock('@/services/notifications/notification.service', () => ({
  NotificationService: { createNotification: (...a: any[]) => mockCreateNotification(...a) },
}));
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { set: (...a: any[]) => mockRedisSet(...a) },
}));

import { NotifySkill, resolveOwnerToUserIds, escapeTelegramHtml } from '../notify.skill';

const ctx: SkillContext = {
  userId: 'u-123',
  workspaceId: 'ws-1',
  chatSessionId: 's-1',
};

const run = (args: Record<string, any>) => NotifySkill.execute('notify_owner', args, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  // Default: not a duplicate (SET NX returns 'OK' when newly set).
  mockRedisSet.mockResolvedValue('OK');
  // Default: no connected channels.
  mockGetTelegramToken.mockResolvedValue(null);
  mockGetSlackToken.mockResolvedValue(null);
  mockCreateNotification.mockResolvedValue({ id: 'n-1' });
});

describe('resolveOwnerToUserIds', () => {
  it('maps "me" and empty to the calling user', () => {
    expect(resolveOwnerToUserIds('me', ctx)).toEqual(['u-123']);
    expect(resolveOwnerToUserIds('', ctx)).toEqual(['u-123']);
    expect(resolveOwnerToUserIds('ME', ctx)).toEqual(['u-123']);
  });

  it('maps "user:<id>" to that id', () => {
    expect(resolveOwnerToUserIds('user:abc', ctx)).toEqual(['abc']);
  });

  it('returns [] for unsupported forms', () => {
    expect(resolveOwnerToUserIds('project:p1', ctx)).toEqual([]);
    expect(resolveOwnerToUserIds('codeowner:/x', ctx)).toEqual([]);
    expect(resolveOwnerToUserIds('user:', ctx)).toEqual([]);
  });
});

describe('escapeTelegramHtml', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('notify_owner', () => {
  it('returns an error when title or message is missing', async () => {
    const r = await run({ title: '', message: 'x' });
    expect(r.success).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('returns an error for an unresolvable owner', async () => {
    const r = await run({ owner_ref: 'project:p1', title: 't', message: 'm' });
    expect(r.success).toBe(false);
    expect(r.message).toContain('Cannot resolve owner');
  });

  it('always sends in-app even with no connected channels', async () => {
    const r = await run({ title: 'Run failed', message: 'details' });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
    expect(r.data?.channels).toContain('in_app');
  });

  it('sends to telegram (HTML-escaped) when connected', async () => {
    mockGetTelegramToken.mockResolvedValue({ access_token: 'bot', external_id: '42' });
    await run({ title: 'a<b', message: 'c&d', level: 'error' });
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    const body = mockSendTelegramMessage.mock.calls[0][2] as string;
    expect(body).toContain('a&lt;b');
    expect(body).toContain('c&amp;d');
    expect(body).not.toContain('a<b'); // raw unescaped must not leak
  });

  it('is best-effort: telegram error does not stop slack/in-app', async () => {
    mockGetTelegramToken.mockResolvedValue({ access_token: 'bot', external_id: '42' });
    mockSendTelegramMessage.mockRejectedValue(new Error('telegram 400'));
    mockGetSlackToken.mockResolvedValue({ access_token: 'https://hooks.slack.com/x' });
    const r = await run({ title: 't', message: 'm' });
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true); // slack + in-app succeeded
    expect(r.data?.failed).toBe(1); // telegram counted as failed
  });

  it('skips a duplicate send within the dedup window', async () => {
    mockRedisSet.mockResolvedValue(null); // NX → null means key already existed
    const r = await run({ title: 't', message: 'm' });
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
    expect(r.data?.deduped).toBe(true);
  });

  it('still sends if redis dedup check throws', async () => {
    mockRedisSet.mockRejectedValue(new Error('redis down'));
    const r = await run({ title: 't', message: 'm' });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
  });

  it('rejects an unknown tool name', async () => {
    const r = await NotifySkill.execute('nope', {}, ctx);
    expect(r.success).toBe(false);
    expect(r.message).toContain('Unknown notify tool');
  });
});
