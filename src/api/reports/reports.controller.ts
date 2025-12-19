import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import { JiraReportService } from '@/services/integrations/jira-report.service';
import { supabaseAdmin } from '@/db/supabase';
import { FinalTestReport, JiraIssueRequest } from '@/types';

async function ensureUserOwnsTest(testId: string, userId: string): Promise<boolean> {
  // ✅ FIX #26/#27: Prevent cross-user data exposure; avoid testId enumeration by returning false for non-owned tests
  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('id')
    .eq('id', testId)
    .eq('user_id', userId)
    .single();

  return !!(data && !error);
}

/**
 * Generate final test report with code, artifacts, and analysis
 * POST /api/v1/reports/generate/:testId
 */
export const generateReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const { testId } = req.params;
    const userId = req.user?.id;

    if (!testId) {
      res.status(400).json({
        success: false,
        message: 'Test ID is required',
      });
      return;
    }

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'User authentication required',
      });
      return;
    }

    // ✅ FIX #26: Ownership check BEFORE any report/result access
    const ownsTest = await ensureUserOwnsTest(testId, userId);
    if (!ownsTest) {
      res.status(404).json({
        success: false,
        message: 'Test not found',
      });
      return;
    }

    logger.info('[REPORTS] Generating report', {
      testId,
      userId,
    });

    // Check if report already exists
    const existingReport = await TestReportGeneratorService.getReportByTestId(testId);
    if (existingReport) {
      res.status(200).json({
        success: true,
        message: 'Report already exists',
        data: existingReport,
      });
      return;
    }

    // Fetch test result from database
    const { data: testResult, error: testError } = await supabaseAdmin
      .from('test_results')
      .select('*')
      .eq('test_id', testId)
      .single();

    if (testError || !testResult) {
      res.status(404).json({
        success: false,
        message: 'Test result not found',
      });
      return;
    }

    // Fetch test plan if exists
    const { data: testPlan } = await supabaseAdmin
      .from('test_plans')
      .select('*')
      .eq('id', testId)
      .single();

    // Fetch AI analysis if exists
    const { data: aiAnalysis } = await supabaseAdmin
      .from('ai_analysis')
      .select('*')
      .eq('test_id', testId)
      .single();

    // Generate report
    const report = await TestReportGeneratorService.generateFinalReport({
      testId,
      testResult,
      testPlan: testPlan || undefined,
      aiAnalysis: aiAnalysis || undefined,
    });

    res.status(200).json({
      success: true,
      message: 'Report generated successfully',
      data: report,
    });
  } catch (error) {
    logger.error('[REPORTS] Generate report error', {
      error: error instanceof Error ? error.message : String(error),
      testId: req.params.testId,
    });

    res.status(500).json({
      success: false,
      message: 'Failed to generate report',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get existing report by test ID
 * GET /api/v1/reports/:testId
 */
export const getReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const { testId } = req.params;
    const userId = req.user?.id;

    if (!testId) {
      res.status(400).json({
        success: false,
        message: 'Test ID is required',
      });
      return;
    }

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'User authentication required',
      });
      return;
    }

    // ✅ FIX #26: Ownership check
    const ownsTest = await ensureUserOwnsTest(testId, userId);
    if (!ownsTest) {
      res.status(404).json({
        success: false,
        message: 'Report not found',
      });
      return;
    }

    const report = await TestReportGeneratorService.getReportByTestId(testId);

    if (!report) {
      res.status(404).json({
        success: false,
        message: 'Report not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    logger.error('[REPORTS] Get report error', {
      error: error instanceof Error ? error.message : String(error),
      testId: req.params.testId,
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get report',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Create Jira issue from test report
 * POST /api/v1/reports/:testId/jira
 */
export const createJiraIssue = async (req: Request, res: Response): Promise<void> => {
  try {
    const { testId } = req.params;
    const { projectKey, issueType, priority } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'User authentication required',
      });
      return;
    }

    if (!testId) {
      res.status(400).json({
        success: false,
        message: 'Test ID is required',
      });
      return;
    }

    // ✅ FIX #26: Ownership check BEFORE any report/result access
    const ownsTest = await ensureUserOwnsTest(testId, userId);
    if (!ownsTest) {
      res.status(404).json({
        success: false,
        message: 'Test not found',
      });
      return;
    }

    if (!projectKey) {
      res.status(400).json({
        success: false,
        message: 'Jira project key is required',
      });
      return;
    }

    logger.info('[REPORTS] Creating Jira issue', {
      testId,
      userId,
      projectKey,
      issueType,
    });

    // Get or generate report
    let report = await TestReportGeneratorService.getReportByTestId(testId);

    if (!report) {
      logger.info('[REPORTS] Report not found, generating...', { testId });

      // Fetch test result
      const { data: testResult, error: testError } = await supabaseAdmin
        .from('test_results')
        .select('*')
        .eq('test_id', testId)
        .single();

      if (testError || !testResult) {
        res.status(404).json({
          success: false,
          message: 'Test result not found',
        });
        return;
      }

      // Fetch test plan
      const { data: testPlan } = await supabaseAdmin
        .from('test_plans')
        .select('*')
        .eq('id', testId)
        .single();

      // Fetch AI analysis
      const { data: aiAnalysis } = await supabaseAdmin
        .from('ai_analysis')
        .select('*')
        .eq('test_id', testId)
        .single();

      // Generate report
      report = await TestReportGeneratorService.generateFinalReport({
        testId,
        testResult,
        testPlan: testPlan || undefined,
        aiAnalysis: aiAnalysis || undefined,
      });
    }

    // Create Jira issue
    const jiraIssue = await JiraReportService.createJiraIssueFromReport({
      userId,
      projectKey,
      testReport: report,
      issueType: issueType || 'Bug',
      priority,
    });

    res.status(200).json({
      success: true,
      message: 'Jira issue created successfully',
      data: {
        issueKey: jiraIssue.key,
        issueUrl: jiraIssue.self,
        report,
      },
    });
  } catch (error) {
    logger.error('[REPORTS] Create Jira issue error', {
      error: error instanceof Error ? error.message : String(error),
      testId: req.params.testId,
    });

    res.status(500).json({
      success: false,
      message: 'Failed to create Jira issue',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Download generated Playwright code
 * GET /api/v1/reports/:testId/code
 */
export const downloadCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const { testId } = req.params;
    const userId = req.user?.id;

    if (!testId) {
      res.status(400).json({
        success: false,
        message: 'Test ID is required',
      });
      return;
    }

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'User authentication required',
      });
      return;
    }

    // ✅ FIX #26: Ownership check
    const ownsTest = await ensureUserOwnsTest(testId, userId);
    if (!ownsTest) {
      res.status(404).json({
        success: false,
        message: 'Report not found',
      });
      return;
    }

    const report = await TestReportGeneratorService.getReportByTestId(testId);

    if (!report) {
      res.status(404).json({
        success: false,
        message: 'Report not found',
      });
      return;
    }

    // Set headers for file download
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="test-${testId}.spec.ts"`);

    res.status(200).send(report.generatedCode.code);
  } catch (error) {
    logger.error('[REPORTS] Download code error', {
      error: error instanceof Error ? error.message : String(error),
      testId: req.params.testId,
    });

    res.status(500).json({
      success: false,
      message: 'Failed to download code',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
