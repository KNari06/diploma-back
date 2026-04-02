/**
 * StepTelemetryCollector
 *
 * Lightweight per-step telemetry collection during replay runs.
 * Attaches page listeners once per run and uses timestamp watermarks
 * to attribute console errors and network responses to individual steps.
 *
 * Overhead: <5ms per step (2× page.url() + array filter).
 */

import type { Page, ConsoleMessage, Response, Request } from 'playwright';
import { logger } from '@/utils/core/logger';
import type {
  IntentActionType,
  StepTelemetryEntry,
  StepTelemetryTimeline,
} from './preview.types';

// ── Ring buffer limits ──
const MAX_CONSOLE_ERRORS = 50;
const MAX_NETWORK_EVENTS = 100;
// ── Per-step output limits ──
const MAX_ERRORS_PER_STEP = 3;
const MAX_NETWORK_PER_STEP = 3;
const DESCRIPTION_MAX_LENGTH = 80;
const ERROR_MAX_LENGTH = 200;

// ── Ignored network patterns (analytics, tracking, etc.) ──
const IGNORED_URL_PATTERNS = [
  'google-analytics.com', 'googletagmanager.com', 'facebook.net',
  'hotjar.com', 'sentry.io', 'segment.io', 'mixpanel.com',
  'amplitude.com', 'fullstory.com', 'intercom.io', 'crisp.chat',
];

interface ConsoleEntry {
  text: string;
  timestamp: number;
}

interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  resourceType: string;
  timestamp: number;
}

export class StepTelemetryCollector {
  private page: Page;
  private consoleErrors: ConsoleEntry[] = [];
  private networkResponses: NetworkEntry[] = [];
  private entries: StepTelemetryEntry[] = [];

  // Watermark state for current step
  private stepStartTimestamp = 0;
  private stepIndex = -1;
  private stepId = '';
  private stepActionType: IntentActionType = 'click';
  private stepDescription = '';
  private urlBefore = '';
  private startUrl = '';
  private testCaseId?: string;
  private destroyed = false;

  // Bound handlers for cleanup
  private onConsole: (msg: ConsoleMessage) => void;
  private onResponse: (res: Response) => void;
  private onRequestFailed: (req: Request) => void;

  constructor(page: Page, options?: { testCaseId?: string; startUrl?: string }) {
    this.page = page;
    this.testCaseId = options?.testCaseId;
    this.startUrl = options?.startUrl || '';

    // Bind handlers
    this.onConsole = (msg: ConsoleMessage) => {
      const type = msg.type();
      if (type !== 'error') return;

      this.consoleErrors.push({
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (this.consoleErrors.length > MAX_CONSOLE_ERRORS) {
        this.consoleErrors.shift();
      }
    };

    this.onResponse = (res: Response) => {
      const req = res.request();
      const resourceType = req.resourceType();
      if (resourceType !== 'fetch' && resourceType !== 'xhr') return;

      const url = req.url();
      if (IGNORED_URL_PATTERNS.some(p => url.includes(p))) return;

      this.networkResponses.push({
        url,
        method: req.method(),
        status: res.status(),
        resourceType,
        timestamp: Date.now(),
      });
      if (this.networkResponses.length > MAX_NETWORK_EVENTS) {
        this.networkResponses.shift();
      }
    };

    this.onRequestFailed = (req: Request) => {
      const resourceType = req.resourceType();
      if (resourceType !== 'fetch' && resourceType !== 'xhr') return;

      const url = req.url();
      if (IGNORED_URL_PATTERNS.some(p => url.includes(p))) return;

      this.networkResponses.push({
        url,
        method: req.method(),
        status: 0, // 0 = network failure
        resourceType,
        timestamp: Date.now(),
      });
      if (this.networkResponses.length > MAX_NETWORK_EVENTS) {
        this.networkResponses.shift();
      }
    };

    // Attach listeners
    this.page.on('console', this.onConsole);
    this.page.on('response', this.onResponse);
    this.page.on('requestfailed', this.onRequestFailed);

    logger.debug('[STEP_TELEMETRY] Collector initialized');
  }

  /**
   * Mark the beginning of a step. Records watermark timestamp and URL.
   */
  markStepStart(
    stepIndex: number,
    stepId: string,
    actionType: IntentActionType,
    description: string,
    currentUrl: string,
  ): void {
    this.stepStartTimestamp = Date.now();
    this.stepIndex = stepIndex;
    this.stepId = stepId;
    this.stepActionType = actionType;
    this.stepDescription = description?.slice(0, DESCRIPTION_MAX_LENGTH) || '';
    this.urlBefore = currentUrl;
  }

  /**
   * Mark the end of a step. Collects events since watermark and builds entry.
   */
  markStepEnd(
    status: 'pass' | 'fail' | 'skipped',
    currentUrl: string,
    options?: {
      error?: string;
      retried?: boolean;
      attempts?: number;
    },
  ): void {
    const now = Date.now();
    const since = this.stepStartTimestamp;

    // Collect console errors since step start
    const newConsoleErrors = this.consoleErrors
      .filter(e => e.timestamp >= since)
      .slice(-MAX_ERRORS_PER_STEP)
      .map(e => e.text.slice(0, ERROR_MAX_LENGTH));

    // Collect network responses since step start
    const recentNetwork = this.networkResponses.filter(e => e.timestamp >= since);

    const newNetworkErrors = recentNetwork
      .filter(e => e.status >= 400 || e.status === 0)
      .slice(-MAX_NETWORK_PER_STEP)
      .map(e => ({ url: this.truncateUrl(e.url), method: e.method, status: e.status }));

    const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const newNetworkSuccesses = recentNetwork
      .filter(e => e.status >= 200 && e.status < 300 && MUTATING_METHODS.has(e.method))
      .slice(-MAX_NETWORK_PER_STEP)
      .map(e => ({ url: this.truncateUrl(e.url), method: e.method, status: e.status }));

    const entry: StepTelemetryEntry = {
      stepIndex: this.stepIndex,
      stepId: this.stepId,
      actionType: this.stepActionType,
      description: this.stepDescription,
      timestamp: since,
      durationMs: now - since,
      status,
      urlBefore: this.urlBefore,
      urlAfter: currentUrl,
      urlChanged: this.urlBefore !== currentUrl,
      newConsoleErrors,
      newNetworkErrors,
      newNetworkSuccesses,
      ...(options?.error ? { error: options.error.slice(0, ERROR_MAX_LENGTH) } : {}),
      ...(options?.retried ? { retried: true } : {}),
      ...(options?.attempts && options.attempts > 1 ? { attempts: options.attempts } : {}),
    };

    this.entries.push(entry);
  }

  /**
   * Get the complete telemetry timeline.
   */
  getTimeline(): StepTelemetryTimeline {
    return {
      version: '1.0',
      testCaseId: this.testCaseId,
      startUrl: this.startUrl,
      totalSteps: this.entries.length,
      collectedAt: new Date().toISOString(),
      entries: this.entries,
    };
  }

  /**
   * Detach page listeners and clean up.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      this.page.off('console', this.onConsole);
      this.page.off('response', this.onResponse);
      this.page.off('requestfailed', this.onRequestFailed);
    } catch {
      // Page may already be closed
    }

    logger.debug('[STEP_TELEMETRY] Collector destroyed', {
      entriesCollected: this.entries.length,
    });
  }

  /** Truncate URL to pathname + first 60 chars of search for compact telemetry. */
  private truncateUrl(url: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname;
      const search = u.search ? u.search.slice(0, 60) : '';
      return `${path}${search}`;
    } catch {
      return url.slice(0, 120);
    }
  }
}
