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

/**
 * Where the test session should be hosted from the runner's perspective.
 * Mirrors `DeviceSource` in qait-mobile-runner.
 *
 * - `local-emulator` — locally-spawned AVD or iOS simulator
 * - `local-physical` — USB-attached real device (Android serial or iPhone UDID)
 * - `cloud`          — redroid container or remote emulator (host:port)
 */
export type MobileDeviceSource = 'local-emulator' | 'local-physical' | 'cloud';

/**
 * Caller-supplied device-selection hint, forwarded verbatim to the runner.
 * All fields optional — runner applies its `DEVICE_DEFAULT_SOURCE` policy
 * when nothing is specified. Phase 2.6: lets the frontend pin a specific
 * physical iPhone / Android phone for a session.
 */
export interface MobileDeviceSelector {
  source?: MobileDeviceSource;
  serial?: string;
}

export interface MobileSessionConfig {
  avdName?: string;
  simulatorName?: string;
  wdaPort?: number;
  snapshotName?: string;
  /**
   * Phase 2.6 (physical-device routing). When present, the runner uses
   * this to pick a specific device instead of falling back to its default
   * policy. When absent, behaviour is unchanged (runner picks an emulator
   * or whatever `DEVICE_DEFAULT_SOURCE` says).
   */
  deviceSelector?: MobileDeviceSelector;
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
  | 'dismiss'            // Smart close of top modal / sheet / dialog
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
  /** Swipe direction (mobile swipe step). Distinct from scrollDirection so
   *  editor swipe steps don't conflict with scroll steps semantically.
   *  Forwarded by the frontend; runner reads it via resolveDirection(). */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Swipe distance hint (0-1 normalised). Forwarded by the editor. */
  distance?: number;
  continueOnError?: boolean;
  // App management
  activityName?: string;
  clearData?: boolean;
  /** close_app: when true the runner clears app data (Android: `pm clear`).
   *  Absent / false keeps the soft `am force-stop` behaviour for back-compat. */
  hard?: boolean;
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
  // Permission dialog. Modern Android (11+) runtime-permission dialogs show
  // up to four buttons depending on the permission family:
  //   - "While using the app" / "Allow"   → allow / allow_foreground
  //   - "Only this time"                  → allow_once
  //   - "Allow all the time"              → allow_always (background, location)
  //   - "Don't allow" / "Deny"            → deny
  // iOS WDA acceptAlert/dismissAlert collapses the allow_* variants to a
  // single "tap the first accept button" behaviour.
  permissionAction?: 'allow' | 'deny' | 'allow_always' | 'allow_foreground' | 'allow_once';
  // Network simulation
  networkPreset?: '2g' | '3g' | '4g' | '5g' | 'wifi' | 'offline';
  networkLatencyMs?: number;
  networkBandwidthKbps?: number;
  networkPacketLossPercent?: number;
  // Dismiss
  /** Free-text hint for `dismiss` steps ("Reading settings sheet"). Advisory
   *  only — the runner always closes the top-most active layer it sees. */
  dismissTarget?: string;
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
  /**
   * Persisted compiled locator plan from a prior successful resolve.
   * The runner's compiled-fast-path reads this field at dispatch time
   * (qait-mobile-runner intent-step-converter.ts) and skips the LLM /
   * vision resolvers entirely when the plan still matches the live
   * tree. Pre-fix this field was preserved at runtime via spread but
   * not declared on the type, so ts-eyes couldn't see that the
   * regression dispatch path was correctly forwarding it. Persist via
   * `IntentTestCaseService.batchUpdateStepsFromRun()` after every run
   * (see mobile-test-run.job.ts:persistCompiledPlansFromRun) and via
   * `updateStepFromPreviewApply()` after every editor apply (web's
   * preview.handler.ts pattern; mobile editor session.controller.ts
   * needs the same treatment).
   */
  compiled?: MobileCompiledPlan;
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
  /**
   * Set by the runner when the plan must NOT be persisted, even if
   * `success === true` and `compiledPlan` is present. Reasons:
   *   - 'vte_mismatch': VTE caught the typed text in a sibling field, so
   *     the plan that pointed at it is locking in a wrong element.
   *   - 'foreground_mismatch': plan was built against the wrong app's tree.
   * Backend persist sites (mobile-step-apply.service.ts,
   * mobile-test-run.job.ts persistCompiledPlansFromRun, session.controller.ts
   * runTestCaseOnSession auto-persist) check this and skip writes.
   */
  planStaleReason?: 'vte_mismatch' | 'foreground_mismatch';
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

// ── UI State (live read of current screen for AI Agent) ─────────────
// Mirror of the runner's UiStateSnapshot. Kept as a loose shape here
// because the backend only reads these fields — we don't want to import
// the runner's A11yTree type into the backend just to re-export it.

/** Window summary inside `actualForeground.windows[]`. Mirror of runner shape. */
export interface MobileForegroundWindow {
  packageName: string;
  activityName: string | null;
  kind: 'app' | 'launcher' | 'system_ui' | 'system_settings' | 'recents' | 'unknown';
  isFocused: boolean;
  isResumed: boolean;
}

/** Device-fresh foreground truth (dumpsys-derived). */
export interface MobileActualForeground {
  screenState: 'awake' | 'locked' | 'aod' | 'off' | 'unknown';
  windows: MobileForegroundWindow[];
  /** The single most-likely-foreground window. Null when nothing resolvable. */
  primary: MobileForegroundWindow | null;
  capturedAt: string;
  durationMs: number;
}

export interface MobileUiState {
  sessionId: string;
  platform: 'android' | 'ios';
  app?: string;
  activity?: string;
  fingerprint: string;
  screenSize: { width: number; height: number };
  windowInfo?: { keyboardVisible?: boolean; hasDialog?: boolean };
  /** Compact ASCII dump of the a11y tree — drop straight into an LLM prompt. */
  formattedTree: string;
  /** Raw A11yTree. Opaque to the backend; omit from the wire with ?includeTree=false. */
  tree?: unknown;
  /** base64-encoded PNG. Omit with ?includeScreenshot=false. */
  screenshotBase64?: string;
  capturedAt: string;
  /**
   * Alias for the legacy `app` field — what the runner *expected* to be
   * foregrounded based on the session's launched package. Compare against
   * `actualForeground.primary.packageName` to detect drift.
   */
  expectedApp?: string;
  /**
   * Device-fresh truth via dumpsys (Android) / equivalent (iOS). What is
   * ACTUALLY on screen right now, independent of the a11y dump. Used to
   * detect cases where the user wandered out of the app under test
   * (settings, launcher, another app).
   */
  actualForeground?: MobileActualForeground;
  /**
   * Populated when `expectedApp` and `actualForeground.primary.packageName`
   * disagree. Null when they match. Drives the LLM "user left the app"
   * warning in mobile chat.
   */
  foregroundMismatch?: { expected: string; actual: string } | null;
  /**
   * Recent crash / ANR captured from logcat (Android) within the runner's
   * observation window. Null when none observed. Lets the LLM surface
   * "the app just crashed" instead of guessing from an unstable tree.
   */
  recentDisruption?: {
    type: 'crash' | 'anr';
    packageName: string;
    snippet: string;
    capturedAt: string;
  } | null;
  /**
   * WebView heuristics. `detected=true` means the screen has at least one
   * WebView host (Capacitor / Cordova / RN-WebView / hybrid). The runner
   * suggests which context the LLM should drive — `webview` flips
   * tap_element to DOM mode after switch_to_webview.
   */
  webView?: { detected: boolean; suggestedContext: 'native' | 'webview' };
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
  /**
   * Real `versionCode` from the build (Android versionCode / iOS
   * CFBundleVersion). Supplied by the uploader at finalize time. Used
   * by the fast-auth snapshot gate — when this differs from the
   * snapshot's `apkVersionCode`, the compiler invalidates the snapshot
   * and falls back to recipe replay. Falls back to CI buildNumber for
   * legacy uploads that pre-date explicit version capture. Undefined
   * when neither is available — the version gate degrades to TTL +
   * runtime-failure invalidation, acceptable for v1.
   */
  appVersionCode?: number;
  /**
   * Human-readable version string ("1.2.3"). Carried purely for
   * logging / display in runner output — NOT used in any gating
   * decision (numeric `appVersionCode` is the single source of truth
   * for fast-auth invalidation).
   */
  appVersionName?: string;
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
  /**
   * Job-level retry counter. Incremented by the worker before re-throwing
   * to BullMQ on retry-able errors (runner unreachable, transient 503,
   * Redis hiccup). Mirrors the web TestJobData.retryCount field used by
   * manual-test-run.job.ts:322-329 to gate `shouldRetry()`. Initial value
   * is undefined → treated as 0 inside the worker. Capped at
   * `MOBILE_TEST_MAX_RETRIES` (env, default 1) so a permanently-broken
   * runner doesn't infinitely retry.
   */
  retryCount?: number;
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
