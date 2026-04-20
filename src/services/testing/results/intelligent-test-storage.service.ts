import type { ActionResult, DynamicAction, IntelligentTestResult, PageVisit } from '@/agent/types/intelligent-testing.types';
import { supabaseAdmin } from '@/db/supabase';
import { generateEmbeddings } from '@/services/ai/core/embedding.service';
import { logger } from '@/utils/core/logger';

/**
 * Service for storing intelligent test results in specialized tables
 * Provides complete data for visualization and replay
 */
export class IntelligentTestStorageService {
  /**
   * Save complete intelligent test session with all details
   * ✅ ENHANCED: Now accepts graph_data for perfect visualization consistency
   */
  static async saveTestSession(params: {
    testId: string;
    userId: string;
    projectId: string;
    result: IntelligentTestResult;
    config: {
      goal: string;
      startUrl: string;
      mode: string;
      browser: string;
      viewport?: any;
      credentialsUsed?: boolean;
    };
    graphData?: any; // ✅ NEW: Complete graph from GraphBuilder
  }): Promise<{ sessionId: string; success: boolean }> {
    const { testId, userId, projectId, result, config } = params;

    try {
      logger.info('[INTELLIGENT_STORAGE] Saving test session', {
        testId,
        pagesVisited: result.pagesVisited,
        actionsTaken: result.actionsTaken,
        hasGraphData: !!params.graphData,
        graphNodes: params.graphData?.nodes?.length || 0,
        graphEdges: params.graphData?.edges?.length || 0,
      });

      // ✅ FIX #2: Validate required fields before insert
      if (!testId || !userId || !projectId || !config.goal || !config.startUrl) {
        // ✅ IMPROVED: Log which fields are missing for easier debugging
        const missingFields = [
          !testId && 'testId',
          !userId && 'userId',
          !projectId && 'projectId',
          !config.goal && 'goal',
          !config.startUrl && 'startUrl',
        ].filter((v): v is string => typeof v === 'string');

        logger.error('[INTELLIGENT_STORAGE] Missing required fields for test session', {
          testId,
          missingFields,
          hasTestId: !!testId,
          hasUserId: !!userId,
          hasProjectId: !!projectId,
          hasGoal: !!config.goal,
          hasStartUrl: !!config.startUrl,
        });

        throw new Error(`Missing required fields for test session: ${missingFields.join(', ')}`);
      }

      // ✅ FIX #3: Ensure duration is valid (can be 0 for very fast tests)
      const duration = result.duration ?? 0;
      const startedAt = duration > 0
        ? new Date(Date.now() - duration).toISOString()
        : new Date().toISOString();

      // 1. Create test session
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .insert({
          test_id: testId,
          user_id: userId, // ✅ Schema: TEXT NOT NULL (not UUID)
          project_id: projectId,
          goal: config.goal,
          start_url: config.startUrl,
          mode: config.mode || 'balanced',
          status: result.success ? 'completed' : 'failed',
          success: result.success,
          pages_visited: result.pagesVisited || 0,
          actions_taken: result.actionsTaken || 0,
          duration_ms: duration,
          cost_usd: result.cost || null, // ✅ Can be null
          summary: result.summary || null, // ✅ Can be null
          browser: config.browser || null,
          viewport: config.viewport || {},
          credentials_used: config.credentialsUsed || false,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          graph_data: params.graphData || null, // ✅ NEW: Save complete graph
        })
        .select('id')
        .single();

      if (sessionError || !session) {
        // ✅ IMPROVED: Detailed Supabase error logging
        logger.error('[INTELLIGENT_STORAGE] Supabase insert failed', {
          testId,
          errorMessage: sessionError?.message,
          errorCode: (sessionError as any)?.code,
          errorDetails: (sessionError as any)?.details,
          errorHint: (sessionError as any)?.hint,
        });
        throw new Error(`Failed to create session: ${sessionError?.message}`);
      }

      const sessionId = session.id;
      logger.info('[INTELLIGENT_STORAGE] Session created', { sessionId });

      // 2. Save page visits with actions
      if (result.pageVisits && Array.isArray(result.pageVisits)) {
        await this.savePageVisits(sessionId, result.pageVisits);
      } else {
        logger.warn('[INTELLIGENT_STORAGE] No page visits to save', { testId });
      }

      // 3. Save errors as findings
      if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
        await this.saveFindings(sessionId, result.errors);
      }

      logger.info('[INTELLIGENT_STORAGE] Test session saved successfully', {
        sessionId,
        pages: result.pageVisits?.length || 0,
        actions: result.actionsTaken || 0,
      });

      return { sessionId, success: true };
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to save test session', {
        error,
        testId,
      });
      throw error;
    }
  }

  /**
   * Save all page visits with their actions
   */
  private static async savePageVisits(
    sessionId: string,
    pageVisits: PageVisit[]
  ): Promise<void> {
    try {
      // ✅ FIX: Track actual saved visits for correct ordering
      let savedVisitCount = 0;

      for (let i = 0; i < pageVisits.length; i++) {
        const visit = pageVisits[i];

        // ✅ FIX #4: Validate required fields
        if (!visit || !visit.url || !visit.pageType) {
          logger.warn('[INTELLIGENT_STORAGE] Skipping page visit with missing data', {
            url: visit?.url,
            pageType: visit?.pageType,
            visitIndex: i,
          });
          continue;
        }

        // Create page visit record
        savedVisitCount += 1; // ✅ FIX: Increment only for valid visits
        const { data: pageVisit, error: visitError } = await supabaseAdmin
          .from('intelligent_page_visits')
          .insert({
            session_id: sessionId,
            url: visit.url,
            page_type: visit.pageType,
            visit_order: savedVisitCount, // ✅ FIX: Use saved count, not index
            success: visit.success ?? true, // ✅ Default to true if not specified
            visited_at: visit.timestamp
              ? new Date(visit.timestamp).toISOString()
              : new Date().toISOString(), // ✅ Fallback if timestamp missing
            // ✅ NEW: Store DOM analysis for step editor linting
            dom_analysis: visit.domAnalysis || null,
            // Screenshot (base64 or URL)
            screenshot: visit.screenshot || null,
          })
          .select('id')
          .single();

        if (visitError || !pageVisit) {
          logger.error('[INTELLIGENT_STORAGE] Failed to save page visit', {
            error: visitError,
            url: visit.url,
          });
          continue;
        }

        // Save action results for this page (if available)
        if (visit.actionResults && visit.actionResults.length > 0) {
          await this.saveActionResults(sessionId, pageVisit.id, visit.actionResults);
        } else if (visit.actions && visit.actions.length > 0) {
          // Fallback: save planned actions if results not available
          await this.saveActions(sessionId, pageVisit.id, visit.actions);
        }
      }

      logger.info('[INTELLIGENT_STORAGE] Page visits saved', {
        count: pageVisits.length,
      });
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to save page visits', { error });
      throw error;
    }
  }

  /**
   * Save action results for a specific page visit (with execution data)
   */
  private static async saveActionResults(
    sessionId: string,
    pageVisitId: string,
    actionResults: ActionResult[]
  ): Promise<void> {
    try {
      // ✅ FIX #5: Validate and map action results safely
      // ✅ FIX: Track actual saved actions for correct ordering
      let savedActionCount = 0;
      const actionRecords = actionResults
        .filter((result) => result && result.action && result.action.action) // ✅ Filter invalid actions
        .map((result) => {
          savedActionCount += 1; // ✅ FIX: Increment only for valid actions
          return {
            page_visit_id: pageVisitId,
            session_id: sessionId,
            action_order: savedActionCount, // ✅ FIX: Use saved count, not index
          action_type: result.action.action,
          selector: result.action.selector || null,
          value: result.action.value || null,
          description: result.action.description || result.action.action, // ✅ Fallback description
          expected_result: result.action.expectedResult || null,
          timeout_ms: result.action.timeout || null,
          optional: result.action.optional || false,
          retry_count: result.retryCount || 0,
          max_retries: 3,
          // Actual execution results
          success: result.success ?? false, // ✅ Default to false if not specified
          error_message: result.error || null,
          url_changed: result.urlChanged ?? false,
          url_before: result.urlBefore || null,
          url_after: result.urlAfter || null,
          // ✅ FIX #9: Use proper before/after screenshot fields
          screenshot_before: result.screenshotBefore || result.screenshot || null,
          screenshot_after: result.screenshotAfter || result.screenshot || null,
          executed_at: result.timestamp && typeof result.timestamp === 'number'
            ? new Date(result.timestamp).toISOString()
            : new Date().toISOString(), // ✅ Fallback timestamp
          };
        });

      const { error } = await supabaseAdmin
        .from('intelligent_test_actions')
        .insert(actionRecords);

      if (error) {
        logger.error('[INTELLIGENT_STORAGE] Failed to save action results', {
          error,
          pageVisitId,
        });
      } else {
        logger.info('[INTELLIGENT_STORAGE] Action results saved', {
          count: actionResults.length,
          pageVisitId,
        });
      }
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to save action results', { error });
    }
  }

  /**
   * Save planned actions for a specific page visit (fallback without execution data)
   */
  private static async saveActions(
    sessionId: string,
    pageVisitId: string,
    actions: DynamicAction[]
  ): Promise<void> {
    try {
      const actionRecords = actions.map((action, index) => ({
        page_visit_id: pageVisitId,
        session_id: sessionId,
        action_order: index + 1,
        action_type: action.action,
        selector: action.selector,
        value: action.value,
        description: action.description,
        expected_result: action.expectedResult,
        timeout_ms: action.timeout,
        optional: action.optional || false,
        retry_count: action.retry || 0,
        max_retries: 3,
        success: true, // Unknown, assume success
        executed_at: new Date().toISOString(),
      }));

      const { error } = await supabaseAdmin
        .from('intelligent_test_actions')
        .insert(actionRecords);

      if (error) {
        logger.error('[INTELLIGENT_STORAGE] Failed to save planned actions', {
          error,
          pageVisitId,
        });
      } else {
        logger.info('[INTELLIGENT_STORAGE] Planned actions saved', {
          count: actions.length,
          pageVisitId,
        });
      }
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to save planned actions', { error });
    }
  }

  /**
   * Save test findings (bugs, errors, warnings)
   */
  private static async saveFindings(
    sessionId: string,
    errors: Array<{ message: string; page: string }>
  ): Promise<void> {
    try {
      // ✅ FIX #7: Validate and map errors safely
      const findingRecords = errors
        .filter((error) => error && error.message && typeof error.message === 'string') // ✅ Filter invalid errors
        .map((error) => {
          const message = String(error.message || 'Test Error');
          return {
            session_id: sessionId,
            finding_type: 'bug' as const, // ✅ Schema constraint
            severity: 'high' as const, // ✅ Schema constraint (can be improved to detect severity)
            title: message.substring(0, 200) || 'Test Error', // ✅ Limit title length, safe substring
            description: message || 'No description available',
            found_at: new Date().toISOString(),
          };
        });

      // Generate embeddings for semantic search (non-fatal)
      let recordsToInsert = findingRecords as Array<(typeof findingRecords)[0] & { embedding?: string | null }>;
      try {
        if (findingRecords.length > 0) {
          const embeddingTexts = findingRecords.map(f =>
            [f.title, f.description].filter(Boolean).join(' — ')
          );
          const embeddings = await generateEmbeddings(embeddingTexts);
          recordsToInsert = findingRecords.map((f, i) => ({
            ...f,
            embedding: embeddings[i] ? JSON.stringify(embeddings[i]) : null,
          }));
        }
      } catch (embError) {
        logger.warn('[INTELLIGENT_STORAGE] Failed to generate finding embeddings (non-fatal)', {
          sessionId,
          error: embError instanceof Error ? embError.message : String(embError),
        });
      }

      const { error } = await supabaseAdmin
        .from('intelligent_test_findings')
        .insert(recordsToInsert);

      if (error) {
        logger.error('[INTELLIGENT_STORAGE] Failed to save findings', { error });
      } else {
        logger.info('[INTELLIGENT_STORAGE] Findings saved', {
          count: errors.length,
        });
      }
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to save findings', { error });
    }
  }

  /**
   * Save AI decision (for analysis and debugging)
   */
  static async saveAIDecision(params: {
    sessionId: string;
    pageVisitId?: string;
    decisionType: string;
    context: any;
    decision: any;
    reasoning: string;
    confidence?: number;
    alternatives?: any[];
    modelUsed: string;
    tokensUsed?: number;
  }): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('intelligent_ai_decisions')
        .insert({
          session_id: params.sessionId,
          page_visit_id: params.pageVisitId,
          decision_type: params.decisionType,
          context: params.context,
          decision: params.decision,
          reasoning: params.reasoning,
          confidence: params.confidence,
          alternatives: params.alternatives,
          model_used: params.modelUsed,
          tokens_used: params.tokensUsed,
          decided_at: new Date().toISOString(),
        });

      if (error) {
        logger.error('[INTELLIGENT_STORAGE] Failed to save AI decision', {
          error,
        });
      }
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to save AI decision', { error });
    }
  }

  /**
   * Update action result after execution
   */
  static async updateActionResult(
    actionId: string,
    result: {
      success: boolean;
      errorMessage?: string;
      urlChanged?: boolean;
      urlBefore?: string;
      urlAfter?: string;
      durationMs?: number;
      screenshotBefore?: string;
      screenshotAfter?: string;
    }
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('intelligent_test_actions')
        .update({
          success: result.success,
          error_message: result.errorMessage,
          url_changed: result.urlChanged,
          url_before: result.urlBefore,
          url_after: result.urlAfter,
          duration_ms: result.durationMs,
          screenshot_before: result.screenshotBefore,
          screenshot_after: result.screenshotAfter,
        })
        .eq('id', actionId);

      if (error) {
        logger.error('[INTELLIGENT_STORAGE] Failed to update action result', {
          error,
          actionId,
        });
      }
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to update action result', {
        error,
      });
    }
  }

  /**
   * Get test session with all details for visualization
   */
  static async getTestSession(sessionId: string): Promise<any> {
    try {
      // Get session with pages and actions using the view
      const { data, error } = await supabaseAdmin
        .from('intelligent_test_session_full')
        .select('*')
        .eq('id', sessionId)
        .single();

      if (error || !data) {
        throw new Error(`Session not found: ${error?.message}`);
      }

      // Get page visits with actions
      const { data: pages, error: pagesError } = await supabaseAdmin
        .from('intelligent_page_with_actions')
        .select('*')
        .eq('session_id', sessionId)
        .order('visit_order', { ascending: true });

      if (pagesError) {
        logger.error('[INTELLIGENT_STORAGE] Failed to get pages', {
          error: pagesError,
        });
      }

      // Get findings
      const { data: findings, error: findingsError } = await supabaseAdmin
        .from('intelligent_test_findings')
        .select('*')
        .eq('session_id', sessionId)
        .order('found_at', { ascending: true });

      if (findingsError) {
        logger.error('[INTELLIGENT_STORAGE] Failed to get findings', {
          error: findingsError,
        });
      }

      return {
        session: data,
        pages: pages || [],
        findings: findings || [],
      };
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to get test session', {
        error,
        sessionId,
      });
      throw error;
    }
  }

  /**
   * Get test flow for visualization (simplified)
   */
  static async getTestFlow(sessionId: string): Promise<any[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('intelligent_test_flow')
        .select('*')
        .eq('session_id', sessionId)
        .order('visit_order', { ascending: true });

      if (error) {
        throw new Error(`Failed to get test flow: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      logger.error('[INTELLIGENT_STORAGE] Failed to get test flow', {
        error,
        sessionId,
      });
      throw error;
    }
  }

  /**
   * Create a minimal session row that exists only as an FK anchor for
   * later `intelligent_test_findings`. Used by paths that don't produce
   * the rich page_visits / actions data (currently all mobile dispatchers)
   * so that ai-analysis's `extractBugPatterns` has a session_id to attach
   * findings to — otherwise /bug-insights skips the run.
   *
   * Best-effort: returns undefined on failure, never throws.
   */
  static async createSessionAnchor(params: {
    testId: string;
    userId: string;
    projectId: string;
    goal: string;
    startUrl: string;
    browser: string;
  }): Promise<string | undefined> {
    try {
      const { data, error } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .insert({
          test_id: params.testId,
          user_id: params.userId,
          project_id: params.projectId,
          goal: params.goal,
          start_url: params.startUrl,
          mode: 'fast',
          status: 'running',
          browser: params.browser,
        })
        .select('id')
        .single();

      if (error || !data) {
        logger.warn('[INTELLIGENT_STORAGE] Failed to create session anchor', {
          testId: params.testId,
          error: error?.message,
        });
        return undefined;
      }
      return data.id;
    } catch (err) {
      logger.warn('[INTELLIGENT_STORAGE] Session anchor creation threw (non-fatal)', {
        testId: params.testId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}
