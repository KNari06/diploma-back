/**
 * API Flow Spec Controller
 * REST endpoints for managing API flow specs and running them
 */

import { Request, Response } from 'express';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { FlowBuilderService } from '@/services/testing/api/flow/flow-builder.service';
import { FlowExecutorService, cancelFlowRun, createFlowRun } from '@/services/testing/api/flow/flow-executor.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import type { ParseSpecRequest, RunFlowRequest } from '@/services/testing/api/flow/flow.types';

/** Extract and validate userId from request. Returns null if missing. */
function getUserId(req: Request): string | null {
  const userId = (req as any).user?.id || (req as any).userId;
  return userId && typeof userId === 'string' ? userId : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/api-flow-spec/parse
// Parse a Swagger URL or uploaded spec → AI DAG → visualization
// ─────────────────────────────────────────────────────────────────────────────

export const parseSpec = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { source, url, content, fileName, projectId, environmentId, chatSessionId, analysisId, userAnswers } = req.body;

    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }
    if (source === 'url' && !url) {
      res.status(400).json({ success: false, error: 'url is required when source is url' });
      return;
    }
    if (source === 'file' && !content) {
      res.status(400).json({ success: false, error: 'content is required when source is file' });
      return;
    }
    if (!['url', 'file'].includes(source)) {
      res.status(400).json({ success: false, error: 'source must be "url" or "file"' });
      return;
    }

    const parseRequest: ParseSpecRequest = {
      source,
      url,
      content,
      fileName,
      projectId,
      environmentId,
      chatSessionId,
      analysisId,
      userAnswers,
    };

    logger.info('[FLOW_SPEC_CONTROLLER] Parsing spec', { source, url, projectId, userId });

    const result = await FlowBuilderService.buildFromSpec(parseRequest, userId);

    // If AI has questions, return them instead of the DAG
    if (result.questions && result.questions.length > 0) {
      res.json({
        success: true,
        needsInput: true,
        data: {
          questions: result.questions,
          analysisId: result.analysisId,
          confidence: result.confidence,
          specSummary: {
            title: result.spec.title,
            totalEndpoints: result.spec.endpoints.length,
          },
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        flowSpec: result.flowSpec,
        visualization: result.visualization,
        dag: result.dag,
        specSummary: {
          title: result.spec.title,
          version: result.spec.version,
          baseUrl: result.spec.baseUrl,
          totalEndpoints: result.spec.endpoints.length + result.spec.unsupportedEndpoints.length,
          supportedEndpoints: result.spec.endpoints.length,
          unsupportedEndpoints: result.spec.unsupportedEndpoints,
          authSchemes: result.spec.authSchemes,
        },
      },
    });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Parse failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message || 'Failed to parse spec' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/api-flow-spec/project/:projectId
// List all flow specs for a project
// ─────────────────────────────────────────────────────────────────────────────

export const listByProject = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { projectId } = req.params;
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);

    const result = await FlowBuilderService.listByProject(projectId, userId, limit, offset);

    res.json({
      success: true,
      data: result.specs,
      pagination: { total: result.total, limit, offset },
    });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] List failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to list flow specs' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/api-flow-spec/:id
// Get flow spec details with visualization
// ─────────────────────────────────────────────────────────────────────────────

export const getById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { id } = req.params;

    const flowSpec = await FlowBuilderService.getById(id, userId);
    if (!flowSpec) {
      res.status(404).json({ success: false, error: 'Flow spec not found' });
      return;
    }

    // Rebuild visualization from stored DAG
    const visualization = FlowBuilderService.buildVisualizationFromDag(flowSpec.executionDag);

    res.json({
      success: true,
      data: { flowSpec, visualization },
    });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Get failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get flow spec' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/api-flow-spec/:id
// Update flow spec (DAG edits, error strategy)
// ─────────────────────────────────────────────────────────────────────────────

