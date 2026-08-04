/**
 * Mobile Runner API Types
 * Mirror of qait-mobile-runner's API contract.
 * These are COPIES, not imports — runner is a separate microservice.
 */

// ── Platform ─────────────────────────────────────────────────────

export type MobilePlatform = 'android' | 'ios' | 'flutter';

/**
 * The OS that hosts a Flutter (or RN) session — which pool/simulator to
 * acquire, which artifact shard to read, which runner to route to
 * (ADR-0019's "host lane"). Persisted per test case
 * (`intent_test_cases.host_platform`, NULL = inherit) with the project
 * default in `projects.settings.flutterDefaultHost`.
 */
export type FlutterHostPlatform = 'android' | 'ios';

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

/**
 * The app framework detected at APK/IPA upload time
 * (`mobile_app_builds.detectedFramework` / `projects.settings.mobileApp`).
 */
export type DetectedFramework = 'android' | 'ios' | 'flutter' | 'react-native';

/**
 * Derive the test-case storage platform from the app's detected framework.
 *
 * Why this exists: a Flutter app's UI is one opaque canvas, so the runner's
 * live ui-state reports the HOST platform (`android`/`ios`), never `flutter`.
 * If we save a test case using that host value it becomes `mobile_android`,
 * and the regression/warmup paths then create a plain Android session and
 * SKIP `attach-flutter` — so the Flutter VM is never connected and element
 * resolution reads an empty native tree. Deriving the key from the upload-time
 * `detectedFramework` keeps Flutter apps on the Flutter path.
 *
 * `hostPlatform` only disambiguates non-flutter cases (e.g. react-native on
 * iOS → mobile_ios). Defaults to android when nothing is known.
 */
export function frameworkToMobilePlatformKey(
  framework: DetectedFramework | undefined,
  hostPlatform?: 'android' | 'ios',
): MobilePlatformKey {
  if (framework === 'flutter') return 'mobile_flutter';
  if (framework === 'ios') return 'mobile_ios';
  // React-Native runs on either host — respect hostPlatform so RN-on-iOS
  // isn't mislabeled mobile_android. Falls through to the host check below.
  if (hostPlatform === 'ios') return 'mobile_ios';
  // 'android', 'react-native' on android, or unknown → native android stack.
  return 'mobile_android';
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
  /**
   * When true, the runner marks this session as DEDICATED: excluded from TTL
   * cleanup + capacity eviction (so its persistent container survives) and
   * guarded by a per-serial lock. Set ONLY on the dedicated-emulator routing
   * path alongside a pinned `deviceSelector.serial`. See dedicated-device.service.
   */
  dedicated?: boolean;
}

// ── Action Types (mirror of runner's IntentActionType) ───────────

