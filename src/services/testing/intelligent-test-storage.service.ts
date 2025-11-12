import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import type { IntelligentTestResult, PageVisit, ActionResult, DynamicAction } from '@/agent/types/intelligent-testing.types';

/**
 * Service for storing intelligent test results in specialized tables
 * Provides complete data for visualization and replay
 */
export class IntelligentTestStorageService {
  /**
   * Save complete intelligent test session with all details
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
  }): Promise<{ sessionId: string; success: boolean }> {
    const { testId, userId, projectId, result, config } = params;

    try {
      logger.info('[INTELLIGENT_STORAGE] Saving test session', {
        testId,
        pagesVisited: result.pagesVisited,
        actionsTaken: result.actionsTaken,
      });

      // 1. Create test session
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .insert({
          test_id: testId,
          user_id: userId,
          project_id: projectId,
          goal: config.goal,
          start_url: config.startUrl,
          mode: config.mode || 'balanced',
          status: result.success ? 'completed' : 'failed',
          success: result.success,
          pages_visited: result.pagesVisited,
          actions_taken: result.actionsTaken,
          duration_ms: result.duration,
          cost_usd: result.cost,
          summary: result.summary,
          browser: config.browser,
          viewport: config.viewport || {},
          credentials_used: config.credentialsUsed || false,
          started_at: new Date(Date.now() - result.duration).toISOString(),
          completed_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (sessionError || !session) {
        throw new Error(`Failed to create session: ${sessionError?.message}`);
      }

      const sessionId = session.id;
      logger.info('[INTELLIGENT_STORAGE] Session created', { sessionId });

      // 2. Save page visits with actions
      await this.savePageVisits(sessionId, result.pageVisits);

      // 3. Save errors as findings
      if (result.errors.length > 0) {
        await this.saveFindings(sessionId, result.errors);
      }

      logger.info('[INTELLIGENT_STORAGE] Test session saved successfully', {
        sessionId,
        pages: result.pageVisits.length,
        actions: result.actionsTaken,
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
      for (let i = 0; i < pageVisits.length; i++) {
        const visit = pageVisits[i];

        // Create page visit record
        const { data: pageVisit, error: visitError } = await supabaseAdmin
          .from('intelligent_page_visits')
          .insert({
            session_id: sessionId,
            url: visit.url,
            page_type: visit.pageType,
            visit_order: i + 1,
            success: visit.success,
            visited_at: new Date(visit.timestamp).toISOString(),
            // Note: vision_analysis and dom_analysis can be added if available
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
      const actionRecords = actionResults.map((result, index) => ({
        page_visit_id: pageVisitId,
        session_id: sessionId,
        action_order: index + 1,
        action_type: result.action.action,
        selector: result.action.selector,
        value: result.action.value,
        description: result.action.description,
        expected_result: result.action.expectedResult,
        timeout_ms: result.action.timeout,
        optional: result.action.optional || false,
        retry_count: result.retryCount || 0,
        max_retries: 3,
        // Actual execution results
        success: result.success,
        error_message: result.error,
        url_changed: result.urlChanged,
        url_before: result.urlBefore,
        url_after: result.urlAfter,
        screenshot_before: result.screenshot,
        screenshot_after: result.screenshot,
        executed_at: new Date(result.timestamp).toISOString(),
      }));

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
      const findingRecords = errors.map((error) => ({
        session_id: sessionId,
        finding_type: 'bug',
        severity: 'high',
        title: 'Test Error',
        description: error.message,
        found_at: new Date().toISOString(),
      }));

      const { error } = await supabaseAdmin
        .from('intelligent_test_findings')
        .insert(findingRecords);

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
}
