/**
 * Mobile Runner API Types
 * Mirror of qait-mobile-runner's API contract.
 * These are COPIES, not imports — runner is a separate microservice.
 */

// ── Platform ─────────────────────────────────────────────────────

export type MobilePlatform = 'android' | 'ios' | 'flutter';

/**
 * `intent_test_cases.platform` storage form (also used as the denormalised
 * `test_executions.platform` column). Distinct from `MobilePlatform`, which
 * is the short runner-facing form, and from the hyphenated `browser` key
 * (`mobile-android` etc.) used on the `tests` row.
 */
export type MobilePlatformKey = 'mobile_android' | 'mobile_ios' | 'mobile_flutter';

export function toMobilePlatformKey(platform: MobilePlatform): MobilePlatformKey {
  return platform === 'ios' ? 'mobile_ios'
    : platform === 'flutter' ? 'mobile_flutter'
    : 'mobile_android';
}

// ── Session ──────────────────────────────────────────────────────

export interface MobileSessionResponse {
  sessionId: string;
  platform: MobilePlatform;
  device?: Record<string, unknown>;
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
  /**
   * Lifecycle phase — same semantics as the web `PlaywrightCommand.phase`.
   * Populated by `stitchPhases()` in `regression-run.service` when a
   * test case has setup_steps / teardown_steps. The runner forwards it
   * back on each step result so reports can render phase-separated
   * timelines. Absent on pre-Phase-3 runs; treat as 'main'.
   */
  phase?: 'setup' | 'main' | 'teardown';
}

// ── Step Result ──────────────────────────────────────────────────

/**
 * Compiled mobile locator plan — mirrors qait-mobile-runner's CompiledMobilePlan.
 * Backend stores this on the IntentStep after successful apply so subsequent runs
 * can skip the LLM pipeline. See runner/src/types/intent-step.types.ts for builder.
 */
export interface MobileCompiledPlan {
  version: 1;
  platform: 'android' | 'ios' | 'flutter';
  compiledAt: string;
  strategies: Array<Record<string, unknown>>;
  ordinal?: { index: number; total?: number };
  fingerprint: {
    label?: string;
    role?: string;
    siblingCount?: number;
    parentText?: string;
  };
}

export interface MobileStepResult {
  stepId: string;
  success: boolean;
  error?: string;
  screenshot?: string; // base64
  resolvedVia?: 'compiled' | 'exact_label' | 'exact_text' | 'partial' | 'coordinates' | 'llm' | 'vision' | 'thinking' | 'soft_score' | 'passthrough' | 'skipped' | 'unresolved' | 'low_confidence';
  durationMs: number;
  /** Freshly-built compiled plan from this run. Persist onto the IntentStep. */
  compiledPlan?: MobileCompiledPlan;
  /** Error evidence collected during/after this step */
  evidence?: {
    logErrors?: string[];
    consoleErrors?: Array<{ type: string; message: string; source?: string; line?: number; timestamp: number }>;
    networkErrors?: Array<{ url: string; method: string; error?: string; status?: number; statusText?: string; timestamp: number }>;
    systemAlert?: { text: string; isError: boolean };
  };
  /** Automatic error classification */
  errorClassification?: {
    type: string;
    confidence: number;
    summary: string;
  };
  /** Structured bug report for this failed step */
  bugReport?: {
    type: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    stepsToReproduce: Array<{ stepNumber: number; action: string; result: string }>;
    evidence: Record<string, unknown>;
    environment: Record<string, unknown>;
    detectedAt: number;
  };
  /**
   * Non-blocking, advisory messages raised by the runner for this step (e.g.
   * `install_app` warns when the APK is a release build without WebView
   * debugging). The editor renders these as amber badges / toasts next to
   * the step result. Only present when non-empty — never an empty array.
   */
  warnings?: Array<{
    /** Stable machine code (e.g. 'WEBVIEW_DEBUGGABLE_DISABLED'). */
    code: string;
    /** Ready-to-display human message (may be multi-sentence). */
    message: string;
    /** Optional app identifier the warning refers to. */
    packageName?: string;
  }>;
}