export type MobileIntentActionType =
  // Web-compatible actions (mapped to mobile commands by runner)
  | 'click' | 'type' | 'scroll' | 'press' | 'hover'
  | 'assert' | 'ai_check' | 'extract_text' | 'navigate' | 'wait' | 'screenshot'
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
  | 'network'
  // Stage a file on the device and drive the system picker to select it.
  // `step.value` carries a durable public URL (the editor's Supabase
  // publicUrl); `description` names the element that opens the picker, and an
  // empty description means stage-only. Android hosts only — the runner
  // rejects a URL source on iOS explicitly.
  | 'upload'
  // Device conditions (runner: set_geolocation/clear_geolocation, set_orientation)
  | 'geolocation'       // mock GPS location (set lat/lng, or clear)
  | 'rotate'            // device orientation (portrait / landscape / reverse_*)
  // V-cross-app: run another saved test case at this point in the sequence,
  // possibly on a different platform. Informational only — the backend
  // orchestrator resolves this step before dispatch; the runner never
  // receives it (see MobileIntentStepOptions.linkTestCase).
  | 'link_test_case';

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
  /**
   * Opt-in per-step AI VISUAL check (mirror of the runner's
   * IntentStepOptions.visualCheck). When `enabled`, the runner runs a vision
   * pass over the post-step screenshot for defects the a11y-tree / rule path
   * can't see (text truncation, overlap, contrast, blank/stuck screen,
   * keyboard-over-input, …) and returns them in `MobileStepResult.visualIssues`.
   * Non-fatal by default; `failOnIssue` fails the step on a detected issue.
   */
  visualCheck?: { enabled: boolean; failOnIssue?: boolean };
  /**
   * Typing realism for a type step (editor "type like a human" toggle).
   * 'human' = per-character, 'instant' = atomic, 'auto'/undefined = the runner's
   * heuristic. Forwarded verbatim into the runner type_text command's typeMode.
   * Flutter-only effect; native typing is always per-key.
   */
  typeMode?: 'auto' | 'human' | 'instant';
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  /** Natural-language description of a scrollable container to scroll INSIDE
   *  (e.g. "the comments list"). The runner resolves it semantically and
   *  swipes within the resolved element; empty → full-screen scroll. Mirrors
   *  the web editor's options.scrollContainerDescription. */
  scrollContainerDescription?: string;
  /** Swipe direction (mobile swipe step). Distinct from scrollDirection so
   *  editor swipe steps don't conflict with scroll steps semantically.
   *  Forwarded by the frontend; runner reads it via resolveDirection(). */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Swipe distance hint (0-1 normalised). Forwarded by the editor. */
  distance?: number;
  /**
   * Upload step — mirrors the web upload step's descriptor. `sourceType:
   * 'storage'` means `step.value` is a durable Supabase publicUrl (from
   * POST /api/v1/preview/upload-file); `'url'` means an author-supplied
   * public URL. The runner downloads it at dispatch and pushes it to the
   * device, so nothing here is a runner-host path.
   */
  upload?: {
    sourceType?: 'storage' | 'url';
    filename?: string;
    envVar?: string;
  };
  /** Upload step — original filename, used for the on-device name and for the
   *  filename match in a document picker. */
  uploadFilename?: string;
  /** Upload step — runner-host path form, produced only by the `file`
   *  test-resource compiler, never by the editor. */
  uploadFilePath?: string;
  /** Upload step — override the kind-derived on-device destination. */
  uploadRemotePath?: string;
  /** Upload step — MIME hint ('image/*', 'application/pdf'). Selects both the
   *  on-device destination directory and the expected picker strategy. */
  uploadMimeType?: string;
  continueOnError?: boolean;
  /**
   * Author-time "step is switched off" toggle. `false` = the runner skips this
   * step without dispatching it; absent / `true` = execute. Mirrors the web
   * `StepOptions.enabled`. The runner declares it in `run.schema.ts` too —
   * without that entry Zod strips it at the HTTP boundary and the toggle
   * becomes a silent no-op on mobile.
   */
  enabled?: boolean;
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
  // Geolocation (mock GPS). Field names mirror the runner's own
  // intent-step-converter so a saved step replays identically. `set` needs
  // latitude+longitude; `clear` removes the mock fix.
  geolocationAction?: 'set' | 'clear';
  geolocationLatitude?: number;
  geolocationLongitude?: number;
  geolocationAltitude?: number;
  // Rotate / device orientation.
  rotateOrientation?: 'portrait' | 'landscape' | 'reverse_portrait' | 'reverse_landscape';
  // Dismiss
  /** Free-text hint for `dismiss` steps ("Reading settings sheet"). Advisory
   *  only — the runner always closes the top-most active layer it sees. */
  dismissTarget?: string;
  /** `extract_text` steps only — variable name the runner's scratchpad
   *  stores the resolved element's text under, namespaced as
   *  `extracted.<name>` and referenceable via `{{extracted.<name>}}`. */
  extractVariable?: string;
  /**
   * `link_test_case` steps only — mirrors `StepOptions.linkTestCase` in
   * preview.types.ts. Informational: the runner never executes this step
   * type, so this field never crosses the HTTP boundary to qait-mobile-runner.
   */
  linkTestCase?: {
    linkedTestCaseId: string;
    linkedPlatform: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
    inputBindings?: Array<{ targetParam: string; valueExpr: string }>;
    outputBindings?: Array<{ alias: string; sourceVariable: string }>;
  };
}

