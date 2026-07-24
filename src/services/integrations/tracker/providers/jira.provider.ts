/**
 * JiraTrackerProvider — the FIRST TaskTrackerProvider implementation.
 *
 * Pure delegation to the existing jira.service (no behavior change): it maps
 * Jira's native shapes to the neutral tracker model. This is the safety net —
 * Jira keeps working exactly as before while consumers migrate to the interface.
 */

import {
  buildJiraAuthUrl,
  exchangeCodeForToken,
  getAccessibleResources,
  getJiraBoards,
  getBoardConfiguration,
  getBoardIssues,
  getJiraStatuses,
  getProjectStatusesWithId,
  getJiraIssueWithContext,
  addJiraComment,
  transitionJiraIssue,
} from '@/services/api/jira.service';
import { JiraWebhookService } from '@/services/integrations/jira-webhook-jira.service';
import type { JiraIssueListItem } from '@/types';
import type {
  Board, Column, Task, TaskPerson, TaskRelatedContext, TaskSeverity,
  TaskStatus, TaskStatusCategory, TrackerAuthResult, TrackerCapabilities, TrackerWebhookEvent,
} from '@/types/tracker.types';
import type { TaskTrackerProvider, TrackerAuth } from '../tracker-provider.interface';

/** Jira priority name → neutral severity. */
function jiraPriorityToSeverity(name?: string): TaskSeverity {
  switch ((name || '').toLowerCase()) {
    case 'highest': case 'blocker': return 'blocker';
    case 'high': case 'critical': return 'critical';
    case 'medium': case 'major': return 'major';
    case 'low': case 'lowest': case 'minor': case 'trivial': return 'minor';
    default: return 'none';
  }
}

/** Jira statusCategory key → neutral category. */
function jiraCategoryToNeutral(statusCategory?: Record<string, unknown>): TaskStatusCategory {
  const key = typeof statusCategory?.key === 'string' ? statusCategory.key.toLowerCase() : '';
  if (key === 'new' || key === 'to do' || key === 'todo') return 'todo';
  if (key === 'indeterminate' || key === 'in progress') return 'in_progress';
  if (key === 'done') return 'done';
  return 'unknown';
}

function jiraPerson(p: JiraIssueListItem['reporter']): TaskPerson | null {
  if (!p) return null;
  return { id: p.accountId, displayName: p.displayName, email: p.emailAddress };
}

function issueToTask(issue: JiraIssueListItem): Task {
  return {
    provider: 'jira',
    id: issue.id,
    key: issue.key,
    title: issue.summary,
    description: issue.description,
    status: {
      id: issue.status?.id ?? '',
      name: issue.status?.name ?? 'Unknown',
      category: jiraCategoryToNeutral(issue.status?.statusCategory),
    },
    severity: jiraPriorityToSeverity(issue.priority?.name),
    rawPriority: issue.priority?.name,
    reporter: jiraPerson(issue.reporter),
    assignee: jiraPerson(issue.assignee),
    labels: issue.labels ?? [],
    createdAt: issue.created,
    updatedAt: issue.updated,
    boardRef: issue.project ? { id: issue.project.id, key: issue.project.key, name: issue.project.name } : undefined,
  };
}

const CAPABILITIES: TrackerCapabilities = {
  hasBoards: true,
  hasComments: true,
  hasStatusWrite: true,
  hasWebhook: true,
};

export class JiraTrackerProvider implements TaskTrackerProvider {
  readonly provider = 'jira' as const;
  readonly capabilities = CAPABILITIES;

  buildAuthUrl(state: string): string {
    return buildJiraAuthUrl(state);
  }

  async exchangeCode(code: string): Promise<TrackerAuthResult[]> {
    const token = await exchangeCodeForToken(code);
    const resources = await getAccessibleResources(token.access_token);
    return resources.map((r) => ({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in,
      scope: token.scope,
      externalId: r.id,      // cloud_id
      externalUrl: r.url,
    }));
  }

  async listBoards(auth: TrackerAuth): Promise<Board[]> {
    const boards = await getJiraBoards(auth.accessToken, auth.externalId!);
    return boards.map((b) => ({ id: String(b.id), name: b.name, type: b.type }));
  }

