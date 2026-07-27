import type { JiraIssueListItem } from '@/types';

// Mock the whole jira.service — the provider is a pure delegation+mapping layer,
// so the test stubs the service boundary and asserts the neutral mapping only.
jest.mock('@/services/api/jira.service', () => ({
  buildJiraAuthUrl: jest.fn(() => 'https://auth.example/authorize'),
  exchangeCodeForToken: jest.fn(),
  getAccessibleResources: jest.fn(),
  getJiraBoards: jest.fn(),
  getBoardConfiguration: jest.fn(),
  getBoardIssues: jest.fn(),
  getJiraStatuses: jest.fn(),
  getProjectStatusesWithId: jest.fn(),
  getJiraIssueWithContext: jest.fn(),
  addJiraComment: jest.fn(),
  transitionJiraIssue: jest.fn(),
}));

import * as jira from '@/services/api/jira.service';
import { JiraTrackerProvider } from '../jira.provider';

const AUTH = { accessToken: 'tok', externalId: 'cloud-1' };

function makeIssue(overrides: Partial<JiraIssueListItem> = {}): JiraIssueListItem {
  return {
    id: '10001',
    key: 'BUG-1',
    summary: 'Login button unresponsive',
    description: 'Steps to reproduce...',
    status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { id: '2', name: 'High' },
    issuetype: { id: '1', name: 'Bug' },
    reporter: { accountId: 'u1', displayName: 'Ann', emailAddress: 'ann@x.io' },
    assignee: { accountId: 'u2', displayName: 'Bob' },
    created: '2026-07-01T10:00:00.000Z',
    updated: '2026-07-02T10:00:00.000Z',
    labels: ['regression'],
    project: { id: 'p1', key: 'BUG', name: 'Bug Board' },
    ...overrides,
  };
}

