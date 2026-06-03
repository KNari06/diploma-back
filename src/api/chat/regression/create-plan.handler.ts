/**
 * CREATE PLAN HANDLER - Regression Plan Creation
 *
 * Handles the 'create_plan' intent detected by AI intent parser.
 * Creates a new regression plan with specified modules.
 *
 * Triggered by:
 * - "create plan from Auth and Payments"
 * - "create regression plan Pre-release"
 * - "создай план из модулей Auth и Payments"
 */

import { supabaseAdmin } from '@/db/supabase';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { resolveProjectId } from './project-resolver';

/**
 * Handler for create_plan intent
 * Creates a regression plan from specified items
 */
export async function handleCreatePlanIntent(
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
    logger.info('[CREATE_PLAN_HANDLER] Processing create plan intent', {
      intent: parsedIntent,
      userId,
    });

    // Extract plan details from parsed intent
    const planName = parsedIntent?.suggestedName || parsedIntent?.planName;
    const moduleNames = parsedIntent?.moduleNames || [];
    const description = parsedIntent?.description;

    if (!planName) {
      res.json({
        success: true,
        message: userLanguage === 'ru'
          ? 'Укажите название плана. Как назвать план?'
          : 'Please provide a plan name. What would you like to call this plan?',
        data: {
          needsClarification: true,
          question: 'What would you like to name this regression plan?',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    // Resolve the target project (workspace-membership scoped — see resolver).
    const projectId = await resolveProjectId(params);

    if (!projectId) {
      throw new NotFoundError('Project', workspace_id);
    }

    // Create the plan
    const plan = await RegressionPlanService.create({
      projectId,
      userId,
      name: planName,
      description,
    });

    // Add modules if specified
    for (const moduleName of moduleNames) {
      const { data: mod } = await supabaseAdmin
        .from('test_modules')
        .select('id')
        .eq('project_id', projectId)
        .ilike('name', moduleName)
        .limit(1)
        .maybeSingle();

      if (mod) {
        await RegressionPlanService.addItem({
          planId: plan.id,
          itemType: 'module',
          moduleId: mod.id,
        });
      }
    }

    logger.info('[CREATE_PLAN_HANDLER] Plan created', {
      planId: plan.id,
      planName,
      modulesAdded: moduleNames.length,
    });

    res.json({
      success: true,
      message: userLanguage === 'ru'
        ? `План "${planName}" создан. ID: ${plan.id}`
        : `Plan "${planName}" created. ID: ${plan.id}`,
      data: {
        planId: plan.id,
        planName: plan.name,
        itemsAdded: moduleNames.length,
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[CREATE_PLAN_HANDLER] Error creating plan', { error, userId });

    if (error instanceof ValidationError || error instanceof NotFoundError) {
      res.status(error instanceof NotFoundError ? 404 : 400).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create plan',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
