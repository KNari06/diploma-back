/**
 * ClarificationService
 * Manages user clarification requests and responses during test execution
 * Uses WebSocket for real-time communication
 */

import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { connection } from '@/config/infrastructure/queues';

export type ClarificationType = 'url' | 'credentials' | 'test_data' | 'payment_approval' | 'captcha_solve' | '2fa_code';

/**
 * Sentinel answer the frontend sends when the user clicks "Skip flow" on a
 * captcha/2FA prompt. The poll loop treats it as an immediate skip — it stops
 * waiting and returns null (same downstream handling as a timeout) instead of
 * blocking for the full clarification timeout. Must match the literal sent by
 * the frontend ExplorationClarificationModal.
 */
export const CLARIFICATION_SKIP_SENTINEL = '__skip__';

export interface ClarificationRequest {
  testId: string;
  questionId: string;
  question: string;
  type: ClarificationType;
  required: boolean;
  options?: string[];
  timeout?: number;
  resolve: (answer: string | null) => void;
  reject: (error: Error) => void;
  retryCount: number;
}

export class ClarificationService {
  private static pendingQuestions = new Map<string, ClarificationRequest>();
  private static readonly DEFAULT_TIMEOUT = 60000; // 60 seconds
  private static readonly MAX_RETRIES = 1; // Retry once

  /**
   * Request clarification from user
   * Returns Promise that resolves when user responds or times out
   */
  static async requestClarification(params: {
    testId: string;
    userId?: string;
    question: string;
    type: ClarificationType;
    required?: boolean;
    options?: string[];
    timeout?: number;
  }): Promise<string | null> {
    const questionId = uuidv4();
    const timeout = params.timeout || this.DEFAULT_TIMEOUT;

    logger.info('[CLARIFICATION_SERVICE] Requesting clarification', {
      testId: params.testId,
      questionId,
      type: params.type,
      timeout,
    });

    return new Promise((resolve, reject) => {
      const request: ClarificationRequest = {
        testId: params.testId,
        questionId,
        question: params.question,
        type: params.type,
        required: params.required !== false,
        options: params.options,
        timeout,
        resolve,
        reject,
        retryCount: 0,
      };

      // Store pending question
      this.pendingQuestions.set(questionId, request);

      // Emit clarification request via WebSocket
      webSocketService.emitTestClarificationRequest(params.testId, {
        testId: params.testId,
        questionId,
        question: params.question,
        type: params.type,
        required: params.required !== false,
        options: params.options,
        timeout,
        timestamp: new Date().toISOString(),
        userId: params.userId,
      });

      // Set timeout
      setTimeout(() => {
        this.handleTimeout(questionId);
      }, timeout);
    });
  }

  /**
   * Handle user response
   */
  static handleResponse(testId: string, questionId: string, answer: string): void {
    const request = this.pendingQuestions.get(questionId);

    if (!request) {
      logger.warn('[CLARIFICATION_SERVICE] Received response for unknown question', {
        testId,
        questionId,
      });
      return;
    }

    if (request.testId !== testId) {
      logger.warn('[CLARIFICATION_SERVICE] Test ID mismatch', {
        expectedTestId: request.testId,
        receivedTestId: testId,
        questionId,
      });
      return;
    }

    logger.info('[CLARIFICATION_SERVICE] Received response', {
      testId,
      questionId,
      answerLength: answer.length,
    });

    // Remove from pending
    this.pendingQuestions.delete(questionId);

    // Resolve promise
    request.resolve(answer);
  }

  /**
   * Handle timeout
   */
  private static handleTimeout(questionId: string): void {
    const request = this.pendingQuestions.get(questionId);

    if (!request) {
      // Already resolved or cancelled
      return;
    }

    logger.warn('[CLARIFICATION_SERVICE] Question timeout', {
      testId: request.testId,
      questionId,
      retryCount: request.retryCount,
    });

    // Retry if allowed
    if (request.retryCount < this.MAX_RETRIES) {
      request.retryCount++;

      logger.info('[CLARIFICATION_SERVICE] Retrying question', {
        testId: request.testId,
        questionId,
        retryCount: request.retryCount,
      });

      // Re-emit clarification request
      webSocketService.emitTestClarificationRequest(request.testId, {
        testId: request.testId,
        questionId: request.questionId,
        question: `[RETRY ${request.retryCount}/${this.MAX_RETRIES}] ${request.question}`,
        type: request.type,
        required: request.required,
        options: request.options,
        timeout: request.timeout,
        timestamp: new Date().toISOString(),
      });

      // Set new timeout
      setTimeout(() => {
        this.handleTimeout(questionId);
      }, request.timeout || this.DEFAULT_TIMEOUT);
    } else {
      // Max retries reached, resolve with null
      logger.error('[CLARIFICATION_SERVICE] Max retries reached, no response', {
        testId: request.testId,
        questionId,
      });

      this.pendingQuestions.delete(questionId);
      request.resolve(null); // null indicates no response
    }
  }

  /**
   * Cancel clarification request
   */
  static cancelRequest(questionId: string): void {
    const request = this.pendingQuestions.get(questionId);

    if (request) {
      logger.info('[CLARIFICATION_SERVICE] Cancelling clarification request', {
        testId: request.testId,
        questionId,
      });

      this.pendingQuestions.delete(questionId);
      request.reject(new Error('Clarification cancelled'));
    }
  }

