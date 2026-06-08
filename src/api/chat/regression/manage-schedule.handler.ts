/**
 * MANAGE SCHEDULE HANDLER (Phase 2)
 *
 * First-class intent for cron-schedule management: create / update / activate /
 * deactivate / delete. Routes through executeTool → qa_manage_schedule (plan/
 * module name→id resolution + confirm guard handled centrally).
 *
 * Triggered by:
 * - "schedule the nightly plan to run every day at 2am"
 * - "pause the regression schedule"
 * - "запускай smoke план каждый день в 9 утра по Алматы"
 */

import { NotFoundError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { resolveProjectId } from './project-resolver';
import {
  clarify,
  resolveConfirmation,
  runManageTool,
  type ManageToolParams,
} from './shared/manage-tool.helper';

interface ManageScheduleParams extends ManageToolParams {
  message: string;
  parsedIntent?: any;
  answers?: Record<string, any>;
}

const VALID_ACTIONS = new Set(['create', 'update', 'activate', 'deactivate', 'delete']);

/**
 * Pre-flight required-field check for schedules. `create` needs a cron and a
 * single run target (plan OR module); the id-based actions need a schedule name.
 * Returns a clarifying question or null. Mirrors the tool's required fields.
 */
function missingFieldQuestion(action: string, manage: Record<string, any>): string | null {
  if (action === 'create') {
    if (!manage.cronExpression && !manage.runAt) {
      return 'When should this schedule run? (e.g. "every day at 9am", "every Monday", or a one-time date like "June 10 at 2:30pm")';
    }
    if (!manage.planName && !manage.moduleName) {
      return 'What should the schedule run — a plan or a module? Please name it.';
    }
  }
  if ((action === 'update' || action === 'activate' || action === 'deactivate' || action === 'delete') && !manage.name) {
    return 'Which schedule do you mean? Please give its name.';
  }
  return null;
}

/** Human-readable preview of the pending schedule change (for the confirm prompt). */
function describeScheduleChange(action: string, manage: Record<string, any>): string {
  const sched = manage.name ? `schedule "${manage.name}"` : 'the schedule';
  const target = manage.planName
    ? ` running plan "${manage.planName}"`
    : manage.moduleName ? ` running module "${manage.moduleName}"` : '';
  const when = manage.runAt
    ? ` once at ${manage.runAt}`
    : manage.cronExpression
      ? ` at ${manage.cronExpression}${manage.timezone ? ` (${manage.timezone})` : ''}`
      : '';
  switch (action) {
    case 'create':
      return `create ${sched}${target}${when}`;
    case 'update':
      return `update ${sched}${target}${when}`;
    case 'activate':
      return `activate ${sched}`;
    case 'deactivate':
      return `pause ${sched}`;
    case 'delete':
      return `delete ${sched}`;
    default:
      return `modify ${sched}`;
  }
}

export async function handleManageScheduleIntent(
  _req: Request,
  res: Response,
  params: ManageScheduleParams,
): Promise<void> {
  const { parsedIntent, message, answers, userId, workspace_id } = params;

  try {
    const manage = parsedIntent?.metadata?.manage ?? {};
    const action = manage.action;

    if (!action || !VALID_ACTIONS.has(action)) {
      clarify(res, params.chatSessionId, 'What should I do with the schedule — create, update, activate, deactivate, or delete it?');
      return;
    }

    // Pre-flight: ask for the one missing required field rather than surfacing
    // the tool's raw "Missing required field" error to the user.
    const missing = missingFieldQuestion(action, manage);
    if (missing) {
      clarify(res, params.chatSessionId, missing);
      return;
    }

    const args: Record<string, any> = {
      action,
      confirm: resolveConfirmation({ message, answers }),
    };

    // project_id is only needed for create; for the others the schedule is
    // identified by name/id. Resolve it best-effort so create works.
    const projectId = await resolveProjectId(params);
    if (action === 'create') {
      if (!projectId) {
        throw new NotFoundError('Project', workspace_id);
      }
      args.project_id = projectId;
    } else if (projectId) {
      args.project_id = projectId;
    }

    if (manage.name) args.name = manage.name;
    if (manage.cronExpression) args.cron_expression = manage.cronExpression;
    if (manage.runAt) args.run_at = manage.runAt;
    if (manage.timezone) args.timezone = manage.timezone;
    // plan_id / module_id accept a name OR uuid; the tool resolves it.
    if (manage.planName) args.plan_id = manage.planName;
    if (manage.moduleName) args.module_id = manage.moduleName;

    await runManageTool({
      toolName: 'qa_manage_schedule',
      args,
      params,
      res,
      logTag: 'MANAGE_SCHEDULE_HANDLER',
      previewDescription: describeScheduleChange(action, manage),
    });
  } catch (error) {
    logger.error('[MANAGE_SCHEDULE_HANDLER] Error managing schedule', { error, userId });
    if (error instanceof NotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Failed to manage the schedule',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
