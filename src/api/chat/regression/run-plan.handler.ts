/**
 * RUN PLAN HANDLER - Regression Plan Execution
 *
 * Handles the 'run_plan' intent detected by AI intent parser.
 * Executes a regression plan (custom test set).
 *
 * Triggered by:
 * - "run plan Pre-release"
 * - "execute regression plan"
 * - "запусти план Pre-release"
 */

import { supabaseAdmin } from '@/db/supabase';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for run_plan intent
 * Runs a regression plan by name or ID
 */
export async function handleRunPlanIntent(
  req: Request,
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
  const localized = getLocalizedMessages(userLanguage);

  try {
    logger.info('[RUN_PLAN_HANDLER] Processing run plan intent', {
      intent: parsedIntent,
      userId,
    });

    // Extract plan identifier from parsed intent
    const planId = parsedIntent?.planId;
    const planName = parsedIntent?.planName || parsedIntent?.suggestedName;

    let targetPlanId = planId;

    // If no ID but name provided, search for plan
    if (!targetPlanId && planName) {
      // Get project from workspace
      const { data: project } = await supabaseAdmin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspace_id)
        .eq('user_id', userId)
        .limit(1)
        .single();

      if (project) {
        const plans = await RegressionPlanService.listByProject(project.id, userId);
        const matchedPlan = plans.find(
          (p) => p.name.toLowerCase() === planName.toLowerCase()
        );
        if (matchedPlan) {
          targetPlanId = matchedPlan.id;
        }
      }
    }

    if (!targetPlanId) {
      res.json({
        success: true,
        message: userLanguage === 'ru'
          ? 'Укажите план для запуска. Какой план вы хотите запустить?'
          : 'Please specify a plan to run. Which plan would you like to execute?',
        data: {
          needsClarification: true,
          question: 'Which regression plan would you like to run?',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    // Run the plan
    const result = await RegressionRunService.runPlan({
      planId: targetPlanId,
      userId,
      trigger: 'chat',
      parameters: parsedIntent?.parameters || {},
    });

    logger.info('[RUN_PLAN_HANDLER] Plan execution started', {
      runId: result.runId,
      totalTests: result.totalTests,
    });

    res.json({
      success: true,
      message: userLanguage === 'ru'
        ? `План запущен. Run ID: ${result.runId}. Всего тестов: ${result.totalTests}`
        : `Plan execution started. Run ID: ${result.runId}. Total tests: ${result.totalTests}`,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        type: 'plan',
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[RUN_PLAN_HANDLER] Error running plan', { error, userId });

    if (error instanceof ValidationError || error instanceof NotFoundError) {
      res.status(error instanceof NotFoundError ? 404 : 400).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: localized.runRegression?.error || 'Failed to run plan',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
