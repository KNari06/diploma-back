/**
 * Provider-neutral task-tracker model.
 *
 * These types are the shared contract every tracker (Jira, Linear, ClickUp, …)
 * normalizes INTO, so the Bug board, the QA orchestrator, feedback, and the
 * webhook path stop depending on Jira-specific shapes. Each provider maps its
 * native API objects to these; nothing here is Jira-specific.
 *
 * Design rule: if a field can't exist on some tracker, it's optional/nullable.
 * Severity is normalized to ONE scale (not Jira priority names, not Linear
 * integers) so downstream logic is provider-agnostic.
 */

/** Open provider identifier — new trackers add a string, validated by the registry (not a DB CHECK). */
export type TrackerProvider = 'jira' | 'linear' | 'clickup' | 'asana' | 'github' | (string & {});

/** Normalized severity — every provider maps its own priority model to this. */
export type TaskSeverity = 'blocker' | 'critical' | 'major' | 'minor' | 'none';

/** Normalized status category — coarse bucket every tracker can map its state into. */
export type TaskStatusCategory = 'todo' | 'in_progress' | 'done' | 'unknown';

/** A tracker status/state/column-status (stable id + display name + coarse category). */
export interface TaskStatus {
  id: string;            // stable id (survives renames) — provider-native
  name: string;          // display name
  category: TaskStatusCategory;
}

/** A person reference (reporter/assignee), provider-neutral. */
export interface TaskPerson {
  id: string;            // provider-native user id (accountId / uuid / numeric)
  displayName: string;
  email?: string;
}

/** A board/list/team grouping tasks (Jira board, Linear team, ClickUp list). */
export interface Board {
  id: string;
  name: string;
  type?: string;         // provider hint (scrum/kanban/team/list) — informational
}

/** A board column / workflow lane, resolving to one or more statuses. */
export interface Column {
  name: string;
  statuses: TaskStatus[]; // statuses that map into this column
}

/** The neutral task — every tracker normalizes its issue/ticket/card into this. */
export interface Task {
  provider: TrackerProvider;   // provenance — enables a mixed board
  id: string;                  // provider-native id
  key: string;                 // human ref (PROJ-123 / ENG-45 / #12 / numeric) — display only, no format assumed
  url?: string;                // link to the task in the tracker
  title: string;
  description: string | null;  // plain text (ADF/markdown already flattened)
  status: TaskStatus;
  severity: TaskSeverity;      // normalized (NOT the raw provider priority)
  rawPriority?: string;        // original priority label/number, for display only
  reporter: TaskPerson | null;
  assignee: TaskPerson | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  boardRef?: { id: string; key?: string; name?: string }; // project/board/list this task belongs to
}

/** A related task (parent/subtask/link) — trimmed for prompt context. */
export interface RelatedTask {
  key: string;
  title: string;
  status?: string;
  relation?: string;   // 'parent' | 'subtask' | 'blocks' | 'relates to' | ...
}

/** A comment on a task, flattened to plain text. */
export interface TaskComment {
  author?: string;
  createdAt?: string;
  text: string;
}

/** Everything around a task the agent reads for assessment. */
export interface TaskRelatedContext {
  related: RelatedTask[];
  comments: TaskComment[];
}

/** What a provider can do — lets consumers degrade gracefully (audit cases 22/23). */
export interface TrackerCapabilities {
  hasBoards: boolean;        // exposes a board/column model (Jira yes, GitHub Issues no)
  hasComments: boolean;      // can post comments back
  hasStatusWrite: boolean;   // can change a task's status
  hasWebhook: boolean;       // supports inbound webhooks
}

/** A normalized inbound webhook event (after provider-specific parsing). */
export interface TrackerWebhookEvent {
  provider: TrackerProvider;
  taskKey?: string;
  projectRef?: string;                       // native project/team/list ref for mapping
  transitionedTo: TaskStatus[];              // statuses this update moved INTO
  currentStatus?: TaskStatus;                // fallback when no changelog
  siteHost?: string;                         // for cross-site guard (if the payload carries it)
}

/** OAuth result a provider returns after code exchange. */
export interface TrackerAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string;
  externalId: string;   // cloud_id / workspace id / team id — provider-native
  externalUrl?: string; // site url
}
