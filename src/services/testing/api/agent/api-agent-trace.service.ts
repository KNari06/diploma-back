/**
 * API Agent Trace Service
 * Writes detailed JSONL trace for API agent runs
 * Reuses LiteTraceWriter infrastructure and uploads to lite-trace-logs bucket
 */

import { isDevelopment } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { LiteTraceWriter } from '@/agent/core/lite/trace/lite-trace-writer';
import {
  uploadLiteTraceLogToStorage,
  insertTraceFileRecord,
  deleteLiteTraceLogFromStorage,
} from '@/services/storage/test-artifacts-storage.service';
import { isValidUUID } from '@/utils/validation/validation';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ApiAgentRunState,
  ApiAgentStepResult,
  ApiAgentAIDecision,
  ApiAgentRequest,
  ApiAgentSummary,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TRACE_FILE_SIZE = 50 * 1024 * 1024; // 50MB max per trace file
const CLEANUP_AGE_HOURS = 24; // Delete local trace files older than 24h

// ═══════════════════════════════════════════════════════════════════════════
// TRACE SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ApiAgentTraceService {
  private writer: LiteTraceWriter;
  private testId: string;
  private runId: string;
  private userId: string;

  constructor(testId: string, runId: string, userId: string) {
    this.testId = testId;
    this.runId = runId;
    this.userId = userId;

    // Write traces outside repo to avoid nodemon watch restarts
    const logsDir = path.join(os.tmpdir(), 'qai_test_logs');

    // Create trace writer with API agent prefix
    this.writer = new LiteTraceWriter({
      testId,
      runId,
      logsDir,
      maxFileSizeBytes: 50 * 1024 * 1024, // 50MB limit for API agent traces
      maxPayloadChars: 10000, // Smaller payloads for API tests
    });

    logger.debug('[API_AGENT_TRACE] Writer initialized', { testId, runId });
  }

  /**
   * Write run start event
   */
  writeRunStart(request: ApiAgentRequest, policy: any): void {
    this.writer.write({
      stage: 'agent',
      eventType: 'run_start',
      payload: {
        level: request.level,
        url: request.url,
        method: request.method,
        policy: {
          budget: policy.budget,
          noveltyThreshold: policy.noveltyStopThreshold,
        },
        userId: this.redactUserId(request.userId),
      },
    });
  }

  /**
   * Write step planning event
   */
  writeStepPlanning(stepIndex: number, decision: ApiAgentAIDecision): void {
    this.writer.write({
      iteration: stepIndex,
      stage: 'planning',
      eventType: 'step_planned',
      payload: {
        hasNextStep: !!decision.nextStep,
        reasoning: decision.reasoning,
        shouldStop: decision.shouldStop,
        stopReason: decision.stopReason,
        noveltyEstimate: decision.noveltyEstimate,
        nextStep: decision.nextStep
          ? {
              stepType: decision.nextStep.stepType,
              description: decision.nextStep.description,
              riskLevel: decision.nextStep.riskLevel,
              request: this.redactRequest(decision.nextStep.request),
            }
          : null,
      },
    });
  }

  /**
   * Write step execution start
   */
  writeStepStart(stepIndex: number, step: any): void {
    this.writer.write({
      iteration: stepIndex,
      stage: 'execution',
      eventType: 'step_start',
      payload: {
        stepType: step.stepType,
        description: step.description,
        request: this.redactRequest(step.request),
      },
    });
  }

  /**
   * Write step execution result
   */
  writeStepResult(stepIndex: number, result: ApiAgentStepResult): void {
    this.writer.write({
      iteration: stepIndex,
      stage: 'execution',
      eventType: 'step_result',
      payload: {
        stepId: result.stepId,
        stepType: result.stepType,
        success: result.success,
        error: result.error,
        response: result.response
          ? {
              status: result.response.status,
              statusText: result.response.statusText,
              durationMs: result.response.durationMs,
              // Redact body and headers
              bodyPreview: this.truncateBody(result.response.body),
              headerCount: Object.keys(result.response.headers).length,
            }
          : null,
        findingsCount: result.findings.length,
        findings: result.findings.map((f) => ({
          id: f.id,
          type: f.type,
          severity: f.severity,
          title: f.title,
        })),
        aiTokensUsed: result.aiTokensUsed,
      },
    });
  }

  /**
   * Write state update after step
   */
  writeStateUpdate(state: ApiAgentRunState): void {
    this.writer.write({
      iteration: state.currentStep,
      stage: 'observation',
      eventType: 'state_update',
      payload: {
        novelty: state.novelty,
        consumed: state.consumed,
        findingsTotal: state.findings.length,
        discoveredMethods: state.discoveredMethods,
        knownIdsCount: state.knownIds.length,
        hasInferredSchema: !!state.inferredSchema,
      },
    });
  }

  /**
   * Write safety gate check
   */
  writeSafetyGateCheck(
    stepType: string,
    allowed: boolean,
    reason?: string,
    skipped?: string
  ): void {
    this.writer.write({
      stage: 'safety',
      eventType: 'safety_gate_check',
      payload: {
        stepType,
        allowed,
        reason,
        skippedAction: skipped,
      },
    });
  }

  /**
   * Write run end event
   */
  writeRunEnd(state: ApiAgentRunState, summary: ApiAgentSummary): void {
    this.writer.write({
      stage: 'agent',
      eventType: 'run_end',
      payload: {
        status: state.status,
        stopReason: state.stopReason,
        durationMs: summary.durationMs,
        stepsExecuted: summary.stepsExecuted,
        findingsCounts: summary.findingsCounts,
        securityScore: summary.securityScore,
        aiTokensUsed: summary.aiTokensUsed,
        creditsCharged: summary.creditsCharged,
      },
    });
  }

  /**
   * Write error event
   */
  writeError(error: string, context?: any): void {
    this.writer.write({
      stage: 'agent',
      eventType: 'error',
      payload: {
        error,
        context: context ? this.redactSensitive(context) : undefined,
      },
    });
  }

  /**
   * Close writer and upload trace to storage
   * Returns the storage path if successful
   */
  async closeAndUpload(): Promise<string | null> {
    try {
      await this.writer.close();

      // In development, keep trace logs locally for debugging — skip Supabase upload
      if (isDevelopment) {
        logger.debug('[API_AGENT_TRACE] Skipping upload in development mode, keeping local file', {
          filePath: this.writer.getFilePath(),
        });
        return null;
      }

      const filePath = this.writer.getFilePath();
      const originalFileName = path.basename(filePath);

      // Guard: skip upload if file missing or too large
      if (!fs.existsSync(filePath)) {
        logger.warn('[API_AGENT_TRACE] Trace file missing, skipping upload', { filePath });
        return null;
      }
      const size = fs.statSync(filePath).size;
      if (size > MAX_TRACE_FILE_SIZE) {
        logger.warn('[API_AGENT_TRACE] Trace file too large, skipping upload', {
          size,
          max: MAX_TRACE_FILE_SIZE,
        });
        return null;
      }

      // Only upload if userId is valid UUID
      if (isValidUUID(this.userId)) {
        const result = await uploadLiteTraceLogToStorage(
          filePath,
          this.userId,
          originalFileName,
          'api-agent',
        );

        // Register the trace in trace_files so it shows up in the admin UI.
        // testId is nullable (api-agent tests are not stored in `tests`),
        // so we pass null and rely on the `browser` discriminator for filtering.
        try {
          await insertTraceFileRecord({
            userId: this.userId,
            testId: null,
            fileName: result.fileName,
            storagePath: result.storagePath,
            fileSize: result.fileSize,
            browser: 'api-agent-trace',
            status: 'uploaded',
          });
        } catch (insertError) {
          logger.error('[API_AGENT_TRACE] Failed to register trace in DB, rolling back storage', {
            error: insertError instanceof Error ? insertError.message : String(insertError),
            storagePath: result.storagePath,
          });
          await deleteLiteTraceLogFromStorage(result.storagePath).catch(() => {});
          return null;
        }

        logger.info('[API_AGENT_TRACE] Trace uploaded', {
          path: result.storagePath,
          size: result.fileSize,
        });
        return result.storagePath;
      } else {
        logger.warn('[API_AGENT_TRACE] Skipping upload - invalid userId', {
          userId: this.userId.substring(0, 8),
        });
        return null;
      }
    } catch (error) {
      logger.error('[API_AGENT_TRACE] Failed to upload trace', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get file path for reference
   */
  getFilePath(): string {
    return this.writer.getFilePath();
  }

  /**
   * Get run ID
   */
  getRunId(): string {
    return this.runId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REDACTION HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private redactUserId(userId: string): string {
    if (!userId) return '[no-user]';
    return userId.substring(0, 8) + '...';
  }

  private redactRequest(request: any): any {
    if (!request) return null;
    const correlationId =
      request.headers?.['x-qai-correlation-id'] ||
      request.headers?.['X-QAI-Correlation-Id'] ||
      request.headers?.['x-qai-correlation-id'.toUpperCase()];
    return {
      method: request.method,
      url: request.url,
      // Redact headers
      headersCount: request.headers ? Object.keys(request.headers).length : 0,
      correlationId,
      hasBody: !!request.body,
      bodyPreview: this.truncateBody(request.body),
    };
  }

  private redactSensitive(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;

    const sensitiveKeys = [
      'password',
      'token',
      'secret',
      'authorization',
      'api_key',
      'apikey',
      'auth',
      'bearer',
      'cookie',
      'session',
    ];

    const redacted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (sensitiveKeys.some((s) => keyLower.includes(s))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactSensitive(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private truncateBody(body: any, maxLength: number = 200): string | null {
    if (body === null || body === undefined) return null;
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (str.length > maxLength) {
      return str.substring(0, maxLength) + `...[${str.length - maxLength} more chars]`;
    }
    return str;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATIC CLEANUP UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Cleanup old trace files from local disk
   * Should be called periodically (e.g., on server start or cron)
   */
  static async cleanupOldTraceFiles(logsDir: string): Promise<{
    deleted: number;
    errors: number;
  }> {
    let deleted = 0;
    let errors = 0;

    try {
      if (!fs.existsSync(logsDir)) {
        return { deleted: 0, errors: 0 };
      }

      const files = await fs.promises.readdir(logsDir);
      const now = Date.now();
      const maxAgeMs = CLEANUP_AGE_HOURS * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.startsWith('api_agent_') || !file.endsWith('.jsonl')) {
          continue;
        }

        const filePath = `${logsDir}/${file}`;

        try {
          const stats = await fs.promises.stat(filePath);
          const age = now - stats.mtimeMs;

          if (age > maxAgeMs) {
            await fs.promises.unlink(filePath);
            deleted++;
            logger.debug('[API_AGENT_TRACE] Deleted old trace file', {
              file,
              ageHours: Math.floor(age / (60 * 60 * 1000)),
            });
          }
        } catch (fileError) {
          errors++;
          logger.warn('[API_AGENT_TRACE] Failed to process file for cleanup', {
            file,
            error: fileError instanceof Error ? fileError.message : String(fileError),
          });
        }
      }

      if (deleted > 0) {
        logger.info('[API_AGENT_TRACE] Cleanup completed', { deleted, errors });
      }
    } catch (error) {
      logger.error('[API_AGENT_TRACE] Cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { deleted, errors };
  }

  /**
   * Check current trace file size
   */
  getCurrentFileSize(): number {
    try {
      const filePath = this.writer.getFilePath();
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        return stats.size;
      }
    } catch {
      // Ignore errors
    }
    return 0;
  }

  /**
   * Check if trace file is approaching size limit
   */
  isApproachingSizeLimit(): boolean {
    const size = this.getCurrentFileSize();
    return size > MAX_TRACE_FILE_SIZE * 0.9; // 90% of limit
  }
}