  /**
   * Cancel all requests for a test
   */
  static cancelAllForTest(testId: string): void {
    const questionsToCancel: string[] = [];

    this.pendingQuestions.forEach((request, questionId) => {
      if (request.testId === testId) {
        questionsToCancel.push(questionId);
      }
    });

    questionsToCancel.forEach(questionId => {
      this.cancelRequest(questionId);
    });

    if (questionsToCancel.length > 0) {
      logger.info('[CLARIFICATION_SERVICE] Cancelled all clarification requests for test', {
        testId,
        cancelledCount: questionsToCancel.length,
      });
    }
  }

  /**
   * Get pending question count for a test
   */
  static getPendingCount(testId: string): number {
    let count = 0;
    this.pendingQuestions.forEach(request => {
      if (request.testId === testId) {
        count++;
      }
    });
    return count;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REDIS-BASED CLARIFICATION (for worker process / exploration)
  // ═══════════════════════════════════════════════════════════════════════

  private static redisClient: Redis | null = null;

  private static getRedisClient(): Redis {
    if (!this.redisClient) {
      this.redisClient = new Redis(connection as any);
    }
    return this.redisClient;
  }

  /**
   * Request clarification from user via Redis (for worker process).
   * Used by exploration FlowRunner when captcha/2FA is encountered.
   * Emits via WebSocket (Redis Pub/Sub fallback) and polls Redis for answer.
   */
  static async requestClarificationViaRedis(params: {
    explorationId: string;
    /**
     * Chat room to deliver into. OPTIONAL — the REST `/explorations/start` path
     * has no chat session at all, so requiring it made asking impossible there.
     * Supply `userId` instead (or as well); the emit routes to whichever is set,
     * and the web client filters on `explorationId`.
     */
    chatSessionId?: string;
    /** User room fallback. At least one of chatSessionId / userId is required. */
    userId?: string;
    question: string;
    // 'test_data' = the flow needs a real value it can't invent (promo/referral
    // code, account number, a one-time code that isn't strictly 2FA). Reuses the
    // same text-input clarification UI as '2fa_code'. NOT for credentials —
    // passwords need a dedicated secure form (see FlowRunner note).
    // 'product_brief' = a Phase 0 discovery question the analyst could not infer
    // (is this production? which role is the test account?). Same text/choice UI.
    type: 'captcha_solve' | '2fa_code' | 'test_data' | 'product_brief';
    /** Optional fixed choices, rendered as buttons instead of a text field. */
    options?: string[];
    timeout?: number;
  }): Promise<string | null> {
    // Without a destination the question can never be delivered, and the caller
    // would block for the full timeout waiting for an answer nobody was asked for.
    if (!params.chatSessionId && !params.userId) {
      logger.warn('[CLARIFICATION_SERVICE] No chatSessionId or userId — cannot deliver', {
        explorationId: params.explorationId,
        type: params.type,
      });
      return null;
    }
    const questionId = uuidv4();
    const redisKey = `exploration:clarification:${questionId}`;
    const timeout = params.timeout || 120_000; // 2 min for captcha

    logger.info('[CLARIFICATION_SERVICE] Requesting clarification via Redis', {
      explorationId: params.explorationId,
      questionId,
      type: params.type,
      timeout,
    });

    // Emit clarification request via WebSocket (uses Redis Pub/Sub fallback in worker)
    webSocketService.emitExplorationClarification({
      explorationId: params.explorationId,
      questionId,
      question: params.question,
      type: params.type,
      timeout,
      chatSessionId: params.chatSessionId,
      // Routes to the user room when there is no chat session (REST path).
      userId: params.userId,
      ...(params.options?.length ? { options: params.options } : {}),
      timestamp: new Date().toISOString(),
    });

    // Poll Redis for answer (worker can't receive WebSocket events directly)
    const pollInterval = 2000;
    const maxPolls = Math.ceil(timeout / pollInterval);
    const redis = this.getRedisClient();

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const answer = await redis.get(redisKey);
        if (answer) {
          await redis.del(redisKey);
          // User chose to skip — stop polling now instead of waiting out the
          // full timeout. Returning null reuses the existing "unresolved
          // blocker" path in the FlowRunner (no retry, flow stays blocked).
          if (answer === CLARIFICATION_SKIP_SENTINEL) {
            logger.info('[CLARIFICATION_SERVICE] User skipped clarification', {
              questionId,
              explorationId: params.explorationId,
            });
            return null;
          }
          logger.info('[CLARIFICATION_SERVICE] Received Redis clarification answer', {
            questionId,
            explorationId: params.explorationId,
          });
          return answer;
        }
      } catch (error) {
        logger.warn('[CLARIFICATION_SERVICE] Redis poll error', {
          questionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.warn('[CLARIFICATION_SERVICE] Redis clarification timed out', {
      questionId,
      explorationId: params.explorationId,
    });
    return null; // Timeout
  }

  /**
   * Handle exploration clarification response (called from API/WebSocket handler).
   * Stores answer in Redis so worker process can pick it up via polling.
   */
  static async handleExplorationClarificationResponse(questionId: string, answer: string): Promise<void> {
    const redisKey = `exploration:clarification:${questionId}`;
    const redis = this.getRedisClient();
    await redis.set(redisKey, answer, 'EX', 300); // 5 min TTL

    logger.info('[CLARIFICATION_SERVICE] Stored exploration clarification response in Redis', {
      questionId,
    });
  }
}