describe('JiraTrackerProvider', () => {
  const provider = new JiraTrackerProvider();
  beforeEach(() => jest.clearAllMocks());

  it('declares itself as the jira provider with full capabilities', () => {
    expect(provider.provider).toBe('jira');
    expect(provider.capabilities).toEqual({
      hasBoards: true, hasComments: true, hasStatusWrite: true, hasWebhook: true,
    });
  });

  it('maps a Jira issue to a neutral Task faithfully', async () => {
    (jira.getJiraIssueWithContext as jest.Mock).mockResolvedValue({
      issue: makeIssue(), related: { parent: null, subtasks: [], links: [], comments: [] },
    });

    const task = await provider.getTask(AUTH, 'BUG-1');

    expect(task).toMatchObject({
      provider: 'jira',
      id: '10001',
      key: 'BUG-1',
      title: 'Login button unresponsive',
      description: 'Steps to reproduce...',
      status: { id: '3', name: 'In Progress', category: 'in_progress' },
      severity: 'critical', // "High" → critical
      rawPriority: 'High',
      reporter: { id: 'u1', displayName: 'Ann', email: 'ann@x.io' },
      assignee: { id: 'u2', displayName: 'Bob', email: undefined },
      labels: ['regression'],
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-02T10:00:00.000Z',
      boardRef: { id: 'p1', key: 'BUG', name: 'Bug Board' },
    });
  });

  it.each([
    ['Highest', 'blocker'],
    ['High', 'critical'],
    ['Medium', 'major'],
    ['Low', 'minor'],
    ['Lowest', 'minor'],
    ['Weird-custom', 'none'],
  ])('maps Jira priority %s → severity %s', async (name, severity) => {
    (jira.getJiraIssueWithContext as jest.Mock).mockResolvedValue({
      issue: makeIssue({ priority: { id: 'x', name } }),
      related: { parent: null, subtasks: [], links: [], comments: [] },
    });
    const task = await provider.getTask(AUTH, 'BUG-1');
    expect(task.severity).toBe(severity);
  });

  it.each([
    ['new', 'todo'],
    ['indeterminate', 'in_progress'],
    ['done', 'done'],
    ['mystery', 'unknown'],
  ])('maps Jira statusCategory %s → category %s', async (key, category) => {
    (jira.getJiraIssueWithContext as jest.Mock).mockResolvedValue({
      issue: makeIssue({ status: { id: '9', name: 'X', statusCategory: { key } } }),
      related: { parent: null, subtasks: [], links: [], comments: [] },
    });
    const task = await provider.getTask(AUTH, 'BUG-1');
    expect(task.status.category).toBe(category);
  });

  it('handles a null priority and null people without throwing', async () => {
    (jira.getJiraIssueWithContext as jest.Mock).mockResolvedValue({
      issue: makeIssue({ priority: null, reporter: null, assignee: null }),
      related: { parent: null, subtasks: [], links: [], comments: [] },
    });
    const task = await provider.getTask(AUTH, 'BUG-1');
    expect(task.severity).toBe('none');
    expect(task.reporter).toBeNull();
    expect(task.assignee).toBeNull();
  });

  it('flattens related context (parent + subtasks + links + comments) to neutral shape', async () => {
    (jira.getJiraIssueWithContext as jest.Mock).mockResolvedValue({
      issue: makeIssue(),
      related: {
        parent: { key: 'EPIC-9', summary: 'Auth epic' },
        subtasks: [{ key: 'BUG-2', summary: 'sub', status: 'To Do' }],
        links: [{ type: 'blocks', direction: 'outward', key: 'BUG-3', summary: 'linked', status: 'Done' }],
        comments: [{ author: 'Ann', created: '2026-07-01', text: 'looks broken' }],
      },
    });

    const ctx = await provider.getRelatedContext(AUTH, 'BUG-1');

    expect(ctx.related).toEqual([
      { key: 'EPIC-9', title: 'Auth epic', relation: 'parent' },
      { key: 'BUG-2', title: 'sub', status: 'To Do', relation: 'subtask' },
      { key: 'BUG-3', title: 'linked', status: 'Done', relation: 'blocks' },
    ]);
    expect(ctx.comments).toEqual([{ author: 'Ann', createdAt: '2026-07-01', text: 'looks broken' }]);
  });

  it('exchangeCode fans a token across every accessible resource (cloud_id → externalId)', async () => {
    (jira.exchangeCodeForToken as jest.Mock).mockResolvedValue({
      access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'read', token_type: 'Bearer',
    });
    (jira.getAccessibleResources as jest.Mock).mockResolvedValue([
      { id: 'cloud-1', name: 'Site1', url: 'https://s1.atlassian.net', scopes: [] },
      { id: 'cloud-2', name: 'Site2', url: 'https://s2.atlassian.net', scopes: [] },
    ]);

    const results = await provider.exchangeCode('code123');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ accessToken: 'a', refreshToken: 'r', externalId: 'cloud-1', externalUrl: 'https://s1.atlassian.net' });
    expect(results[1].externalId).toBe('cloud-2');
  });

  it('listTasks fetches board issues and maps them to Tasks', async () => {
    (jira.getBoardIssues as jest.Mock).mockResolvedValue({ issues: [makeIssue(), makeIssue({ key: 'BUG-2' })], total: 2 });
    (jira.getBoardConfiguration as jest.Mock).mockResolvedValue({ columns: [] });
    (jira.getJiraStatuses as jest.Mock).mockResolvedValue({});

    const { tasks, total } = await provider.listTasks(AUTH, { boardRef: '5', limit: 50 });

    expect(total).toBe(2);
    expect(tasks.map((t) => t.key)).toEqual(['BUG-1', 'BUG-2']);
    expect(jira.getBoardIssues).toHaveBeenCalledWith('tok', 'cloud-1', '5', 0, 50);
  });

  it('setStatus transitions by target name', async () => {
    await provider.setStatus(AUTH, 'BUG-1', { name: 'Ready to test' });
    expect(jira.transitionJiraIssue).toHaveBeenCalledWith('tok', 'cloud-1', 'BUG-1', 'Ready to test');
  });

  it('setStatus is a no-op when no target is given', async () => {
    await provider.setStatus(AUTH, 'BUG-1', {});
    expect(jira.transitionJiraIssue).not.toHaveBeenCalled();
  });
});
