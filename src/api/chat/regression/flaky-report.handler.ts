/**
 * FLAKY REPORT HANDLER (Phase 2)
 *
 * Handles the 'flaky_report' intent — "which tests are flaky?", "show flaky
 * tests in the last 2 weeks". Read-only: calls qa_detect_flaky_tests through
 * the central tool pipeline (no confirm gating).
 *
 * Triggered by:
 * - "show me flaky tests"
 * - "which tests are unreliable lately?"
 * - "покажи нестабильные тесты за последние 2 недели"
 */

import { NotFoundError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { resolveProjectId } from './project-resolver';
import { runManageTool, type ManageToolParams } from './shared/manage-tool.helper';

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90;

interface FlakyReportParams extends ManageToolParams {
  message: string;
  parsedIntent?: any;
}

export async function handleFlakyReportIntent(
  _req: Request,
  res: Response,
  params: FlakyReportParams,
): Promise<void> {
  const { parsedIntent, userId, workspace_id } = params;

  try {
    logger.info('[FLAKY_REPORT_HANDLER] Processing flaky report intent', { userId });

    const projectId = await resolveProjectId(params);
    if (!projectId) {
      throw new NotFoundError('Project', workspace_id);
    }

    // Optional lookback window the classifier extracted (e.g. "last 2 weeks" →
    // analysis.lookbackDays=14), clamped to the tool's max. Defaults to 30.
    const requestedDays = parsedIntent?.metadata?.analysis?.lookbackDays;
    const days = Number.isFinite(requestedDays) && requestedDays > 0
      ? Math.min(requestedDays, MAX_LOOKBACK_DAYS)
      : DEFAULT_LOOKBACK_DAYS;

    await runManageTool({
      toolName: 'qa_detect_flaky_tests',
      args: { project_id: projectId, days },
      params,
      res,
      logTag: 'FLAKY_REPORT_HANDLER',
    });
  } catch (error) {
    logger.error('[FLAKY_REPORT_HANDLER] Error generating flaky report', { error, userId });

    if (error instanceof NotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Failed to generate flaky report',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
