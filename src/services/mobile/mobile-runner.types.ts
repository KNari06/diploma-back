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

// ── Action Types (mirror of runner's IntentActionType) ───────────

export type MobileIntentActionType =
  // Web-compatible actions (mapped to mobile commands by runner)
  | 'click' | 'type' | 'scroll' | 'press' | 'hover'
  | 'assert' | 'ai_check' | 'navigate' | 'wait' | 'screenshot'
  | 'select' | 'check' | 'uncheck' | 'toggle' | 'open' | 'close' | 'wait_for'
  // Mobile-specific actions
  | 'open_app'           // launch app by package/bundle ID
  | 'close_app'          // terminate app
  | 'open_notifications' // pull down notification shade
  | 'swipe'              // swipe gesture
  | 'long_press'         // long tap / press and hold
  | 'double_tap'         // double tap
  | 'drag'               // drag and drop
  | 'pinch'              // pinch zoom
  | 'go_back'            // Android back / iOS swipe-back
  | 'go_home'            // Home button
  // Biometric & auth
  | 'biometric' | 'otp' | 'permission' | 'clipboard'
  // Network simulation
  | 'network';

// ── IntentStep (mirror of runner's IntentStep) ──────────────────

export interface MobileBindingHints {
  role?: string;
  label?: string;
  placeholder?: string;
  nearText?: string;
  type?: string;
  autocomplete?: string;
}

export interface MobileIntentStepOptions {
  timeout?: number;
  replaceContent?: boolean;
  pressEnter?: boolean;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  continueOnError?: boolean;
  // App management
  activityName?: string;
  clearData?: boolean;
  // Gesture options
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  durationMs?: number;
  pinchDirection?: 'in' | 'out';
  pinchScale?: number;
  // Biometric
  biometricAction?: 'enroll' | 'match' | 'fail';
  biometricType?: 'fingerprint' | 'faceId' | 'touchId';
  fingerId?: number;
  // OTP
  otpAction?: 'read_sms' | 'read_clipboard' | 'read_notification' | 'generate_totp' | 'type_otp';
  totpSecret?: string;
  otpCode?: string;
  otpExtractPattern?: string;
  otpSenderFilter?: string;
  // Permission dialog
  permissionAction?: 'allow' | 'deny' | 'allow_always';
  // Network simulation
  networkPreset?: '2g' | '3g' | '4g' | '5g' | 'wifi' | 'offline';
  networkLatencyMs?: number;
  networkBandwidthKbps?: number;
  networkPacketLossPercent?: number;
}

export interface MobileIntentStep {
  id: string;
  type: MobileIntentActionType;
  description: string;
  value?: string;
  assertionText?: string;
  bindingHints?: MobileBindingHints;
  options?: MobileIntentStepOptions;
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
  /** Steps to execute (runner expects field name 'steps') */
  steps: MobileIntentStep[];
  testRunId?: string;
  testName?: string;
  screenshotEachStep?: boolean;
  stopOnFailure?: boolean;
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
  /** Supabase Storage path for APK/IPA (if project has uploaded app) */
  appStoragePath?: string;
  /** Original filename of the APK/IPA */
  appOriginalName?: string;
  // ── CI/CD fields ──────────────────────────────────────────────
  /** CI run ID for tracking grouped test executions */
  ciRunId?: string;
  /** URL to POST results when test completes (outbound webhook) */
  callbackUrl?: string;
  /** Saved test case ID (for mapping results back) */
  testCaseId?: string;
  /** Saved test case name (for display in results) */
  testCaseName?: string;
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
