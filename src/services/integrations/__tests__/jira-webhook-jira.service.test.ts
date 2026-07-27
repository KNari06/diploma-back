import { JiraWebhookService } from '../jira-webhook-jira.service';

// Mock the db/ boundary. effectiveTriggerStatuses is the real impl.
jest.mock('../db/jira-webhook.db', () => {
  const actual = jest.requireActual('../db/jira-webhook.db');
  return { ...actual, findProjectsForJiraKey: jest.fn(), getOwnerJiraSiteHosts: jest.fn().mockResolvedValue([]) };
});
// Mock the Redis handle so claimAssessment is deterministic.
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { set: jest.fn().mockResolvedValue('OK') },
}));
import { findProjectsForJiraKey, getOwnerJiraSiteHosts } from '../db/jira-webhook.db';
import { redisConnection } from '@/config/infrastructure/queues';

// Event where status transitioned INTO "Ready to test" (id 10007), site acme.atlassian.net.
const evt = (over: Record<string, any> = {}) => ({
  webhookEvent: 'jira:issue_updated',
  issue: {
    key: 'KAN-1',
    self: 'https://acme.atlassian.net/rest/api/3/issue/10001',
    fields: { project: { key: 'KAN' }, status: { id: '10007', name: 'Ready to test' } },
  },
  changelog: { items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '10007', toString: 'Ready to test' }] },
  ...over,
});

describe('JiraWebhookService.verifySecret', () => {
  it('accepts an exact match; rejects mismatch/empty', () => {
    expect(JiraWebhookService.verifySecret('s3cr3t', 's3cr3t')).toBe(true);
    expect(JiraWebhookService.verifySecret('nope', 's3cr3t')).toBe(false);
    expect(JiraWebhookService.verifySecret(undefined, 's3cr3t')).toBe(false);
  });
});

describe('JiraWebhookService.parse + matchTrigger', () => {
  it('captures the transitioned-to status id + name', () => {
    const p = JiraWebhookService.parse(evt());
    expect(p.transitionedTo).toEqual([{ id: '10007', name: 'Ready to test' }]);
    expect(p.projectKey).toBe('KAN');
  });

  it('matches by stable ID even if the display name differs (renamed column)', () => {
    const p = JiraWebhookService.parse(evt());
    // Configured name is stale ("QA"), but the id still matches.
    const m = JiraWebhookService.matchTrigger(p, [{ id: '10007', name: 'QA' }]);
    expect(m).toEqual({ id: '10007', name: 'Ready to test' });
  });

  it('matches by name when no id is configured (legacy entry)', () => {
    const p = JiraWebhookService.parse(evt());
    const m = JiraWebhookService.matchTrigger(p, [{ id: '', name: 'ready to test' }]);
    expect(m?.name).toBe('Ready to test');
  });

  it('supports multiple trigger statuses', () => {
    const p = JiraWebhookService.parse(evt());
    const m = JiraWebhookService.matchTrigger(p, [{ id: '5', name: 'QA' }, { id: '10007', name: 'Ready to test' }]);
    expect(m?.id).toBe('10007');
  });

  it('no match when the entered status is not configured', () => {
    const p = JiraWebhookService.parse(evt());
    expect(JiraWebhookService.matchTrigger(p, [{ id: '999', name: 'Done' }])).toBeNull();
  });

  it('does NOT match an unrelated field change', () => {
    const p = JiraWebhookService.parse(evt({
      changelog: { items: [{ field: 'assignee', to: 'u2', toString: 'Dana' }] },
      issue: { key: 'KAN-1', fields: { project: { key: 'KAN' }, status: { id: '3', name: 'In Progress' } } },
    }));
    expect(JiraWebhookService.matchTrigger(p, [{ id: '10007', name: 'Ready to test' }])).toBeNull();
  });

  it('with no changelog, matches on the current status', () => {
    const p = JiraWebhookService.parse(evt({ changelog: undefined }));
    expect(JiraWebhookService.matchTrigger(p, [{ id: '10007', name: 'x' }])?.id).toBe('10007');
  });
});

