/**
 * Mobile Runner API Types
 * Mirror of qait-mobile-runner's API contract.
 * These are COPIES, not imports — runner is a separate microservice.
 */

// ── Platform ─────────────────────────────────────────────────────

export type MobilePlatform = 'android' | 'ios';

// ── Session ──────────────────────────────────────────────────────

export interface MobileSessionResponse {
  id: string;
  platform: MobilePlatform;
  createdAt: number;
}

export interface MobileSessionConfig {
  avdName?: string;
  simulatorName?: string;
  wdaPort?: number;
  snapshotName?: string;
}

// ── IntentStep (mirrors backend's own IntentStep subset) ─────────

export interface MobileIntentStep {
  id: string;
  type: string;
  description: string;
  value?: string;
  assertionText?: string;
  bindingHints?: {
    role?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    type?: string;
    autocomplete?: string;
  };
  options?: {
    timeout?: number;
    replaceContent?: boolean;
    pressEnterAfterFill?: boolean;
    continueOnError?: boolean;
    direction?: string;
    scrollAmount?: number;
    key?: string;
  };
  isAutoInjected?: boolean;
  expectedOutcome?: 'success' | 'error';
}

// ── Step Result ──────────────────────────────────────────────────

export interface MobileStepResult {
  stepId: string;
  success: boolean;
  error?: string;
  screenshot?: string; // base64
  resolvedVia?: 'exact_label' | 'exact_text' | 'partial' | 'coordinates' | 'llm' | 'vision' | 'skipped';
  durationMs: number;
}

// ── Run Steps ────────────────────────────────────────────────────

export interface MobileRunStepsRequest {
  intentSteps: MobileIntentStep[];
  autoScreenshot?: boolean;
  autoA11ySnapshot?: boolean;
  screenshotEachStep?: boolean;
}

export interface MobileRunStepsResponse {
  sessionId: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  passRate: number;
  steps: MobileStepResult[];
  durationMs: number;
  status: 'passed' | 'failed' | 'partial';
}

// ── Artifacts ────────────────────────────────────────────────────

export interface MobileArtifact {
  type: 'screenshot' | 'video' | 'a11y_tree';
  name: string;
  path: string;
  size?: number;
  mimeType?: string;
}

export interface MobileArtifactBundle {
  sessionId: string;
  artifacts: MobileArtifact[];
}

// ── Health ────────────────────────────────────────────────────────

export interface MobileHealthResponse {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  uptime: number;
  activeSessions: number;
}

// ── BullMQ Job Data ──────────────────────────────────────────────

export interface MobileTestJobData {
  testId: string;
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
  platform: MobilePlatform;
  browser: 'mobile-android' | 'mobile-ios';
  appPackage?: string;
  intentSteps: MobileIntentStep[];
  geminiApiKey?: string;
  /** URL of the mobile runner */
  runnerUrl: string;
  runnerApiKey?: string;
}

// ── Error ─────────────────────────────────────────────────────────

export class MobileRunnerError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'MobileRunnerError';
  }
}