  async listColumns(auth: TrackerAuth, boardRef: string): Promise<Column[]> {
    const [config, statusMap] = await Promise.all([
      getBoardConfiguration(auth.accessToken, auth.externalId!, boardRef),
      getJiraStatuses(auth.accessToken, auth.externalId!),
    ]);
    return (config.columns || []).map((col) => ({
      name: col.name ?? '',
      statuses: (col.statuses || []).map((s) => ({
        id: s.id,
        name: statusMap[s.id] ?? s.id,
        category: 'unknown' as TaskStatusCategory,
      })),
    }));
  }

  async listTasks(
    auth: TrackerAuth,
    opts: { boardRef?: string; limit?: number; offset?: number },
  ): Promise<{ tasks: Task[]; columns: Column[]; total: number }> {
    // Board-scoped fetch (the primary Bug-board path). projectRef/JQL variants
    // stay in the controller for now; the provider covers the board case.
    const boardRef = opts.boardRef!;
    const { issues, total } = await getBoardIssues(
      auth.accessToken, auth.externalId!, boardRef, opts.offset ?? 0, opts.limit ?? 100,
    );
    const columns = await this.listColumns(auth, boardRef).catch(() => []);
    return { tasks: issues.map(issueToTask), columns, total };
  }

  async getTask(auth: TrackerAuth, taskKey: string): Promise<Task> {
    const { issue } = await getJiraIssueWithContext(auth.accessToken, auth.externalId!, taskKey);
    return issueToTask(issue);
  }

  async getRelatedContext(auth: TrackerAuth, taskKey: string): Promise<TaskRelatedContext> {
    const { related } = await getJiraIssueWithContext(auth.accessToken, auth.externalId!, taskKey);
    const relatedTasks = [
      ...(related.parent?.key ? [{ key: related.parent.key, title: related.parent.summary, relation: 'parent' }] : []),
      ...related.subtasks.map((s) => ({ key: s.key, title: s.summary, status: s.status, relation: 'subtask' })),
      ...related.links.map((l) => ({ key: l.key, title: l.summary, status: l.status, relation: l.type })),
    ];
    return {
      related: relatedTasks,
      comments: related.comments.map((c) => ({ author: c.author, createdAt: c.created, text: c.text })),
    };
  }

  async listStatuses(auth: TrackerAuth, projectRef: string): Promise<TaskStatus[]> {
    const statuses = await getProjectStatusesWithId(auth.accessToken, auth.externalId!, projectRef);
    return statuses.map((s) => ({ id: s.id, name: s.name, category: 'unknown' as TaskStatusCategory }));
  }

  async addComment(auth: TrackerAuth, taskKey: string, body: string): Promise<void> {
    await addJiraComment(auth.accessToken, auth.externalId!, taskKey, body);
  }

  async setStatus(auth: TrackerAuth, taskKey: string, status: { id?: string; name?: string }): Promise<void> {
    // Jira transitions by target status NAME (2-step transition dance in jira.service).
    const target = status.name || status.id;
    if (!target) return;
    await transitionJiraIssue(auth.accessToken, auth.externalId!, taskKey, target);
  }

  verifyWebhook(input: { query: Record<string, unknown>; expectedSecret?: string }): boolean {
    const provided = typeof input.query.secret === 'string' ? input.query.secret : undefined;
    return JiraWebhookService.verifySecret(provided, input.expectedSecret);
  }

  parseWebhook(payload: unknown): TrackerWebhookEvent | null {
    const p = JiraWebhookService.parse(payload);
    if (p.webhookEvent && p.webhookEvent !== 'jira:issue_updated') return null;
    if (!p.issueKey || !p.projectKey) return null;
    return {
      provider: 'jira',
      taskKey: p.issueKey,
      projectRef: p.projectKey,
      transitionedTo: p.transitionedTo.map((t) => ({ id: t.id, name: t.name, category: 'unknown' as TaskStatusCategory })),
      currentStatus: p.statusId || p.statusName
        ? { id: p.statusId || '', name: p.statusName || '', category: 'unknown' as TaskStatusCategory }
        : undefined,
      siteHost: p.siteHost,
    };
  }
}