export const updateSpec = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { id } = req.params;
    const { executionDag, errorStrategy } = req.body;

    const updated = await FlowBuilderService.update(id, userId, { executionDag, errorStrategy });
    if (!updated) {
      res.status(404).json({ success: false, error: 'Flow spec not found' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Update failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to update flow spec' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/api-flow-spec/:id
// ─────────────────────────────────────────────────────────────────────────────

export const deleteSpec = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { id } = req.params;

    const deleted = await FlowBuilderService.delete(id, userId);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Flow spec not found' });
      return;
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Delete failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to delete flow spec' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/api-flow-spec/:id/run
// Start flow execution
// ─────────────────────────────────────────────────────────────────────────────

export const runFlow = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { id } = req.params;
    const { config, chatSessionId, nodeOverrides } = req.body as RunFlowRequest;

    const flowSpec = await FlowBuilderService.getById(id, userId);
    if (!flowSpec) {
      res.status(404).json({ success: false, error: 'Flow spec not found' });
      return;
    }

    logger.info('[FLOW_SPEC_CONTROLLER] Starting flow run', { flowSpecId: id, userId });

    // Credit check: 1 credit per endpoint in the flow
    const creditCost = flowSpec.executionDag?.nodes?.length || 1;
    const hasCredits = await UserCreditsService.hasCredits(userId, creditCost);
    if (!hasCredits) {
      res.status(402).json({
        success: false,
        error: `Insufficient credits. This flow requires ${creditCost} credits (1 per endpoint).`,
      });
      return;
    }

    const creditResult = await UserCreditsService.deductCredits(
      userId,
      creditCost,
      `API Flow: ${flowSpec.name} (${creditCost} endpoints)`,
      { flowSpecId: id, endpoints: creditCost },
    );

    if (!creditResult.success) {
      res.status(402).json({
        success: false,
        error: 'Failed to deduct credits. Please try again.',
      });
      return;
    }

    // Create flow run record first so we can return the ID immediately
    const flowRunId = await createFlowRun(flowSpec.id, userId, {
      ...({ errorStrategy: flowSpec.errorStrategy, maxRetries: 3, retryBackoffMs: 1000, stepTimeoutMs: 15000, totalTimeoutMs: 300000, rateLimitDelayMs: 100 }),
      ...(config || {}),
    } as any, chatSessionId);

    const runRequest: RunFlowRequest = { config, chatSessionId, nodeOverrides };

    // Start execution async — refund credits on catastrophic failure (not step failures)
    FlowExecutorService.execute(flowSpec, userId, runRequest, flowRunId).catch(async (error) => {
      logger.error('[FLOW_SPEC_CONTROLLER] Flow execution failed catastrophically, refunding credits', {
        flowSpecId: id,
        error: error.message,
        creditCost,
      });
      // Refund credits via addCredits with type 'refund'
      await UserCreditsService.addCredits(
        userId,
        creditCost,
        'refund',
        `Refund: API Flow "${flowSpec.name}" failed to execute`,
        { flowSpecId: id },
      ).catch(refundErr => {
        logger.error('[FLOW_SPEC_CONTROLLER] Credit refund failed', { error: refundErr });
      });
    });

    res.json({
      success: true,
      message: 'Flow execution started. Follow progress via WebSocket events.',
      flowSpecId: id,
      flowRunId,
    });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Run failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to start flow execution' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/api-flow-spec/:id/stop
// Cancel running flow execution
// ─────────────────────────────────────────────────────────────────────────────

export const stopFlow = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { runId } = req.body;
    if (!runId) {
      res.status(400).json({ success: false, error: 'runId is required' });
      return;
    }

    // Verify the requesting user owns this run
    const { data: run } = await supabaseAdmin
      .from('api_flow_runs')
      .select('user_id')
      .eq('id', runId)
      .maybeSingle();
    if (run && run.user_id !== userId) {
      res.status(403).json({ success: false, error: 'Not authorized to stop this run' });
      return;
    }

    const cancelled = cancelFlowRun(runId);
    res.json({ success: true, cancelled });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to stop flow' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/api-flow-spec/:id/runs
// List execution runs for a flow spec
// ─────────────────────────────────────────────────────────────────────────────

export const getRuns = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { id } = req.params;
    const limit = parseInt(String(req.query.limit || '10'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);

    const result = await FlowBuilderService.getRuns(id, userId, limit, offset);

    res.json({
      success: true,
      data: result.runs,
      pagination: { total: result.total, limit, offset },
    });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Get runs failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get runs' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/api-flow-spec/:id/runs/:runId
// Get specific run details
// ─────────────────────────────────────────────────────────────────────────────

export const getRunById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { runId } = req.params;

    const run = await FlowBuilderService.getRunById(runId, userId);
    if (!run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    res.json({ success: true, data: run });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Get run failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get run' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/api-flow-spec/:id/reparse
// Re-fetch spec from source URL and rebuild DAG (preserves user overrides)
// ─────────────────────────────────────────────────────────────────────────────

export const reparseSpec = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    const existing = await FlowBuilderService.getById(id, userId);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Flow spec not found' });
      return;
    }

    if (!existing.sourceUrl) {
      res.status(400).json({
        success: false,
        error: 'Cannot re-parse: this flow was created from a file upload, not a URL. Please upload the updated file via /parse.',
      });
      return;
    }

    logger.info('[FLOW_SPEC_CONTROLLER] Re-parsing spec', { flowSpecId: id, url: existing.sourceUrl });

    // Re-build from same URL, same project
    const result = await FlowBuilderService.buildFromSpec({
      source: 'url',
      url: existing.sourceUrl,
      projectId: existing.projectId,
      environmentId: existing.environmentId,
    }, userId);

    // Preserve user's error strategy from the old spec
    if (result.flowSpec && existing.errorStrategy !== 'stop_on_failure') {
      await FlowBuilderService.update(result.flowSpec.id, userId, {
        errorStrategy: existing.errorStrategy,
      });
    }

    res.json({
      success: true,
      data: {
        flowSpec: result.flowSpec,
        visualization: result.visualization,
        previousId: id,
        changes: {
          oldEndpoints: existing.totalEndpoints,
          newEndpoints: result.spec.endpoints.length,
        },
      },
    });
  } catch (error: any) {
    logger.error('[FLOW_SPEC_CONTROLLER] Re-parse failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message || 'Failed to re-parse spec' });
  }
};