export interface MobileIntentStep {
  id: string;
  type: MobileIntentActionType;
  description: string;
  value?: string;
  assertionText?: string;
  bindingHints?: MobileBindingHints;
  options?: MobileIntentStepOptions;
  /**
   * Authoring-time flag: this step's `value` is a credential (password /
   * OTP / token / API key). Set by the mobile agent when it authors a
   * draft step (mirrors the `type_text` tool's isSensitive arg). Primary
   * signal for `sanitizeMobileSteps` — a flagged value is parameterized on
   * save regardless of what the description says; the regex catalogue is
   * only the fallback for unflagged steps.
   */
  isSensitive?: boolean;
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
   * (see mobile-test-run.job.ts:CompiledPlanPersistenceService.persistFromRun) and via
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
  /**
   * Why the step was not executed. `resolvedVia: 'skipped'` is ambiguous — six
   * producers share it (client abort, run timeout, unsupported step, `store`
   * meta-steps, the stopOnFailure tail-fill, and an author-disabled step).
   * `'disabled'` means the AUTHOR switched the step off, which is what billing
   * and the run report key off to avoid charging for it or calling it a pass.
   */
  skipReason?: 'disabled';
  /**
   * Set by the runner when a FAILED ai-check could not produce a trustworthy
   * verdict (circuit_breaker_open / inconclusive / empty_tree / low_confidence /
   * truncated_at_budget / …). Absent on a normal confident fail. Gates the
   * backend `ai_check.errored` audit so a legitimately-failed assertion isn't
   * logged as a system failure.
   */
  aiCheckSkippedReason?: string;
  /** ai_check steps only, pass or fail: the fully-interpolated assertion text
   *  actually evaluated (placeholders resolved via the runner's scratchpad). */
  aiCheckResolvedAssertion?: string;
  /** ai_check steps only, pass or fail: LLM self-reported 0-1 confidence. */
  aiCheckConfidence?: number;
  /** ai_check steps only, pass or fail: 1-2 sentence LLM explanation. */
  aiCheckExplanation?: string;
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
   * mobile-test-run.job.ts CompiledPlanPersistenceService.persistFromRun, session.controller.ts
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
   * Visual defects the opt-in per-step AI visual check found in the post-step
   * screenshot (mirror of the runner's CommandResult.visualIssues). Present
   * only when the step opted in (`options.visualCheck`) and ≥1 issue was found.
   * Persisted into `metadata.steps[]` and folded into the AI-analysis input.
   */
  visualIssues?: Array<{
    type: string;
    severity: 'warning' | 'critical';
    description: string;
    location?: string;
    confidence: number;
  }>;
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
  /**
   * The runner's ENTIRE scratchpad at the point this step completed (e.g.
   * `extracted.orderId`), only present when this step's action modified it
   * (runner gates on `scratchpad.dirty`). The runner has always sent this
   * field (`run.routes.ts`) — it was simply never typed or read on the
   * backend before `link_test_case` needed a way to read a completed run's
   * final captured values back. Take the LAST step (in order) that defines
   * this field to get the run's final accumulated state.
   */
  scratchpadSnapshot?: Record<string, string>;
  /**
   * The USER-authored trigger that fired while this step ran (a dialog/popup was
   * cleared mid-step). Forwarded verbatim by the runner (`id` = the editor's
   * trigger id; `condition`/`action` mirror the `Trigger` contract above, plus
   * the matched surface text). The backend maps it to the web `TriggerFiredPayload`
   * via `buildTriggerFiredPayload` for the editor's "TRIGGER"/"FIRED" indicators
   * and persists it into the saved run report. Absent when no user trigger fired.
   */
  triggerFired?: Trigger & { matchedText?: string };
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

// ── Triggers ─────────────────────────────────────────────────────

/**
 * User-defined event→action rule forwarded VERBATIM to the mobile runner.
 *
 * CANONICAL CROSS-REPO CONTRACT — this shape is mirrored exactly by the runner
 * (qait-mobile-runner src/api/schemas/run.schema.ts `triggerSchema`). The
 * runner matches a trigger BEFORE its built-in permission policy. There is NO
 * `source` field — that's runner-internal (defaults to 'user'). Do NOT add
 * fields here without changing the runner schema in lockstep.
 *
 * Persisted per-test on `intent_test_cases.triggers`, echoed into the BullMQ
 * mobile job, and sent in the run-steps body.
 */
export type TriggerCondition =
  | { kind: 'permission_dialog' }
  | { kind: 'any_dialog' }
  | { kind: 'dialog_text'; contains: string };

export type TriggerAction =
  | { kind: 'permission'; decision: 'allow' | 'deny' }
  | { kind: 'tap'; text: string }
  | { kind: 'back' };

export interface Trigger {
  id: string;
  condition: TriggerCondition;
  action: TriggerAction;
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
  /**
   * User-defined triggers active for this run (matched before the built-in
   * permission policy). Forwarded verbatim — see the `Trigger` contract above.
   * Omitted when the test has none.
   */
  triggers?: Trigger[];
  /**
   * Android versionCode / iOS CFBundleVersion of the app under test. The runner
   * stashes it on the session and folds it into the element-resolver cache key,
   * so a cached pick from a different build (same runner process, within the
   * cache TTL) is never replayed against a new build. Omitted when unknown.
   */
  appVersionCode?: number;
}

export interface MobileRunStepsResponse {
  sessionId: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  /**
   * Steps the AUTHOR switched off, counted apart from `skippedSteps` ("meant to
   * run, couldn't"). Billing subtracts these so a step that never reached the
   * device isn't charged (×4 on mobile). Absent on runners predating the
   * flag — treat as 0.
   */
  userSkippedSteps?: number;
  passRate: number;
  steps: MobileStepResult[];
  durationMs: number;
  status: 'passed' | 'failed' | 'partial';
  /** Test-level metadata echoed from the request */
  metadata?: MobileTestMetadata;
  /**
   * Screenshot of the starting screen, captured BEFORE any step ran ("step 0").
   * Base64 from the runner; uploaded to a URL by the job before persisting.
   */
  initialScreenshot?: string;
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

// ── Phase B5 — runner observation endpoints ──────────────────────

/**
 * Response shape from runner `GET /api/sessions/:id/foreground`.
 * Mirrors what `qait-mobile-runner/src/api/routes/session.routes.ts`
 * emits — keep in sync if the runner contract evolves.
 *
 * `foreground` is intentionally typed as the same `MobileActualForeground`
 * we already use inside `MobileUiState` — the runner returns the same
 * shape from both endpoints so backend tools can swap eager-inject and
 * tool-call paths without re-mapping.
 */
export interface MobileForegroundResponse {
  sessionId: string;
  platform: 'android' | 'ios';
  expectedApp?: string;
  foreground: MobileActualForeground;
  mismatch: { expected: string; actual: string } | null;
  capturedAt: string;
}

/**
 * Single step entry in `MobileStepHistoryResponse.steps`. Mirrors the
 * runner's `RedactedStepSummary` from `runner/step-history.ts` — the
 * sensitive field (`type_text.text`) has already been replaced with
 * `{ inputLength, inputClass }` upstream. Backend may still apply an
 * additional layer of PII redaction defence-in-depth (Phase B-SEC).
 */
export interface MobileStepSummary {
  stepIndex: number;
  commandType: string;
  paramsSummary: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  startedAt: number;
  completedAt: number;
}

export interface MobileStepHistoryResponse {
  sessionId: string;
  steps: MobileStepSummary[];
  /** False ⇒ caller passed `?includeRawInputs=true`. */
  redacted: boolean;
  capturedAt: string;
}

export type MobileLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Response shape from runner `GET /api/sessions/:id/logs`. The runner
 * already caps payload at ~2KB and applies the requested `level` filter
 * before returning. Lines are unparsed (raw `adb logcat -d` output for
 * Android, `xcrun simctl log show` for iOS sim, `go-ios syslog` for
 * physical iOS).
 */
export interface MobileLogsResponse {
  sessionId: string;
  platform: 'android' | 'ios';
  level: MobileLogLevel;
  lines: string[];
  /** True when the runner's 2KB cap kicked in OR a single line was character-truncated. */
  truncated: boolean;
  capturedAt: string;
}

// ── BullMQ Job Data ──────────────────────────────────────────────

export interface MobileTestJobData {
  testId: string;
  userId: string;
  workspaceId: string;
  projectId?: string;
  chatSessionId?: string;
  platform: MobilePlatform;
  /**
   * Host lane for a `flutter` job (ADR-0019): which OS the worker acquires
   * and which runner URL was stamped. Resolved at dispatch time
   * (case override > project default > 'android'). Absent = 'android'
   * (back-compat for in-flight jobs enqueued before this field existed).
   * Ignored for native platforms.
   */
  hostPlatform?: FlutterHostPlatform;
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
   * User-defined triggers echoed from `intent_test_cases.triggers`. Carried
   * verbatim through Redis (no secrets — pure event→action rules) and forwarded
   * to the runner in the run-steps body. Omitted when the test has none.
   */
  triggers?: Trigger[];
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
  /**
   * V-cross-app continuation: when set, this job RESUMES an existing live
   * mobile session instead of acquiring/prepping a new one. Used for the
   * "steps" segment that runs after a cross-platform `link_test_case` —
   * without this, that segment goes through the normal session-acquire +
   * MobileAppPrepService.prepApp + attachFlutter pipeline, which force-stops
   * and relaunches the app, discarding any typed-but-not-yet-submitted UI
   * state from before the link (confirmed incident 2026-07-06 — a phone
   * number typed before the link was gone by the time the continuation
   * segment ran). Skips session acquisition, permission-policy apply,
   * prepApp, fast-auth restore, and attachFlutter entirely — goes straight
   * to Phase 4 (run steps) against this exact sessionId.
   */
  resumeSessionId?: string;
  /**
   * The ORIGINAL sessionSource ('pool'|'warmup'|'cold'|'dedicated') the
   * resumed session was acquired under. Required alongside
   * `resumeSessionId` so the LAST segment's cleanup (release vs end vs
   * destroy) still does the right thing — a resuming job never went
   * through Phase 3 acquisition itself, so it has no other way to learn
   * this. Ignored when `resumeSessionId` is absent.
   */
  resumeSessionSource?: 'pool' | 'warmup' | 'cold' | 'dedicated';
  /**
   * V-cross-app continuation: when true, this job's `finally` block must
   * NOT release/end/destroy its session — a later segment (dispatched with
   * `resumeSessionId` set to this session) will continue using it. Set on
   * every segment except the last one in a chain, so the session is still
   * cleaned up eventually.
   */
  keepSessionAlive?: boolean;
}

// ── Exploration (autonomous app crawl) ─────────────────────────────
// Shapes for the runner's /api/explorer/* API, brokered by the backend
// so the runner API key never reaches the browser. Kept intentionally
// loose for the snapshot — it's the runner's UI-contract object and the
// backend only reads a handful of fields (status, stats, flows). The
// relay/job slices narrow what they consume.

/** Runner response to POST /api/explorer/sessions/:id/start (202). */
export interface MobileExplorationStartResponse {
  runId: string;
  status: string; // ExplorationStatus on the runner: 'running' | 'awaiting_user' | …
}

/**
 * Structured pre-exploration context forwarded to the runner. Mirrors the
 * runner's AppBriefing. Carries NO credentials by design — test credentials
 * are handled through the runner's answer/redaction seam, never this blob.
 */
export interface MobileAppBriefing {
  description?: string;
  region?: string;
  keyFlows?: string[];
  avoid?: string[];
  /** Field-format rules for the FormFiller (e.g. "promo code = 8 uppercase"). */
  dataHints?: string;
  /** Per-flow success conditions the agent asserts ("an order number appears"). */
  successCriteria?: string[];
}

/** Runner readiness probe — GET /api/explorer/readiness. */
export interface MobileExplorationReadiness {
  runner: { ok: boolean; version?: string };
  llm: { openaiKeySet: boolean; geminiKeySet: boolean; explorerModel?: string };
  defaults?: { budget?: Record<string, number> };
}

/**
 * UI-contract snapshot returned by GET /runs/:id and /runs/:id/result.
 * Loosely typed on purpose — the runner owns this shape. `status` and
 * `stats` are the fields the backend job/relay rely on.
 */
export interface MobileExplorationSnapshot {
  runId?: string;
  status?: string;
  entryUrl?: string;
  stats?: Record<string, unknown>;
  flows?: unknown[];
  pages?: unknown[];
  [key: string]: unknown;
}

// ── Error ─────────────────────────────────────────────────────────

export class MobileRunnerError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code?: string,
    /**
     * Runner-supplied cause for a reclaimed session (`idle_ttl` / `evicted` /
     * `device_disconnected` / `rest_delete` / …), parsed from the 404 body.
     * Used to trace WHY the editor's "session expired" fired.
     */
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'MobileRunnerError';
  }
}
