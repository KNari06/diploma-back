import * as regressionDb from './db/regression.db';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION SAVE SERVICE - Save test flows as reusable test cases
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extracts replay data from completed tests and creates:
 * - Intent test cases (unified table for UI test cases)
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
const MAX_COMMAND_LENGTH = 10000;

/**
 * Service for saving test flows as regression test cases
 * Extracts replay data from completed tests
 */
export class RegressionSaveService {
  /**
   * Save a test flow as a reusable test case.
   *
   * Two modes, determined by which inputs the caller provides:
   *
   *   A. From an executed test (web replay):
   *      — pass `sourceTestId`.
   *      — service loads the `tests` row, extracts commands/graph_ref,
   *        and writes an `intent_test_cases` row with `replay_strategy`
   *        = 'commands' | 'graph_extract'.
   *
   *   B. From a recording buffer (mobile, step editor, any platform that
   *      does not materialize into a `tests` row before save):
   *      — pass `projectId` + `platform` + `steps` (IntentStep[]).
   *      — service writes the row directly with `replay_strategy='mobile_steps'`
   *        (or 'steps_editor' for non-mobile) and `steps_json=steps`. No URL
   *        check — mobile cases don't need one (runner uses `mobile://<platform>`
   *        sentinel; step-editor sets URL via a subsequent PATCH if needed).
   *
   *   The two modes are mutually exclusive: if both `sourceTestId` and
   *   `steps` are present, `sourceTestId` wins (the stored commands trump
   *   a stale local buffer).
   *
   * @throws {NotFoundError} If source test not found (mode A) or project missing (mode B)
   * @throws {ValidationError} If validation fails (no URL in mode A, empty steps in mode B, etc.)
   */
  static async saveTestCase(params: {
    // mode A — from completed web test
    sourceTestId?: string;
    // mode B — from in-memory recording / step editor
    projectId?: string;
    platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
    steps?: any[];
    appPackage?: string;
    startActivity?: string;
    tags?: string[];
    /**
     * Pre-computed parameters schema for {{param_*}} placeholders in `steps`
     * (mobile agent sanitizes sensitive values to placeholders before save).
     * Without it, a saved sensitive step can't resolve on regression replay —
     * resolvePlaceholders leaves the literal and the runner types it verbatim.
     */
    parametersSchema?: Record<string, unknown> | null;
    // common
    userId: string;
    name: string;
    description?: string;
    kind?: 'standalone' | 'regression_member';
  }): Promise<{
    savedTestCaseId: string;
    projectId: string;
    replayStrategy: 'commands' | 'graph_extract' | 'mobile_steps' | 'steps_editor';
    parametersCount: number;
  }> {
    const { sourceTestId, userId, name, description, kind = 'standalone' } = params;

    // ── Mode dispatch ─────────────────────────────────────────────
    // If no sourceTestId, we're in "from recording" mode.
    if (!sourceTestId) {
      return this.saveFromRecording({
        projectId: params.projectId,
        userId,
        name,
        description,
        kind,
        platform: params.platform,
        steps: params.steps,
        appPackage: params.appPackage,
        startActivity: params.startActivity,
        tags: params.tags,
        parametersSchema: params.parametersSchema ?? null,
      });
    }

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

      // 6. Build human-readable steps from execution data
      const stepsJson = this.buildStepsJson(session, test);

      // 7. Create intent test case (unified table) with status='published'
      // Saving from a completed test means it's ready for regression runs.
      const savedCase = await regressionDb.insertIntentTestCase({
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
        // Human-readable steps (commands remain source of truth for replay)
        steps_json: stepsJson,
      });

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
   * Save an in-memory recording / step-editor buffer as a test case.
   *
   * Called from `saveTestCase` when the caller did NOT provide `sourceTestId`
   * (i.e. there is no executed `tests` row to extract commands from).
   *
   * Writes directly to `intent_test_cases`:
   *   - mobile_* platforms → `replay_strategy='mobile_steps'`, `steps_json=steps`.
   *     Runner reads `steps_json` at dispatch time in `dispatchMobileTest`.
   *   - web (step editor) → `replay_strategy='steps_editor'`, `steps_json=steps`.
   *     `IntentStepConverterService.convertToCommands` handles it at run time.
   *
   * @throws {NotFoundError}   If project not found
   * @throws {ValidationError} If access denied, invalid platform, or empty steps
   */
  private static async saveFromRecording(params: {
    projectId?: string;
    userId: string;
    name: string;
    description?: string;
    kind: 'standalone' | 'regression_member';
    platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
    steps?: any[];
    appPackage?: string;
    startActivity?: string;
    tags?: string[];
    parametersSchema?: Record<string, unknown> | null;
  }): Promise<{
    savedTestCaseId: string;
    projectId: string;
    replayStrategy: 'mobile_steps' | 'steps_editor';
    parametersCount: number;
  }> {
    const {
      projectId,
      userId,
      name,
      description,
      kind,
      platform = 'web',
      steps,
      appPackage,
      startActivity,
      tags,
      parametersSchema,
    } = params;
    // Persist the placeholder schema so {{param_*}} values resolve on replay.
    // Guard the same limit the from-test path enforces.
    const paramSchema =
      parametersSchema && Object.keys(parametersSchema).length > 0 ? parametersSchema : null;
    if (paramSchema && Object.keys(paramSchema).length > MAX_PARAMETERS_PER_TEST) {
      throw new ValidationError(
        `Too many parameters detected (${Object.keys(paramSchema).length}). Maximum allowed: ${MAX_PARAMETERS_PER_TEST}`,
      );
    }

    if (!projectId) {
      throw new ValidationError(
        'projectId is required when saving without sourceTestId',
      );
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('name is required and must be non-empty');
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new ValidationError('steps must be a non-empty array of IntentStep');
    }
    const VALID_PLATFORMS = new Set([
      'web', 'mobile_android', 'mobile_ios', 'mobile_flutter',
    ]);
    if (!VALID_PLATFORMS.has(platform)) {
      throw new ValidationError(
        `platform must be one of ${[...VALID_PLATFORMS].join(' | ')}, got '${platform}'`,
      );
    }

    // Verify project ownership
    const project = await regressionDb.getProjectForSave(projectId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }
    if (project.user_id !== userId) {
      throw new ValidationError('Access denied to this project');
    }

    // Normalise steps through the shared IntentStep helper. Same function
    // is used by `stitchPhases` for setup/teardown extras and by
    // `dispatchMobileTest` for the mobile body — one source of truth for
    // which fields survive the JSONB round-trip. No phase at save time;
    // phase is stamped at dispatch when we know whether we're running
    // setup/main/teardown.
    const { normaliseIntentStep } = await import('./intent-step-dispatch.service');
    const normalizedSteps = steps.map((step: any, index: number) =>
      normaliseIntentStep(step, index),
    );

    const isMobile = platform.startsWith('mobile_');
    const replayStrategy: 'mobile_steps' | 'steps_editor' = isMobile
      ? 'mobile_steps'
      : 'steps_editor';

    // Mobile cases don't have a web URL; use a sentinel so downstream
    // code that references url/start_url doesn't crash.
    // `dispatchMobileTest` uses `mobile://${shortPlatform}` itself for the
    // `tests` row, so this value is display-only.
    const effectiveUrl = isMobile
      ? `mobile://${platform.replace('mobile_', '')}`
      : null;

    logger.info('[REGRESSION_SAVE] Saving from recording buffer', {
      projectId,
      userId,
      name,
      platform,
      stepsCount: normalizedSteps.length,
      replayStrategy,
      kind,
    });

    const savedCase = await regressionDb.insertIntentTestCase({
      project_id: projectId,
      user_id: userId,
      name,
      description: description || null,
      status: 'published',
      kind,
      platform,
      replay_strategy: replayStrategy,
      commands: null,
      graph_ref: null,
      steps_json: normalizedSteps,
      parameters_schema: paramSchema,
      url: effectiveUrl,
      start_url: effectiveUrl,
      tags: tags || null,
      // Mobile app metadata carried inline until we add a dedicated column.
      ...(isMobile && (appPackage || startActivity)
        ? {
            goal: JSON.stringify({
              appPackage: appPackage || null,
              startActivity: startActivity || null,
            }),
          }
        : {}),
    });

    logger.info('[REGRESSION_SAVE] Test case saved from recording', {
      intentTestCaseId: savedCase.id,
      projectId,
      platform,
      stepsCount: normalizedSteps.length,
      replayStrategy,
    });

    return {
      savedTestCaseId: savedCase.id,
      projectId,
      replayStrategy,
      parametersCount: 0,
    };
  }

  /**
   * Get source test and verify access
   *
   * @throws {NotFoundError} If test not found
   * @throws {ValidationError} If access denied or test not completed
   */
  private static async getSourceTest(testId: string, userId: string): Promise<any> {
    let test: any;
    try {
      test = await regressionDb.getSourceTestForSave(testId);
    } catch {
      throw new NotFoundError('Test', testId);
    }
    if (!test) {
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
    try {
      return await regressionDb.getIntelligentSessionForTest(testId);
    } catch (error) {
      logger.warn('[REGRESSION_SAVE] Failed to get intelligent session', {
        error,
        testId,
      });
      return null;
    }
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
   * Build human-readable steps_json from execution data
   * Extracts from intelligent session result (executedSteps / pageVisits)
   * Falls back to empty array if no execution data available
   */
  private static buildStepsJson(session: any, test: any): any[] {
    try {
      // Try executedSteps from session result first
      const executedSteps = session?.result?.executedSteps;
      if (Array.isArray(executedSteps) && executedSteps.length > 0) {
        return executedSteps.map((step: any, index: number) => ({
          step: index + 1,
          action: step.action || 'unknown',
          description: step.description || step.thought || '',
          target: step.selector || step.target || undefined,
          value: this.maskSensitiveStepValue(step.value, step),
          url: step.url || test.url || '',
        }));
      }

      // Try pageVisits from session result
      const pageVisits = session?.result?.pageVisits;
      if (Array.isArray(pageVisits) && pageVisits.length > 0) {
        return pageVisits.map((visit: any, index: number) => ({
          step: index + 1,
          action: 'goto',
          description: visit.title || `Navigate to ${visit.url}`,
          url: visit.url || '',
        }));
      }

      // Try commands from test as last resort (convert to step format)
      if (Array.isArray(test.commands) && test.commands.length > 0) {
        return test.commands.map((cmd: any, index: number) => ({
          step: index + 1,
          action: cmd.action || 'unknown',
          description: cmd.description || cmd.label || '',
          target: cmd.selector || undefined,
          value: cmd.value?.startsWith?.('{{') ? cmd.value : this.maskSensitiveStepValue(cmd.value, cmd),
          url: cmd.url || test.url || '',
        }));
      }

      return [];
    } catch (error) {
      logger.warn('[REGRESSION_SAVE] Failed to build steps_json, falling back to empty', { error });
      return [];
    }
  }

  /**
   * Mask sensitive values in step data (reuses same patterns as sanitizeCommands)
   */
  private static maskSensitiveStepValue(value: any, step: any): string | undefined {
    if (!value || typeof value !== 'string') return undefined;

    const sensitivePatterns = [
      /password/i, /token/i, /secret/i, /api[_-]?key/i, /auth/i, /credential/i, /\bkey\b/i,
    ];
    const contextText = `${step.selector || ''} ${step.description || ''} ${step.label || ''}`;
    const isSensitive = sensitivePatterns.some(pattern => pattern.test(contextText));

    return isSensitive ? '***' : value;
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

}
