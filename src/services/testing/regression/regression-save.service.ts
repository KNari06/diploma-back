import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION SAVE SERVICE - Save test flows as reusable test cases
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extracts replay data from completed tests and creates:
 * - Intent test cases (unified table for UI test cases)
 * - Regression suites (collections of related test cases)
 *
 * Key Features:
 * - Automatic parameterization of sensitive values (passwords, tokens)
 * - Support for commands-based and graph-based replay strategies
 * - URL persistence for reliable replay
 * - Access control verification
 *
 * NOTE: UI test cases are now stored in intent_test_cases (unified table)
 * with status='published' when saved from a completed test.
 */

// Limits to prevent resource abuse
const MAX_PARAMETERS_PER_TEST = 50;
const MAX_TEST_CASES_PER_SUITE = 100;
const MAX_COMMAND_LENGTH = 10000;

/**
 * Service for saving test flows as regression test cases
 * Extracts replay data from completed tests
 */
export class RegressionSaveService {
  /**
   * Save a test flow as a standalone test case or suite member
   *
   * @param params.sourceTestId - ID of completed test to save
   * @param params.userId - User ID for ownership verification
   * @param params.name - Display name for saved test case
   * @param params.description - Optional description
   * @param params.kind - 'standalone' for independent test or 'regression_member' for suite inclusion
   * @returns Saved test case metadata
   * @throws {NotFoundError} If source test not found
   * @throws {ValidationError} If test cannot be saved (not completed, no URL, etc.)
   */
  static async saveTestCase(params: {
    sourceTestId: string;
    userId: string;
    name: string;
    description?: string;
    kind?: 'standalone' | 'regression_member';
  }): Promise<{
    savedTestCaseId: string;
    projectId: string;
    replayStrategy: 'commands' | 'graph_extract';
    parametersCount: number;
  }> {
    const { sourceTestId, userId, name, description, kind = 'standalone' } = params;

    try {
      logger.info('[REGRESSION_SAVE] Saving test case', {
        sourceTestId,
        userId,
        name,
        kind,
      });

      // 1. Get source test
      const test = await this.getSourceTest(sourceTestId, userId);

      // 2. Get intelligent session if exists
      const session = await this.getIntelligentSession(sourceTestId);

      // 3. Extract replay data
      const replayData = await this.extractReplayData(test, session);

      // 4. Validate URL before saving
      if (!test.url) {
        throw new ValidationError(
          'Test has no URL - cannot save for replay. Please ensure the test has a valid target URL.'
        );
      }

      // 5. Validate parameters limit
      const parametersCount = Object.keys(replayData.parametersSchema || {}).length;
      if (parametersCount > MAX_PARAMETERS_PER_TEST) {
        throw new ValidationError(
          `Too many parameters detected (${parametersCount}). Maximum allowed: ${MAX_PARAMETERS_PER_TEST}`
        );
      }

      // 6. Create intent test case (unified table) with status='published'
      // Saving from a completed test means it's ready for regression runs.
      const { data: savedCase, error } = await supabaseAdmin
        .from('intent_test_cases')
        .insert({
          project_id: test.project_id,
          user_id: userId,
          source_test_id: sourceTestId,
          source_intelligent_session_id: session?.id || null,
          name,
          description: description || null,
          // Lifecycle: saved from test = published
          status: 'published',
          kind,
          // Replay data
          replay_strategy: replayData.strategy,
          commands: replayData.commands || null,
          graph_ref: replayData.graphRef || null,
          parameters_schema: replayData.parametersSchema || null,
          // URL fields
          url: test.url || null,
          start_url: test.url || null,
          // Empty steps_json (commands are the source of truth for replay)
          steps_json: [],
        })
        .select('id')
        .single();

      if (error || !savedCase) {
        throw new Error(`Failed to save test case: ${error?.message}`);
      }

      logger.info('[REGRESSION_SAVE] Intent test case saved successfully', {
        intentTestCaseId: savedCase.id,
        projectId: test.project_id,
        strategy: replayData.strategy,
        status: 'published',
      });

      return {
        savedTestCaseId: savedCase.id, // Keep same return field name for API compatibility
        projectId: test.project_id,
        replayStrategy: replayData.strategy,
        parametersCount: Object.keys(replayData.parametersSchema || {}).length,
      };
    } catch (error) {
      logger.error('[REGRESSION_SAVE] Failed to save test case', { error, sourceTestId });
      throw error;
    }
  }