// ── Test Metadata ────────────────────────────────────────────────

/** Test-level metadata forwarded to the mobile runner. All fields optional. */
export interface MobileTestMetadata {
  /** Natural language description of the test's purpose/intent */
  goal?: string;
  /** Detailed test description */
  description?: string;
  /** What the test should verify */
  expectedResult?: string;
  /** Test priority level */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Freeform tags for filtering/grouping */
  tags?: string[];
}

/**
 * Build MobileTestMetadata from an IntentTestCase.
 * Supports both camelCase (mapped objects) and snake_case (raw DB rows).
 * Returns undefined if all fields are empty.
 */
export function buildMetadataFromTestCase(tc: {
  goal?: string;
  description?: string;
  expectedResult?: string;
  expected_result?: string;
  priority?: string;
  tags?: string[];
}): MobileTestMetadata | undefined {
  const m: MobileTestMetadata = {};
  if (tc.goal) m.goal = tc.goal;
  if (tc.description) m.description = tc.description;
  // Support both camelCase (mapped) and snake_case (raw DB row)
  const expectedResult = tc.expectedResult || tc.expected_result;
  if (expectedResult) m.expectedResult = expectedResult;
  if (tc.priority) m.priority = tc.priority as MobileTestMetadata['priority'];
  if (tc.tags?.length) m.tags = tc.tags;
  return Object.keys(m).length > 0 ? m : undefined;
}

// ── Run Steps ────────────────────────────────────────────────────

export interface MobileRunStepsRequest {
  /** Steps to execute (runner expects field name 'steps') */
  steps: MobileIntentStep[];
  testRunId?: string;
  testName?: string;
  screenshotEachStep?: boolean;
  stopOnFailure?: boolean;
  /** Test-level metadata (goal, description, priority, tags, etc.) */
  metadata?: MobileTestMetadata;
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
  /** Test-level metadata echoed from the request */
  metadata?: MobileTestMetadata;
  /** Aggregated errors from all failed steps */
  errors?: Array<{ type: string; message: string; stepId?: string; timestamp: number }>;
  /** Device log errors (logcat/syslog) collected during the run */
  logs?: string[];
  /** Network errors captured during the run (WebView only) */
  networkLogs?: Array<{ url: string; method: string; status?: number; error?: string; timestamp: number }>;
  /** Bug reports from failed steps — ready for UI display */
  bugReports?: Array<MobileStepResult['bugReport']>;
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
  projectId?: string;
  chatSessionId?: string;
  platform: MobilePlatform;
  browser: 'mobile-android' | 'mobile-ios' | 'mobile-flutter';
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
  /** Test-level metadata forwarded to the mobile runner */
  metadata?: MobileTestMetadata;
  // ── Analytics linkage ──────────────────────────────────────────
  /**
   * When both `analyticsRunId` and `analyticsExecutionId` are set, the job
   * finalizes the whole run (chat path). Regression-plan callers pass only
   * the execution id so they can manage run-level status themselves.
   */
  analyticsRunId?: string;
  /** Pre-created `test_executions.id` the job flips to passed/failed. */
  analyticsExecutionId?: string;
  /**
   * Pre-created `intelligent_test_sessions.id`. Without a session row,
   * `ai-analysis.extractBugPatterns` early-returns and the run never
   * contributes to /bug-insights.
   */
  intelligentSessionId?: string;
  /**
   * Raw bindings reference (echoed from `intent_test_cases.resource_bindings`).
   *
   * SECURITY CONTRACT: the job payload carries ONLY `{kind, resource_id,
   * required?}`. Decryption + compilation into setup IntentSteps happens
   * inside the worker (mobile-test-run.job.ts:process) — plaintext secrets
   * NEVER land in Redis. If you ever add a sibling field here that holds
   * decrypted data, re-read the Track 5 notes in
   * `memory/project_deferred_tracks_plan.md` first; that invariant is the
   * whole point of Option A.
   */
  resourceBindings?: Array<{
    kind: string;
    resource_id: string;
    required?: boolean;
  }>;
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
