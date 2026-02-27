import { redisConnection } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
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

// ═══════════════════════════════════════════════════════════════════════════
// REDIS LOCK HELPER: Prevents concurrent test starts for the same chat session
// ═══════════════════════════════════════════════════════════════════════════
const CHAT_TEST_LOCK_PREFIX = 'lock:chat_test_start:';
const CHAT_TEST_LOCK_TTL_SECONDS = 10; // Short TTL to prevent stuck locks

async function acquireChatTestLock(chatSessionId: string): Promise<boolean> {
  try {
    const lockKey = `${CHAT_TEST_LOCK_PREFIX}${chatSessionId}`;
    const result = await redisConnection.set(lockKey, '1', 'EX', CHAT_TEST_LOCK_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch {
    // If Redis is unavailable, fail-open (allow the request)
    return true;
  }
}

async function releaseChatTestLock(chatSessionId: string): Promise<void> {
  try {
    const lockKey = `${CHAT_TEST_LOCK_PREFIX}${chatSessionId}`;
    await redisConnection.del(lockKey);
  } catch {
    // Best-effort release
  }
}

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

  // Track Redis lock state for cleanup in error handler
  let lockAcquired = false;

  try {
    // FIX #13: Consistent progress starting from 0%
    emitProcessingStep(chatSessionId, 'executing_test', 'Starting UI test...', 0);

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

    checkTimeout();

    // ✅ GUARD: Only 1 active test per chat session - REJECT if one already exists
    // This prevents duplicate tests from rapid clicks or concurrent requests
    // Uses Redis lock to prevent race conditions between concurrent requests
    if (chatSessionId) {
      // Step 1: Acquire distributed lock to prevent race conditions
      lockAcquired = await acquireChatTestLock(chatSessionId);
      if (!lockAcquired) {
        logger.warn('[UI_TEST] Rejected: concurrent request already in progress', {
          chatSessionId,
          userId,
          planId,
        });

        if (!res.headersSent) {
          res.status(409).json({
            success: false,
            error: 'CONCURRENT_REQUEST',
            message: 'Another test request is already being processed for this chat. Please wait a moment.',
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      // Step 2: Check for active tests (now under lock)
      try {
        const runningTests = await ManualTestService.getRunningTestsForChatSession(chatSessionId);
        if (runningTests.length > 0) {
          const existingTest = runningTests[0];
          logger.warn('[UI_TEST] Rejected: chat session already has an active test', {
            chatSessionId,
            userId,
            existingTestId: existingTest.id,
            existingTestStatus: existingTest.status,
            planId,
          });

          // Release lock before returning
          await releaseChatTestLock(chatSessionId);

          if (!res.headersSent) {
            res.status(409).json({
              success: false,
              error: 'TEST_ALREADY_RUNNING',
              message: 'A test is already running in this chat. Please wait for it to complete or cancel it first.',
              existingTestId: existingTest.id,
              timestamp: new Date().toISOString(),
            });
          }
          return; // Exit early - do not create new test
        }
      } catch (guardError) {
        // Log but don't block - fail-open to avoid breaking flow if mapping query fails
        logger.warn('[UI_TEST] Failed to check for active tests in chat session', {
          error: guardError instanceof Error ? guardError.message : String(guardError),
          chatSessionId,
          userId,
        });
        // Don't release lock here - continue with test creation
      }
    }

    // Soft credit check — verify user has at least 1 credit to start
    // Actual credits are deducted per-step during execution
    const softCreditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
    if (softCreditCheck.available < 1) {
      logger.warn('[UI_TEST] Insufficient credits (soft check)', { userId, available: softCreditCheck.available });
      if (!res.headersSent) {
        res.status(402).json({
          success: false,
          error: 'Insufficient credits',
          message: 'You need at least 1 credit to start a test.',
        });
      }
      return;
    }

    logger.info('[UI_TEST] Soft credit check passed', {
      userId,
      available: softCreditCheck.available,
      note: 'Credits will be deducted per-step during execution',
    });

    emitProcessingStep(chatSessionId, 'executing_test', 'Setting up test environment...', 20);
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

    emitProcessingStep(chatSessionId, 'executing_test', 'Launching browser...', 30);
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
        chatSessionId, // Pass chat session ID for WebSocket routing isolation
        prefilledSteps: plan.prefilledSteps, // Smart Resolver: prefilled steps for fast replay
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
        // Credits are deducted AFTER successful test start (see below).
        // So if runTest fails, credits were NOT deducted here.
        note: 'Test failed to start; credits were not deducted',
      });

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
    // ✅ FIX (duplicate start): If we reused an existing active test, DO NOT deduct credits again.
    const reusedExistingTest = testCreated?.message === 'ACTIVE_TEST_REUSED';

    // Create analytics records (regression_run + test_execution)
    // Without these, analytics endpoints show 0 for chat-launched tests.
    // Skip if we reused an existing test — analytics records already exist for it.
    if (!reusedExistingTest && actualTestId) {
      try {
        const { data: analyticsRun, error: runInsertError } = await supabaseAdmin
          .from('regression_runs')
          .insert({
            project_id: project_id,
            user_id: userId,
            trigger: 'chat',
            status: 'running',
            test_id: actualTestId,
          })
          .select('id')
          .single();

        if (runInsertError || !analyticsRun) {
          logger.warn('[UI_TEST] Failed to create analytics regression_run', {
            error: runInsertError?.message,
            testId: actualTestId,
          });
        } else {
          const { error: execInsertError } = await supabaseAdmin
            .from('test_executions')
            .insert({
              run_id: analyticsRun.id,
              test_type: 'ui',
              test_case_id: null,
              status: 'running',
              started_at: new Date().toISOString(),
              browser: 'chrome',
              result: { testId: actualTestId, type: 'ui', trigger: 'chat' },
            });

          if (execInsertError) {
            logger.warn('[UI_TEST] Failed to create analytics test_execution', {
              error: execInsertError.message,
              runId: analyticsRun.id,
              testId: actualTestId,
            });
          } else {
            logger.info('[UI_TEST] Analytics records created for Pro test', {
              runId: analyticsRun.id,
              testId: actualTestId,
            });
          }
        }
      } catch (analyticsError) {
        // Analytics tracking is non-critical — never block test execution
        logger.warn('[UI_TEST] Analytics tracking failed (non-critical)', {
          error: analyticsError instanceof Error ? analyticsError.message : String(analyticsError),
          testId: actualTestId,
        });
      }
    }

    // Credits are now deducted per-step during execution — no upfront deduction needed
    if (reusedExistingTest) {
      logger.info('[UI_TEST] Reused existing active test', {
        testId: actualTestId,
        url: plan.url,
        userId,
      });
    }

    emitProcessingStep(chatSessionId, 'executing_test', 'Test is running!', 100);

    // ✅ FIX: Save test-chat mapping SYNCHRONOUSLY (awaited)
    // This is critical for the "1 active test per chat" guard to work reliably
    // Without await, concurrent requests could both pass the guard before mapping is saved
    if (chatSessionId && userId && actualTestId) {
      let mappingSaved = false;
      try {
        await TestChatMappingService.saveTestChatMapping({
          testId: actualTestId,
          chatSessionId,
          userId,
        });
        mappingSaved = true;
        logger.debug('[UI_TEST] Test-chat mapping saved', {
          testId: actualTestId,
          chatSessionId,
        });
      } catch (mappingError) {
        // Log error but don't fail the flow - test is already created
        logger.error('[UI_TEST] Failed to save test-chat mapping', {
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
          testId: actualTestId,
        });
      } finally {
        // ✅ Release Redis lock ONLY if mapping was saved successfully.
        // If mapping failed, keep the lock until TTL to reduce chances of creating duplicates.
        if (lockAcquired && mappingSaved) {
          await releaseChatTestLock(chatSessionId);
        }
      }
    } else if (chatSessionId && lockAcquired) {
      // Release lock if we didn't save mapping (edge case: no actualTestId)
      await releaseChatTestLock(chatSessionId);
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

    // ✅ Release Redis lock on error to prevent stuck locks
    if (lockAcquired && chatSessionId) {
      await releaseChatTestLock(chatSessionId);
    }

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
