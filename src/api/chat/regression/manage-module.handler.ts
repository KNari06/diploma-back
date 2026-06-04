/**
 * MANAGE MODULE HANDLER (Phase 2)
 *
 * First-class intent for test-module management: create / update (rename, etc.).
 * Routes through executeTool → qa_manage_module (name→id resolution + confirm
 * guard handled centrally), so this handler only extracts params and delegates.
 *
 * Triggered by:
 * - "create a module called Checkout for web"
 * - "rename the smoke module to Smoke - Critical Path"
 * - "переименуй модуль Orders"
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

interface ManageModuleParams extends ManageToolParams {
  message: string;
  parsedIntent?: any;
  answers?: Record<string, any>;
}

const VALID_ACTIONS = new Set(['create', 'update']);

/**
 * Pre-flight required-field check for modules. `create` needs a name + a valid
 * platform; `update` needs to know which module. Returns a clarifying question
 * or null. Mirrors qa_manage_module's required fields.
 */
function missingFieldQuestion(action: string, manage: Record<string, any>): string | null {
  const VALID_PLATFORMS = new Set(['web_ui', 'api', 'mobile']);
  if (action === 'create') {
    if (!manage.name) return 'What should the new module be called?';
    if (!manage.platformKey || !VALID_PLATFORMS.has(manage.platformKey)) {
      return 'What platform is this module for — web_ui, api, or mobile?';
    }
  }
  if (action === 'update' && !manage.moduleName) {
    return 'Which module would you like to update?';
  }
  return null;
}

/** Human-readable preview of the pending module change (for the confirm prompt). */
function describeModuleChange(action: string, manage: Record<string, any>): string {
  if (action === 'create') {
    return `create a ${manage.platformKey || ''} module${manage.name ? ` called "${manage.name}"` : ''}`.replace(/\s+/g, ' ');
  }
  const target = manage.moduleName ? `module "${manage.moduleName}"` : 'the module';
  return manage.name ? `rename ${target} to "${manage.name}"` : `update ${target}`;
}

export async function handleManageModuleIntent(
  _req: Request,
  res: Response,
  params: ManageModuleParams,
): Promise<void> {
  const { parsedIntent, message, answers, userId, workspace_id } = params;

  try {
    const manage = parsedIntent?.metadata?.manage ?? {};
    const action = manage.action;

    if (!action || !VALID_ACTIONS.has(action)) {
      clarify(res, params.chatSessionId, 'Would you like to create a new module or update an existing one?');
      return;
    }

    // Pre-flight: ask for the one missing required field rather than leaking the
    // tool's raw "Missing required field" error to the user.
    const missing = missingFieldQuestion(action, manage);
    if (missing) {
      clarify(res, params.chatSessionId, missing);
      return;
    }

    const projectId = await resolveProjectId(params);
    if (!projectId) {
      throw new NotFoundError('Project', workspace_id);
    }

    // qa_manage_module accepts module_id as a name OR uuid and resolves it.
    const args: Record<string, any> = {
      action,
      project_id: projectId,
      confirm: resolveConfirmation({ message, answers }),
    };
    if (manage.name) args.name = manage.name;
    if (manage.moduleName) args.module_id = manage.moduleName;
    if (manage.platformKey) args.platform_key = manage.platformKey;
    if (manage.priority) args.priority = manage.priority;

    await runManageTool({
      toolName: 'qa_manage_module',
      args,
      params,
      res,
      logTag: 'MANAGE_MODULE_HANDLER',
      previewDescription: describeModuleChange(action, manage),
    });
  } catch (error) {
    logger.error('[MANAGE_MODULE_HANDLER] Error managing module', { error, userId });
    if (error instanceof NotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Failed to manage the module',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
