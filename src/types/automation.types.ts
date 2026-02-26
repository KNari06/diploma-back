/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTOMATION ACTIONS — Universal post-event automation types
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export type TriggerEvent =
  | 'run_completed'
  | 'run_failed'
  | 'run_passed'
  | 'test_completed'
  | 'test_failed'
  | 'schedule_executed';

export type ActionType =
  | 'telegram_notify'
  | 'slack_notify'
  | 'jira_create_issue'
  | 'webhook_post'
  | 'generate_share_link';

export type ActionCondition = 'always' | 'on_failure' | 'on_success';

export type ActionLogStatus = 'success' | 'failed' | 'skipped';

export type SourceEntityType = 'regression_run' | 'test' | 'schedule';

// ── Action config shapes ───────────────────────────────────────────────────

export interface TelegramNotifyConfig {
  chat_id?: string;
  include_share_link?: boolean;
  template?: string;
}

export interface SlackNotifyConfig {
  channel_id: string;
  include_share_link?: boolean;
  template?: string;
}

export interface JiraCreateIssueConfig {
  project_key: string;
  issue_type?: string;
  priority?: string;
  labels?: string[];
}

export interface WebhookPostConfig {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
}

export interface GenerateShareLinkConfig {
  auto: boolean;
}

export type ActionConfig =
  | TelegramNotifyConfig
  | SlackNotifyConfig
  | JiraCreateIssueConfig
  | WebhookPostConfig
  | GenerateShareLinkConfig;

// ── Core entities ──────────────────────────────────────────────────────────

export interface AutomationAction {
  id: string;
  userId: string;
  projectId?: string;
  scheduleId?: string;
  planId?: string;
  triggerEvent: TriggerEvent;
  actionType: ActionType;
  condition: ActionCondition;
  config: ActionConfig;
  name?: string;
  isActive: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationActionLog {
  id: string;
  actionId: string;
  triggerEvent: TriggerEvent;
  sourceEntityType: SourceEntityType;
  sourceEntityId: string;
  status: ActionLogStatus;
  errorMessage?: string;
  responseData?: Record<string, any>;
  idempotencyKey: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
}

// ── Service params ─────────────────────────────────────────────────────────

export interface CreateAutomationActionParams {
  userId: string;
  projectId?: string;
  scheduleId?: string;
  planId?: string;
  triggerEvent: TriggerEvent;
  actionType: ActionType;
  condition?: ActionCondition;
  config: ActionConfig;
  name?: string;
  priority?: number;
}

export interface UpdateAutomationActionParams {
  id: string;
  userId: string;
  triggerEvent?: TriggerEvent;
  actionType?: ActionType;
  condition?: ActionCondition;
  config?: ActionConfig;
  name?: string;
  isActive?: boolean;
  priority?: number;
}

// ── Execution context ──────────────────────────────────────────────────────

export interface AutomationEventContext {
  triggerEvent: TriggerEvent;
  sourceEntityType: SourceEntityType;
  sourceEntityId: string;
  userId: string;
  projectId?: string;
  planId?: string;
  scheduleId?: string;
  eventData: {
    status?: string;
    runId?: string;
    testId?: string;
    summary?: Record<string, any>;
    title?: string;
    message?: string;
    shareToken?: string;
    shareUrl?: string;
  };
}