  /**
   * Create a regression suite with multiple test cases
   * Test case IDs now refer to intent_test_cases (unified table).
   *
   * @param params.projectId - Project ID for the suite
   * @param params.userId - User ID for ownership verification
   * @param params.name - Display name for the suite
   * @param params.description - Optional description
   * @param params.testCaseIds - Array of intent_test_cases IDs to include
   * @returns Suite metadata
   * @throws {NotFoundError} If project not found
   * @throws {ValidationError} If access denied or validation fails
   */
  static async createSuite(params: {
    projectId: string;
    userId: string;
    name: string;
    description?: string;
    testCaseIds: string[]; // intent_test_cases IDs
  }): Promise<{ suiteId: string }> {
    const { projectId, userId, name, description, testCaseIds } = params;

    try {
      logger.info('[REGRESSION_SAVE] Creating suite', {
        projectId,
        userId,
        name,
        testCasesCount: testCaseIds.length,
      });

      // Validate suite size limit
      if (testCaseIds.length > MAX_TEST_CASES_PER_SUITE) {
        throw new ValidationError(
          `Too many test cases for a single suite (${testCaseIds.length}). Maximum allowed: ${MAX_TEST_CASES_PER_SUITE}`
        );
      }

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Create suite
      const { data: suite, error: suiteError } = await supabaseAdmin
        .from('regression_suites')
        .insert({
          project_id: projectId,
          user_id: userId,
          name,
          description: description || null,
        })
        .select('id')
        .single();

      if (suiteError || !suite) {
        throw new Error(`Failed to create suite: ${suiteError?.message}`);
      }

      // Add test cases to suite (now uses intent_test_case_id)
      const items = testCaseIds.map((caseId, index) => ({
        suite_id: suite.id,
        intent_test_case_id: caseId,
        order_index: index + 1,
      }));

      const { error: itemsError } = await supabaseAdmin
        .from('regression_suite_items')
        .insert(items);

      if (itemsError) {
        throw new Error(`Failed to add test cases to suite: ${itemsError.message}`);
      }

      logger.info('[REGRESSION_SAVE] Suite created successfully', {
        suiteId: suite.id,
        testCasesCount: testCaseIds.length,
      });

      return { suiteId: suite.id };
    } catch (error) {
      logger.error('[REGRESSION_SAVE] Failed to create suite', { error, projectId });
      throw error;
    }
  }

  /**
   * Get source test and verify access
   *
   * @throws {NotFoundError} If test not found
   * @throws {ValidationError} If access denied or test not completed
   */
  private static async getSourceTest(testId: string, userId: string): Promise<any> {
    const { data: test, error } = await supabaseAdmin
      .from('tests')
      .select('*, projects!inner(user_id)')
      .eq('id', testId)
      .single();

    if (error || !test) {
      throw new NotFoundError('Test', testId);
    }

    // ✅ FIX: Handle projects as object (when using single())
    const projectUserId = (test.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new ValidationError('Access denied to this test');
    }

    // Check test is completed
    if (test.status !== 'completed') {
      throw new ValidationError(
        `Cannot save test with status '${test.status}'. Only completed tests can be saved.`
      );
    }

    return test;
  }

  /**
   * Get intelligent session for test (contains graph_data)
   *
   * @returns Intelligent session or null if not found
   */
  private static async getIntelligentSession(testId: string): Promise<any | null> {
    const { data: session, error } = await supabaseAdmin
      .from('intelligent_test_sessions')
      .select('*')
      .eq('test_id', testId)
      .maybeSingle();

    if (error) {
      logger.warn('[REGRESSION_SAVE] Failed to get intelligent session', {
        error,
        testId,
      });
      return null;
    }

    return session;
  }

  /**
   * Extract replay data from test
   * Priority: commands > graph_data extraction
   *
   * @returns Replay strategy, commands/graph, and parameter schema
   * @throws {ValidationError} If no replayable data available
   */
  private static async extractReplayData(
    test: any,
    session: any
  ): Promise<{
    strategy: 'commands' | 'graph_extract';
    commands: any[] | null;
    graphRef: any | null;
    parametersSchema: any | null;
  }> {
    // Try commands first (preferred)
    if (test.commands && Array.isArray(test.commands) && test.commands.length > 0) {
      logger.info('[REGRESSION_SAVE] Using commands strategy', { testId: test.id });

      const { sanitized, parametersSchema } = this.sanitizeCommands(test.commands);

      return {
        strategy: 'commands',
        commands: sanitized,
        graphRef: null,
        parametersSchema,
      };
    }

    // Fallback to graph_data extraction
    if (session?.graph_data?.nodes && session.graph_data.nodes.length > 0) {
      logger.info('[REGRESSION_SAVE] Using graph_extract strategy', { testId: test.id });

      const { steps, parametersSchema } = this.extractFromGraph(session.graph_data);

      return {
        strategy: 'graph_extract',
        commands: null,
        graphRef: { steps },
        parametersSchema,
      };
    }

    // No replayable data
    throw new ValidationError(
      'Test is not replayable: no commands or graph_data available'
    );
  }

