import { Response } from 'express';
import { redisConnection } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { confirmTestPlan } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
import { executeApiTest } from '@/services/testing/api/apiTest.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ApiTestStorageService } from '@/services/testing/api/api-test-storage.service';
import { ChatService } from '@/services/utils/chat.service';
import { emitProcessingStep } from '../shared/utils';
import { runApiFuzzing } from './fuzzing';
import { formatApiResponse } from './formatting';

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
 * HELPER: EXECUTE API TEST FLOW (REFACTORED - CRITICAL FIXES)
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX #1-5: Error handling, validation, non-blocking chat save
 * FIX #12: Global timeout for entire flow (60s)
 * FIX #13: Consistent WebSocket progress (0-100%)
 */
export async function executeApiTestFlow(
  res: Response,
  params: {
    plan: any;
    planId: string;
    userId: string;
    chatSessionId?: string;
    userMessage?: string; // FIX #14: Actual user message
  }
): Promise<void> {
  const { plan, planId, userId, chatSessionId, userMessage = 'Approved test execution' } = params;

  // ✅ FIX #1: Validate input parameters
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Invalid plan - plan must be a valid object');
  }

  if (!planId || typeof planId !== 'string' || planId.trim().length === 0) {
    throw new Error('Invalid planId - planId is required');
  }

  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid userId - userId is required');
  }

  // FIX #12: Global timeout for entire API test flow
  const flowTimeout = 60000; // 60 seconds
  const flowStartTime = Date.now();

  const checkTimeout = () => {
    if (Date.now() - flowStartTime > flowTimeout) {
      throw new Error(`API test flow timeout after ${flowTimeout / 1000}s`);
    }
  };

  logger.info('🔵 [API_TEST] Starting API test execution', {
    planId,
    url: plan?.url,
    method: plan?.metadata?.method,
    chatSessionId,
    timeout: flowTimeout,
  });

  // Track Redis lock state for cleanup in error handler
  let lockAcquired = false;

  try {
    // FIX #13: Consistent progress starting from 0%
    emitProcessingStep(chatSessionId, 'executing_test', '🚀 Starting API test execution...', 0);
    emitProcessingStep(chatSessionId, 'executing_test', '📋 Confirming test plan...', 5);

    // FIX #4: Validate plan.url before execution
    if (!plan.url || typeof plan.url !== 'string' || plan.url.trim().length === 0) {
      throw new Error('Invalid plan URL - URL is required for API testing');
    }

    // Validate URL format
    try {
      new URL(plan.url);
    } catch {
      throw new Error(`Invalid URL format: ${plan.url}`);
    }

    // ✅ FIX #11: Check timeout BEFORE each major step (not after)
    checkTimeout();

    // Confirm plan
    const confirmResult = await confirmTestPlan(planId, userId);
    if (!confirmResult.success) {
      throw new Error(`Failed to confirm test plan: ${confirmResult.message}`);
    }

    emitProcessingStep(chatSessionId, 'executing_test', '💳 Checking credits...', 10);
    checkTimeout();

    // ✅ GUARD: Only 1 active test per chat session - REJECT if one already exists
    // This prevents duplicate tests from rapid clicks or concurrent requests
    // Uses Redis lock to prevent race conditions between concurrent requests
    if (chatSessionId) {
      // Step 1: Acquire distributed lock to prevent race conditions
      lockAcquired = await acquireChatTestLock(chatSessionId);
      if (!lockAcquired) {
        logger.warn('[API_TEST] Rejected: concurrent request already in progress', {
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
        const { ManualTestService } = await import('@/services/testing/ui/manualTest.service');
        const runningTests = await ManualTestService.getRunningTestsForChatSession(chatSessionId);
        if (runningTests.length > 0) {
          const existingTest = runningTests[0];
          logger.warn('[API_TEST] Rejected: chat session already has an active test', {
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
        logger.warn('[API_TEST] Failed to check for active tests in chat session', {
          error: guardError instanceof Error ? guardError.message : String(guardError),
          chatSessionId,
          userId,
        });
        // Don't release lock here - continue with test creation
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CREDITS DEDUCTION: Spisываются ДО выполнения теста
    // ═══════════════════════════════════════════════════════════════════════
    // ВАЖНО: Кредиты списываются ДО выполнения теста, поэтому даже если тест
    // упадет с ошибкой, кредиты останутся списанными (это намеренное поведение).
    // Пользователь платит за попытку выполнения теста, независимо от результата.
    const apiTestId = `api_${planId}_${Date.now()}`;

    // ✅ FIX #9: Validate plan.metadata as object
    const apiDetails = plan.metadata && typeof plan.metadata === 'object' && !Array.isArray(plan.metadata)
      ? plan.metadata
      : {};

    try {
      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: 'api',
        credits: TokenCalculatorService.getTestCreditCost('api'),
        costUSD: 0.0011,
        testId: apiTestId,
        description: `API test: ${apiDetails.method || 'GET'} ${plan.url}`,
      });
      logger.info('[API_TEST] Credits deducted successfully', {
        testId: apiTestId,
        userId: userId.substring(0, 8) + '...',
      });
    } catch (creditError) {
      logger.error('[API_TEST] Failed to deduct credits', {
        error: creditError instanceof Error ? creditError.message : String(creditError),
        userId,
      });
      throw new Error('Insufficient credits or payment error');
    }

    emitProcessingStep(chatSessionId, 'executing_test', '🔧 Preparing API request...', 15);
    checkTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // TEST EXECUTION: Выполнение теста (кредиты уже списаны выше)
    // ═══════════════════════════════════════════════════════════════════════
    // Если тест упадет здесь, кредиты НЕ возвращаются (намеренное поведение)
    // FIX #1: Wrap executeApiTest in try-catch
    let apiTestResult: any;
    try {
      apiTestResult = await executeApiTest(
        {
          method: apiDetails.method || 'GET',
          url: plan.url,
          body: apiDetails.body,
          headers: apiDetails.headers || {},
          expectedStatus: apiDetails.expectedStatus || 200,
        },
        chatSessionId
      );

      // ✅ FIX #4: Validate apiTestResult is not null/undefined
      if (!apiTestResult || typeof apiTestResult !== 'object') {
        throw new Error('executeApiTest returned invalid result');
      }
    } catch (testError) {
      // Кредиты уже списаны выше, поэтому не возвращаем их
      logger.error('[API_TEST] executeApiTest failed (credits already deducted)', {
        error: testError instanceof Error ? testError.message : String(testError),
        url: plan.url,
        testId: apiTestId,
      });
      throw new Error(`API test execution failed: ${testError instanceof Error ? testError.message : 'Unknown error'}`);
    }

    checkTimeout();

    // FIX #2: Wrap runApiFuzzing in try-catch (already has internal try-catch, but double-check)
    let fuzzingReport: any = null;
    try {
      fuzzingReport = await runApiFuzzing(apiTestResult, apiDetails, plan.url, chatSessionId);
    } catch (fuzzingError) {
      // Fuzzing is optional, don't fail the entire test
      logger.warn('[API_TEST] Fuzzing failed, continuing without it', {
        error: fuzzingError instanceof Error ? fuzzingError.message : String(fuzzingError),
      });
      // fuzzingReport stays null
    }

    checkTimeout();

    // ✅ FIX: Save test-chat mapping SYNCHRONOUSLY (awaited)
    // This is critical for the "1 active test per chat" guard to work reliably
    // Without await, concurrent requests could both pass the guard before mapping is saved
    if (chatSessionId && userId) {
      let mappingSaved = false;
      try {
        await TestChatMappingService.saveTestChatMapping({
          testId: apiTestId,
          chatSessionId,
          userId,
        });
        mappingSaved = true;
        logger.debug('[API_TEST] Test-chat mapping saved', {
          testId: apiTestId,
          chatSessionId,
        });
      } catch (mappingError) {
        // Log error but don't fail the flow - test is already created
        logger.error('[API_TEST] Failed to save test-chat mapping', {
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
          testId: apiTestId,
        });
      } finally {
        // ✅ Release Redis lock ONLY if mapping was saved successfully.
        // If mapping failed, keep the lock until TTL to reduce chances of creating duplicates.
        if (lockAcquired && mappingSaved) {
          await releaseChatTestLock(chatSessionId);
        }
      }
    } else if (chatSessionId && lockAcquired) {
      // Release lock if we didn't save mapping (edge case)
      await releaseChatTestLock(chatSessionId);
    }

    // ✅ FIX #3: Wrap formatApiResponse in try-catch
    let finalMessage: string;
    try {
      const formatResult = await formatApiResponse(
        apiTestResult,
        fuzzingReport,
        plan,
        apiDetails
      );

      // ✅ FIX #10: Validate formatApiResponse return value
      if (!formatResult || typeof formatResult !== 'object' || !formatResult.finalMessage) {
        throw new Error('formatApiResponse returned invalid result');
      }

      finalMessage = formatResult.finalMessage;
    } catch (formatError) {
      logger.error('[API_TEST] formatApiResponse failed', {
        error: formatError instanceof Error ? formatError.message : String(formatError),
      });
      // Fallback message
      finalMessage = `✅ API test completed!\n**URL:** ${plan.url}\n**Method:** ${apiDetails.method || 'GET'}\n**Status:** ${apiTestResult.status || 'N/A'}`;
    }

    // ✅ FIX #6: isTestRunned should check if test actually succeeded
    const isTestRunned = !!apiTestResult && apiTestResult.success === true;

    // ═══════════════════════════════════════════════════════════════════════
    // SAVE TO DATABASE: Save comprehensive test results to api_test_executions
    // ═══════════════════════════════════════════════════════════════════════
    // Get projectId from chat session if available
    let projectId: string | undefined;
    if (chatSessionId) {
      try {
        const { data: session } = await supabaseAdmin
          .from('chat_sessions')
          .select('project_id')
          .eq('id', chatSessionId)
          .single();
        if (session?.project_id) {
          projectId = session.project_id;
        }
      } catch (sessionError) {
        logger.warn('[API_TEST] Failed to get project_id from chat session', {
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
          chatSessionId,
        });
      }
    }

    // Save to database (non-blocking, fire-and-forget)
    ApiTestStorageService.saveApiTestExecution({
      userId,
      testId: apiTestId,
      chatSessionId: chatSessionId || undefined,
      projectId,
      request: {
        method: apiDetails.method || 'GET',
        url: plan.url,
        headers: apiDetails.headers || {},
        body: apiDetails.body,
      },
      response: {
        status: apiTestResult.status || 0,
        statusText: apiTestResult.statusText || '',
        headers: apiTestResult.responseHeaders || {},
        body: apiTestResult.responseBody || null,
        durationMs: apiTestResult.durationMs || 0,
      },
      success: apiTestResult.success !== false,
      errorMessage: apiTestResult.error || undefined,
      fuzzingReport: fuzzingReport
        ? {
            summary: fuzzingReport.summary || {
              totalTests: 0,
              passed: 0,
              failed: 0,
              duration: 0,
            },
            issues: fuzzingReport.issues || [],
            securityScore: fuzzingReport.securityScore || 0,
            metadata: fuzzingReport.metadata || {},
          }
        : undefined,
      metadata: {
        planId,
        testType: 'api',
        is_test_runned: isTestRunned,
      },
    }).catch(storageError => {
      logger.error('[API_TEST] Failed to save test execution to database', {
        error: storageError instanceof Error ? storageError.message : String(storageError),
        testId: apiTestId,
      });
      // Don't fail the test if storage fails
    });

    // FIX #5: Make chat save non-blocking (fire-and-forget)
    if (chatSessionId) {
      ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: userMessage }, // FIX #14: Use actual user message
        {
          role: 'ai',
          content: finalMessage,
          metadata: {
            testResult: {
              ...apiTestResult,
              // ✅ FIX: Add request details to testResult for history retrieval
              method: apiDetails.method || 'GET',
              url: plan.url,
              requestHeaders: apiDetails.headers || {},
              requestBody: apiDetails.body,
            },
            testId: apiTestId,
            testType: 'api',
            is_test_runned: isTestRunned, // ✅ NEW: Flag indicating if test is completed/failed
            // ✅ FIX #5: Safe access to fuzzingReport.summary and issues
            fuzzingReport: fuzzingReport && fuzzingReport.summary && fuzzingReport.issues ? {
              totalTests: fuzzingReport.summary.totalTests || 0,
              passed: fuzzingReport.summary.passed || 0,
              failed: fuzzingReport.summary.failed || 0,
              issuesFound: fuzzingReport.issues.length || 0,
              securityScore: fuzzingReport.securityScore || 0,
            } : null,
          },
        },
      ]).catch(saveError => {
        logger.error('[API_TEST] Failed to save chat messages', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
          sessionId: chatSessionId,
        });
      });
    }

    // ✅ FIX #7: Check if response already sent before sending
    if (res.headersSent) {
      logger.warn('[API_TEST] Response already sent, cannot send success response', {
        testId: apiTestId,
      });
      return;
    }

    // Send response immediately (don't wait for chat save)
    res.json({
      success: true, // ← Frontend expects this!
      reply: finalMessage,
      testResult: apiTestResult,
      fuzzingReport: fuzzingReport || undefined,
      testId: apiTestId,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });

    logger.info('✅ [API_TEST] HTTP response sent successfully', {
      testId: apiTestId,
      duration: Date.now() - flowStartTime,
    });
  } catch (error) {
    logger.error('❌ [API_TEST] Critical error in API test flow', {
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
        error: 'API test failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    throw error; // Re-throw for handleExecutionError
  }
}
