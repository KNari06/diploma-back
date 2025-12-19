import { Request, Response } from 'express';
import { supabaseAdmin } from '../../db/supabase';
import { IntelligentTestStorageService } from '../../services/testing/results/intelligent-test-storage.service';
import { TestReportGeneratorService } from '../../services/testing/results/test-report-generator.service';
import { PlaywrightStep, PlaywrightStepType } from '../../types/playwright.types';
import { logger } from '@/utils/core/logger';
import { exportGraph, parsePlaywrightTestSteps } from '@/utils/parsing/playwrightParser';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maximum allowed steps to prevent DoS
const MAX_STEPS_LIMIT = 1000;

// Maximum allowed nesting depth
const MAX_NESTING_DEPTH = 10;

/**
 * Parse test steps and return graph visualization
 */
export async function parseTestSteps(req: Request, res: Response): Promise<void> {
  try {
    const { steps, options } = req.body;

    // Validate steps array
    if (!steps || !Array.isArray(steps)) {
      res.status(400).json({
        success: false,
        error: 'Steps array is required',
      });
      return;
    }

    // Prevent DoS attacks with too many steps
    if (steps.length > MAX_STEPS_LIMIT) {
      res.status(400).json({
        success: false,
        error: `Too many steps. Maximum allowed: ${MAX_STEPS_LIMIT}`,
      });
      return;
    }

    // Validate steps structure and prevent deep nesting
    const validationResult = validateStepsStructure(steps);
    if (!validationResult.valid) {
      res.status(400).json({
        success: false,
        error: 'Invalid steps structure',
        details: validationResult.errors,
      });
      return;
    }

    // Validate options if provided
    if (options && typeof options !== 'object') {
      res.status(400).json({
        success: false,
        error: 'Options must be an object',
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

    if (res.headersSent) {
      logger.warn('[TEST_VISUALIZATION] Response already sent, cannot send error response');
      return;
    }

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

    // Validate steps array
    if (!steps || !Array.isArray(steps)) {
      res.status(400).json({
        success: false,
        error: 'Steps array is required',
      });
      return;
    }

    // Prevent DoS attacks with too many steps
    if (steps.length > MAX_STEPS_LIMIT) {
      res.status(400).json({
        success: false,
        error: `Too many steps. Maximum allowed: ${MAX_STEPS_LIMIT}`,
      });
      return;
    }

    // Validate format parameter
    if (typeof format !== 'string' || !['json', 'mermaid'].includes(format)) {
      res.status(400).json({
        success: false,
        error: 'Format must be either "json" or "mermaid"',
      });
      return;
    }

    // Validate steps structure
    const validationResult = validateStepsStructure(steps);
    if (!validationResult.valid) {
      res.status(400).json({
        success: false,
        error: 'Invalid steps structure',
        details: validationResult.errors,
      });
      return;
    }

    // Validate options if provided
    if (options && typeof options !== 'object') {
      res.status(400).json({
        success: false,
        error: 'Options must be an object',
      });
      return;
    }

    const graph = parsePlaywrightTestSteps(steps as PlaywrightStep[], options);
    const exported = exportGraph(graph, format as 'json' | 'mermaid');

    if (format === 'mermaid') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(exported);
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(exported);
    }
  } catch (error) {
    logger.error('Error exporting graph:', error);

    if (res.headersSent) {
      logger.warn('[TEST_VISUALIZATION] Response already sent, cannot send error response');
      return;
    }

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
    const userId = req.user?.id;

    // Validate testId parameter
    if (!testId) {
      res.status(400).json({
        success: false,
        error: 'Test ID is required',
      });
      return;
    }

    // Validate testId format (UUID)
    if (!UUID_REGEX.test(testId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid test ID format',
      });
      return;
    }

    // Validate format parameter
    if (typeof format !== 'string' || !['json', 'mermaid'].includes(format)) {
      res.status(400).json({
        success: false,
        error: 'Format must be either "json" or "mermaid"',
      });
      return;
    }

    logger.info('[TEST_VISUALIZATION] Getting test visualization', { testId, userId, format });

    // Get comprehensive test data
    const testData = await getComprehensiveTestData(testId, userId);

    if (!testData) {
      res.status(404).json({
        success: false,
        error: 'Test not found',
        message: 'Test not found or access denied',
      });
      return;
    }

    // ✅ NEW: Check if we have saved graph_data (perfect 1:1 match with real-time)
    let graph;
    let stepsSource = 'unknown';
    let steps: PlaywrightStep[] | undefined;

    logger.info('[TEST_VISUALIZATION] Checking for graph_data', {
      testId,
      hasIntelligentSession: !!testData.intelligentSession,
      hasSession: !!testData.intelligentSession?.session,
      hasGraphData: !!testData.intelligentSession?.session?.graph_data,
      graphDataNodes: testData.intelligentSession?.session?.graph_data?.nodes?.length || 0,
      graphDataEdges: testData.intelligentSession?.session?.graph_data?.edges?.length || 0,
    });

    if (testData.intelligentSession?.session?.graph_data) {
      // Use saved graph directly (no conversion needed)
      logger.info('[TEST_VISUALIZATION] Using saved graph_data from intelligent session', {
        testId,
        nodesCount: testData.intelligentSession.session.graph_data.nodes?.length || 0,
        edgesCount: testData.intelligentSession.session.graph_data.edges?.length || 0,
      });
      graph = testData.intelligentSession.session.graph_data;
      stepsSource = 'saved_graph';
    } else {
      // Fallback: Extract and convert steps from all available sources
      steps = await extractTestSteps(testData);

      if (!steps || steps.length === 0) {
        res.status(404).json({
          success: false,
          error: 'No test steps found',
          message: 'No executable steps found for this test',
          testData: {
            id: testData.test.id,
            status: testData.test.status,
            url: testData.test.url,
            hasResults: testData.results.length > 0,
            hasTraceFiles: testData.traceFiles.length > 0,
            hasIntelligentSession: !!testData.intelligentSession,
            hasReport: !!testData.report,
          },
        });
        return;
      }

      // Parse options
      let parsedOptions = {};
      if (options && typeof options === 'string') {
        try {
          parsedOptions = JSON.parse(options);
        } catch (e) {
          logger.warn('[TEST_VISUALIZATION] Invalid options JSON', { options });
        }
      } else if (options && typeof options === 'object') {
        parsedOptions = options;
      }

      // Generate visualization from steps
      logger.info('[TEST_VISUALIZATION] Generating graph from steps (no saved graph_data)');
      graph = parsePlaywrightTestSteps(steps, {
        includeStartEnd: true,
        autoLayout: true,
        addButtons: true,
        ...parsedOptions,
      });
      stepsSource = determineStepsSource(testData);
    }

    // Add metadata about data sources
    const metadata = {
      ...(graph.metadata || {}),
      testId,
      testUrl: testData.test.url,
      testStatus: testData.test.status,
      executedAt: testData.test.completed_at || testData.test.created_at,
      dataSources: {
        traceFiles: testData.traceFiles.length,
        testResults: testData.results.length,
        intelligentSession: !!testData.intelligentSession,
        report: !!testData.report,
        apiConfigs: testData.apiConfigs.length,
        usedSavedGraph: stepsSource === 'saved_graph', // ✅ NEW: Indicate if we used saved graph
      },
      stepsSource,
      generatedAt: new Date().toISOString(),
    };

    const result = {
      ...graph,
      metadata,
    };

    // Return in requested format
    if (format === 'mermaid') {
      const exported = exportGraph(result, 'mermaid');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(exported);
    } else {
      res.json({
        success: true,
        data: result,
        timestamp: new Date(),
      });
    }

    logger.info('[TEST_VISUALIZATION] Test visualization generated successfully', {
      testId,
      stepsCount: stepsSource === 'saved_graph' ? (graph.nodes?.length || 0) : (steps?.length || 0),
      nodesCount: graph.nodes?.length || 0,
      edgesCount: graph.edges.length,
      format,
    });

  } catch (error) {
    logger.error('Error getting test visualization:', error);

    if (res.headersSent) {
      logger.warn('[TEST_VISUALIZATION] Response already sent, cannot send error response');
      return;
    }

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

    // Prevent DoS attacks with too many steps
    if (steps.length > MAX_STEPS_LIMIT) {
      res.status(400).json({
        success: false,
        error: `Too many steps. Maximum allowed: ${MAX_STEPS_LIMIT}`,
        valid: false,
      });
      return;
    }

    const validationResult = validateStepsStructure(steps);

    res.json({
      success: true,
      valid: validationResult.valid,
      errors: validationResult.errors,
      warnings: validationResult.warnings,
      stepCount: steps.length,
      maxDepth: validationResult.maxDepth,
    });
  } catch (error) {
    logger.error('Error validating test steps:', error);

    if (res.headersSent) {
      logger.warn('[TEST_VISUALIZATION] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to validate test steps',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Comprehensive validation of steps structure
 */
function validateStepsStructure(steps: any[]): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  maxDepth: number;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let maxDepth = 0;

  // Valid step types
  const validStepTypes = [
    'goto', 'goBack', 'goForward', 'reload',
    'click', 'dblclick', 'fill', 'type', 'hover', 'check', 'uncheck', 'selectOption', 'press', 'focus', 'blur',
    'dragAndDrop', 'swipe', 'tap',
    'waitForSelector', 'waitForTimeout', 'waitForLoadState', 'waitForNavigation', 'scroll', 'scrollIntoView',
    'upload', 'download', 'screenshot',
    'assert', 'expect', 'assertVisible', 'assertHidden', 'assertEnabled', 'assertDisabled', 'assertText', 'assertValue', 'assertCount',
    'if', 'else', 'loop', 'while', 'forEach',
    'custom', 'script', 'evaluate'
  ];

  function validateStep(step: any, index: number | string, depth: number = 0): void {
    maxDepth = Math.max(maxDepth, depth);

    // Check maximum nesting depth
    if (depth > MAX_NESTING_DEPTH) {
      errors.push(`Step ${index}: Nesting depth exceeds maximum allowed (${MAX_NESTING_DEPTH})`);
      return;
    }

    // Required fields
    if (!step.id || typeof step.id !== 'string') {
      errors.push(`Step ${index}: Missing or invalid required field 'id'`);
    }
    if (!step.type || typeof step.type !== 'string') {
      errors.push(`Step ${index}: Missing or invalid required field 'type'`);
    } else if (!validStepTypes.includes(step.type)) {
      errors.push(`Step ${index}: Invalid step type '${step.type}'`);
    }
    if (!step.label || typeof step.label !== 'string') {
      warnings.push(`Step ${index}: Missing or invalid recommended field 'label'`);
    }

    // Validate ID uniqueness (basic check)
    if (step.id && typeof step.id === 'string' && step.id.length > 100) {
      warnings.push(`Step ${index}: ID is very long (${step.id.length} chars)`);
    }

    // Type-specific validation
    if (step.type === 'if') {
      if (!step.children || !Array.isArray(step.children)) {
        warnings.push(`Step ${index}: 'if' type should have 'children' array`);
      } else {
        step.children.forEach((childStep: any, childIndex: number) => {
          validateStep(childStep, `${index}.${childIndex}`, depth + 1);
        });
      }
      if (step.else && Array.isArray(step.else)) {
        step.else.forEach((elseStep: any, elseIndex: number) => {
          validateStep(elseStep, `${index}.else.${elseIndex}`, depth + 1);
        });
      }
    }

    if (['loop', 'while', 'forEach'].includes(step.type)) {
      if (!step.children || !Array.isArray(step.children)) {
        warnings.push(`Step ${index}: Loop type '${step.type}' should have 'children' array`);
      } else {
        step.children.forEach((childStep: any, childIndex: number) => {
          validateStep(childStep, `${index}.${childIndex}`, depth + 1);
        });
      }
    }

    // Validate selector for interaction steps
    const selectorRequiredTypes = ['click', 'dblclick', 'fill', 'type', 'hover', 'check', 'uncheck', 'selectOption', 'focus', 'blur'];
    if (selectorRequiredTypes.includes(step.type) && !step.selector) {
      warnings.push(`Step ${index}: Step type '${step.type}' should have 'selector' field`);
    }

    // Validate value for input steps
    const valueRequiredTypes = ['fill', 'type', 'selectOption'];
    if (valueRequiredTypes.includes(step.type) && step.value === undefined) {
      warnings.push(`Step ${index}: Step type '${step.type}' should have 'value' field`);
    }

    // Validate timeout
    if (step.timeout !== undefined && (typeof step.timeout !== 'number' || step.timeout < 0 || step.timeout > 300000)) {
      errors.push(`Step ${index}: Invalid timeout value (must be 0-300000ms)`);
    }
  }

  // Validate all steps
  steps.forEach((step, index) => {
    validateStep(step, index);
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    maxDepth,
  };
}

/**
 * Get comprehensive test data from all sources
 */
async function getComprehensiveTestData(testId: string, userId?: string): Promise<{
  test: any;
  results: any[];
  traceFiles: any[];
  intelligentSession: any;
  report: any;
  apiConfigs: any[];
} | null> {
  try {
    // 1. Get main test data
    const { data: test, error: testError } = await supabaseAdmin
      .from('tests')
      .select(`
        id, url, status, browsers, project_id, user_id, options,
        created_at, updated_at, started_at, completed_at
      `)
      .eq('id', testId)
      .single();

    if (testError || !test) {
      logger.warn('[TEST_VISUALIZATION] Test not found', { testId, error: testError });
      return null;
    }

    // Check access permissions
    if (userId && test.user_id && test.user_id !== userId) {
      logger.warn('[TEST_VISUALIZATION] Access denied', { testId, userId, testUserId: test.user_id });
      return null;
    }

    // 2. Get test results with all details
    // Note: video_url and trace_url may not exist in test_results table
    // They are typically stored in trace_files table
    const { data: results, error: resultsError} = await supabaseAdmin
      .from('test_results')
      .select(`
        id, test_id, browser, status, screenshot, dom, logs,
        network_logs, errors, performance, ai_summary,
        created_at, completed_at
      `)
      .eq('test_id', testId)
      .order('created_at', { ascending: true });

    if (resultsError) {
      logger.error('[TEST_VISUALIZATION] Error getting test results', { error: resultsError, testId });
    }

    // 3. Get trace files
    const { data: traceFiles, error: traceError } = await supabaseAdmin
      .from('trace_files')
      .select(`
        id, test_id, user_id, file_name, storage_path, file_size,
        browser, status, public_url, parsed_data, parsed_at, created_at
      `)
      .eq('test_id', testId)
      .order('created_at', { ascending: false });

    if (traceError) {
      logger.error('[TEST_VISUALIZATION] Error getting trace files', { error: traceError, testId });
    }

    // 4. Get intelligent test session (if exists)
    // ✅ ENHANCED: Load graph_data along with session
    let intelligentSession = null;
    try {
      const { data: sessions, error: sessionError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id, graph_data') // ✅ NEW: Include graph_data
        .eq('test_id', testId)
        .limit(1);

      if (!sessionError && sessions && sessions.length > 0) {
        logger.info('[TEST_VISUALIZATION] Found intelligent session', {
          testId,
          sessionId: sessions[0].id,
          hasGraphData: !!sessions[0].graph_data,
          graphDataType: typeof sessions[0].graph_data,
          graphDataIsObject: sessions[0].graph_data && typeof sessions[0].graph_data === 'object',
          graphDataNodes: sessions[0].graph_data?.nodes?.length || 0,
          graphDataEdges: sessions[0].graph_data?.edges?.length || 0,
        });

        intelligentSession = await IntelligentTestStorageService.getTestSession(sessions[0].id);

        // ✅ NEW: Attach graph_data to session if available
        if (intelligentSession && sessions[0].graph_data) {
          intelligentSession.session = {
            ...intelligentSession.session,
            graph_data: sessions[0].graph_data,
          };
          logger.info('[TEST_VISUALIZATION] Graph data attached to session', {
            testId,
            nodesCount: sessions[0].graph_data?.nodes?.length || 0,
            edgesCount: sessions[0].graph_data?.edges?.length || 0,
          });
        } else {
          logger.warn('[TEST_VISUALIZATION] Graph data not attached', {
            testId,
            hasIntelligentSession: !!intelligentSession,
            hasGraphData: !!sessions[0].graph_data,
          });
        }
      } else {
        logger.warn('[TEST_VISUALIZATION] No intelligent session found', {
          testId,
          sessionError: sessionError?.message,
          sessionsCount: sessions?.length || 0,
        });
      }
    } catch (error) {
      logger.warn('[TEST_VISUALIZATION] Error getting intelligent session', { error, testId });
    }

    // 5. Get test report (if exists)
    let report = null;
    try {
      report = await TestReportGeneratorService.getReportByTestId(testId);
    } catch (error) {
      logger.warn('[TEST_VISUALIZATION] Error getting test report', { error, testId });
    }

    // 6. Get API test configurations (if exists)
    // Note: api_test_configs table may not have test_id column
    // API configs are typically linked via different mechanism
    // Skip this query if table doesn't exist or structure is different
    let apiConfigs: any[] = [];
    try {
      const { data, error: apiError } = await supabaseAdmin
        .from('api_test_configs')
        .select(`
          id, name, description, test_data, expected_status,
          expected_response, setup_steps, cleanup_steps, validation_rules
        `)
        .eq('id', testId); // Using id instead of test_id as fallback

      if (!apiError && data) {
        apiConfigs = data;
      } else if (apiError) {
        logger.debug('[TEST_VISUALIZATION] API configs not available', { testId });
      }
    } catch (error) {
      logger.debug('[TEST_VISUALIZATION] API configs table not accessible', { testId });
    }

    return {
      test,
      results: results || [],
      traceFiles: traceFiles || [],
      intelligentSession,
      report,
      apiConfigs,
    };

  } catch (error) {
    logger.error('[TEST_VISUALIZATION] Error getting comprehensive test data', { error, testId });
    return null;
  }
}

/**
 * Extract and convert test steps from all available sources
 */
async function extractTestSteps(testData: {
  test: any;
  results: any[];
  traceFiles: any[];
  intelligentSession: any;
  report: any;
  apiConfigs: any[];
}): Promise<PlaywrightStep[]> {
  const steps: PlaywrightStep[] = [];

  // Priority 1: Trace files (most detailed)
  if (testData.traceFiles.length > 0) {
    const traceSteps = extractStepsFromTraceFiles(testData.traceFiles);
    if (traceSteps.length > 0) {
      logger.info('[TEST_VISUALIZATION] Using steps from trace files', { count: traceSteps.length });
      return traceSteps;
    }
  }

  // Priority 2: Test report (comprehensive)
  if (testData.report && testData.report.generatedCode?.steps) {
    const reportSteps = convertReportStepsToPlaywright(testData.report.generatedCode.steps, testData.report);
    if (reportSteps.length > 0) {
      logger.info('[TEST_VISUALIZATION] Using steps from test report', { count: reportSteps.length });
      return reportSteps;
    }
  }

  // Priority 3: Intelligent test session (AI-generated)
  // ✅ ENHANCED: Check if session has saved graph_data first
  if (testData.intelligentSession) {
    // ✅ NEW: If we have saved graph_data, use it directly (perfect 1:1 match with real-time)
    if (testData.intelligentSession.session?.graph_data) {
      logger.info('[TEST_VISUALIZATION] Using saved graph from intelligent session (1:1 match with real-time)');
      // Graph is already complete, no need to convert to steps
      // We'll handle this in a special way below
      return []; // Return empty to trigger graph_data usage
    }

    // Fallback: Convert from page visits if no graph_data
    const intelligentSteps = convertIntelligentSessionToPlaywright(testData.intelligentSession);
    if (intelligentSteps.length > 0) {
      logger.info('[TEST_VISUALIZATION] Using steps from intelligent session (converted)', { count: intelligentSteps.length });
      return intelligentSteps;
    }
  }

  // Priority 4: AI Summary from test results
  if (testData.results.length > 0) {
    const aiSteps = extractStepsFromAISummary(testData.results);
    if (aiSteps.length > 0) {
      logger.info('[TEST_VISUALIZATION] Using steps from AI summary', { count: aiSteps.length });
      return aiSteps;
    }
  }

  // Priority 5: API test configurations
  if (testData.apiConfigs.length > 0) {
    const apiSteps = convertApiConfigsToPlaywright(testData.apiConfigs, testData.test);
    if (apiSteps.length > 0) {
      logger.info('[TEST_VISUALIZATION] Using steps from API configs', { count: apiSteps.length });
      return apiSteps;
    }
  }

  // Priority 6: Generate basic steps from test data
  const basicSteps = generateBasicStepsFromTest(testData.test);
  logger.info('[TEST_VISUALIZATION] Using basic generated steps', { count: basicSteps.length });
  return basicSteps;
}

/**
 * Extract steps from trace files
 */
function extractStepsFromTraceFiles(traceFiles: any[]): PlaywrightStep[] {
  for (const traceFile of traceFiles) {
    if (traceFile.parsed_data && traceFile.parsed_data.steps) {
      return traceFile.parsed_data.steps.map((step: any, index: number) => ({
        id: step.stepId?.toString() || `trace_${index}`,
        type: mapTraceTypeToPlaywright(step.type),
        label: step.description || `${step.type} action`,
        selector: step.selector,
        value: step.text,
        timeout: step.timeout,
        meta: {
          source: 'trace',
          timestamp: step.timestamp,
          traceFile: traceFile.file_name,
        },
      }));
    }
  }
  return [];
}

/**
 * Convert report steps to Playwright format
 */
function convertReportStepsToPlaywright(steps: string[], report: any): PlaywrightStep[] {
  return steps.map((step, index) => ({
    id: `report_${index}`,
    type: 'custom',
    label: step,
    meta: {
      source: 'report',
      reportId: report.testId,
      artifacts: report.artifacts,
      analysis: report.analysis,
    },
  }));
}

/**
 * Convert intelligent session to Playwright format
 */
function convertIntelligentSessionToPlaywright(session: any): PlaywrightStep[] {
  const steps: PlaywrightStep[] = [];

  if (session.pages) {
    session.pages.forEach((page: any, pageIndex: number) => {
      // Add navigation step
      steps.push({
        id: `nav_${pageIndex}`,
        type: 'goto',
        label: `Navigate to ${page.url}`,
        value: page.url,
        meta: {
          source: 'intelligent',
          pageTitle: page.title,
          visitOrder: page.visit_order,
        },
      });

      // Add action steps
      if (page.actions) {
        page.actions.forEach((action: any, actionIndex: number) => {
          steps.push({
            id: `action_${pageIndex}_${actionIndex}`,
            type: mapActionTypeToPlaywright(action.action_type),
            label: action.description || action.action_type,
            selector: action.selector,
            value: action.value,
            meta: {
              source: 'intelligent',
              success: action.success,
              errorMessage: action.error_message,
              durationMs: action.duration_ms,
            },
          });
        });
      }
    });
  }

  return steps;
}

/**
 * Extract steps from AI summary
 */
function extractStepsFromAISummary(results: any[]): PlaywrightStep[] {
  for (const result of results) {
    if (result.ai_summary && result.ai_summary.steps) {
      return result.ai_summary.steps.map((step: any, index: number) => ({
        id: `ai_${index}`,
        type: mapAITypeToPlaywright(step.type || step.action),
        label: step.description || step.label || `Step ${index + 1}`,
        selector: step.selector,
        value: step.value || step.text,
        meta: {
          source: 'ai_summary',
          browser: result.browser,
          confidence: step.confidence,
        },
      }));
    }
  }
  return [];
}

/**
 * Convert API configs to Playwright format
 */
function convertApiConfigsToPlaywright(apiConfigs: any[], test: any): PlaywrightStep[] {
  const steps: PlaywrightStep[] = [];

  apiConfigs.forEach((config, configIndex) => {
    // Add setup steps
    if (config.setup_steps) {
      config.setup_steps.forEach((step: any, stepIndex: number) => {
        steps.push({
          id: `setup_${configIndex}_${stepIndex}`,
          type: 'custom',
          label: `Setup: ${step.description || step.action}`,
          value: step.value,
          meta: {
            source: 'api_config',
            configName: config.name,
            stepType: 'setup',
          },
        });
      });
    }

    // Add main API test step
    steps.push({
      id: `api_${configIndex}`,
      type: 'custom',
      label: `API Test: ${config.name}`,
      value: config.description,
      meta: {
        source: 'api_config',
        configName: config.name,
        expectedStatus: config.expected_status,
        testData: config.test_data,
      },
    });

    // Add cleanup steps
    if (config.cleanup_steps) {
      config.cleanup_steps.forEach((step: any, stepIndex: number) => {
        steps.push({
          id: `cleanup_${configIndex}_${stepIndex}`,
          type: 'custom',
          label: `Cleanup: ${step.description || step.action}`,
          value: step.value,
          meta: {
            source: 'api_config',
            configName: config.name,
            stepType: 'cleanup',
          },
        });
      });
    }
  });

  return steps;
}

/**
 * Generate basic steps from test data
 */
function generateBasicStepsFromTest(test: any): PlaywrightStep[] {
  const steps: PlaywrightStep[] = [];

  // Add navigation step
  steps.push({
    id: 'basic_nav',
    type: 'goto',
    label: `Navigate to ${test.url}`,
    value: test.url,
    meta: {
      source: 'generated',
      testId: test.id,
      browsers: test.browsers,
    },
  });

  // Add basic interaction step
  steps.push({
    id: 'basic_interaction',
    type: 'custom',
    label: 'Perform test interactions',
    meta: {
      source: 'generated',
      note: 'Detailed steps not available - test was executed but steps were not recorded',
    },
  });

  return steps;
}

/**
 * Map trace action types to Playwright types
 * @param type - Trace action type (from Playwright trace)
 * @returns PlaywrightStepType for visualization
 */
function mapTraceTypeToPlaywright(type: string): PlaywrightStepType {
  // Validate input
  if (!type || typeof type !== 'string' || type.trim().length === 0) {
    logger.debug('[TEST_VISUALIZATION] Invalid type in mapTraceTypeToPlaywright', { type });
    return 'custom';
  }

  const normalizedType = type.trim().toLowerCase();

  const mapping: Record<string, PlaywrightStepType> = {
    'navigate': 'goto',
    'goto': 'goto',
    'click': 'click',
    'fill': 'fill',
    'type': 'type',
    'screenshot': 'screenshot',
    'waitForSelector': 'waitForSelector',
    'wait': 'waitForSelector',
    'waitForTimeout': 'wait',
    'expect': 'assert',
    'assert': 'assert',
    'assertVisible': 'assertVisible',
    'assertText': 'assertText',
    'assertValue': 'assertValue',
    'assertUrl': 'assertUrl',
    'assertCount': 'assertCount',
    'hover': 'hover',
    'scroll': 'scroll',
    'select': 'select',
    'selectOption': 'selectOption',
    'check': 'check',
    'uncheck': 'uncheck',
    'press': 'press',
    'extract': 'extract',
    'evaluate': 'evaluate',
  };

  const mappedType = mapping[normalizedType];
  if (mappedType) {
    return mappedType;
  }

  // Log unmapped types for debugging
  logger.debug('[TEST_VISUALIZATION] Unmapped trace type', { type, normalizedType });
  return 'custom';
}

/**
 * Map action types to Playwright types
 * @param type - Action type (from test report or intelligent session)
 * @returns PlaywrightStepType for visualization
 */
function mapActionTypeToPlaywright(type: string): PlaywrightStepType {
  // Validate input
  if (!type || typeof type !== 'string' || type.trim().length === 0) {
    logger.debug('[TEST_VISUALIZATION] Invalid type in mapActionTypeToPlaywright', { type });
    return 'custom';
  }

  const normalizedType = type.trim().toLowerCase();

  const mapping: Record<string, PlaywrightStepType> = {
    'click': 'click',
    'fill': 'fill',
    'type': 'type',
    'navigate': 'goto',
    'goto': 'goto',
    'scroll': 'scroll',
    'hover': 'hover',
    'wait': 'waitForSelector',
    'waitForSelector': 'waitForSelector',
    'waitForTimeout': 'wait',
    'screenshot': 'screenshot',
    'assert': 'assert',
    'expect': 'assert',
    'assertVisible': 'assertVisible',
    'assertText': 'assertText',
    'assertValue': 'assertValue',
    'assertUrl': 'assertUrl',
    'assertCount': 'assertCount',
    'select': 'select',
    'selectOption': 'selectOption',
    'check': 'check',
    'uncheck': 'uncheck',
    'press': 'press',
  };

  const mappedType = mapping[normalizedType];
  if (mappedType) {
    return mappedType;
  }

  // Log unmapped types for debugging
  logger.debug('[TEST_VISUALIZATION] Unmapped action type', { type, normalizedType });
  return 'custom';
}

/**
 * Map AI summary types to Playwright types
 * @param type - AI-generated action type (from AI summary)
 * @returns PlaywrightStepType for visualization
 */
function mapAITypeToPlaywright(type: string): PlaywrightStepType {
  // Validate input
  if (!type || typeof type !== 'string' || type.trim().length === 0) {
    logger.debug('[TEST_VISUALIZATION] Invalid type in mapAITypeToPlaywright', { type });
    return 'custom';
  }

  const normalizedType = type.trim().toLowerCase();

  const mapping: Record<string, PlaywrightStepType> = {
    'navigation': 'goto',
    'navigate': 'goto',
    'goto': 'goto',
    'click': 'click',
    'input': 'fill',
    'fill': 'fill',
    'type': 'type',
    'typing': 'type',
    'assertion': 'assert',
    'assert': 'assert',
    'expect': 'assert',
    'wait': 'waitForSelector',
    'waiting': 'waitForSelector',
    'waitForSelector': 'waitForSelector',
    'screenshot': 'screenshot',
    'scroll': 'scroll',
    'scrolling': 'scroll',
    'hover': 'hover',
    'select': 'select',
    'selection': 'select',
    'check': 'check',
    'uncheck': 'uncheck',
    'press': 'press',
    'keypress': 'press',
  };

  const mappedType = mapping[normalizedType];
  if (mappedType) {
    return mappedType;
  }

  // Log unmapped types for debugging
  logger.debug('[TEST_VISUALIZATION] Unmapped AI type', { type, normalizedType });
  return 'custom';
}

/**
 * Determine the primary source of steps
 */
function determineStepsSource(testData: any): string {
  if (testData.traceFiles.length > 0 && testData.traceFiles[0].parsed_data?.steps) {
    return 'trace_files';
  }
  if (testData.report && testData.report.generatedCode?.steps) {
    return 'test_report';
  }
  if (testData.intelligentSession) {
    return 'intelligent_session';
  }
  if (testData.results.some((r: any) => r.ai_summary?.steps)) {
    return 'ai_summary';
  }
  if (testData.apiConfigs.length > 0) {
    return 'api_configs';
  }
  return 'generated_basic';
}
