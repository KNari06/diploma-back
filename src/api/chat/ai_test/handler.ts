import { supabaseAdmin } from '@/db/supabase';
import { NavigationRequiresClarificationError } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { requestMissingInformation, runAutonomousExploration } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
import { ChatService } from '@/services/utils/chat.service';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { parseAnswers } from '@/services/utils/question-generator.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { checkRequestAborted } from '../shared/request-cancellation';
import { emitProcessingStep, normalizeUrl } from '../shared/utils';

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
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers, abortSignal } = params;

  if (abortSignal) checkRequestAborted(abortSignal);

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

    // FIX #4: Better progress updates
    emitProcessingStep(chatSessionId, 'checking_autonomous', '🤖 Analyzing your request...', 30);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 0: LOAD CHAT SESSION CONTEXT (FIX #1: Error handling)
    // ═══════════════════════════════════════════════════════════════════════

    let sessionProject: { id: string; name: string; settings?: { main_url?: string } } | null = null;
    if (chatSessionId) {
      try {
        const sessionData = await ChatService.getSessionWithProject(chatSessionId, userId); // SECURITY: Pass userId for verification

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
        const parsed = parseAnswers(answers);

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
    const extractedUrl = rawUrl ? normalizeUrl(rawUrl) : null;

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
        const result = await requestMissingInformation(message, {
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

          ChatService.saveChatMessages(chatSessionId, [
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

    emitProcessingStep(chatSessionId, 'checking_autonomous', '🔍 Setting up project...', 40);

    let project_id: string;
    try {
      const projectResult = await ProjectContextService.findOrCreateProject(
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
        ChatService.updateSessionProject(chatSessionId, project_id, userId).catch(updateError => {
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
    // STEP 3: HANDLE CREDENTIALS (from answers OR saved in DB)
    // ═══════════════════════════════════════════════════════════════════════

    let finalCredentials: any = null;

    // Priority 1: Credentials from user answers (fresh input)
    if (parsedAnswers?.credentials) {
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

    // Priority 2: Saved credentials from DB (if not found in answers or invalid)
    if (!finalCredentials) {
      try {
        emitProcessingStep(chatSessionId, 'validating_credentials', '🔍 Getting saved credentials...', 45);

        const savedCredentials = await ProjectContextService.getProjectCredentials(project_id, userId);

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
    // ✅ NEW STEP 4: RUN AUTONOMOUS EXPLORATION + GENERATE REAL TEST PLAN
    // Replaces UiTestPlanService with real browser-based exploration
    // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'generating_plan', '🔍 Analyzing page with real browser...', 50);

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
      const result = await runAutonomousExploration({
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
          ? `🤔 I couldn't find any navigation links on ${explorationError.currentUrl}.\n\nCould you provide the direct URL to the page you want to test?\n\nFor example:\n• Registration page: https://site.com/register\n• Login page: https://site.com/login\n• Specific feature: https://site.com/feature`
          : `🤔 I tried to navigate to the target page but couldn't find it after 3 attempts.\n\nCould you provide the direct URL to the page you want to test?`;

        // Generate clarifying question for URL
        const clarifyingQuestion = {
          id: 'target_url',
          question: 'Please provide the direct URL to the page you want to test:',
          required: true,
          type: 'url' as const,
          placeholder: 'https://example.com/specific-page',
          validation: {
            pattern: '^https?://.+',
            minLength: 10,
          },
        };

        // Save to history
        if (chatSessionId) {
          ChatService.saveChatMessages(chatSessionId, [
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
          const result = await requestMissingInformation(message, {
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

            ChatService.saveChatMessages(chatSessionId, [
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
      ChatService.saveChatMessages(chatSessionId, [
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
      ChatService.saveChatMessages(chatSessionId, [
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
  }
}
