import { supabaseAdmin } from '@/db/supabase';
import { TestResultsFormatterService } from '@/services/testing/results/test-results-formatter.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST COMPLETION HANDLER SERVICE - Post-test completion pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles test completion workflow:
 * 1. Notifies linked chat sessions with formatted results
 * 2. Updates regression run statuses (if test was part of regression)
 * 3. Includes test metadata for AI context enrichment
 *
 * Called by:
 * - BullMQ job handlers when tests complete
 * - Manual test completion hooks
 *
 * Key Features:
 * - Chat notification with rich metadata
 * - Automatic regression run status updates
 * - Support for both single test and batch runs
 */

/**
 * Service to handle test completion and notify chat sessions
 */
export class TestCompletionHandlerService {
  /**
   * Handle test completion and send results to chat
   * Main entry point called when a test finishes execution
   *
   * @param testId - UUID of completed test
   * @returns void (errors are logged but not thrown)
   */
  static async handleTestCompletion(testId: string): Promise<void> {
    try {
      logger.info('[TEST_COMPLETION] Handling test completion', { testId });

      // Get chat sessions linked to this test
      const chatSessions = await TestChatMappingService.getChatSessionsForTest(
        testId
      );

      if (!chatSessions || chatSessions.length === 0) {
        logger.debug('[TEST_COMPLETION] No chat sessions found for test', {
          testId,
        });
        // Continue to update regression runs even if no chat sessions
      }

      // ✅ FIX #8: Get test data with proper field selection
      const { data: test, error: testError } = await supabaseAdmin
        .from('tests')
        .select('id, url, status, browsers, created_at, completed_at') // ✅ Select only needed fields
        .eq('id', testId)
        .single();

      if (testError || !test) {
        logger.error('[TEST_COMPLETION] Failed to get test', {
          error: testError?.message,
          testId,
        });
        return;
      }

      // ✅ FIX #9: Get test results with proper field selection
      const { data: results, error: resultsError } = await supabaseAdmin
        .from('test_results')
        .select(
          'id, test_id, browser, status, errors, created_at, completed_at'
        ) // ✅ Select only needed fields
        .eq('test_id', testId); // ✅ Correct field name: test_id (not testId)

      if (resultsError) {
        logger.error('[TEST_COMPLETION] Failed to get results', {
          error: resultsError,
          testId,
        });
        // Continue without results (will use test status)
      }

      // Send to linked chat sessions (if any)
      if (chatSessions && chatSessions.length > 0) {
        // Format results as chat message
        const formattedMessage = TestResultsFormatterService.formatTestResults(
          test,
          results || []
        );

        // ✅ FIX: Include test results in metadata so AI can see them
        const testResultMetadata = {
          testId: testId,
          testType: 'ui',
          testResult: {
            status: test.status,
            url: test.url,
            browsers: test.browsers,
            completedAt: test.completed_at,
            results: (results || []).map(r => ({
              browser: r.browser,
              status: r.status,
              errors: r.errors,
              completedAt: r.completed_at,
            })),
          },
        };

        // Send to all linked chat sessions
        for (const chatSessionId of chatSessions) {
          try {
            await ChatService.saveChatMessages(chatSessionId, [
              {
                role: 'ai',
                content: formattedMessage,
                metadata: testResultMetadata,
              },
            ]);

            logger.info('[TEST_COMPLETION] Results sent to chat', {
              testId,
              chatSessionId,
            });
          } catch (chatError) {
            logger.error('[TEST_COMPLETION] Failed to send results to chat', {
              error: chatError,
              testId,
              chatSessionId,
            });
            // Continue with other sessions
          }
        }
      }

      // Update regression runs associated with this test
      await this.updateRegressionRuns(testId);
    } catch (error) {
      logger.error('[TEST_COMPLETION] Unexpected error', { error, testId });
    }
  }

