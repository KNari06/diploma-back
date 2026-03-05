import { redisConnection } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ResolverMatchType } from '@/types/testing.types';
import { requestMissingInformation } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { ChatService } from '@/services/utils/chat.service';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { parseAnswers } from '@/services/utils/question-generator.service';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatTestUpdatePayload } from '@/websocket/types/types';
import { Request, Response } from 'express';
import { checkRequestAborted } from '../shared/request-cancellation';
import { emitProcessingStep, normalizeUrl } from '../shared/utils';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { QueueManager } from '@/config/infrastructure/queues';

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
    // If Redis is unavailable, fail-closed (reject the request to prevent concurrent execution)
    logger.warn('[CHAT_LOCK] Redis unavailable, denying lock to prevent concurrent test execution', {
      chatSessionId,
    });
    return false;
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
 * Run an async operation with timeout and optional cancellation support.
 * Throws when timeout is exceeded or AbortSignal is triggered.
 */
async function runWithTimeoutAndAbort<T>(
  operation: Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  timeoutLabel: string = 'Operation',
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  let abortHandler: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${timeoutLabel} timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  const races: Array<Promise<T>> = [operation, timeoutPromise as Promise<T>];
  if (abortSignal) {
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new Error('Request aborted'));
        return;
      }
      abortHandler = () => reject(new Error('Request aborted'));
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    });
    races.push(abortPromise as Promise<T>);
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: PLATFORM TEST (UI Testing) - REFACTORED & FIXED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CRITICAL FIXES:
 * - FIX #1: Added comprehensive error handling for all async operations
 * - FIX #2: Implemented proper test plan approval flow (like API test)
 * - FIX #3: Added timeout protection for entire flow
 * - FIX #4: Improved WebSocket progress updates
 * - FIX #5: Fixed extractUrlFromMessage undefined issue
 * - FIX #6: Removed duplicate question asking logic
 *
 * FLOW (Lite mode — always):
 * 1. Validate URL + scope
 * 2. Create/find project
 * 3. Run test immediately (no approval step)
 */
