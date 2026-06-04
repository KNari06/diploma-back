/**
 * MANAGE PLAN HANDLER (Phase 2)
 *
 * First-class intent for regression-plan management: create / update /
 * add_item / remove_item. Routes through executeTool → qa_manage_regression_plan
 * (which itself resolves names→ids and enforces the confirm-preview guard), so
 * this handler stays thin: extract typed params, resolve the project, set the
 * confirm flag from the user's turn, delegate.
 *
 * Triggered by:
 * - "create a regression plan called Smoke Suite"
 * - "add the checkout module to my Release plan"
 * - "удали flow Login из плана Nightly"
 */

import { NotFoundError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { resolveProjectId } from './project-resolver';
import {
  resolveConfirmation,
  runManageTool,
  type ManageToolParams,
} from './shared/manage-tool.helper';

interface ManagePlanParams extends ManageToolParams {
  message: string;
  parsedIntent?: any;
  answers?: Record<string, any>;
}

const VALID_ACTIONS = new Set(['create', 'update', 'add_item', 'remove_item']);

/** Human-readable preview of the pending plan change (for the confirm prompt). */
function describePlanChange(action: string, manage: Record<string, any>): string {
  const plan = manage.planName ? `"${manage.planName}"` : 'the plan';
  const item = manage.itemName ? `${manage.itemType || 'item'} "${manage.itemName}"` : 'an item';
  switch (action) {
    case 'create':
      return `create a regression plan${manage.name ? ` called "${manage.name}"` : ''}`;
    case 'update':
      return `update plan ${plan}`;
    case 'add_item':
      return `add ${item} to plan ${plan}`;
    case 'remove_item':
      return `remove ${item} from plan ${plan}`;
    default:
      return `modify plan ${plan}`;
  }
}

export async function handleManagePlanIntent(
  _req: Request,
  res: Response,
  params: ManagePlanParams,
): Promise<void> {
  const { parsedIntent, message, answers, userId, workspace_id } = params;

  try {
    const manage = parsedIntent?.metadata?.manage ?? {};
    const action = manage.action;

    if (!action || !VALID_ACTIONS.has(action)) {
      res.json({
        success: true,
        message: 'What would you like to do with the plan — create, update, or add/remove an item?',
        data: { needsClarification: true },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    const projectId = await resolveProjectId(params);
    if (!projectId) {
      throw new NotFoundError('Project', workspace_id);
    }

    // qa_manage_regression_plan resolves plan/item names → ids internally, so we
    // pass names straight through. plan_id accepts a name OR a uuid.
    const args: Record<string, any> = {
      action,
      project_id: projectId,
      confirm: resolveConfirmation({ message, answers }),
    };
    if (manage.name) args.name = manage.name;
    if (manage.planName) args.plan_id = manage.planName;
    if (manage.itemType) args.item_type = manage.itemType;
    if (manage.itemName) args.item_id = manage.itemName;

    await runManageTool({
      toolName: 'qa_manage_regression_plan',
      args,
      params,
      res,
      logTag: 'MANAGE_PLAN_HANDLER',
      previewDescription: describePlanChange(action, manage),
    });
  } catch (error) {
    logger.error('[MANAGE_PLAN_HANDLER] Error managing plan', { error, userId });
    if (error instanceof NotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Failed to manage the regression plan',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
