import { EventEmitter } from 'events';

import { logger } from '@/utils/core/logger';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * In-process event emitter for signaling UI test execution completion
 * within a regression run.
 *
 * Lifecycle:
 *   1. executeTestCasesAsync() calls waitForCompletion() for each dispatched UI test
 *   2. TestCompletionHandlerService.updateTestExecutionsForCompletedUiTest()
 *      calls signalCompletion() after updating the execution status
 *   3. The waiting promise resolves, allowing dependent tests to proceed
 *
 * Memory safety:
 *   - Each listener auto-removes after firing (once: true)
 *   - A timeout ensures no listener leaks if completion never arrives
 */
class ExecutionCompletionEmitter extends EventEmitter {
  private static instance: ExecutionCompletionEmitter;

  private constructor() {
    super();
    this.setMaxListeners(500);
  }

  static getInstance(): ExecutionCompletionEmitter {
    if (!this.instance) {
      this.instance = new ExecutionCompletionEmitter();
    }
    return this.instance;
  }

  /**
   * Wait for a specific execution to reach a terminal status.
   * Returns the final status ('passed' | 'failed' | 'skipped' | 'cancelled').
   */
  waitForCompletion(executionId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve) => {
      const eventName = `exec:${executionId}`;

      const timer = setTimeout(() => {
        this.removeAllListeners(eventName);
        logger.warn('[EXEC_COMPLETION_EMITTER] Timed out waiting for execution', {
          executionId,
          timeoutMs,
        });
        resolve('failed');
      }, timeoutMs);

      this.once(eventName, (status: string) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  /**
   * Signal that an execution has completed.
   * Called from TestCompletionHandlerService after updating test_executions status.
   */
  signalCompletion(executionId: string, status: string): void {
    const eventName = `exec:${executionId}`;
    this.emit(eventName, status);
  }
}

export const executionCompletionEmitter = ExecutionCompletionEmitter.getInstance();