export async function handlePlatformTest(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    abortSignal?: AbortSignal;
    logger?: FunctionLogger;
    mode?: 'lite' | 'pro' | 'editor'; // Test execution mode (default: 'lite')
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers, abortSignal, logger: functionLogger, mode } = params;

  // Wrap entire test plan flow with AI tracking context
  const executePlatformTest = async () => {
    // Begin AI usage tracking session
    const sessionId = chatSessionId || `test-plan-${Date.now()}`;
    AIUsageTracker.beginSession(sessionId, {
      workspaceId: workspace_id,
      userId,
      operationType: 'test-plan',
    });

    if (abortSignal) {
      const checkRequestAbortedWithLogging = functionLogger
        ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
        : checkRequestAborted;
      checkRequestAbortedWithLogging(abortSignal);
    }

    // FIX #3: Setup timeout for entire platform test flow
  const flowStartTime = Date.now();
  const flowTimeout = 60000; // 60 seconds
  const checkTimeout = (step?: string) => {
    const elapsed = Date.now() - flowStartTime;

    // ✅ IMPROVEMENT: Validate elapsed time (protect against system time changes)
    if (elapsed < 0) {
      logger.warn('[PLATFORM_TEST] Negative elapsed time detected (system time changed?)', {
        elapsed,
        flowStartTime,
        currentTime: Date.now(),
      });
      // Don't throw, just log - system time change is rare and shouldn't break flow
      return;
    }

    if (elapsed > flowTimeout) {
      const elapsedSeconds = Math.round(elapsed / 1000);
      const timeoutMessage = `Platform test flow timeout after ${flowTimeout / 1000}s (elapsed: ${elapsedSeconds}s)${step ? ` at step: ${step}` : ''}`;

      logger.error('[PLATFORM_TEST] Flow timeout exceeded', {
        timeout: flowTimeout,
        elapsed,
        elapsedSeconds,
        step: step || 'unknown',
        userId,
        chatSessionId,
      });

      throw new Error(timeoutMessage);
    }
  };

  // Track Redis lock state for cleanup in error handler
  let lockAcquired = false;

  try {
    logger.info('[PLATFORM_TEST] Starting UI test flow', {
      userId,
      workspace_id,
      chatSessionId,
      conversationId,
      scope: parsedIntent?.scope,
      target: parsedIntent?.target,
      hasUrl: !!parsedIntent?.page,
      hasAnswers: !!answers,
      messageLength: message?.length || 0,
      timeout: flowTimeout,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 0: EARLY CREDIT CHECK (before any processing)
    // ═══════════════════════════════════════════════════════════════════════
    // Soft credit check — verify user has at least 1 credit to start
    // Actual credits are deducted per-step during execution
    const effectiveMode = mode || 'lite';
    const baseCreditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');

    if (baseCreditCheck.available < 1) {
      logger.warn('[PLATFORM_TEST] Insufficient credits (soft check)', {
        userId,
        available: baseCreditCheck.available,
      });

      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        message: `❌ Insufficient credits. You need at least 1 credit to start a test, but you have ${baseCreditCheck.available}. Credits are deducted per step during execution.`,
        creditsRequired: 1,
        creditsAvailable: baseCreditCheck.available,
        shortage: 1 - baseCreditCheck.available,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ✅ GUARD: Only 1 active test per chat session - REJECT if one already exists
    // This prevents duplicate tests from rapid clicks or concurrent requests
    // Uses Redis lock to prevent race conditions between concurrent requests
    if (chatSessionId) {
      // Step 1: Acquire distributed lock to prevent race conditions
      lockAcquired = await acquireChatTestLock(chatSessionId);
      if (!lockAcquired) {
        logger.warn('[PLATFORM_TEST] Rejected: concurrent request already in progress', {
          chatSessionId,
          userId,
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
          logger.warn('[PLATFORM_TEST] Rejected: chat session already has an active test', {
            chatSessionId,
            userId,
            existingTestId: existingTest.id,
            existingTestStatus: existingTest.status,
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
        logger.warn('[PLATFORM_TEST] Failed to check for active tests in chat session', {
          error: guardError instanceof Error ? guardError.message : String(guardError),
          chatSessionId,
          userId,
        });
        // Don't release lock here - continue with test creation
      }
    }

    // FIX #4: Better progress updates
    const emitProcessingStepWithLogging = functionLogger
      ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
      : emitProcessingStep;
    emitProcessingStepWithLogging(chatSessionId, 'checking_autonomous', 'Analyzing your request...', 30);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: LOAD CHAT SESSION CONTEXT (FIX #1: Error handling)
    // ═══════════════════════════════════════════════════════════════════════

    let sessionProject: { id: string; name: string; settings?: { main_url?: string } } | null = null;
    if (chatSessionId) {
      try {
        const getSessionWithProjectWithLogging = functionLogger
          ? withFunctionLogging(ChatService.getSessionWithProject.bind(ChatService), 'ChatService.getSessionWithProject', functionLogger)
          : ChatService.getSessionWithProject.bind(ChatService);
        const sessionData = await getSessionWithProjectWithLogging(chatSessionId, userId); // SECURITY: Pass userId for verification

        // Explicitly handle null/undefined cases for consistency
        if (sessionData?.project) {
          sessionProject = sessionData.project;

          if (sessionProject.settings?.main_url) {
            logger.info('[PLATFORM_TEST] Found project in session', {
              projectId: sessionProject.id,
              projectName: sessionProject.name,
              projectUrl: sessionProject.settings.main_url,
            });
          } else {
            logger.debug('[PLATFORM_TEST] Project in session but no main_url', {
              projectId: sessionProject.id,
              projectName: sessionProject.name,
            });
          }
        } else {
          logger.debug('[PLATFORM_TEST] No project in session yet', {
            sessionId: chatSessionId,
            hasSessionData: !!sessionData,
          });
        }
      } catch (error) {
        logger.warn('[PLATFORM_TEST] Failed to get session project', {
          error: error instanceof Error ? error.message : String(error),
          chatSessionId,
        });
        // Continue without session project (graceful degradation)
        sessionProject = null;
      }
    }

    checkTimeout('load_session_context');

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: PROCESS ANSWERS (if user provided them)
    // ═══════════════════════════════════════════════════════════════════════


    let parsedAnswers: {
      url?: string;
      scope?: string;
      needsAuth?: boolean;
      credentials?: { email?: string; username?: string; password: string };
      additionalInfo?: Record<string, any>;
    } | null = null;

    // Parse user answers if they were provided
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      logger.info('[PLATFORM_TEST] Processing user answers', {
        answerKeys: Object.keys(answers),
        hasCredentials: !!answers.credentials,
        hasUrl: !!answers.url,
      });

      try {
        const parseAnswersWithLogging = functionLogger
          ? withFunctionLogging(parseAnswers, 'parseAnswers', functionLogger)
          : parseAnswers;
        const parsed = parseAnswersWithLogging(answers);

        // Only set parsedAnswers if we got meaningful data (not empty object)
        // This helps distinguish between "no answers" (null) and "empty answers" (empty object)
        const hasData = parsed.url || parsed.scope || parsed.credentials || parsed.needsAuth !== undefined;
        parsedAnswers = hasData ? parsed : null;

        logger.info('[PLATFORM_TEST] Parsed answers successfully', {
          hasUrl: !!parsedAnswers?.url,
          hasScope: !!parsedAnswers?.scope,
          needsAuth: parsedAnswers?.needsAuth,
          hasCredentials: !!parsedAnswers?.credentials,
          hasData,
        });
      } catch (parseError) {
        logger.error('[PLATFORM_TEST] Failed to parse answers', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          answers: JSON.stringify(answers).substring(0, 100),
        });
        // Continue without parsed answers (will re-ask if needed)
        parsedAnswers = null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: VALIDATE URL + SCOPE (FIX #5: Safe URL extraction)
    // ═══════════════════════════════════════════════════════════════════════

    // FIX #5: Safe URL extraction with priority: answers > parsedIntent > session
    const rawUrl =
      parsedAnswers?.url ||
      parsedIntent?.page ||
      sessionProject?.settings?.main_url ||
      null;

    // Normalize URL: add https:// if protocol is missing
    const normalizeUrlWithLogging = functionLogger
      ? withFunctionLogging(normalizeUrl, 'normalizeUrl', functionLogger)
      : normalizeUrl;
    const extractedUrl = rawUrl ? normalizeUrlWithLogging(rawUrl) : null;

    const hasUrl = !!extractedUrl;
    const hasScope = !!(parsedAnswers?.scope || parsedIntent?.scope);

    logger.info('[PLATFORM_TEST] Validation check', {
      hasUrl,
      hasScope,
      extractedUrl: extractedUrl || 'none',
      scope: parsedAnswers?.scope || parsedIntent?.scope || 'none',
      fromAnswers: !!parsedAnswers,
    });

    // If missing info, ask questions
    if (!hasUrl || !hasScope) {
      logger.info('[PLATFORM_TEST] Missing required information', { hasUrl, hasScope });

      // ✅ OPTIMIZATION: Load user projects only when needed (for showing project options)
      let userProjects: any[] = [];
      try {
        const { data, error } = await supabaseAdmin
          .from('projects')
          .select('id, name, settings')
          .eq('user_id', userId)
          .eq('workspace_id', workspace_id)
          .order('created_at', { ascending: false })
          .limit(10);

        if (error) {
          logger.error('[PLATFORM_TEST] Failed to load user projects', { error });
        } else {
          userProjects = data || [];
        }

        logger.info('[PLATFORM_TEST] Loaded user projects', {
          projectCount: userProjects.length,
        });
      } catch (error) {
        logger.warn('[PLATFORM_TEST] Error loading projects, continuing without them', {
          error: error instanceof Error ? error.message : String(error),
        });
        userProjects = [];
      }

      try {
        const requestMissingInformationWithLogging = functionLogger
          ? withFunctionLogging(requestMissingInformation, 'requestMissingInformation', functionLogger)
          : requestMissingInformation;
        const result = await requestMissingInformationWithLogging(message, {
          hasUrl,
          hasScope,
          intent: 'platform_test',
          userProjects,
        });

        // Save to history (non-blocking)
        if (chatSessionId) {
          // ✅ IMPROVEMENT: Include questions in content so AI can see them in history
          const questionsText = result.questions
            .map((q: any, idx: number) => `${idx + 1}. ${q.question || q.id}`)
            .join('\n');

          const fullContent = `📝 I need some more information to set up the test:\n\n${questionsText}`;

          const saveChatMessagesWithLogging = functionLogger
            ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
            : ChatService.saveChatMessages.bind(ChatService);
          saveChatMessagesWithLogging(chatSessionId, [
            { role: 'user', content: message },
            {
              role: 'ai',
              content: fullContent,
              metadata: {
                questions: result.questions,
                conversationId: result.conversationId,
                requiresAnswers: true,
              },
            },
          ]).catch(saveError => {
            logger.error('[PLATFORM_TEST] Failed to save messages', {
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          });
        }

        if (lockAcquired && chatSessionId) {
          await releaseChatTestLock(chatSessionId);
          lockAcquired = false;
        }

        res.json({
          reply: '📝 I need some more information to set up the test:',
          questions: result.questions,
          conversationId: result.conversationId,
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
        return;
      } catch (error) {
        logger.error('[PLATFORM_TEST] requestMissingInformation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error('Failed to generate questions');
      }
    }

    checkTimeout('process_answers');

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: FIND OR CREATE PROJECT (FIX #1: Error handling)
    // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStepWithLogging(chatSessionId, 'checking_autonomous', 'Setting up project...', 40);

    let project_id: string;
    try {
      const findOrCreateProjectWithLogging = functionLogger
        ? withFunctionLogging(ProjectContextService.findOrCreateProject.bind(ProjectContextService), 'ProjectContextService.findOrCreateProject', functionLogger)
        : ProjectContextService.findOrCreateProject.bind(ProjectContextService);
      const projectResult = await findOrCreateProjectWithLogging(
        workspace_id,
        extractedUrl,
        userId
      );
      project_id = projectResult.project_id;

      if (projectResult.is_new) {
        logger.info('[PLATFORM_TEST] Created new project', { project_id, url: extractedUrl });
      }

      // Update session with project (non-blocking)
      if (chatSessionId) {
        const updateSessionProjectWithLogging = functionLogger
          ? withFunctionLogging(ChatService.updateSessionProject.bind(ChatService), 'ChatService.updateSessionProject', functionLogger)
          : ChatService.updateSessionProject.bind(ChatService);
        updateSessionProjectWithLogging(chatSessionId, project_id, userId).catch(updateError => {
          logger.warn('[PLATFORM_TEST] Failed to update session project', {
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });
      }
    } catch (error) {
      logger.error('[PLATFORM_TEST] ProjectContextService failed', {
        error: error instanceof Error ? error.message : String(error),
        url: extractedUrl,
      });
      throw new Error(`Failed to initialize project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    checkTimeout('find_or_create_project');

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: HANDLE CREDENTIALS (from message text, answers, OR saved in DB)
    // Priority: message text > answers > saved in DB
    // ═══════════════════════════════════════════════════════════════════════

    let finalCredentials: any = null;

    // Priority 0: Credentials extracted by GPT during intent parsing (highest priority)
    // GPT handles any language: English, Russian, Kazakh, etc.
    if (parsedIntent?.credentials) {
      const { login, loginType, password } = parsedIntent.credentials;
      logger.info('[PLATFORM_TEST] Using GPT-extracted credentials from intent parsing', {
        loginType,
        hasLogin: !!login,
        hasPassword: !!password,
        // SECURITY: Never log actual credential values
      });
      finalCredentials = {
        email: loginType === 'email' ? login : undefined,
        phone: loginType === 'phone' ? login : undefined,
        // For id/other/custom identifier types we keep `username` as a safe fallback
        // because downstream auto-fill logic already handles username/email/phone fields.
        username: (loginType === 'username' || loginType === 'id' || loginType === 'other') ? login : undefined,
        identifier: login,
        identifierType: loginType,
        password,
      };
    }

    // Priority 1: Credentials from user answers (if not found in message)
    if (!finalCredentials && parsedAnswers?.credentials) {
      // ✅ IMPROVEMENT: Validate credentials structure before use
      const creds = parsedAnswers.credentials;
      const hasIdentifier = (creds.email && typeof creds.email === 'string' && creds.email.trim().length > 0) ||
                           (creds.username && typeof creds.username === 'string' && creds.username.trim().length > 0);
      const hasPassword = creds.password && typeof creds.password === 'string' && creds.password.trim().length > 0;

      if (hasIdentifier && hasPassword) {
        logger.info('[PLATFORM_TEST] Using credentials from user answers');
        finalCredentials = parsedAnswers.credentials;
      } else {
        logger.warn('[PLATFORM_TEST] Invalid credentials structure in parsedAnswers, will try DB', {
          hasEmail: !!creds.email,
          hasUsername: !!creds.username,
          hasPassword: !!creds.password,
        });
        // Fall through to Priority 2 (DB lookup)
      }
    }

    // Priority 2: Saved credentials from DB (if not found in message or answers)
    if (!finalCredentials) {
      try {
        emitProcessingStepWithLogging(chatSessionId, 'validating_credentials', 'Checking credentials...', 45);

        const getProjectCredentialsWithLogging = functionLogger
          ? withFunctionLogging(ProjectContextService.getProjectCredentials.bind(ProjectContextService), 'ProjectContextService.getProjectCredentials', functionLogger)
          : ProjectContextService.getProjectCredentials.bind(ProjectContextService);
        const savedCredentials = await getProjectCredentialsWithLogging(project_id, userId);

        if (savedCredentials) {
          logger.info('[PLATFORM_TEST] Found saved credentials in DB', { project_id });
          finalCredentials = savedCredentials;
        } else {
          logger.debug('[PLATFORM_TEST] No saved credentials found in DB', { project_id });
        }
      } catch (error) {
        logger.warn('[PLATFORM_TEST] Failed to get saved credentials', {
          error: error instanceof Error ? error.message : String(error),
        });
        finalCredentials = null;
      }
    }

    // Determine if authentication is needed
    const needsAuth = parsedAnswers?.needsAuth ?? !!finalCredentials;

    checkTimeout('handle_credentials');

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY SELECTION: standard (single-goal run) vs exploration (BFS discovery)
    // ═══════════════════════════════════════════════════════════════════════

    // Check if request was cancelled before starting test
    if (abortSignal) {
      const checkRequestAbortedWithLogging = functionLogger
        ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
        : checkRequestAborted;
      checkRequestAbortedWithLogging(abortSignal);
    }

    const executionStrategy = parsedIntent?.executionStrategy || 'standard';

    // ═══════════════════════════════════════════════════════════════════════
    // EXPLORATION BRANCH — autonomous BFS discovery + multi-flow execution
    // Requires explicit user confirmation before starting (expensive operation)
    // ═══════════════════════════════════════════════════════════════════════
    if (executionStrategy === 'exploration') {
      // Store pending exploration in Redis for confirmation flow
      const pendingKey = `pending_exploration:${chatSessionId || userId}`;
      const pendingData = JSON.stringify({
        entryUrl: extractedUrl.trim(),
        projectId: project_id,
        userId,
        chatSessionId,
        workspaceId: workspace_id,
        scopeHint: parsedIntent?.target || parsedIntent?.scope || undefined,
        credentials: finalCredentials || undefined,
      });
      await redisConnection.set(pendingKey, pendingData, 'EX', 600); // 10 min TTL

      const confirmationMessage =
        `**Site Exploration** — **${extractedUrl}**\n\n` +
        `This will autonomously explore the entire site, discover all pages, and generate test cases for every flow found.\n\n` +
        `**Please note:**\n` +
        `- Uses **significantly more credits** than a single test (5-20x depending on site size)\n` +
        `- Takes **10-15 minutes** to complete\n` +
        `- Explores up to 10 pages and 20 flows\n\n` +
        `Do you want to proceed? Reply **yes** to start or **no** to cancel.`;

      // Save messages
      if (chatSessionId) {
        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
            content: confirmationMessage,
            metadata: { mode: 'exploration_confirmation', url: extractedUrl },
          },
        ]).catch(() => {});
      }

      // Release lock
      if (lockAcquired && chatSessionId) {
        await releaseChatTestLock(chatSessionId);
        lockAcquired = false;
      }

      res.json({
        success: true,
        reply: confirmationMessage,
        mode: 'exploration_confirmation',
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STANDARD BRANCH — single-goal immediate lite run
    // ═══════════════════════════════════════════════════════════════════════

    logger.info('[PLATFORM_TEST] Running test immediately (standard mode)', {
        url: extractedUrl,
        userId,
        project_id,
        hasCredentials: !!finalCredentials,
      });

      emitProcessingStepWithLogging(chatSessionId, 'executing_test', 'Starting test...', 50);

      // Check cancellation before creating test request
      if (abortSignal) {
        const checkRequestAbortedWithLogging = functionLogger
          ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
          : checkRequestAborted;
        checkRequestAbortedWithLogging(abortSignal);
      }

      // Step L1: Build test goal from message + parsedIntent
      const finalScope = parsedAnswers?.scope || parsedIntent.scope || 'general';
      const testGoal = parsedIntent.target
        ? `${parsedIntent.target} on ${extractedUrl} (${finalScope})`
        : `Test ${finalScope} functionality on ${extractedUrl}`;

      // Step L2: Create test request
      const resolvedContext = parsedIntent?.resolvedContext;
      const testRequest = {
        url: extractedUrl.trim(),
        browsers: ['chrome' as const],
        projectId: project_id,
        userId,
        options: finalCredentials ? { credentials: finalCredentials } : {},
        commands: [], // Lite mode: no pre-defined commands, AI generates dynamically
        intent: finalScope,
        intelligentMode: true, // Always intelligent for Lite
        testGoal,
        mode: 'lite' as const,
        chatSessionId, // Pass chat session ID for WebSocket routing isolation
        prefilledSteps: resolvedContext?.prefilledSteps, // Smart Resolver: prefilled steps for fast replay
      };

      emitProcessingStepWithLogging(chatSessionId, 'executing_test', 'Launching browser...', 60);

      // Check cancellation before creating test
      if (abortSignal) {
        const checkRequestAbortedWithLogging = functionLogger
          ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
          : checkRequestAborted;
        checkRequestAbortedWithLogging(abortSignal);
      }

      // Step L3: Run test immediately
      let testCreated: any;
      let actualTestId: string | null = null;

      try {
        testCreated = await ManualTestService.runTest(testRequest);

        if (!testCreated?.success || !testCreated.data?.id) {
          throw new Error(testCreated?.message || 'Failed to create test');
        }

        actualTestId = testCreated.data.id;

        logger.info('[PLATFORM_TEST] Lite mode: test created', {
          testId: actualTestId,
          url: extractedUrl,
        });

      } catch (testError) {
        logger.error('[PLATFORM_TEST] Lite mode: test creation failed', {
          error: testError instanceof Error ? testError.message : String(testError),
          url: extractedUrl,
        });
        throw new Error(`Failed to start test: ${testError instanceof Error ? testError.message : 'Unknown error'}`);
      }

      // Step L4: Deduct credits AFTER successful test creation
      // ✅ FIX: If we reused an existing active test, do NOT deduct credits again.
      const reusedExistingTest = testCreated?.message === 'ACTIVE_TEST_REUSED';

      // Step L3b: Create analytics records (regression_run + test_execution)
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
            logger.warn('[PLATFORM_TEST] Failed to create analytics regression_run', {
              error: runInsertError?.message,
              testId: actualTestId,
            });
          } else {
            // Create a test_execution linked to the run so step-level analytics work
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
              logger.warn('[PLATFORM_TEST] Failed to create analytics test_execution', {
                error: execInsertError.message,
                runId: analyticsRun.id,
                testId: actualTestId,
              });
            } else {
              logger.info('[PLATFORM_TEST] Analytics records created for Lite test', {
                runId: analyticsRun.id,
                testId: actualTestId,
              });
            }
          }
        } catch (analyticsError) {
          // Analytics tracking is non-critical — never block test execution
          logger.warn('[PLATFORM_TEST] Analytics tracking failed (non-critical)', {
            error: analyticsError instanceof Error ? analyticsError.message : String(analyticsError),
            testId: actualTestId,
          });
        }
      }
      // Credits are now deducted per-step during execution — no upfront deduction needed
      if (reusedExistingTest) {
        logger.info('[PLATFORM_TEST] Reused existing active test', {
          testId: actualTestId,
          url: extractedUrl,
          userId,
        });
      }

      // ✅ FIX: Save test-chat mapping SYNCHRONOUSLY (awaited)
      // This is critical for the "1 active test per chat" guard to work reliably
      if (chatSessionId && actualTestId) {
        let mappingSaved = false;
        try {
          const resolverMatchType: ResolverMatchType = parsedIntent?.resolvedContext ? 'partial' : 'none';
          await TestChatMappingService.saveTestChatMapping({
            testId: actualTestId,
            chatSessionId,
            userId,
            metadata: { resolverMatchType, trigger: 'chat' },
          });
          mappingSaved = true;
          logger.debug('[PLATFORM_TEST] Test-chat mapping saved', {
            testId: actualTestId,
            chatSessionId,
          });
        } catch (mappingError) {
          // Log error but don't fail the flow - test is already created
          logger.error('[PLATFORM_TEST] Failed to save test-chat mapping', {
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

      // Step L6: Emit WebSocket event
      if (chatSessionId && actualTestId) {
        try {
          const payload: ChatTestUpdatePayload = {
            sessionId: chatSessionId,
            testId: actualTestId,
            status: 'started',
            message: 'Lite test started',
            timestamp: new Date().toISOString(),
          };
          webSocketService.emitChatTestUpdate(chatSessionId, payload);
        } catch {
          // Ignore WS errors
        }
      }

      emitProcessingStepWithLogging(chatSessionId, 'executing_test', 'Test is running!', 100);

      // Step L7: Save to chat history (non-blocking)
      const replyMessage = `🚀 **Test Started in Lite Mode!**\n\n` +
        `I'm testing **${extractedUrl}** right now.\n\n` +
        `**Goal:** ${testGoal}\n\n` +
        `Watch the progress below. I'll navigate dynamically and report any issues I find.\n\n` +
        `📊 Test ID: \`${actualTestId}\``;

      if (chatSessionId) {
        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
            content: replyMessage,
            metadata: {
              testId: actualTestId,
              mode: 'lite',
              testGoal,
              url: extractedUrl,
            },
          },
        ]).catch(() => {});
      }

      // Step L8: Return response
      res.json({
        success: true,
        reply: replyMessage,
        testId: actualTestId,
        mode: 'lite',
        testStarted: true,
        requiresApproval: false, // Key difference from Pro: no approval needed
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });

      logger.info('[PLATFORM_TEST] Test started successfully', {
        testId: actualTestId,
        duration: Date.now() - flowStartTime,
      });

  } catch (error) {
    // ✅ Release Redis lock on error to prevent stuck locks
    if (lockAcquired && chatSessionId) {
      await releaseChatTestLock(chatSessionId);
    }

    // Check if response already sent
    if (res.headersSent) {
      logger.warn('[PLATFORM_TEST] Response already sent, cannot send error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    logger.error('[PLATFORM_TEST] Error in platform test flow', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: Date.now() - flowStartTime,
    });

    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'Failed to process platform test');

    // Check for timeout
    const isTimeout = errorMessage.includes('timeout');

    // Save error to history (non-blocking)
    if (chatSessionId) {
      const saveChatMessagesWithLogging = functionLogger
        ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
        : ChatService.saveChatMessages.bind(ChatService);
      saveChatMessagesWithLogging(chatSessionId, [
        { role: 'user', content: message },
        { role: 'ai', content: `❌ Error: ${errorMessage}` },
      ]).catch(saveError => {
        logger.error('[PLATFORM_TEST] Failed to save error message', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
      });
    }

    res.status(isTimeout ? 408 : 500).json({
      success: false,
      error: isTimeout ? 'Request timeout' : 'Failed to process platform test',
      message: errorMessage,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  } finally {
    // End AI usage tracking session
    const usageStats = await AIUsageTracker.endSession(sessionId);
    if (usageStats) {
      logger.info('[PLATFORM_TEST] AI usage stats', {
        sessionId,
        workspaceId: workspace_id,
        ...usageStats,
      });
    }
  }
};

// Execute platform test within AI tracking context
return withAIContext(
  { workspaceId: workspace_id, userId, operationType: 'test-plan' },
  executePlatformTest
);
}
