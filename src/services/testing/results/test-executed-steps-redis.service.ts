import { redisConnection } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export type ExecutedStepEvent = {
  ts: string;
  browser?: string;
  type: 'progress' | 'step_completed';
  data: any;
};

type ProgressFingerprint = {
  progress?: number;
  phase?: string;
  currentStep?: string;
  actionType?: string;
  actionDesc?: string;
};

function truncateString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '…[truncated]';
}

function safeCloneForStorage(
  value: unknown,
  options: { maxDepth: number; maxStringLen: number; maxArrayLen: number; maxObjectKeys: number },
  depth: number = 0
): any {
  if (value === null) return null;
  if (value === undefined) return null;

  const t = typeof value;
  if (t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (t === 'string') return truncateString(value, options.maxStringLen);
  if (t === 'bigint') return truncateString(String(value), options.maxStringLen);
  if (t === 'function' || t === 'symbol') return null;

  if (depth >= options.maxDepth) return '[max_depth]';

  if (Array.isArray(value)) {
    return value.slice(0, options.maxArrayLen).map((v) => safeCloneForStorage(v, options, depth + 1));
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, any> = {};
    const keys = Object.keys(obj).slice(0, options.maxObjectKeys);
    for (const key of keys) {
      out[key] = safeCloneForStorage(obj[key], options, depth + 1);
    }
    return out;
  }

  return truncateString(String(value), options.maxStringLen);
}

function reduceProgressPayload(payload: any): any {
  // Structured progress payload (preferred)
  if (payload && typeof payload === 'object' && typeof payload.progress === 'number' && typeof payload.phase === 'string') {
    return {
      testId: typeof payload.testId === 'string' ? payload.testId : undefined,
      browser: typeof payload.browser === 'string' ? payload.browser : undefined,
      progress: payload.progress,
      phase: payload.phase,
      currentStep: truncateString(payload.currentStep, 2000),
      icon: truncateString(payload.icon, 128),
      action: payload.action && typeof payload.action === 'object'
        ? {
          type: truncateString(payload.action.type, 128),
          description: truncateString(payload.action.description, 2000),
          target: truncateString(payload.action.target, 500),
        }
        : undefined,
      totalSteps: typeof payload.totalSteps === 'number' ? payload.totalSteps : undefined,
      completedSteps: typeof payload.completedSteps === 'number' ? payload.completedSteps : undefined,
      status: truncateString(payload.status, 64),
      elapsedTime: typeof payload.elapsedTime === 'number' ? payload.elapsedTime : undefined,
      estimatedRemaining: typeof payload.estimatedRemaining === 'number' ? payload.estimatedRemaining : undefined,
      sessionId: truncateString(payload.sessionId, 128),
      timestamp: truncateString(payload.timestamp, 64),
    };
  }

  // Orchestrator-style or unknown shapes: store truncated JSON-safe clone
  return safeCloneForStorage(payload, { maxDepth: 4, maxStringLen: 2000, maxArrayLen: 50, maxObjectKeys: 50 });
}

function reduceRuntimeMeta(meta: any): any {
  if (!meta || typeof meta !== 'object') return undefined;
  return {
    stepId: truncateString(meta.stepId, 128),
    runtimeStatus: truncateString(meta.runtimeStatus, 32),
    source: truncateString(meta.source, 32),
    confidenceTier: truncateString(meta.confidenceTier, 16),
    failedReason: truncateString(meta.failedReason, 64),
    failureExplanation: truncateString(meta.failureExplanation, 2000),
    executionMs: typeof meta.executionMs === 'number' ? meta.executionMs : undefined,
    rootCause: truncateString(meta.rootCause, 32),
    networkVerdict: truncateString(meta.networkVerdict, 64),
    bugScreenshotUrl: truncateString(meta.bugScreenshotUrl, 2000),
    healConfidence: typeof meta.healConfidence === 'number' ? meta.healConfidence : undefined,
    needsReview: typeof meta.needsReview === 'boolean' ? meta.needsReview : undefined,
    flaky: typeof meta.flaky === 'boolean' ? meta.flaky : undefined,
    resolutionPath: truncateString(meta.resolutionPath, 32),
    networkEvidence: Array.isArray(meta.networkEvidence)
      ? meta.networkEvidence.slice(0, 10).map((e: any) => ({
          method: truncateString(e?.method, 16),
          url: truncateString(e?.url, 500),
          status: typeof e?.status === 'number' ? e.status : undefined,
          error: truncateString(e?.error, 500),
        }))
      : undefined,
    stepErrors: meta.stepErrors && typeof meta.stepErrors === 'object'
      ? {
          console: typeof meta.stepErrors.console === 'number' ? meta.stepErrors.console : 0,
          network: typeof meta.stepErrors.network === 'number' ? meta.stepErrors.network : 0,
          ui: typeof meta.stepErrors.ui === 'number' ? meta.stepErrors.ui : 0,
        }
      : undefined,
  };
}

function reduceStepCompletedPayload(payload: any): any {
  if (payload && typeof payload === 'object') {
    return {
      testId: typeof payload.testId === 'string' ? payload.testId : undefined,
      browser: typeof payload.browser === 'string' ? payload.browser : undefined,
      step: typeof payload.step === 'number' ? payload.step : undefined,
      stepDescription: truncateString(payload.stepDescription, 2000),
      success: typeof payload.success === 'boolean' ? payload.success : undefined,
      timestamp: truncateString(payload.timestamp, 64),
      // V11: Preserve runtimeMeta so V11 data survives Redis → Postgres persistence
      runtimeMeta: reduceRuntimeMeta(payload.runtimeMeta),
    };
  }

  return safeCloneForStorage(payload, { maxDepth: 3, maxStringLen: 2000, maxArrayLen: 20, maxObjectKeys: 30 });
}

function normalizeTimestamp(input: unknown): string {
  if (typeof input === 'string' && input.trim().length > 0) return input;
  if (typeof input === 'number' && Number.isFinite(input)) return new Date(input).toISOString();
  return new Date().toISOString();
}

function getBrowser(payload: any): string | undefined {
  return typeof payload?.browser === 'string' && payload.browser.trim().length > 0 ? payload.browser.trim() : undefined;
}

export class TestExecutedStepsRedisService {
  private static readonly KEY_PREFIX = 'test:executed_steps:';
  private static readonly LOCK_PREFIX = 'lock:test:executed_steps:';
  private static readonly TTL_SECONDS = 86400; // 24h
  private static readonly MAX_EVENTS = 5000;

  private static readonly PROGRESS_MIN_INTERVAL_MS = 2000;
  private static readonly PROGRESS_MIN_DELTA = 5;

  // Hard cap for serialized JSON per event to reduce Redis memory use.
  // If exceeded, store a minimal marker payload.
  private static readonly MAX_EVENT_JSON_BYTES = 20_000;

  private static lastProgressByKey = new Map<string, { fp: ProgressFingerprint; tsMs: number }>();
  private static finalizeInProgress = new Set<string>();

  // Cleanup stale entries from lastProgressByKey every 5 minutes
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly STALE_ENTRY_AGE_MS = 30 * 60 * 1000; // 30 min
  private static cleanupTimer: ReturnType<typeof setInterval> | null = (() => {
    const timer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, entry] of TestExecutedStepsRedisService.lastProgressByKey) {
        if (now - entry.tsMs > TestExecutedStepsRedisService.STALE_ENTRY_AGE_MS) {
          TestExecutedStepsRedisService.lastProgressByKey.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug('[EXECUTED_STEPS_REDIS] Cleaned stale progress entries', {
          cleaned,
          remaining: TestExecutedStepsRedisService.lastProgressByKey.size,
        });
      }
    }, TestExecutedStepsRedisService.CLEANUP_INTERVAL_MS);
    // Allow process to exit without waiting for this timer
    if (timer.unref) timer.unref();
    return timer;
  })();

  private static key(testId: string): string {
    return `${this.KEY_PREFIX}${testId}`;
  }

  private static lockKey(testId: string): string {
    return `${this.LOCK_PREFIX}${testId}`;
  }

  static async appendProgress(testId: string, payload: any): Promise<void> {
    try {
      if (!testId || typeof testId !== 'string') return;

      const browser = getBrowser(payload) || 'unknown';
      const dedupKey = `${testId}:${browser}`;
      const nowMs = Date.now();

      const fp: ProgressFingerprint = {
        progress: typeof payload?.progress === 'number' ? payload.progress : undefined,
        phase: typeof payload?.phase === 'string' ? payload.phase : undefined,
        currentStep: typeof payload?.currentStep === 'string' ? payload.currentStep : undefined,
        actionType: typeof payload?.action?.type === 'string' ? payload.action.type : undefined,
        actionDesc: typeof payload?.action?.description === 'string' ? payload.action.description : undefined,
      };

      const last = this.lastProgressByKey.get(dedupKey);
      if (last) {
        const progressDelta = (fp.progress ?? 0) - (last.fp.progress ?? 0);
        const shouldSkipByInterval = nowMs - last.tsMs < this.PROGRESS_MIN_INTERVAL_MS;
        const shouldSkipByDelta =
          typeof fp.progress === 'number' &&
          typeof last.fp.progress === 'number' &&
          progressDelta >= 0 &&
          progressDelta < this.PROGRESS_MIN_DELTA;

        const isSamePhase = fp.phase === last.fp.phase;
        const isSameCurrentStep = fp.currentStep === last.fp.currentStep;
        const isSameAction = fp.actionType === last.fp.actionType && fp.actionDesc === last.fp.actionDesc;

        if (shouldSkipByInterval && shouldSkipByDelta && isSamePhase && isSameCurrentStep && isSameAction) {
          return;
        }
      }

      this.lastProgressByKey.set(dedupKey, { fp, tsMs: nowMs });

      const ev: ExecutedStepEvent = {
        ts: normalizeTimestamp(payload?.timestamp),
        browser: browser === 'unknown' ? undefined : browser,
        type: 'progress',
        data: reduceProgressPayload(payload),
      };

      let json = JSON.stringify(ev);
      if (json.length > this.MAX_EVENT_JSON_BYTES) {
        json = JSON.stringify({
          ts: ev.ts,
          browser: ev.browser,
          type: ev.type,
          data: { _truncated: true },
        } satisfies ExecutedStepEvent);
      }
      const key = this.key(testId);

      await redisConnection
        .multi()
        .rpush(key, json)
        .ltrim(key, -this.MAX_EVENTS, -1)
        .expire(key, this.TTL_SECONDS)
        .exec();
    } catch {
      // Best-effort only.
    }
  }

  static async appendStepCompleted(testId: string, payload: any): Promise<void> {
    try {
      if (!testId || typeof testId !== 'string') return;

      const ev: ExecutedStepEvent = {
        ts: normalizeTimestamp(payload?.timestamp),
        browser: getBrowser(payload),
        type: 'step_completed',
        data: reduceStepCompletedPayload(payload),
      };

      let json = JSON.stringify(ev);
      if (json.length > this.MAX_EVENT_JSON_BYTES) {
        json = JSON.stringify({
          ts: ev.ts,
          browser: ev.browser,
          type: ev.type,
          data: { _truncated: true },
        } satisfies ExecutedStepEvent);
      }
      const key = this.key(testId);

      await redisConnection
        .multi()
        .rpush(key, json)
        .ltrim(key, -this.MAX_EVENTS, -1)
        .expire(key, this.TTL_SECONDS)
        .exec();
    } catch {
      // Best-effort only.
    }
  }

  static async getLive(testId: string): Promise<ExecutedStepEvent[]> {
    try {
      if (!testId || typeof testId !== 'string') return [];
      const key = this.key(testId);
      const raw = await redisConnection.lrange(key, 0, -1);
      if (!raw || raw.length === 0) return [];

      const events: ExecutedStepEvent[] = [];
      for (const item of raw) {
        try {
          const parsed = JSON.parse(item);
          if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'string' && typeof parsed.type === 'string') {
            events.push(parsed as ExecutedStepEvent);
          }
        } catch {
          // skip invalid
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  static async finalizeToDb(testId: string): Promise<void> {
    try {
      if (!testId || typeof testId !== 'string') return;
      if (this.finalizeInProgress.has(testId)) return;
      this.finalizeInProgress.add(testId);

      // Distributed lock to prevent double-finalize in multi-instance main deployments.
      const lockKey = this.lockKey(testId);
      // ioredis typing expects EX before NX
      const lock = await redisConnection.set(lockKey, '1', 'EX', 60, 'NX');
      if (lock !== 'OK') {
        this.finalizeInProgress.delete(testId);
        return;
      }

      const key = this.key(testId);
      const raw = await redisConnection.lrange(key, 0, -1);
      const events: ExecutedStepEvent[] = [];
      for (const item of raw || []) {
        try {
          events.push(JSON.parse(item));
        } catch {
          // skip
        }
      }

      if (events.length > 0) {
        const { error } = await supabaseAdmin
          .from('tests')
          .update({ executed_steps: events })
          .eq('id', testId);

        if (error) {
          logger.warn('[EXECUTED_STEPS_REDIS] Failed to persist executed_steps', {
            testId,
            error: error.message,
          });
          return;
        }
      }

      await redisConnection.del(key);
      await redisConnection.del(lockKey);

      // Clean up in-memory dedup entries for this test
      for (const dedupKey of this.lastProgressByKey.keys()) {
        if (dedupKey.startsWith(`${testId}:`)) {
          this.lastProgressByKey.delete(dedupKey);
        }
      }
    } catch {
      // Best-effort only.
    } finally {
      this.finalizeInProgress.delete(testId);
    }
  }
}
