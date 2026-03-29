/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLAYWRIGHT TUNING — Centralized constants for Editor & Replay modes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All magic numbers, thresholds, and keyword lists for the preview, replay,
 * and editor pipelines live here. Env-var overrides are available for the
 * most environment-sensitive values (viewport, timeouts, confidence thresholds).
 *
 * Usage:
 *   import { PREVIEW_SESSION_CONFIG } from '@/config/testing/playwright-tuning';
 */

import * as path from 'path';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a numeric env var with a safe fallback.
 * Treats undefined, empty string, and NaN as "not set" → returns defaultValue.
 * Correctly handles `0` as a valid override.
 */
function envNum(envVar: string | undefined, defaultValue: number): number {
  if (envVar === undefined || envVar === '') return defaultValue;
  const parsed = Number(envVar);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

// ─── Viewport Presets ────────────────────────────────────────────────────────

export const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 720 },
  tablet:  { width: 768,  height: 1024 },
  mobile:  { width: 375,  height: 812 },
} as const;

export type ViewportPresetName = keyof typeof VIEWPORT_PRESETS;

// ─── Preview Session ─────────────────────────────────────────────────────────

export const PREVIEW_SESSION_CONFIG = {
  /** Auto-cleanup threshold. Override: PREVIEW_SESSION_TTL_MS */
  sessionTtlMs: envNum(process.env.PREVIEW_SESSION_TTL_MS, 5 * 60 * 1000),

  /** How often the cleanup loop runs (ms) */
  sessionCleanupIntervalMs: 60 * 1000,

  /** Min time between snapshot emissions (ms) */
  snapshotThrottleMs: 500,

  /** Safety cap for concurrent sessions (memory guard) */
  maxSessions: 20,

  /** V15: Maximum open tabs per preview session (memory guard) */
  maxTabsPerSession: 8,

  /** Viewport dimensions. Override: PREVIEW_VIEWPORT_WIDTH / PREVIEW_VIEWPORT_HEIGHT */
  viewport: {
    width: envNum(process.env.PREVIEW_VIEWPORT_WIDTH, 1280),
    height: envNum(process.env.PREVIEW_VIEWPORT_HEIGHT, 720),
  },

  /** Screenshot capture settings */
  screenshot: {
    /** JPEG quality (0-100). 65 balances text clarity with bandwidth at ~15 fps. */
    quality: 65,
    /** Skip frame if encoded size exceeds this (bytes) */
    maxSizeBytes: 900_000,
    /** Min time between screenshot emissions per session (ms) */
    throttleMs: 500,
  },

  /** Input event throttle windows (anti-flood) */
  inputThrottle: {
    /** ~20 mouse events/sec max */
    mouseMs: 50,
    /** ~20 wheel events/sec max */
    wheelMs: 50,
    /** ~100 type events/sec max */
    keyboardTypeMs: 10,
    /** ~50 press events/sec max */
    keyboardPressMs: 20,
  },
} as const;

// ─── Step Readiness ───────────────────────────────────────────────────────────

export const STEP_READINESS_CONFIG = {
  /**
   * DOM-stability settle thresholds per previous-action risk profile (ms).
   * Higher = more re-render budget after heavy actions.
   */
  domStableThresholdMs: {
    /** After click/open/close/toggle that may trigger a route change */
    navigation: 500,
    /** After type/select — form re-renders are lighter */
    input: 300,
    /** After assert/hover — almost no side effects */
    assertion: 150,
    default: 300,
  },

  /** Blind settle when no locator is available — avoids complete skip (ms) */
  blindSettleMs: 800,

  /**
   * Max time to wait for SPA URL change after a navigation-trigger action.
   * Override: PREVIEW_SPA_NAV_DETECT_MS
   */
  spaNavDetectMs: envNum(process.env.PREVIEW_SPA_NAV_DETECT_MS, 1500),

  /** Default values for LookaheadOptions */
  defaults: {
    maxWaitMs: 5_000,
    settleMs: 1_500,
    autoWaitThresholdMs: 800,
    maxRetries: 2,
  },
} as const;

// ─── Element Resolver ─────────────────────────────────────────────────────────

