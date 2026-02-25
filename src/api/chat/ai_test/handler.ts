import { redisConnection } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ResolverMatchType } from '@/types/testing.types';
import { NavigationRequiresClarificationError } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { requestMissingInformation, runAutonomousExploration } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
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

// ═══════════════════════════════════════════════════════════════════════════
// CREDENTIAL EXTRACTION FROM USER MESSAGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a string looks like a phone number
 * Improved detection with stricter rules to avoid false-positives
 *
 * Rules:
 * - If starts with +: must have 7-15 digits (international format)
 * - If starts with 8 (KZ/RU): must have 10-11 digits total
 * - If only digits: must have 10-15 digits AND contain formatting (spaces/dashes/parentheses)
 *   OR be exactly 11 digits (common phone length)
 * - Must NOT contain letters (except + at start)
 */
function looksLikePhone(value: string): boolean {
  if (!value || typeof value !== 'string') return false;

  // Remove formatting characters but keep + for international format
  const digitsOnly = value.replace(/[\s\-().]/g, '');
  const digitCount = (digitsOnly.match(/\d/g) || []).length;

  // Check for letters - if present, it's not a phone
  if (/[a-zA-Zа-яёА-ЯЁ]/.test(value)) return false;

  // International format: + followed by 7-15 digits
  if (value.startsWith('+')) {
    return digitCount >= 7 && digitCount <= 15;
  }

  // KZ/RU format: starts with 8, then 10 digits (8XXXXXXXXXX = 11 total)
  if (value.startsWith('8') && /^8[\d\s\-()]+$/.test(value)) {
    return digitCount >= 10 && digitCount <= 11;
  }

  // Other formats: must have formatting OR be exactly 11 digits
  // This prevents pure numeric usernames like "1234567890" from being detected as phone
  const hasFormatting = /[\s\-().]/.test(value);
  const isExactly11Digits = digitCount === 11 && /^\d+$/.test(value.replace(/[\s\-().]/g, ''));

  if (hasFormatting) {
    // Has formatting (spaces, dashes, parentheses) - likely a phone
    return digitCount >= 10 && digitCount <= 15;
  }

  // No formatting: only accept if exactly 11 digits (common phone length)
  // This is a compromise - 10-digit numbers without formatting are ambiguous
  return isExactly11Digits;
}

/**
 * Classify a login value as email, phone, or username
 * Priority: email > phone > username
 */
function classifyLoginValue(value: string): 'email' | 'phone' | 'username' {
  if (!value || typeof value !== 'string') return 'username';

  // Email check (highest priority)
  if (value.includes('@')) return 'email';

  // Phone check
  if (looksLikePhone(value)) return 'phone';

  // Default to username
  return 'username';
}

/**
 * Extract credentials from user message text
 * Supports patterns like:
 * - with "email@test.com" login and "password123" password
 * - with "+77011234567" phone and "password123" password
 * - email: "test@example.com", password: "mypass"
 * - phone: "+77011234567", password: "mypass"
 * - login "user@mail.com" password "secret"
 *
 * SECURITY: Never log the actual password/phone value
 *
 * @param message - User message text
 * @returns Extracted credentials or null if not found
 */
