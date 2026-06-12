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

/**
 * Parse a boolean env var with a safe fallback.
 * Truthy values: '1', 'true', 'yes', 'on' (case-insensitive).
 * Falsy values:  '0', 'false', 'no', 'off', '' or undefined.
 * Anything else returns defaultValue.
 */
function envBool(envVar: string | undefined, defaultValue: boolean): boolean {
  if (envVar === undefined || envVar === '') return defaultValue;
  const v = envVar.toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
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
   * DOM-density settle (inter-step). Page-level readiness (loaders/overlays/
   * animation) can pass while a navigation-heavy SPA is still hydrating — the
   * interactive DOM is sparse for a beat (e.g. 22 interactive nodes now → 134
   * after hydration). Resolving on that sparse snapshot misses the target and
   * triggers scroll-hunt. Wait until the interactive-node count plateaus (stops
   * growing for `quietMs`) at/above `floor`, capped by `maxWaitMs`. Fail-open on
   * budget exhaustion or probe failure. Only runs on fresh-page cases (a
   * navigation just happened OR no fast locator) so stable mid-page clicks are
   * untouched. Override gate: PREVIEW_DOM_DENSITY (set to 'off' to disable).
   */
  domDensity: {
    enabled: (process.env.PREVIEW_DOM_DENSITY ?? '').toLowerCase().trim() !== 'off',
    /** Poll interval for the interactive-node count (ms). */
    pollMs: 120,
    /** Count must not grow for this long to be considered settled (ms). */
    quietMs: 320,
    /**
     * Below this many interactive nodes the page is treated as not-yet-rendered
     * (kept low — the growth plateau is the primary signal, this floor only
     * rejects a transiently empty/near-empty DOM, not minimal real pages).
     */
    floor: 3,
    /** Hard cap on the whole density wait (ms). */
    maxWaitMs: 2_500,
    /** Skip the density wait if less than this remains in the readiness budget (ms). */
    minBudgetMs: 300,
  },

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

  /**
   * V2 (smart-waiter) mode.
   * 'off'    — only V1 runs (current behaviour).
   * 'shadow' — V1 runs as primary, V2 runs in parallel for diff logging only.
   * 'primary'— V2 is authoritative, V1 is dead path.
   * Override: STEP_READINESS_V2_MODE
   */
  v2Mode: ((): 'off' | 'shadow' | 'primary' => {
    const raw = (process.env.STEP_READINESS_V2_MODE ?? '').toLowerCase().trim();
    if (raw === 'shadow' || raw === 'primary') return raw;
    return 'off';
  })(),

  /**
   * V2 tuning. Cheap, single-pass, deadline-respecting.
   * No additive phases — one budget, soft-OR escape at 70%.
   */
  v2: {
    /** Background replay budget. preview uses defaults.maxWaitMs (5s). */
    backgroundMaxWaitMs: envNum(process.env.STEP_READINESS_V2_BG_MAX_MS, 7_000),
    /** Quiet window for pageStable consensus, by prev action class. */
    quietMs: {
      navigation: 500,   // click/open/close/toggle/press/hover/scroll/upload/drag/navigate
      input: 300,        // type/select
      assertion: 150,    // assert/hover (light)
      default: 300,
    },
    /** Hard cap per individual Playwright check (isVisible/isEnabled/count). */
    perCheckCapMs: 500,
    /** Polling interval for actionability (level 1+2). */
    pollIntervalMs: 80,
    /** Bbox stability — coords must not move more than this (px) within quiet window. */
    bboxJitterPx: 1,
    /** Delay between two bbox reads. Less than this = stability check is meaningless. */
    bboxRecheckDelayMs: 60,
    /** Identity check: fingerprint compared on element only when level1 ✓. */
    identity: {
      /** Strong fields — match means strong identity. */
      strongFields: ['elementId', 'testIdAttr', 'name', 'href', 'svgIcon', 'routerLink'] as const,
      /** Weak fields — used as fallback if strong unavailable. */
      weakFields: ['ariaLabel', 'labelText', 'placeholder', 'text', 'role', 'tag'] as const,
    },
    /**
     * Soft-OR escape: after this fraction of budget, pageStable gate is dropped
     * and identity downgrades from strong to weak. Prevents "never settled" on
     * SaaS pages with permanent background polling.
     */
    softEscapeRatio: 0.7,
    /** Default for autoWaitApplied flag. */
    autoWaitThresholdMs: 800,
  },
} as const;