export const ELEMENT_RESOLVER_CONFIG = {
  /** Max chars per candidate text sent to LLM */
  maxCandidateTextLength: 200,

  /** Max chars for intent text sent to LLM */
  maxIntentTextLength: 500,

  /** Max candidates included in a single LLM selection call */
  maxCandidatesForLlm: 50,

  /**
   * Minimum LLM confidence to accept an element match.
   * Override: PREVIEW_CONFIDENCE_THRESHOLD
   */
  confidenceThreshold: envNum(process.env.PREVIEW_CONFIDENCE_THRESHOLD, 0.7),

  /** LLM circuit breaker settings */
  llmCircuitBreaker: {
    /** Consecutive failures before opening the circuit */
    failureThreshold: 3,
    /** Time the circuit stays open before half-open probe (ms) */
    cooldownMs: 60_000,
    /** Per-call LLM selection timeout (ms) */
    timeoutMs: 7_000,
  },

  /** LLM result cache */
  llmCache: {
    ttlMs: 30 * 60 * 1000,
    maxSize: 100,
  },

  /**
   * Modal coverage threshold — modal is "blocking" when it covers this
   * fraction of viewport area (0–1).
   */
  modalCoverageThreshold: 0.3,
} as const;

// ─── Command Executor ─────────────────────────────────────────────────────────

export const COMMAND_EXECUTOR_CONFIG = {
  /**
   * Minimum self-healing LLM confidence to accept a healed selector.
   * Override: PREVIEW_SELFHEAL_THRESHOLD
   */
  selfHealingConfidenceThreshold: envNum(process.env.PREVIEW_SELFHEAL_THRESHOLD, 0.85),

  /** Max self-heal attempts per step (limits flakiness exposure) */
  maxHealAttempts: 1,

  /** Timeout for click actions with navigation detection (ms) */
  clickNavigationTimeoutMs: 15_000,

  /** Timeout waiting for new page after click (ms) */
  newPageLoadTimeoutMs: 10_000,

  /** Fallback domcontentloaded timeout for new page (ms) */
  newPageFallbackTimeoutMs: 5_000,

  /** Max age of cached DOM nodes before re-collecting (ms) */
  domCacheMaxAgeMs: 1_500,
} as const;

// ─── Preview Step Apply ───────────────────────────────────────────────────────

export const STEP_APPLY_CONFIG = {
  /** Max candidates to try before giving up */
  maxAttempts: 3,

  /** Per-action Playwright timeout (ms) */
  actionTimeoutMs: 10_000,

  /** Post-action settle wait (ms) */
  postActionSettleTimeoutMs: 5_000,

  /** Navigate action timeout (ms) */
  navigateTimeoutMs: 30_000,

  /** wait_for step default timeout when not specified in options (ms) */
  waitForDefaultTimeoutMs: 15_000,

  /** Dropdown animation: max poll time (ms) */
  dropdownMaxWaitMs: 5_000,

  /** Dropdown animation: poll interval (ms) */
  dropdownPollIntervalMs: 100,

  /** Animation buffer bounds (ms) */
  animationBuffer: {
    minMs: 200,
    maxMs: 3_000,
    /** Fraction of measured latency to use as buffer */
    latencyFactor: 0.3,
  },

  /** Random human-like pause injected in some steps */
  humanPause: {
    /** Probability of injecting a pause */
    probability: 0.35,
    minMs: 80,
    maxMs: 220,
  },
} as const;

// ─── Replay Trace Writer ──────────────────────────────────────────────────────

export const REPLAY_TRACE_CONFIG = {
  /** Hard cap on trace file size; summary events bypass it (bytes) */
  maxFileSizeBytes: 100 * 1024 * 1024,

  /** Max characters per payload before truncation */
  maxPayloadChars: 50_000,

  /** Directory for trace files. Override: REPLAY_LOGS_DIR */
  logsDir: process.env.REPLAY_LOGS_DIR ?? path.join(process.cwd(), 'test_logs', 'replay'),

  /** Events that are always written regardless of file size */
  summaryEvents: ['run_start', 'run_end', 'step_failed'] as const,

  /** Regex patterns for field-level redaction of sensitive values */
  sensitivePatterns: [
    /password/i,
    /token/i,
    /secret/i,
    /authorization/i,
    /cookie/i,
    /api[_-]?key/i,
    /auth/i,
    /bearer/i,
    /session/i,
    /credentials?/i,
  ] as const,

  /** Timeout for flushing the write queue on close (ms) */
  closeTimeoutMs: 10_000,
} as const;