function extractCredentialsFromMessage(message: string): { email?: string; username?: string; phone?: string; password: string } | null {
  if (!message || typeof message !== 'string') {
    return null;
  }

  // Pattern 1: with "value" (login|email|username|phone) and "password" password
  const pattern1 = /(?:with\s+)?["']([^"']+)["']\s+(?:login|email|username|phone|tel|телефон)\s+(?:and\s+)?["']([^"']+)["']\s+(?:password|pass)/i;
  const match1 = message.match(pattern1);
  if (match1) {
    const [, loginValue, passwordValue] = match1;
    const type = classifyLoginValue(loginValue);
    return {
      email: type === 'email' ? loginValue : undefined,
      phone: type === 'phone' ? loginValue : undefined,
      username: type === 'username' ? loginValue : undefined,
      password: passwordValue,
    };
  }

  // Pattern 2: key: "value" format (email/login/username/phone: "value", password: "value")
  const emailPattern = /(?:email|login|username)\s*[:=]\s*["']([^"']+)["']/i;
  const phonePattern = /(?:phone|tel|mobile|телефон|номер)\s*[:=]\s*["']([^"']+)["']/i;
  const passwordPattern = /(?:password|pass)\s*[:=]\s*["']([^"']+)["']/i;

  const emailMatch = message.match(emailPattern);
  const phoneMatch = message.match(phonePattern);
  const passwordMatch = message.match(passwordPattern);

  if (passwordMatch && (emailMatch || phoneMatch)) {
    const passwordValue = passwordMatch[1];
    const result: { email?: string; username?: string; phone?: string; password: string } = { password: passwordValue };

    if (phoneMatch) {
      result.phone = phoneMatch[1];
    }

    if (emailMatch) {
      const loginValue = emailMatch[1];
      const type = classifyLoginValue(loginValue);
      if (type === 'email') result.email = loginValue;
      else if (type === 'phone' && !result.phone) result.phone = loginValue;
      else result.username = loginValue;
    }

    return result;
  }

  // Pattern 3: (login|email|username|phone) "user" password "pass" (simple quoted pairs)
  const pattern3 = /(?:login|email|username|phone|tel)\s+["']([^"']+)["']\s+(?:password|pass)\s+["']([^"']+)["']/i;
  const match3 = message.match(pattern3);
  if (match3) {
    const [, loginValue, passwordValue] = match3;
    const type = classifyLoginValue(loginValue);
    return {
      email: type === 'email' ? loginValue : undefined,
      phone: type === 'phone' ? loginValue : undefined,
      username: type === 'username' ? loginValue : undefined,
      password: passwordValue,
    };
  }

  // Pattern 4: Reverse order - password first: password "pass" (login|phone) "user"
  const pattern4 = /(?:password|pass)\s+["']([^"']+)["']\s+(?:login|email|username|phone|tel)\s+["']([^"']+)["']/i;
  const match4 = message.match(pattern4);
  if (match4) {
    const [, passwordValue, loginValue] = match4;
    const type = classifyLoginValue(loginValue);
    return {
      email: type === 'email' ? loginValue : undefined,
      phone: type === 'phone' ? loginValue : undefined,
      username: type === 'username' ? loginValue : undefined,
      password: passwordValue,
    };
  }

  // Pattern 5: Unquoted key: value pairs (login: user@mail.com, password: 123)
  // Handles: (login: kasper_admin@juz40.kz, password: 123qwe123)
  // Handles: email: test@mail.com password: secret
  // Runs LAST — quoted patterns (1-4) have priority to avoid false positives
  const unquotedEmailPattern = /(?:email|login|username)\s*[:=]\s*([^\s,)"']+)/i;
  const unquotedPhonePattern = /(?:phone|tel|mobile|телефон|номер)\s*[:=]\s*([^\s,)"']+)/i;
  const unquotedPasswordPattern = /(?:password|pass|пароль)\s*[:=]\s*([^\s,)"']+)/i;

  const uqEmailMatch = message.match(unquotedEmailPattern);
  const uqPhoneMatch = message.match(unquotedPhonePattern);
  const uqPasswordMatch = message.match(unquotedPasswordPattern);

  if (uqPasswordMatch && (uqEmailMatch || uqPhoneMatch)) {
    // Strip trailing punctuation that isn't part of credentials (e.g., period at end of sentence)
    const stripTrailing = (v: string) => v.replace(/[.!?;:]+$/, '');
    const passwordValue = stripTrailing(uqPasswordMatch[1]);
    const result: { email?: string; username?: string; phone?: string; password: string } = { password: passwordValue };

    if (uqPhoneMatch) {
      result.phone = stripTrailing(uqPhoneMatch[1]);
    }

    if (uqEmailMatch) {
      const loginValue = stripTrailing(uqEmailMatch[1]);
      const type = classifyLoginValue(loginValue);
      if (type === 'email') result.email = loginValue;
      else if (type === 'phone' && !result.phone) result.phone = loginValue;
      else result.username = loginValue;
    }

    return result;
  }

  return null;
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
 * NEW FLOW (CORRECT):
 * 1. Validate URL + scope
 * 2. Create/find project
 * 3. GENERATE TEST PLAN (not run immediately!)
 * 4. Save test plan to DB
 * 5. Show to user for APPROVAL
 * 6. User approves → handlePendingTestPlanApproval → executeUiTestFlow
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

    // Priority 0: Credentials from user message text (highest priority)
    // Handles patterns like: with "email@test.com" login and "password123" password
    const messageCredentials = extractCredentialsFromMessage(message);
    if (messageCredentials) {
      logger.info('[PLATFORM_TEST] Extracted credentials from message text', {
        hasEmail: !!messageCredentials.email,
        hasUsername: !!messageCredentials.username,
        hasPhone: !!messageCredentials.phone,
        // SECURITY: Never log actual password/phone values
      });
      finalCredentials = messageCredentials;
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
    // ✅ LITE MODE: SKIP EXPLORATION → RUN TEST IMMEDIATELY
    // Pro mode continues with exploration → plan confirmation flow
    // ═══════════════════════════════════════════════════════════════════════

    if (effectiveMode === 'lite') {
      // Check if request was cancelled before starting Lite test
      if (abortSignal) {
        const checkRequestAbortedWithLogging = functionLogger
          ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
          : checkRequestAborted;
        checkRequestAbortedWithLogging(abortSignal);
      }

      logger.info('[PLATFORM_TEST] Lite mode: running test immediately (no exploration)', {
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

      logger.info('[PLATFORM_TEST] Lite mode: test started successfully', {
        testId: actualTestId,
        duration: Date.now() - flowStartTime,
      });

      return; // Exit early - Lite mode complete
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ✅ PRO MODE (STEP 4): RUN AUTONOMOUS EXPLORATION + GENERATE REAL TEST PLAN
    // Replaces UiTestPlanService with real browser-based exploration
    // ═══════════════════════════════════════════════════════════════════════

    logger.info('[PLATFORM_TEST] Pro mode: running autonomous exploration', {
      url: extractedUrl,
      userId,
    });

    emitProcessingStepWithLogging(chatSessionId, 'generating_plan', 'Analyzing page with real browser...', 50);

    // Determine scope: from answers > from parsedIntent
    const finalScope = parsedAnswers?.scope || parsedIntent.scope;

    logger.info('[PLATFORM_TEST] Starting autonomous exploration', {
      url: extractedUrl,
      scope: finalScope,
      hasCredentials: !!finalCredentials,
      needsAuth,
      fromAnswers: !!parsedAnswers,
    });

    // ✅ Run autonomous exploration: Launch browser → Analyze real page → Generate accurate plan
    let testPlan, formattedPlan;

    try {
      const runAutonomousExplorationWithLogging = functionLogger
        ? withFunctionLogging(runAutonomousExploration, 'runAutonomousExploration', functionLogger)
        : runAutonomousExploration;
      const result = await runAutonomousExplorationWithLogging({
        userMessage: message,
        answers: {
          url: extractedUrl,
          scope: finalScope,
          target: parsedIntent.target,
          credentials: finalCredentials,
          needsAuth,
          additionalInfo: {
            projectName: sessionProject?.name,
            ...(parsedAnswers?.additionalInfo || {}),
          },
        },
        userId,
        projectId: project_id,
        sessionId: chatSessionId,
        mode: mode || 'lite', // Pass mode to exploration
      });

      // ✅ FIX: Validate that testPlan and message exist
      if (!result.testPlan) {
        logger.error('[PLATFORM_TEST] runAutonomousExploration returned without testPlan', {
          hasExploration: !!result.exploration,
          hasMessage: !!result.message,
        });
        throw new Error('Failed to generate test plan: testPlan is missing from exploration result');
      }

      if (!result.message || typeof result.message !== 'string') {
        logger.error('[PLATFORM_TEST] runAutonomousExploration returned without valid message', {
          hasTestPlan: !!result.testPlan,
          messageType: typeof result.message,
        });
        throw new Error('Failed to generate test plan: message is missing or invalid from exploration result');
      }

      testPlan = result.testPlan;
      formattedPlan = result.message;

    } catch (explorationError) {
      const errorMsg = explorationError instanceof Error ? explorationError.message : String(explorationError);

      // ✅ NEW: Check if error is about navigation requiring clarification
      if (explorationError instanceof NavigationRequiresClarificationError) {
        logger.info('[PLATFORM_TEST] Navigation requires clarification, asking user', {
          url: explorationError.currentUrl,
          goal: explorationError.attemptedGoal,
          reason: explorationError.reason,
        });

        const clarificationMsg = explorationError.reason === 'no_links_found'
          ? `🤔 I couldn't identify navigation links on ${explorationError.currentUrl}.\n\nI'll continue on the current page and try to find the registration flow. If you know the direct registration URL, you can share it to speed things up.`
          : `🤔 I tried to navigate to the target page but couldn't find it after 3 attempts.\n\nCould you provide the direct URL to the page you want to test?`;

        // Generate clarifying question for URL
        const clarifyingQuestion = {
          id: 'target_url',
          question: 'Please provide the direct URL to the page you want to test:',
          required: explorationError.reason !== 'no_links_found',
          type: 'url' as const,
          placeholder: 'example.com/register (or full URL)',
        };

        // Save to history
        if (chatSessionId) {
          const saveChatMessagesWithLogging = functionLogger
            ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
            : ChatService.saveChatMessages.bind(ChatService);
          saveChatMessagesWithLogging(chatSessionId, [
            { role: 'user', content: message },
            {
              role: 'ai',
              content: clarificationMsg,
              metadata: {
                questions: [clarifyingQuestion],
                conversationId: 'nav_clarification_' + Date.now(),
                requiresAnswers: true,
                navigationError: {
                  currentUrl: explorationError.currentUrl,
                  attemptedGoal: explorationError.attemptedGoal,
                  reason: explorationError.reason,
                },
              },
            },
          ]).catch(saveError => {
            logger.error('[PLATFORM_TEST] Failed to save navigation clarification', {
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          });
        }

        res.json({
          reply: clarificationMsg,
          questions: [clarifyingQuestion],
          conversationId: 'nav_clarification_' + Date.now(),
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
        return;
      }

      // ✅ FIX: Check if error is about missing credentials
      if (errorMsg.includes('Authentication required') || errorMsg.includes('credentials')) {
        logger.info('[PLATFORM_TEST] Auth required, asking for credentials', {
          url: extractedUrl,
          originalError: errorMsg,
        });

        // Re-ask with credentials question
        // Note: userProjects not needed here (only credentials question)
        try {
          const requestMissingInformationWithLogging = functionLogger
            ? withFunctionLogging(requestMissingInformation, 'requestMissingInformation', functionLogger)
            : requestMissingInformation;
          const result = await requestMissingInformationWithLogging(message, {
            hasUrl: true,
            hasScope: true,
            hasCredentials: false, // ← Force credentials question
            intent: 'platform_test',
            userProjects: [], // Not needed for credentials question
          });

          // Save to history
          if (chatSessionId) {
            // ✅ IMPROVEMENT: Include questions in content so AI can see them in history
            const questionsText = result.questions
              .map((q: any, idx: number) => `${idx + 1}. ${q.question || q.id}`)
              .join('\n');

            const fullContent = `🔐 This site requires authentication. Please provide your credentials:\n\n${questionsText}`;

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
              logger.error('[PLATFORM_TEST] Failed to save credential request', {
                error: saveError instanceof Error ? saveError.message : String(saveError),
              });
            });
          }

          res.json({
            reply: '🔐 This site requires authentication. Please provide your credentials:',
            questions: result.questions,
            conversationId: result.conversationId,
            timestamp: new Date().toISOString(),
            sessionId: chatSessionId,
          });
          return;

        } catch (reqError) {
          logger.error('[PLATFORM_TEST] Failed to request credentials', {
            error: reqError instanceof Error ? reqError.message : String(reqError),
          });
          // Fall through to generic error handler
        }
      }

      // Re-throw if not a credentials error
      throw explorationError;
    }

    // ✅ FIX: Validate testPlan structure before accessing properties
    if (!testPlan || typeof testPlan !== 'object') {
      logger.error('[PLATFORM_TEST] testPlan is invalid after assignment', {
        testPlanType: typeof testPlan,
        testPlanValue: testPlan,
      });
      throw new Error('Invalid test plan: testPlan is not a valid object');
    }

    logger.info('[PLATFORM_TEST] Autonomous exploration completed', {
      planId: testPlan.id,
      stepsCount: testPlan.steps?.length || 0,
      commandsCount: testPlan.commands?.length || 0,
      intelligentMode: testPlan.intelligentMode || false,
    });

    checkTimeout('autonomous_exploration');

    // ✅ FIX: Validate formattedPlan before using it
    if (!formattedPlan || typeof formattedPlan !== 'string') {
      logger.error('[PLATFORM_TEST] formattedPlan is invalid before saving to history', {
        formattedPlanType: typeof formattedPlan,
        formattedPlanValue: formattedPlan,
      });
      throw new Error('Invalid formatted plan: formattedPlan is missing or not a string');
    }

    // Save to history (non-blocking)
    if (chatSessionId) {
      const saveChatMessagesWithLogging = functionLogger
        ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
        : ChatService.saveChatMessages.bind(ChatService);
      saveChatMessagesWithLogging(chatSessionId, [
        { role: 'user', content: message },
        {
          role: 'ai',
          content: formattedPlan,
          metadata: {
            testPlan,
            requiresApproval: true,
          },
        },
      ]).catch(saveError => {
        logger.error('[PLATFORM_TEST] Failed to save messages', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
      });
    }

    // ✅ FIX: Check if connection is still alive before sending response
    if (req.aborted || req.socket?.destroyed) {
      logger.warn('[PLATFORM_TEST] Client connection closed, cannot send response', {
        planId: testPlan.id,
        duration: Date.now() - flowStartTime,
      });
      return;
    }

    // Send response with test plan
    res.json({
      success: true, // ← Frontend expects this!
      reply: formattedPlan,
      testPlan,
      conversationId: testPlan.id, // ← For tracking approval
      requiresApproval: true, // ← KEY! User must approve
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });

    logger.info('[PLATFORM_TEST] Test plan sent for user approval', {
      planId: testPlan.id,
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
