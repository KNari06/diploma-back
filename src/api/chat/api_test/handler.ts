import { Request, Response } from 'express';
import { logger } from '@/utils/logger';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { ApiTestPlanService } from '@/services/testing/api/api-test-plan.service';
import { saveTestPlan } from '@/services/testing/plans/exploration-cache.service';
import { ChatService } from '@/services/utils/chat.service';
import { emitProcessingStep } from '../shared/utils';
import { convertApiTestPlanToTestPlan } from './formatting';
import { CONSTANTS } from '../shared/constants';
import { checkRequestAborted } from '../shared/request-cancellation';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: API TEST
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function handleApiTest(
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

  try {
    // FIX #8: Validate and merge answers into parsedIntent if provided
    if (answers) {
      // Validate answers structure
      if (typeof answers !== 'object' || Array.isArray(answers)) {
        logger.error('[API_TEST] Invalid answers structure', { answers: typeof answers });
        throw new Error('Invalid answers format - expected object');
      }

      // Safely merge answers with validation
      const validatedAnswers: Record<string, any> = {};

      if (answers.apiMethod && typeof answers.apiMethod === 'string') {
        parsedIntent.apiMethod = answers.apiMethod.toUpperCase();
        validatedAnswers.apiMethod = answers.apiMethod;
      }

      if (answers.apiUrl && typeof answers.apiUrl === 'string') {
        // Validate URL format
        try {
          new URL(answers.apiUrl);
          parsedIntent.apiUrl = answers.apiUrl;
          validatedAnswers.apiUrl = answers.apiUrl;
        } catch {
          logger.warn('[API_TEST] Invalid URL in answers', { apiUrl: answers.apiUrl });
        }
      }

      if (answers.apiBody) {
        parsedIntent.apiBody = answers.apiBody;
        validatedAnswers.apiBody = typeof answers.apiBody === 'string' ? 'provided' : 'object';
      }

      if (answers.apiHeaders && typeof answers.apiHeaders === 'object') {
        parsedIntent.apiHeaders = answers.apiHeaders;
        validatedAnswers.apiHeaders = Object.keys(answers.apiHeaders).length;
      }

      logger.info('[API_TEST] Merged validated answers into parsedIntent', {
        answersProvided: Object.keys(validatedAnswers),
        method: parsedIntent.apiMethod,
        url: parsedIntent.apiUrl,
      });
    }

    logger.info('[API_TEST] Starting API test flow', {
      method: parsedIntent?.apiMethod,
      url: parsedIntent?.apiUrl,
      hasParsedIntent: !!parsedIntent,
      hasAnswers: !!answers,
    });

    emitProcessingStep(chatSessionId, 'checking_autonomous', '🔍 Analyzing API request...', 30);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: VALIDATE API INFO - ASK FOR MISSING DETAILS
    // ═══════════════════════════════════════════════════════════════════════

    const hasMethod = !!parsedIntent?.apiMethod;
    const hasUrl = !!parsedIntent?.apiUrl;

    // If missing method OR URL, ask clarifying questions
    if (!hasMethod || !hasUrl) {
      logger.info('[API_TEST] Missing API details, asking for clarification', {
        hasMethod,
        hasUrl,
        message: message.substring(0, 50),
      });

      const questions = [];

      if (!hasUrl) {
        questions.push({
          id: 'apiUrl',
          question: '🌐 What is the API endpoint URL?',
          type: 'text',
          required: true,
          placeholder: 'https://api.example.com/v1/users',
        });
      }

      if (!hasMethod) {
        questions.push({
          id: 'apiMethod',
          question: '📡 Which HTTP method should I use?',
          type: 'select',
          required: true,
          options: [
            { value: 'GET', label: 'GET - Retrieve data' },
            { value: 'POST', label: 'POST - Create/Submit data' },
            { value: 'PUT', label: 'PUT - Update/Replace data' },
            { value: 'PATCH', label: 'PATCH - Partial update' },
            { value: 'DELETE', label: 'DELETE - Remove data' },
          ],
        });
      }

      const clarificationMessage = `📋 I need a few more details to set up the API test:\n${questions.map(q => `• ${q.question}`).join('\n')}`;

      // Save to history
      if (chatSessionId) {
        await ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: clarificationMessage },
        ]);
      }

      // Note: This conversationId is just for tracking clarification, not a test plan ID
      // So it can use timestamp, but for consistency we could use UUID too
      res.json({
        reply: clarificationMessage,
        questions,
        conversationId: `api_clarify_${Date.now()}`, // Clarification tracking ID (not a test plan)
        needsMoreInfo: true,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: FIND OR CREATE PROJECT
    // ═══════════════════════════════════════════════════════════════════════

    const { project_id } = await ProjectContextService.findOrCreateProject(
      workspace_id,
      parsedIntent.apiUrl,
      userId
    );

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: GENERATE API TEST PLAN
    // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'generating_plan', '📋 Creating test plan...', 60);

    const apiTestPlan = await ApiTestPlanService.generateApiTestPlan({
      method: parsedIntent.apiMethod,
      url: parsedIntent.apiUrl,
      body: parsedIntent.apiBody,
      headers: parsedIntent.apiHeaders,
      userMessage: message,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: CONVERT API TEST PLAN TO UNIFIED TEST PLAN FORMAT
    // ═══════════════════════════════════════════════════════════════════════

    // Convert ApiTestPlan to TestPlan for storage and execution
    const testPlan = convertApiTestPlanToTestPlan(apiTestPlan);

    // Save test plan to database for approval tracking
    // Note: userId/projectId are shortened for logs (privacy + readability)
    logger.info('[API_TEST] Saving test plan to database', {
      planId: testPlan.id,
      userId: userId.substring(0, 8) + '...', // First 8 chars only (privacy)
      projectId: project_id.substring(0, 8) + '...', // First 8 chars only (privacy)
      scope: testPlan.scope,
      status: testPlan.status,
    });

    const saveResult = await saveTestPlan(testPlan, userId, project_id);

    logger.info('[API_TEST] Test plan save result', {
      planId: testPlan.id,
      success: saveResult.success,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: SHOW TEST PLAN TO USER FOR APPROVAL
    // ═══════════════════════════════════════════════════════════════════════

    const formattedPlan = ApiTestPlanService.formatApiTestPlanForConfirmation(apiTestPlan);

    // Save chat messages
    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        {
          role: 'ai',
          content: formattedPlan,
          metadata: {
            testPlan: apiTestPlan,
            requiresApproval: true,
          },
        },
      ]);
    }

    res.json({
      success: true, // ← Frontend expects this!
      reply: formattedPlan,
      testPlan: apiTestPlan,
      conversationId: testPlan.id, // Use this to track approval
      requiresApproval: true,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  } catch (error) {
    logger.error('[API_TEST] Error in API test flow', {
      error,
      errorType: error?.constructor?.name,
      errorMessage: error instanceof Error ? error.message : String(error),
      parsedIntent,
    });

    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'Failed to process API test request');

    // Save error to history
    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: params.message },
        { role: 'ai', content: `❌ Error: ${errorMessage}` },
      ]);
    }

    res.status(500).json({
      success: false,
      error: 'Failed to process API test',
      message: errorMessage,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}