  /**
   * Sanitize commands: remove secrets, parameterize sensitive values
   *
   * @param commands - Raw commands from test
   * @returns Sanitized commands with parameter references and schema
   */
  private static sanitizeCommands(commands: any[]): {
    sanitized: any[];
    parametersSchema: any;
  } {
    const sanitized: any[] = [];
    const parametersSchema: any = {};

    // Patterns that indicate sensitive data
    const sensitivePatterns = [
      /password/i,
      /token/i,
      /secret/i,
      /api[_-]?key/i,
      /auth/i,
      /credential/i,
      /\bkey\b/i, // ✅ Added: match "key" as word boundary
    ];

    for (const cmd of commands) {
      // Validate command size to prevent memory issues
      const cmdString = JSON.stringify(cmd);
      if (cmdString.length > MAX_COMMAND_LENGTH) {
        logger.warn('[REGRESSION_SAVE] Command too large, skipping', {
          size: cmdString.length,
          maxSize: MAX_COMMAND_LENGTH,
        });
        continue;
      }

      const newCmd = { ...cmd };

      // Check if value might be sensitive
      if (newCmd.value && typeof newCmd.value === 'string') {
        const contextText = `${newCmd.selector || ''} ${newCmd.description || ''} ${newCmd.label || ''}`;
        const isSensitive = sensitivePatterns.some(pattern => pattern.test(contextText));

        if (isSensitive) {
          // ✅ Improved: Check if parameter already exists to avoid duplicates
          const existingParam = Object.keys(parametersSchema).find(key =>
            parametersSchema[key].description?.includes(newCmd.selector || newCmd.description)
          );

          if (!existingParam) {
            // Create parameter
            const paramName = this.generateParameterName(newCmd);
            parametersSchema[paramName] = {
              type: 'string',
              description: `Value for ${newCmd.selector || newCmd.action}`,
              required: true,
              sensitive: true,
            };

            // Replace with parameter reference
            newCmd.value = `{{${paramName}}}`;
          } else {
            // Use existing parameter
            newCmd.value = `{{${existingParam}}}`;
          }
        }
      }

      sanitized.push(newCmd);
    }

    return { sanitized, parametersSchema };
  }

  /**
   * Extract steps from graph_data (fallback when commands not available)
   *
   * @param graphData - Graph data from intelligent test session
   * @returns Extracted steps with parameter schema
   */
  private static extractFromGraph(graphData: any): {
    steps: any[];
    parametersSchema: any;
  } {
    const steps: any[] = [];
    const parametersSchema: any = {};

    // Filter action nodes only
    const actionNodes = graphData.nodes.filter(
      (n: any) => n.type === 'action' && n.stepType
    );

    for (const node of actionNodes) {
      const step: any = {
        action: node.stepType,
        selector: node.selector || null,
        value: node.value || null,
        description: node.label,
      };

      // Parameterize sensitive values
      if (step.value && typeof step.value === 'string') {
        const isSensitive = /password|token|secret|key|auth|credential/i.test(
          step.description || ''
        );

        if (isSensitive) {
          const paramName = this.generateParameterName(step);
          parametersSchema[paramName] = {
            type: 'string',
            description: step.description,
            required: true,
            sensitive: true,
          };
          step.value = `{{${paramName}}}`;
        }
      }

      steps.push(step);
    }

    return { steps, parametersSchema };
  }

  /**
   * Generate unique parameter name from command/step
   * Uses selector/description and timestamp for uniqueness
   *
   * @param item - Command or step object
   * @returns Unique parameter name (e.g., "param_login_button_abc123")
   */
  private static generateParameterName(item: any): string {
    const base = (item.selector || item.description || 'value')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .toLowerCase()
      .substring(0, 30);

    return `param_${base}_${Date.now().toString(36)}`;
  }

  /**
   * Verify user has access to project
   *
   * @throws {NotFoundError} If project not found
   * @throws {ValidationError} If access denied
   */
  private static async verifyProjectAccess(
    projectId: string,
    userId: string
  ): Promise<void> {
    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id !== userId) {
      throw new ValidationError('Access denied to this project');
    }
  }
}
