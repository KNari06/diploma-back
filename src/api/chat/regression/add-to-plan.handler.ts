/**
 * ADD TO PLAN HANDLER - Add Items to Regression Plan
 *
 * Handles the 'add_to_plan' intent detected by AI intent parser.
 * Adds modules, flows, or test cases to an existing plan.
 *
 * Triggered by:
 * - "add module Orders to plan Pre-release"
 * - "add flow Checkout to regression plan"
 * - "добавь модуль Orders в план"
 */

import { supabaseAdmin } from '@/db/supabase';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * Handler for add_to_plan intent
 * Adds items to an existing regression plan
 */
export async function handleAddToPlanIntent(
  _req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    context?: any;
    abortSignal?: AbortSignal;
  }
): Promise<void> {
  const { parsedIntent, userId, workspace_id } = params;

  const userLanguage = parsedIntent?.userLanguage || 'neutral';

  try {
    logger.info('[ADD_TO_PLAN_HANDLER] Processing add to plan intent', {
      intent: parsedIntent,
      userId,
    });

    // Extract details from parsed intent
    const planId = parsedIntent?.planId;
    const planName = parsedIntent?.planName;
    const moduleName = parsedIntent?.moduleName;
    const flowName = parsedIntent?.flowName;

    // Get project from workspace
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (!project) {
      throw new NotFoundError('Project', workspace_id);
    }

    // Find plan by ID or name
    let targetPlanId = planId;
    if (!targetPlanId && planName) {
      const plans = await RegressionPlanService.listByProject(project.id, userId);
      const matchedPlan = plans.find(
        (p) => p.name.toLowerCase() === planName.toLowerCase()
      );
      if (matchedPlan) {
        targetPlanId = matchedPlan.id;
      }
    }

    if (!targetPlanId) {
      res.json({
        success: true,
        message: userLanguage === 'ru'
          ? 'Укажите план. К какому плану добавить?'
          : 'Please specify a plan. Which plan should I add to?',
        data: {
          needsClarification: true,
          question: 'Which regression plan would you like to add to?',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    let addedItem = null;

    // Add module
    if (moduleName) {
      const { data: mod } = await supabaseAdmin
        .from('test_modules')
        .select('id, name')
        .eq('project_id', project.id)
        .ilike('name', moduleName)
        .limit(1)
        .maybeSingle();

      if (mod) {
        addedItem = await RegressionPlanService.addItem({
          planId: targetPlanId,
          itemType: 'module',
          moduleId: mod.id,
        });
      } else {
        throw new NotFoundError('Module', moduleName);
      }
    }

    // Add flow (scoped to project via module)
    if (flowName) {
      const { data: flow } = await supabaseAdmin
        .from('test_flows')
        .select('id, name, test_modules!inner(project_id)')
        .eq('test_modules.project_id', project.id)
        .ilike('name', flowName)
        .limit(1)
        .maybeSingle();

      if (flow) {
        addedItem = await RegressionPlanService.addItem({
          planId: targetPlanId,
          itemType: 'flow',
          flowId: flow.id,
        });
      } else {
        throw new NotFoundError('Flow', flowName);
      }
    }

    if (!addedItem) {
      res.json({
        success: true,
        message: userLanguage === 'ru'
          ? 'Укажите что добавить (модуль или flow)'
          : 'Please specify what to add (module or flow)',
        data: {
          needsClarification: true,
          question: 'What would you like to add to the plan?',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    logger.info('[ADD_TO_PLAN_HANDLER] Item added to plan', {
      planId: targetPlanId,
      itemId: addedItem.id,
      itemType: addedItem.itemType,
    });

    res.json({
      success: true,
      message: userLanguage === 'ru'
        ? `Добавлено в план. Item ID: ${addedItem.id}`
        : `Added to plan. Item ID: ${addedItem.id}`,
      data: {
        planId: targetPlanId,
        item: addedItem,
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[ADD_TO_PLAN_HANDLER] Error adding to plan', { error, userId });

    if (error instanceof ValidationError || error instanceof NotFoundError) {
      res.status(error instanceof NotFoundError ? 404 : 400).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to add to plan',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