describe('JiraWebhookService.resolveTrigger', () => {
  beforeEach(() => jest.clearAllMocks());

  const project = (jira: Record<string, any>) => ({
    id: 'p1', user_id: 'u1', workspace_id: 'w1',
    jira: { projectKey: 'KAN', webhookSecret: 's3cr3t', ...jira },
  });

  it('resolves when secret + a trigger status (by id) match', async () => {
    (findProjectsForJiraKey as jest.Mock).mockResolvedValue([
      project({ qaTriggerStatuses: [{ id: '10007', name: 'Ready to test' }] }),
    ]);
    const t = await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t');
    expect(t).toMatchObject({ projectId: 'p1', userId: 'u1', issueKey: 'KAN-1' });
  });

  it('honors the legacy qaColumnName (name-only)', async () => {
    (findProjectsForJiraKey as jest.Mock).mockResolvedValue([
      project({ qaColumnName: 'Ready to test' }),
    ]);
    const t = await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t');
    expect(t?.projectId).toBe('p1');
  });

  it('null on bad secret', async () => {
    (findProjectsForJiraKey as jest.Mock).mockResolvedValue([
      project({ qaTriggerStatuses: [{ id: '10007', name: 'Ready to test' }] }),
    ]);
    expect(await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 'wrong')).toBeNull();
  });

  it('null when status is not a configured trigger (forgiving no-op)', async () => {
    (findProjectsForJiraKey as jest.Mock).mockResolvedValue([
      project({ qaTriggerStatuses: [{ id: '999', name: 'Done' }] }),
    ]);
    expect(await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t')).toBeNull();
  });

  it('null when no project matches the Jira key', async () => {
    (findProjectsForJiraKey as jest.Mock).mockResolvedValue([]);
    expect(await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t')).toBeNull();
  });

  it('ignores non-issue_updated events', async () => {
    expect(await JiraWebhookService.resolveTrigger(
      JiraWebhookService.parse(evt({ webhookEvent: 'jira:issue_created' })), 's3cr3t',
    )).toBeNull();
  });

  it('never throws when the db lookup fails', async () => {
    (findProjectsForJiraKey as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(
      JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t'),
    ).resolves.toBeNull();
  });
});

describe('JiraWebhookService — parse site host + cross-site guard (#3)', () => {
  const project = (jira: Record<string, any>) => ({
    id: 'p1', user_id: 'u1', workspace_id: 'w1',
    jira: { projectKey: 'KAN', webhookSecret: 's3cr3t', qaTriggerStatuses: [{ id: '10007', name: 'Ready to test' }], ...jira },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (findProjectsForJiraKey as jest.Mock).mockResolvedValue([project({})]);
  });

  it('parses the site host from issue.self', () => {
    expect(JiraWebhookService.parse(evt()).siteHost).toBe('acme.atlassian.net');
    expect(JiraWebhookService.hostFromUrl('not a url')).toBeUndefined();
  });

  it('rejects on a positive site-host mismatch', async () => {
    (getOwnerJiraSiteHosts as jest.Mock).mockResolvedValue(['other.atlassian.net']);
    expect(await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t')).toBeNull();
  });

  it('proceeds when owner host matches', async () => {
    (getOwnerJiraSiteHosts as jest.Mock).mockResolvedValue(['acme.atlassian.net']);
    expect((await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t'))?.projectId).toBe('p1');
  });

  it('falls through (no regression) when owner host is unresolvable', async () => {
    (getOwnerJiraSiteHosts as jest.Mock).mockResolvedValue([]); // e.g. legacy jira_tokens only
    expect((await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(evt()), 's3cr3t'))?.projectId).toBe('p1');
  });

  it('falls through when the payload has no self/host', async () => {
    (getOwnerJiraSiteHosts as jest.Mock).mockResolvedValue(['acme.atlassian.net']);
    const noSelf = evt({ issue: { key: 'KAN-1', fields: { project: { key: 'KAN' }, status: { id: '10007', name: 'Ready to test' } } } });
    expect((await JiraWebhookService.resolveTrigger(JiraWebhookService.parse(noSelf), 's3cr3t'))?.projectId).toBe('p1');
  });
});

describe('JiraWebhookService.claimAssessment (cooldown)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when the NX claim is won (first webhook of the burst)', async () => {
    (redisConnection.set as jest.Mock).mockResolvedValue('OK');
    expect(await JiraWebhookService.claimAssessment('p1', 'KAN-1', '10007')).toBe(true);
    expect(redisConnection.set).toHaveBeenCalledWith(
      expect.stringContaining('qait:jira-webhook:assess:p1:KAN-1:10007'), '1', 'EX', expect.any(Number), 'NX',
    );
  });

  it('returns false when the key already exists (repeat within cooldown)', async () => {
    (redisConnection.set as jest.Mock).mockResolvedValue(null);
    expect(await JiraWebhookService.claimAssessment('p1', 'KAN-1', '10007')).toBe(false);
  });

  it('fails open (true) on a Redis error — never silently drops', async () => {
    (redisConnection.set as jest.Mock).mockRejectedValue(new Error('redis down'));
    expect(await JiraWebhookService.claimAssessment('p1', 'KAN-1', '10007')).toBe(true);
  });
});
