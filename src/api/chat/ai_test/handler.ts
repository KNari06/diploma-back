import { Request, Response } from 'express';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { requestMissingInformation, runAutonomousExploration } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
import { ChatService } from '@/services/utils/chat.service';
import { emitProcessingStep } from '../shared/utils';
import { normalizeUrl } from '../shared/utils';

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
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers } = params;

  // FIX #3: Setup timeout for entire platform test flow
  const flowStartTime = Date.now();
  const flowTimeout = 60000; // 60 seconds
  const checkTimeout = () => {
    if (Date.now() - flowStartTime > flowTimeout) {
      throw new Error(`Platform test flow timeout after ${flowTimeout / 1000}s`);
    }
  };

  try {
    logger.info('[PLATFORM_TEST] Starting UI test flow', {
      scope: parsedIntent?.scope,
      target: parsedIntent?.target,
      hasUrl: !!parsedIntent?.page,
      hasAnswers: !!answers,
      timeout: flowTimeout,
    });

    // FIX #4: Better progress updates
    emitProcessingStep(chatSessionId, 'checking_autonomous', '🤖 Analyzing your request...', 30);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 0: LOAD CHAT SESSION CONTEXT (FIX #1: Error handling)
    // ═══════════════════════════════════════════════════════════════════════

    let sessionProject = null;
    if (chatSessionId) {
      try {
        const sessionData = await ChatService.getSessionWithProject(chatSessionId, userId); // SECURITY: Pass userId for verification
        sessionProject = sessionData?.project;

        if (sessionProject?.settings?.main_url) {
          logger.info('[PLATFORM_TEST] Found project in session', {
            projectId: sessionProject.id,
            projectName: sessionProject.name,
            projectUrl: sessionProject.settings.main_url,
          });
        } else {
          logger.debug('[PLATFORM_TEST] No project in session yet');
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

    checkTimeout();

    // Load user projects (FIX #1: Error handling)
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

    checkTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: PROCESS ANSWERS (if user provided them)
    // ═══════════════════════════════════════════════════════════════════════

    let parsedAnswers: any = null;

    // ✅ FIX: Parse user answers if they were provided
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      logger.info('[PLATFORM_TEST] Processing user answers', {
        answerKeys: Object.keys(answers),
        hasCredentials: !!answers.credentials,
        hasUrl: !!answers.url,
      });

      try {
        // Import parseAnswers from question-generator
        const { parseAnswers } = await import('@/services/utils/question-generator.service');
        parsedAnswers = parseAnswers(answers);

        logger.info('[PLATFORM_TEST] Parsed answers successfully', {
          hasUrl: !!parsedAnswers.url,
          hasScope: !!parsedAnswers.scope,
          needsAuth: parsedAnswers.needsAuth,
          hasCredentials: !!parsedAnswers.credentials,
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

      try {
        const result = await requestMissingInformation(message, {
          hasUrl,
          hasScope,
          intent: 'platform_test',
          userProjects,
        });

        // Save to history (non-blocking)
        if (chatSessionId) {
          ChatService.saveChatMessages(chatSessionId, [
            { role: 'user', content: message },
            {
              role: 'ai',
              content: '📝 I need some more information to set up the test:',
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

    checkTimeout();

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

    checkTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: HANDLE CREDENTIALS (from answers OR saved in DB)
    // ═══════════════════════════════════════════════════════════════════════

    let finalCredentials: any = null;

    // Priority 1: Credentials from user answers (fresh input)
    if (parsedAnswers?.credentials) {
      logger.info('[PLATFORM_TEST] Using credentials from user answers');
      finalCredentials = parsedAnswers.credentials;
    }
    // Priority 2: Saved credentials from DB
    else {
      try {
        const savedCredentials = await ProjectContextService.getProjectCredentials(project_id, userId);

        if (savedCredentials) {
          logger.info('[PLATFORM_TEST] Found saved credentials in DB', { project_id });
          finalCredentials = savedCredentials;
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

    checkTimeout();

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
    let exploration, testPlan, formattedPlan;

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

      exploration = result.exploration;
      testPlan = result.testPlan;
      formattedPlan = result.message;

    } catch (explorationError) {
      const errorMsg = explorationError instanceof Error ? explorationError.message : String(explorationError);

      // ✅ FIX: Check if error is about missing credentials
      if (errorMsg.includes('Authentication required') || errorMsg.includes('credentials')) {
        logger.info('[PLATFORM_TEST] Auth required, asking for credentials', {
          url: extractedUrl,
          originalError: errorMsg,
        });

        // Re-ask with credentials question
        try {
          const result = await requestMissingInformation(message, {
            hasUrl: true,
            hasScope: true,
            hasCredentials: false, // ← Force credentials question
            intent: 'platform_test',
            userProjects,
          });

          // Save to history
          if (chatSessionId) {
            ChatService.saveChatMessages(chatSessionId, [
              { role: 'user', content: message },
              {
                role: 'ai',
                content: '🔐 This site requires authentication. Please provide your credentials:',
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

    logger.info('[PLATFORM_TEST] Autonomous exploration completed', {
      planId: testPlan.id,
      explorationId: exploration.timestamp,
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands.length,
      intelligentMode: testPlan.intelligentMode || false,
    });

    checkTimeout();

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
