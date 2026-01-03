import { supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { confirmTestPlan } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { ChatService } from '@/services/utils/chat.service';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatTestUpdatePayload } from '@/websocket/types/types';
import { Response } from 'express';
import { emitProcessingStep, normalizeUrl } from '../shared/utils';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: EXECUTE UI TEST FLOW (REFACTORED - CRITICAL FIXES)
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX #6-11: Error handling, validation, non-blocking chat save
 * FIX #12: Global timeout for entire flow (90s)
 * FIX #13: Consistent WebSocket progress (0-100%)
 */
export async function executeUiTestFlow(
  res: Response,
  params: {
    plan: any;
    planId: string;
    userId: string;
    chatSessionId?: string;
    workspace_id: string;
    userMessage?: string; // FIX #14: Actual user message
  }
): Promise<void> {
  const { plan, planId, userId, chatSessionId, workspace_id, userMessage = 'Approved test execution' } = params;

  // FIX #12: Global timeout for UI test flow (longer than API because browser tests are slower)
  const flowTimeout = 90000; // 90 seconds
  const flowStartTime = Date.now();

  const checkTimeout = () => {
    if (Date.now() - flowStartTime > flowTimeout) {
      throw new Error(`UI test flow timeout after ${flowTimeout / 1000}s`);
    }
  };

  logger.info('🔵 [UI_TEST] Starting UI test execution', {
    planId,
    userId,
    url: plan.url,
    intelligentMode: plan.intelligentMode,
    timeout: flowTimeout,
  });

  try {
    // FIX #13: Consistent progress starting from 0%
    emitProcessingStep(chatSessionId, 'executing_test', '🚀 Starting UI test execution...', 0);
    emitProcessingStep(chatSessionId, 'executing_test', '📋 Confirming test plan...', 5);

    // Validate plan.url
    if (!plan.url || typeof plan.url !== 'string') {
      throw new Error('Invalid plan URL - URL is required for UI testing');
    }

    checkTimeout();

    // FIX #6 & #7: Confirm plan and check result properly
    const confirmResult = await confirmTestPlan(planId, userId);

    if (!confirmResult.success) {
      throw new Error(`Failed to confirm test plan: ${confirmResult.message || 'Unknown error'}`);
    }

    // ✅ REMOVED: Standard mode validation - all UI tests now use intelligent mode
    // Intelligent mode doesn't require commands validation as AI generates actions dynamically

    emitProcessingStep(chatSessionId, 'executing_test', '💳 Checking credits...', 10);
    checkTimeout();

    // ✅ CRITICAL: Check if user sent new message (cancel running tests first)
    // This prevents creating new test if user already sent another message
    if (chatSessionId) {
      try {
        const { ManualTestService } = await import('@/services/testing/ui/manualTest.service');
        const cancelResult = await ManualTestService.cancelAllRunningTestsForChatSession(
          chatSessionId,
          userId
        );
        if (cancelResult.cancelledCount > 0) {
          logger.info('[UI_TEST] Cancelled running tests before creating new test', {
            chatSessionId,
            userId,
            cancelledCount: cancelResult.cancelledCount,
            planId,
          });
        }
      } catch (cancelError) {
        // Don't fail if cancellation fails, but log it
        logger.warn('[UI_TEST] Failed to cancel running tests before creating new test', {
          error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          chatSessionId,
          userId,
        });
      }
    }

    // ✅ CREDITS ALREADY CHECKED in test-execution.ts via CreditCostTrackerService.checkCreditsForTest()
    // No need to duplicate check here - it was already validated before calling executeUiTestFlow
    // Credits will be deducted AFTER successful queue job creation to prevent charging without running
    const uiTestType = 'intelligent';
    const testId = `ui_${planId}_${Date.now()}`;
    const creditsRequired = TokenCalculatorService.getTestCreditCost(uiTestType);

    logger.info('[UI_TEST] Credit check already passed in test-execution.ts', {
      userId,
      required: creditsRequired,
      note: 'Credits were validated before entering this flow',
    });

    emitProcessingStep(chatSessionId, 'executing_test', '🔍 Finding project context...', 20);
    checkTimeout();

    // ✅ OPTIMIZATION: Try to get project_id from chat session first (avoid duplicate findOrCreateProject)
    // Project is already created in handlePlatformTest and saved to session
    let project_id: string | undefined;
    if (chatSessionId) {
      try {
        const { data: session } = await supabaseAdmin
          .from('chat_sessions')
          .select('project_id')
          .eq('id', chatSessionId)
          .single();
        if (session?.project_id) {
          project_id = session.project_id;
          logger.info('[UI_TEST] Using project_id from chat session', { project_id });
        }
      } catch (sessionError) {
        logger.warn('[UI_TEST] Failed to get project_id from chat session, will create/find', {
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
          chatSessionId,
        });
      }
    }

    // If not found in session, find or create project (fallback)
    if (!project_id) {
      try {
        const projectResult = await ProjectContextService.findOrCreateProject(
          workspace_id,
          normalizeUrl(plan.url),
          userId
        );
        project_id = projectResult.project_id;

        if (!project_id) {
          throw new Error('Failed to get project_id from ProjectContextService');
        }

        logger.info('[UI_TEST] Created/found project', {
          project_id,
          is_new: projectResult.is_new,
        });
      } catch (projectError) {
        logger.error('[UI_TEST] ProjectContextService failed', {
          error: projectError instanceof Error ? projectError.message : String(projectError),
          workspace_id,
          url: plan.url,
        });
        throw new Error(`Failed to initialize project: ${projectError instanceof Error ? projectError.message : 'Unknown error'}`);
      }
    }

    // Ensure project_id is defined (should never be undefined at this point)
    if (!project_id) {
      throw new Error('project_id is required but was not found or created');
    }

    emitProcessingStep(chatSessionId, 'executing_test', '⚙️ Launching browser test...', 30);
    checkTimeout();

    // FIX #9: Wrap ManualTestService.runTest in try-catch
    // ✅ IMPROVEMENT: Validate plan fields before use
    const intelligentMode = plan.intelligentMode ?? true; // Default to true (all UI tests are intelligent)
    const planCommands = Array.isArray(plan.commands) ? plan.commands : [];
    const planScope = plan.scope || 'general';
    const planSummary = plan.summary || 'Automated UI test';
    const planEstimatedPages = plan.estimatedPages || '2-3 pages';

    let testCreated: any;
    let actualTestId: string | null = null;

    try {
      // ✅ IMPROVEMENT: Validate required fields before creating testRequest
      if (!plan.url || typeof plan.url !== 'string' || plan.url.trim().length === 0) {
        throw new Error('Invalid plan URL - URL is required and must be a non-empty string');
      }

      const testRequest = {
        url: plan.url.trim(),
        browsers: ['chrome' as const],
        projectId: project_id,
        userId,
        options: {},
        commands: planCommands, // ✅ Safe: always array
        intent: planScope, // ✅ Safe: always string
        intelligentMode, // ✅ Safe: always boolean
        testGoal: intelligentMode ? planSummary : undefined, // ✅ Safe: always string or undefined
        estimatedCost: plan.estimatedCost, // Optional field
        mode: plan.mode || 'lite', // Test execution mode (default: 'lite')
      };

      /// Here we run the main UI/UX manual test
      testCreated = await ManualTestService.runTest(testRequest);

      // ✅ IMPROVEMENT: More thorough validation of response
      if (!testCreated) {
        throw new Error('ManualTestService.runTest returned null/undefined');
      }

      if (!testCreated.success) {
        throw new Error(`Test creation failed: ${testCreated.message || 'Unknown error'}`);
      }

      if (!testCreated.data || typeof testCreated.data !== 'object') {
        throw new Error('Test creation failed - invalid response data structure');
      }

      if (!testCreated.data.id || typeof testCreated.data.id !== 'string') {
        throw new Error('Test creation failed - no valid test ID returned');
      }

      actualTestId = testCreated.data.id;

    } catch (testError) {
      logger.error('[UI_TEST] ManualTestService.runTest failed', {
        error: testError instanceof Error ? testError.message : String(testError),
        url: plan.url,
        // ✅ IMPROVEMENT: Log that credits were already deducted
        note: 'Credits were deducted before test creation - they will not be refunded',
      });

      // ✅ NOTE: Credits were already deducted (line 86), they are NOT refunded on failure
      // This is intentional behavior - credits are spent for attempting to create the test
      throw new Error(`Failed to start test: ${testError instanceof Error ? testError.message : 'Unknown error'}`);
    }

    // ✅ IMPROVEMENT: Type guard - ensure testId exists before using
    if (!actualTestId) {
      throw new Error('Test ID is missing after successful test creation');
    }

    logger.info('✅ [UI_TEST] Test created successfully', {
      testId: actualTestId,
      intelligentMode,
    });

    // ✅ FIX #1: Deduct credits AFTER successful queue job creation
    // This ensures we only charge if test actually started
    emitProcessingStep(chatSessionId, 'executing_test', '💳 Deducting credits...', 90);
    try {
      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: uiTestType,
        credits: creditsRequired,
        costUSD: uiTestType === 'intelligent' ? 0.08 : 0.001,
        testId: actualTestId,
        description: `${uiTestType} UI test: ${plan.url}`,
      });
      logger.info('[UI_TEST] Credits deducted successfully', {
        testId: actualTestId,
        credits: creditsRequired,
      });
    } catch (creditError) {
      // If credit deduction fails AFTER test creation, we need to cancel the test
      logger.error('[UI_TEST] Failed to deduct credits after test creation - cancelling test', {
        error: creditError instanceof Error ? creditError.message : String(creditError),
        testId: actualTestId,
      });

      // Cancel the test to prevent running without payment
      try {
        await ManualTestService.cancelTest(actualTestId, userId);
      } catch (cancelError) {
        logger.error('[UI_TEST] Failed to cancel test after credit deduction failure', {
          error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          testId: actualTestId,
        });
      }

      throw new Error('Failed to deduct credits - test cancelled');
    }

    emitProcessingStep(chatSessionId, 'executing_test', '✅ Test started successfully!', 100);

    // Save test-chat mapping (non-blocking)
    if (chatSessionId && userId && actualTestId) {
      TestChatMappingService.saveTestChatMapping({
        testId: actualTestId,
        chatSessionId,
        userId,
      }).catch(mappingError => {
        logger.error('[UI_TEST] Failed to save test-chat mapping', {
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
          testId: actualTestId,
        });
      });
    }

    // Emit WebSocket event (non-blocking)
    if (chatSessionId && actualTestId) {
      try {
        const testModeMessage = intelligentMode
          ? '🤖 Intelligent test started! AI will autonomously explore and adapt to your site.'
          : '✅ Test started! Monitor progress in real-time.';

        const chatTestUpdatePayload: ChatTestUpdatePayload = {
          sessionId: chatSessionId,
          testId: actualTestId,
          message: testModeMessage,
          status: 'created',
          links: {
            fullReport: `/api/v1/manual-test/${actualTestId}/summary`,
          },
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitChatTestUpdate(chatSessionId, chatTestUpdatePayload);
      } catch (wsError) {
        logger.warn('[UI_TEST] Failed to emit WebSocket event', {
          error: wsError instanceof Error ? wsError.message : String(wsError),
        });
      }
    }

    // Build success message
    const testModeInfo = intelligentMode
      ? `\n\n🤖 **Mode:** Intelligent/Adaptive Testing\n📊 **Estimated:** ${planEstimatedPages}`
      : '';

    const successMessage = `✅ Test plan approved and running!${testModeInfo}\n`;

    // ✅ FIX: Test is considered "runned" if it was successfully created and added to queue
    const isTestRunned = !!actualTestId;

    // FIX #11: Make chat save non-blocking (fire-and-forget)
    if (chatSessionId && actualTestId) {
      ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: userMessage || 'Approved test execution' }, // ✅ IMPROVEMENT: Fallback for userMessage
        {
          role: 'ai',
          content: successMessage,
          metadata: {
            testId: actualTestId,
            testMode: 'intelligent', // ✅ UPDATED: All UI tests are intelligent mode
            is_test_runned: isTestRunned, // ✅ NEW: Flag indicating if test is completed/failed
          },
        },
      ]).catch(saveError => {
        logger.error('[UI_TEST] Failed to save chat messages', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
          sessionId: chatSessionId,
        });
      });
    }

    // ✅ IMPROVEMENT: Check if response already sent before sending
    if (res.headersSent) {
      logger.warn('[UI_TEST] Response already sent, cannot send success response', {
        testId: actualTestId,
      });
      return;
    }

    // Send response immediately (don't wait for chat save)
    res.json({
      success: true, // ← Frontend expects this!
      reply: successMessage,
      testId: actualTestId,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });

    logger.info('✅ [UI_TEST] HTTP response sent successfully', {
      testId: actualTestId,
      duration: Date.now() - flowStartTime,
    });
  } catch (error) {
    logger.error('❌ [UI_TEST] Critical error in UI test flow', {
      error: error instanceof Error ? error.message : String(error),
      planId,
      userId,
    });

    // If response not sent yet, send error
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'UI test failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    throw error; // Re-throw for handleExecutionError
  }
}