  /**
   * Update regression runs that reference this test.
   * Recomputes run status by querying all underlying tests (does not use
   * the completed test's status directly).
   *
   * Called automatically after test completion to keep regression_runs.status in sync.
   *
   * @param testId - UUID of completed test
   */
  private static async updateRegressionRuns(testId: string): Promise<void> {
    try {
      // Find regression runs that reference this test
      // Either directly (test_id) or in a batch (test_ids array)
      const { data: runs, error: runsError } = await supabaseAdmin
        .from('regression_runs')
        .select('id, saved_test_case_id, test_id, test_ids, status')
        .or(`test_id.eq.${testId},test_ids.cs.["${testId}"]`)
        .in('status', ['running']); // Only update runs that are still in progress

      if (runsError) {
        logger.error('[TEST_COMPLETION] Failed to find regression runs', {
          error: runsError,
          testId,
        });
        return;
      }

      if (!runs || runs.length === 0) {
        logger.debug('[TEST_COMPLETION] No regression runs found for test', {
          testId,
        });
        return;
      }

      logger.info('[TEST_COMPLETION] Found regression runs to update', {
        testId,
        runsCount: runs.length,
      });

      // Update each run
      for (const run of runs) {
        await this.recomputeRunStatus(run);
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Error updating regression runs', {
        error: error instanceof Error ? error.message : String(error),
        testId,
      });
    }
  }

  /**
   * Recompute status for a regression run based on underlying tests
   * Determines if all tests are complete and calculates final status
   *
   * Logic:
   * - If any test is cancelled → run is 'cancelled'
   * - Else if any test failed/timeout → run is 'failed'
   * - Else if all completed → run is 'completed'
   * - If some tests still running → no update (wait for completion)
   *
   * @param run - Regression run record with test_id or test_ids
   */
  private static async recomputeRunStatus(run: any): Promise<void> {
    try {
      let underlyingTestIds: string[] = [];

      // Determine which test IDs to check
      if (run.test_id) {
        // Single test case run
        underlyingTestIds = [run.test_id];
      } else if (run.test_ids && Array.isArray(run.test_ids)) {
        // Batch run
        underlyingTestIds = run.test_ids;
      } else {
        logger.warn('[TEST_COMPLETION] Run has no test_id or test_ids', { runId: run.id });
        return;
      }

      // Get all underlying test statuses
      const { data: tests, error: testsError } = await supabaseAdmin
        .from('tests')
        .select('id, status')
        .in('id', underlyingTestIds);

      if (testsError || !tests) {
        logger.error('[TEST_COMPLETION] Failed to get underlying tests', {
          error: testsError,
          runId: run.id,
          testIds: underlyingTestIds,
        });
        return;
      }

      // ✅ Validation: Check if we got all expected tests
      if (tests.length !== underlyingTestIds.length) {
        logger.warn('[TEST_COMPLETION] Missing some underlying tests', {
          runId: run.id,
          expected: underlyingTestIds.length,
          found: tests.length,
        });
      }

      // Check if all tests are complete
      const statuses = tests.map(t => t.status);
      const hasRunning = statuses.some(s => s === 'running' || s === 'pending');

      if (hasRunning) {
        logger.debug('[TEST_COMPLETION] Run still has running tests', {
          runId: run.id,
          runningCount: statuses.filter(s => s === 'running' || s === 'pending')
            .length,
        });
        return; // Don't update yet
      }

      // All tests are complete - compute final status
      let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

      if (statuses.some(s => s === 'cancelled')) {
        finalStatus = 'cancelled';
      } else if (statuses.some(s => s === 'failed' || s === 'timeout')) {
        finalStatus = 'failed';
      }

      // Count results
      const passed = statuses.filter(s => s === 'completed').length;
      const failed = statuses.filter(s => s === 'failed' || s === 'timeout').length;
      const cancelled = statuses.filter(s => s === 'cancelled').length;

      // Build summary
      const summary = {
        total: tests.length,
        passed,
        failed,
        cancelled,
        test_ids: tests.map(t => t.id),
        completed_at: new Date().toISOString(),
      };

      // Update regression run
      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({
          status: finalStatus,
          summary,
          completed_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      if (updateError) {
        logger.error('[TEST_COMPLETION] Failed to update regression run', {
          error: updateError,
          runId: run.id,
          finalStatus,
        });
      } else {
        logger.info('[TEST_COMPLETION] Regression run updated', {
          runId: run.id,
          status: finalStatus,
          summary,
        });
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Error recomputing run status', {
        error: error instanceof Error ? error.message : String(error),
        runId: run?.id || 'unknown',
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI SELECTOR ENGINE
// ═══════════════════════════════════════════════════════════════════════════
// Resolves selectors using embeddings-based element matching.
// Converts DOMNode[] → InteractiveNode[], calls resolveWithEmbeddings(),
// and builds Playwright-compatible selectors from the result.

import type { DOMNode, SelectorCandidate, SelectorResolveRequest, SelectorResolveResponse, SelectorType } from './types';
import { resolveWithEmbeddings } from '@/services/testing/ui/preview/embeddings-resolver.service';
import type { InteractiveNode } from '@/services/testing/ui/preview/preview.types';

export class AISelectorEngine {
  /**
   * Resolve selector using embeddings-based element matching.
   * Converts DOMNode[] to InteractiveNode[], runs resolveWithEmbeddings(),
   * and returns the best Playwright selector with fallbacks.
   */
  static async resolve(request: SelectorResolveRequest): Promise<SelectorResolveResponse> {
    const startTime = Date.now();

    try {
      // Convert DOMNode[] → InteractiveNode[]
      const interactiveNodes = request.nodes.map(node => AISelectorEngine.domNodeToInteractiveNode(node));

      if (interactiveNodes.length === 0) {
        return {
          success: false,
          fallbackSelectors: [],
          explanation: 'No interactive elements found on page',
          metrics: { totalDuration: Date.now() - startTime, cacheHit: false },
        };
      }

      // Build a minimal IntentStep for resolveWithEmbeddings
      const stepDraft = {
        id: `ai-selector-${Date.now()}`,
        type: AISelectorEngine.inferActionType(request.intent) as any,
        description: request.intent,
      };

      // Call embeddings resolver
      const lintResult = await resolveWithEmbeddings({
        previewSessionId: `self-heal-${request.metadata.projectId || 'unknown'}`,
        stepDraft,
        domNodes: interactiveNodes,
        pageUrl: request.metadata.url,
        disableCaching: true, // Self-healing should always use fresh data
        includeAlternatives: true,
        enableLLMDisambiguation: true,
      });

      const aiDuration = Date.now() - startTime;

      // No match found
      if (lintResult.status === 'not_found' || !lintResult.candidates || lintResult.candidates.length === 0) {
        return {
          success: false,
          fallbackSelectors: [],
          explanation: lintResult.message || 'No matching element found via embeddings',
          metrics: { totalDuration: Date.now() - startTime, aiDuration, cacheHit: false },
        };
      }

      // Get the best candidate
      const bestCandidate = lintResult.candidates[0];
      const bestNode = bestCandidate.node;

      if (!bestNode) {
        return {
          success: false,
          fallbackSelectors: [],
          explanation: 'Best candidate has no node data',
          metrics: { totalDuration: Date.now() - startTime, aiDuration, cacheHit: false },
        };
      }

      // Build primary selector
      const primarySelector = AISelectorEngine.buildBestSelector(bestNode);
      const selectorType = AISelectorEngine.detectSelectorType(primarySelector);

      // Build fallback selectors
      const fallbackSelectors = AISelectorEngine.buildFallbackSelectors(bestNode);

      // Find the original DOMNode to get bounding box
      const originalNode = request.nodes.find(n => n.nodeId === bestNode.ref) || request.nodes[0];

      const selectedNode = {
        nodeId: bestNode.ref || originalNode?.nodeId || 'unknown',
        primarySelector,
        selectorType,
        confidence: bestCandidate.confidence,
        boundingBox: originalNode?.boundingBox || { x: 0, y: 0, width: 0, height: 0 },
        element: {
          tag: bestNode.tag,
          text: bestNode.text || '',
          attributes: AISelectorEngine.nodeToAttributes(bestNode),
        },
      };

      logger.info('[AI_SELECTOR_ENGINE] Resolution successful', {
        intent: request.intent.slice(0, 80),
        primarySelector,
        selectorType,
        confidence: bestCandidate.confidence,
        fallbackCount: fallbackSelectors.length,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        selectedNode,
        fallbackSelectors,
        explanation: `Resolved via embeddings: ${bestCandidate.reason}`,
        metrics: { totalDuration: Date.now() - startTime, aiDuration, cacheHit: false },
      };
    } catch (error) {
      logger.error('[AI_SELECTOR_ENGINE] Resolution failed', {
        error: error instanceof Error ? error.message : String(error),
        intent: request.intent.slice(0, 80),
      });

      return {
        success: false,
        fallbackSelectors: [],
        explanation: `AI resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        metrics: { totalDuration: Date.now() - startTime, cacheHit: false },
      };
    }
  }

  /**
   * Convert DOMNode to InteractiveNode for embeddings resolver.
   * Uses enriched attributes from DOMNodeExtractor (__resolvedLabel, __containerTitles,
   * __isTopMostAtCenter) to provide the same data quality as background-dom-collector.
   */
  private static domNodeToInteractiveNode(node: DOMNode): InteractiveNode {
    const attrs = node.attributes;

    // Resolve label: prefer <label for> resolution, fallback to aria-label
    const resolvedLabel = attrs['__resolvedLabel'] || attrs['aria-label'] || undefined;

    // Parse container titles (stored as pipe-delimited string)
    const containerTitlesRaw = attrs['__containerTitles'];
    const containerTitles = containerTitlesRaw ? containerTitlesRaw.split('|').filter(Boolean) : undefined;

    // Parse isTopMostAtCenter
    const isTopMostAtCenter = attrs['__isTopMostAtCenter'] === 'true';

    // Detect dynamic IDs (GUIDs, random strings) — should not be used as selectors
    const id = attrs['id'];
    const isDynamicId = id ? /[0-9a-f]{8,}|[0-9]{4,}|^:r|^:R|^react-|^ember|^ng-/.test(id) : false;

    return {
      ref: node.nodeId,
      tag: node.tag,
      role: node.role || attrs['role'],
      type: attrs['type'],
      inputType: attrs['type'],
      text: node.text,
      labelText: resolvedLabel,
      ariaLabel: attrs['aria-label'],
      name: attrs['name'],
      placeholder: attrs['placeholder'],
      id,
      isDynamicId,
      testIdAttr: attrs['data-testid'] || attrs['data-test'],
      autocomplete: attrs['autocomplete'],
      boundingBox: node.boundingBox,
      isVisible: node.isVisible,
      isInteractive: true,
      isTopMostAtCenter,
      containerTitles,
      // State from attributes
      isDisabled: attrs['disabled'] !== undefined || attrs['aria-disabled'] === 'true',
      readOnly: attrs['readonly'] !== undefined || attrs['aria-readonly'] === 'true',
      required: attrs['required'] !== undefined || attrs['aria-required'] === 'true',
      checked: attrs['checked'] !== undefined ? true : undefined,
      ariaExpanded: attrs['aria-expanded'] === 'true' ? true : (attrs['aria-expanded'] === 'false' ? false : undefined),
      ariaPressed: attrs['aria-pressed'] === 'true' ? true : (attrs['aria-pressed'] === 'false' ? false : undefined),
      ariaSelected: attrs['aria-selected'] === 'true' ? true : (attrs['aria-selected'] === 'false' ? false : undefined),
    };
  }

  /**
   * Build the best Playwright selector from an InteractiveNode.
   * Dynamically picks the most stable selector based on available attributes.
   * Selector format must match what SelfHealingService.getLocatorForPage() supports:
   *   role=<role>[name="<name>"], label=<label>, [data-testid="<id>"], CSS
   */
  private static buildBestSelector(node: InteractiveNode): string {
    // 1. getByRole with name (most stable)
    if (node.role && (node.ariaLabel || node.labelText || node.text)) {
      const name = node.ariaLabel || node.labelText || node.text;
      return `role=${node.role}[name="${name}"]`;
    }

    // 2. getByLabel
    if (node.labelText) {
      return `label=${node.labelText}`;
    }

    // 3. getByTestId
    if (node.testIdAttr) {
      return `[data-testid="${node.testIdAttr}"]`;
    }

    // 4. getByPlaceholder
    if (node.placeholder) {
      return `[placeholder="${node.placeholder}"]`;
    }

    // 5. getByRole without name
    if (node.role) {
      return `role=${node.role}`;
    }

    // 6. CSS with id
    if (node.id && !node.isDynamicId) {
      return `#${node.id}`;
    }

    // 7. CSS with name
    if (node.name) {
      return `${node.tag}[name="${node.name}"]`;
    }

    // 8. Fallback CSS tag + type
    if (node.type) {
      return `${node.tag}[type="${node.type}"]`;
    }

    return node.tag;
  }

  /**
   * Build fallback selectors dynamically from node attributes.
   * Only generates selectors for attributes that actually exist on the node.
   * Deduplicates against primary selector and limits to 3.
   */
  private static buildFallbackSelectors(node: InteractiveNode): SelectorCandidate[] {
    const fallbacks: SelectorCandidate[] = [];
    const primarySelector = AISelectorEngine.buildBestSelector(node);
    const seen = new Set<string>([primarySelector]);

    const add = (type: SelectorType, selector: string, confidence: number, stability: number, reasoning: string) => {
      if (!seen.has(selector)) {
        seen.add(selector);
        fallbacks.push({ type, selector, confidence, stability, reasoning });
      }
    };

    // Each block only fires if the node actually has that attribute
    if (node.labelText) {
      add('getByLabel', `label=${node.labelText}`, 0.85, 0.85, `Label text: "${node.labelText}"`);
    }
    if (node.role) {
      const name = node.ariaLabel || node.labelText || node.text;
      const sel = name ? `role=${node.role}[name="${name}"]` : `role=${node.role}`;
      add('getByRole', sel, 0.8, 0.9, `ARIA role: ${node.role}${name ? ` with name "${name}"` : ''}`);
    }
    if (node.testIdAttr) {
      add('data-testid', `[data-testid="${node.testIdAttr}"]`, 0.9, 0.95, `data-testid: "${node.testIdAttr}"`);
    }
    if (node.placeholder) {
      add('css', `[placeholder="${node.placeholder}"]`, 0.7, 0.7, `Placeholder: "${node.placeholder}"`);
    }
    if (node.name) {
      add('css', `${node.tag}[name="${node.name}"]`, 0.6, 0.6, `HTML name attribute: "${node.name}"`);
    }

    return fallbacks.slice(0, 3);
  }

  /**
   * Detect selector type from selector string
   */
  private static detectSelectorType(selector: string): SelectorType {
    if (selector.startsWith('role=')) return 'getByRole';
    if (selector.startsWith('label=')) return 'getByLabel';
    if (selector.startsWith('text=')) return 'getByText';
    if (selector.includes('[data-testid=')) return 'data-testid';
    if (selector.startsWith('//')) return 'xpath';
    return 'css';
  }

  /**
   * Infer action type from intent description
   */
  private static inferActionType(intent: string): string {
    const lower = intent.toLowerCase();
    if (lower.includes('type') || lower.includes('fill') || lower.includes('enter') || lower.includes('input')) return 'type';
    if (lower.includes('click') || lower.includes('press') || lower.includes('tap') || lower.includes('submit')) return 'click';
    if (lower.includes('select') || lower.includes('choose') || lower.includes('pick')) return 'select';
    if (lower.includes('check') || lower.includes('toggle')) return 'check';
    if (lower.includes('hover')) return 'hover';
    return 'click';
  }

  /**
   * Convert InteractiveNode attributes to a Record for SelectedNode.element
   */
  private static nodeToAttributes(node: InteractiveNode): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (node.id) attrs['id'] = node.id;
    if (node.name) attrs['name'] = node.name;
    if (node.type) attrs['type'] = node.type;
    if (node.role) attrs['role'] = node.role;
    if (node.ariaLabel) attrs['aria-label'] = node.ariaLabel;
    if (node.placeholder) attrs['placeholder'] = node.placeholder;
    if (node.testIdAttr) attrs['data-testid'] = node.testIdAttr;
    if (node.autocomplete) attrs['autocomplete'] = node.autocomplete;
    return attrs;
  }
}
