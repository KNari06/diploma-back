/**
 * ClarificationService
 * Manages user clarification requests and responses during test execution
 * Uses WebSocket for real-time communication
 */

import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import { v4 as uuidv4 } from 'uuid';

export interface ClarificationRequest {
  testId: string;
  questionId: string;
  question: string;
  type: 'url' | 'credentials' | 'test_data' | 'payment_approval';
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
    type: 'url' | 'credentials' | 'test_data' | 'payment_approval';
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
}