// ─── Element Resolver ─────────────────────────────────────────────────────────

export const ELEMENT_RESOLVER_CONFIG = {
  /** Max chars per candidate text sent to LLM (V8 visual/state/iframe hints need ~280) */
  maxCandidateTextLength: 280,

  /** Max chars for intent text sent to LLM */
  maxIntentTextLength: 500,

  /** Max candidates included in a single LLM selection call (pre-scoring ensures top elements) */
  maxCandidatesForLlm: 60,

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
    /**
     * Per-call LLM selection timeout (ms) — OUTER (total) budget.
     *
     * V26: bumped 10000 → 15000 so both providers can use their full
     * `perProviderTimeoutMs` (7s + 7s = 14s) without the outer
     * pre-empting the fallback. Previously 10s left only ~3s for
     * the fallback when the primary used its full 7s, defeating the
     * point of having a fallback during outages.
     *
     * Why this size: Gemini Flash Lite latency floats 8-12s on busy
     * days for 25-30 KB prompts (~60 candidates + scene + apply-rules
     * sits around 29 KB). Per-provider 7s is tight enough to NOT wait
     * for the long tail (we'd rather try the other provider) but
     * generous enough to catch p90. 15s outer = 2 × 7s + 1s slack
     * for prepare/post phases. Still shorter than Playwright's 15s
     * default action timeout (calls happen before the action so we're
     * not racing against the action timeout itself).
     */
    timeoutMs: 15_000,
    /**
     * V26: Per-provider budget. Wall-clock for ONE provider attempt
     * before we give up and try the fallback. Both Gemini and OpenAI
     * each get this much; total worst-case = 2 × perProviderTimeoutMs.
     *
     * Why: when Gemini is degraded (May 2026 outage), the old logic
     * burned the entire 10s budget on Gemini, then refused fallback
     * because `controller.signal.aborted === true`. Fix: each provider
     * gets its own AbortController scoped to perProviderTimeoutMs.
     * Outer `timeoutMs` is the absolute hard cap.
     */
    perProviderTimeoutMs: 7_000,
  },

  /** LLM result cache */
  llmCache: {
    /** 60s TTL — safe: cache key includes pageSignature (URL + refs + content hash),
     *  so any DOM change → different key → cache miss → fresh LLM call */
    ttlMs: 60 * 1000,
    maxSize: 200,
  },

  /**
   * Modal coverage threshold — modal is "blocking" when it covers this
   * fraction of viewport area (0–1).
   */
  modalCoverageThreshold: 0.3,

  /**
   * Candidate pruner — small LLM call that narrows the resolver's candidate
   * set from ~60 down to ~15 BEFORE the main LLM resolver runs. Cuts the
   * resolver prompt size by ~45% and lets cross-script intents reach the
   * resolver (failure mode: juz40-edu.kz Cyrillic "МАТ" never matched the
   * Latin-typed intent under ASCII-only heuristic ranking).
   *
   * The deterministic pre-rank step it replaces (`preScoreAndSort`) was
   * removed — pruner is now the single ranking layer on top of a neutral
   * DOM-order top-60 cap. Shadow vs live is the only remaining knob.
   *
   * Phase 2 rollout uses `shadowMode` — pruner runs and logs results, but
   * the resolver consumes the unmodified DOM-order top-60 set. Lets us
   * measure false-negative rate (pruner removed an element the resolver
   * would have picked) over real traffic before flipping the switch.
   *
   * Override: PREVIEW_PRUNER_ENABLED, PREVIEW_PRUNER_SHADOW
   */
  pruner: {
    /** Master kill switch. When false, pruner is never invoked. */
    enabled: envBool(process.env.PREVIEW_PRUNER_ENABLED, true),
    /**
     * Shadow mode: run pruner for telemetry, but do NOT use its output
     * to drive the resolver. Resolver runs on the DOM-order top-60 set.
     * Default true — Phase 2 ships gated.
     */
    shadowMode: envBool(process.env.PREVIEW_PRUNER_SHADOW, true),
    /** How many candidates the pruner returns. Resolver runs on this set. */
    topK: 15,
    /** Per-call LLM timeout. Pruner prompt is small so 3s is enough. */
    timeoutMs: 3_000,
  },
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

  /** Hard cap on self-healing duration per step (ms). Prevents 40s+ hangs from scroll-retry chains. */
  healTimeoutMs: 20_000,

  /** Stop run after N consecutive step failures (cascading failure detection) */
  maxConsecutiveFailuresBeforeTermination: 3,

  /** Flag step for human review after N heals across runs (flakiness indicator) */
  healCountReviewThreshold: 3,
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

  /** Directory for trace files. Override: REGRESSION_LOGS_DIR (legacy: REPLAY_LOGS_DIR). */
  logsDir: process.env.REGRESSION_LOGS_DIR
    ?? process.env.REPLAY_LOGS_DIR
    ?? path.join(process.cwd(), 'test_logs', 'regressions'),

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

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER FINGERPRINT — Single source of truth for UA, args, headers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Realistic User-Agent string matching current stable Chrome.
 * Updated periodically — search for BROWSER_USER_AGENT to find all usages.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

