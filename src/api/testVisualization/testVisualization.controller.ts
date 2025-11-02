import { Request, Response } from 'express';
import { PlaywrightStep } from '../../types/playwright.types';
import { logger } from '../../utils/logger';
import { exportGraph, parsePlaywrightTestSteps } from '../../utils/playwrightParser';

/**
 * Parse test steps and return graph visualization
 */
export async function parseTestSteps(req: Request, res: Response): Promise<void> {
  try {
    const { steps, options } = req.body;

    if (!steps || !Array.isArray(steps)) {
      res.status(400).json({
        success: false,
        error: 'Steps array is required',
      });
      return;
    }

    const graph = parsePlaywrightTestSteps(steps as PlaywrightStep[], options);

    res.json({
      success: true,
      data: graph,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('Error parsing test steps:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to parse test steps',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Export graph in different formats
 */
export async function exportTestGraph(req: Request, res: Response): Promise<void> {
  try {
    const { steps, format = 'json', options } = req.body;

    if (!steps || !Array.isArray(steps)) {
      res.status(400).json({
        success: false,
        error: 'Steps array is required',
      });
      return;
    }

    if (!['json', 'mermaid'].includes(format)) {
      res.status(400).json({
        success: false,
        error: 'Format must be either "json" or "mermaid"',
      });
      return;
    }

    const graph = parsePlaywrightTestSteps(steps as PlaywrightStep[], options);
    const exported = exportGraph(graph, format as 'json' | 'mermaid');

    if (format === 'mermaid') {
      res.setHeader('Content-Type', 'text/plain');
      res.send(exported);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send(exported);
    }
  } catch (error) {
    logger.error('Error exporting graph:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export graph',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Get visualization for existing test by ID
 */
export async function getTestVisualization(req: Request, res: Response): Promise<void> {
  try {
    const { testId } = req.params;
    const { format = 'json', options } = req.query;

    // TODO: Fetch test steps from database
    // For now, return placeholder response
    res.status(501).json({
      success: false,
      error: 'Not implemented',
      message: 'Test visualization from database not yet implemented',
      hint: 'Use POST /api/test-visualization/parse with steps array instead',
    });
  } catch (error) {
    logger.error('Error getting test visualization:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get test visualization',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Validate test steps structure
 */
export async function validateTestSteps(req: Request, res: Response): Promise<void> {
  try {
    const { steps } = req.body;

    if (!steps || !Array.isArray(steps)) {
      res.status(400).json({
        success: false,
        error: 'Steps array is required',
        valid: false,
      });
      return;
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate each step
    steps.forEach((step: any, index: number) => {
      if (!step.id) {
        errors.push(`Step ${index}: Missing required field 'id'`);
      }
      if (!step.type) {
        errors.push(`Step ${index}: Missing required field 'type'`);
      }
      if (!step.label) {
        warnings.push(`Step ${index}: Missing recommended field 'label'`);
      }

      // Check for nested steps validation
      if (step.type === 'if' && !step.children) {
        warnings.push(`Step ${index}: 'if' type should have 'children' array`);
      }
      if (['loop', 'while', 'forEach'].includes(step.type) && !step.children) {
        warnings.push(`Step ${index}: Loop type should have 'children' array`);
      }
    });

    const valid = errors.length === 0;

    res.json({
      success: true,
      valid,
      errors,
      warnings,
      stepCount: steps.length,
    });
  } catch (error) {
    logger.error('Error validating test steps:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate test steps',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