/**
 * Chromium launch args for anti-detection + stability.
 * Used by browser-pool, exploration, and preview sessions.
 */
/**
 * Headless mode. Playwright 1.50+ uses the new Chrome headless by default
 * (indistinguishable from headed Chrome). No need for 'new' — `true` is correct.
 */
export const BROWSER_HEADLESS_MODE = true;

export const BROWSER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--window-size=1920,1080',
  // NOTE: --disable-gpu intentionally omitted.
  // It breaks CSS compositing (hover highlights, selection outlines) in preview mode.
  // Playwright's new headless mode (1.50+) handles GPU rendering correctly without it.
] as const;

/**
 * Extra HTTP headers applied to every browser context.
 *
 * CRITICAL: `extraHTTPHeaders` is sent on EVERY request, not just the top-level
 * navigation. ONLY CORS-safelisted request headers may live here. Anything else
 * (`Cache-Control`, `Upgrade-Insecure-Requests`, `Sec-Fetch-*`, `Connection`,
 * `Accept-Encoding`, …) forces a CORS preflight on cross-origin XHR/fetch that
 * the target API may reject, breaking the app under test (documentolog: its own
 * API returned `status: 0` on boot). Chromium already sets navigation /
 * Sec-Fetch / Accept-Encoding headers natively per request type — forcing them
 * globally also looks MORE bot-like on XHR, not less. Keep this to Accept +
 * Accept-Language only. (Guarded by `__tests__/playwright-tuning.test.ts`.)
 */
export const BROWSER_EXTRA_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
} as const;

/**
 * Stealth init script injected into every browser context via context.addInitScript().
 * Patches browser APIs that bot detectors check:
 * - navigator.webdriver → false
 * - window.chrome runtime object
 * - navigator.plugins (non-empty)
 * - navigator.languages
 * - WebGL vendor/renderer (generic, not "Google SwiftShader")
 * - Permissions API (notifications = "denied" like real browsers)
 *
 * Must be called ONCE per context (not per page — addInitScript on context auto-applies to all pages).
 */
export const BROWSER_STEALTH_SCRIPT = `
  // 1. Hide webdriver flag (primary bot detection signal)
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Chrome runtime object (missing in headless = bot indicator)
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
  }

  // 3. Plugins array (empty in headless = bot indicator)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.refresh = () => {};
      return plugins;
    },
  });

  // 4. Languages (must match Accept-Language header)
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // 5. WebGL renderer — "Google SwiftShader" = headless giveaway
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';           // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParameter.call(this, param);
  };

  // 6. Permissions API — headless returns "prompt" for notifications, real Chrome returns "denied"
  if (navigator.permissions) {
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null });
      }
      return originalQuery.call(this, params);
    };
  }

  // 7. Connection API — headless often missing
  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
    });
  }

  // 8. Canvas fingerprint noise — add subtle pixel variation to prevent exact-match fingerprinting
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    if (this.width > 16 && this.height > 16) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const style = ctx.fillStyle;
        ctx.fillStyle = 'rgba(0,0,1,0.003)';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = style;
      }
    }
    return origToDataURL.apply(this, arguments);
  };

  // 9. AudioContext — headless often has different sample rate or missing
  if (window.AudioContext || window.webkitAudioContext) {
    const OrigAudioCtx = window.AudioContext || window.webkitAudioContext;
    const origGetFloat = OrigAudioCtx.prototype.__proto__.constructor.prototype.createAnalyser
      ? null : null; // Just ensure constructor exists
    // Ensure sampleRate looks normal (44100 or 48000)
    try {
      Object.defineProperty(OrigAudioCtx.prototype, 'sampleRate', {
        get: function() { return 48000; },
        configurable: true,
      });
    } catch {}
  }
`;

