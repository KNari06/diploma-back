/**
 * WebSocket Types and Interfaces
 * All events and payloads for client-server communication
 */

import type {
  IntentActionType,
  StepOptions,
  BindingHints,
  StepEvidence,
  TargetFingerprint,
} from '@/services/testing/ui/preview/preview.types';

// ============================================================================
// CLIENT → SERVER EVENTS
// ============================================================================

export interface ClientToServerEvents {
  // Subscriptions
  'subscribe:test': (data: { testId: string }) => void;
  'unsubscribe:test': (data: { testId: string }) => void;
  'subscribe:chat': (
    data: { sessionId: string },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  'unsubscribe:chat': (data: { sessionId: string }) => void;

  // Preview subscriptions
  'subscribe:preview': (data: { previewSessionId: string }) => void;
  'unsubscribe:preview': (data: { previewSessionId: string }) => void;

  // Preview step operations
  'preview:step:lint': (data: PreviewStepLintRequest) => void;
  'preview:step:apply': (data: PreviewStepApplyRequest) => void;
  'preview:step:clarify:select': (data: PreviewClarifySelectRequest) => void;

  // Mobile step operations (applies through the mobile runner over a WS round-trip
  // instead of a REST call, so the frontend gets the same live-update semantics as web.)
  'mobile:step:apply': (data: MobileStepApplyRequest) => void;

  // Preview run operations (V8: Run from start)
  'preview:run:start': (data: PreviewRunStartRequest) => void;
  'preview:run:cancel': (data: PreviewRunCancelRequest) => void;

  // Inspect the preview context's auth/session state (cookies + storage
  // key counts) WITHOUT mutating anything. Used by the Run button to
  // detect an active session before starting a run and ask the user
  // whether to keep or clear it. Response: `preview:session:state`.
  'preview:session:inspect': (data: PreviewSessionInspectRequest) => void;

  // Test Resources — live preview actions (Phase 4):
  //
  //   apply-resource: inject a saved Login (cookies + localStorage) into
  //     the live preview context so the user can keep authoring from an
  //     authenticated state without re-typing credentials. Server responds
  //     with `preview:apply-resource:result`.
  //
  //   save-login: snapshot the preview's current storageState as a Login
  //     resource. Creates a new resource when `resourceId` is omitted, or
  //     updates (re-captures) an existing one when provided. Server
  //     responds with `preview:save-login:result`.
  'preview:apply-resource': (data: {
    previewSessionId: string;
    resourceId: string;
  }) => void;
  'preview:save-login': (data: {
    previewSessionId: string;
    /** Update existing resource when set; otherwise create a new one. */
    resourceId?: string;
    /** Required on create, ignored on update. */
    name?: string;
    description?: string;
    /** Scope hints — backend falls back to current URL's hostname. */
    domain?: string;
    ttlSeconds?: number;
    /** If true AND creating, upsert workspace default for the scope. */
    setAsDefault?: boolean;
  }) => void;

  // Preview interactive control (mouse/keyboard)
  'preview:mouse:move': (data: PreviewMouseMoveRequest) => void;
  'preview:mouse:click': (data: PreviewMouseClickRequest) => void;
  'preview:mouse:down': (data: PreviewMouseButtonRequest) => void;
  'preview:mouse:up': (data: PreviewMouseButtonRequest) => void;
  'preview:mouse:wheel': (data: PreviewMouseWheelRequest) => void;
  'preview:mouse:probe': (data: PreviewMouseProbeRequest) => void;
  'preview:keyboard:type': (data: PreviewKeyboardTypeRequest) => void;
  'preview:keyboard:press': (data: PreviewKeyboardPressRequest) => void;

  // Preview viewport
  'preview:viewport:set': (data: PreviewViewportSetRequest) => void;

  // Preview recording
  'preview:recording:start': (data: PreviewRecordingRequest) => void;
  'preview:recording:stop': (data: PreviewRecordingRequest) => void;
  // Inline upload picker responses (correlated by stepId with a
  // `preview:recording:upload:prompt` emitted from the server).
  'preview:recording:upload:resolve': (
    data: PreviewRecordingUploadResolveRequest,
  ) => void;
  'preview:recording:upload:cancel': (
    data: PreviewRecordingUploadCancelRequest,
  ) => void;

  // Preview page actions (refresh, reset, back, forward)
  'preview:page:refresh': (data: { previewSessionId: string }) => void;
  'preview:page:reset': (data: { previewSessionId: string }) => void;
  'preview:page:back': (data: { previewSessionId: string }) => void;
  'preview:page:forward': (data: { previewSessionId: string }) => void;

  // V15: Multi-tab events (client → server)
  'preview:tab:switch': (data: { previewSessionId: string; tabIndex: number }) => void;
  // Close a popup/secondary tab. Root tab (index 0) can't be closed via
  // this event — server refuses. Backend responds by rebroadcasting
  // `preview:tab:closed` with the updated tabs list.
  'preview:tab:close': (data: { previewSessionId: string; tabIndex: number }) => void;

  // Preview DevTools (on-demand requests)
  'preview:network:detail:request': (data: PreviewNetworkDetailRequest) => void;
  'preview:network:list:request': (data: PreviewNetworkListRequest) => void;
  'preview:html:request': (data: PreviewHtmlRequest) => void;
  'preview:accessibility:request': (data: PreviewAccessibilityRequest) => void;
  'preview:context:set': (data: PreviewContextSetRequest) => void;

  // Clarification
  'test:clarification:response': (data: { testId: string; questionId: string; answer: string }) => void;
  'exploration:clarification:response': (data: { questionId: string; answer: string }) => void;

  // Heartbeat
  ping: () => void;
}

// ============================================================================
// SERVER → CLIENT EVENTS
// ============================================================================

export interface ServerToClientEvents {
  // Connection events
  authenticated: (data: AuthenticatedPayload) => void;
  error: (data: ErrorPayload) => void;

  // Test lifecycle events
  'test:created': (data: TestCreatedPayload) => void;
  'test:started': (data: TestStartedPayload) => void;
  'test:progress': (data: TestProgressPayload) => void;
  'test:graph-update': (data: TestGraphUpdatePayload) => void; // ✅ NEW: Real-time graph streaming
  'test:step:completed': (data: TestStepCompletedPayload) => void;
  'test:browser:completed': (data: TestBrowserCompletedPayload) => void;
  'test:completed': (data: TestCompletedPayload) => void;
  'test:failed': (data: TestFailedPayload) => void;
  'test:cancelled': (data: TestCancelledPayload) => void;
  'test:clarification:request': (data: TestClarificationRequestPayload) => void; // ✅ NEW: Request user input during test

  // Video streaming events (Chrome CDP screencast)
  'test:video:frame': (data: TestVideoFramePayload) => void;
  'test:video:stats': (data: TestVideoStatsPayload) => void;
  'test:video:paused': (data: TestVideoPausedPayload) => void;
  'test:video:resumed': (data: TestVideoResumedPayload) => void;
  'test:video:stopped': (data: TestVideoStoppedPayload) => void;
  'test:video:unavailable': (data: TestVideoUnavailablePayload) => void;
  'test:video:started': (data: TestVideoStartedPayload) => void;

  // Result events
  'result:ready': (data: ResultReadyPayload) => void;
  'result:screenshot': (data: ResultScreenshotPayload) => void;
  'result:error': (data: ResultErrorPayload) => void;

  // AI Analysis events
  'ai:analysis:started': (data: AIAnalysisStartedPayload) => void;
  'ai:analysis:progress': (data: AIAnalysisProgressPayload) => void;
  'ai:analysis:completed': (data: AIAnalysisCompletedPayload) => void;
  'ai:bug:found': (data: AIBugFoundPayload) => void;

  // AI action log (one row per LLM call) — pushed to the owning user.
  'ai:log:new': (data: AIActionLogPayload) => void;

  // System (Winston) log entry — pushed only to users with `users.show_logs=true`.
  'system:log:new': (data: SystemLogPayload) => void;

  // Chat events
  'chat:message': (data: ChatMessagePayload) => void;
  'chat:test:update': (data: ChatTestUpdatePayload) => void;
  'chat:processing:step': (data: ChatProcessingStepPayload) => void;
  'api:agent:step': (data: ApiAgentStepPayload) => void;

  // Regression run events
  'regression:run:progress': (data: RegressionRunProgressPayload) => void;

  /**
   * Regression Doctor finished aggregating drift patterns for a completed
   * run. `findingsCount` is 0 when no drift patterns were found — the UI
   * should still refresh its "Doctor findings" panel to hide any stale
   * spinner from an in-flight request. Payload is intentionally minimal;
   * the UI fetches full findings via GET /api/regression/:runId/doctor.
   */
  'regression:doctor:ready': (data: {
    runId: string;
    findingsCount: number;
    timestamp: string;
  }) => void;

  // Exploration events
  'exploration:progress': (data: ExplorationProgressPayload) => void;
  'exploration:completed': (data: ExplorationCompletedPayload) => void;
  'exploration:clarification:request': (data: ExplorationClarificationPayload) => void;

  // Negative testing events
  'negatives:generation:started': (data: any) => void;
  'negatives:generation:progress': (data: any) => void;
  'negatives:generation:completed': (data: any) => void;

  // Allure import events
  'allure:import:progress': (data: AllureImportProgressWSPayload) => void;
  'allure:import:completed': (data: AllureImportCompletedWSPayload) => void;
  'allure:import:failed': (data: AllureImportFailedWSPayload) => void;

  // System events
  'system:error': (data: SystemErrorPayload) => void;
  'system:maintenance': (data: SystemMaintenancePayload) => void;

  // Preview events
  'preview:page': (data: PreviewPagePayload) => void;
  // V20: Frame is sent as 2-arg emit — meta object + raw JPEG bytes (Buffer/ArrayBuffer)
  // Socket.IO 4.x serializes Buffer/ArrayBuffer/Uint8Array as binary frames over the wire
  // (no base64 inflation). The legacy `data: string` field on the meta object is kept for
  // backward compat but is empty when binary transport is used.
  'preview:video:frame': (meta: PreviewVideoFramePayload, frame?: Buffer | ArrayBuffer | Uint8Array) => void;
  'preview:step:lint:result': (data: PreviewStepLintResultPayload) => void;
  'preview:step:apply:result': (data: PreviewStepApplyResultPayload) => void;
  'preview:step:clarify': (data: PreviewClarifyPayload) => void;

  // Mobile apply result — mirrors preview:step:apply:result shape
  'mobile:step:apply:result': (data: MobileStepApplyResultPayload) => void;

  // Preview run events (V8: Run from start)
  'preview:run:started': (data: PreviewRunStartedPayload) => void;
  'preview:run:step': (data: PreviewRunStepPayload) => void;
  'preview:run:completed': (data: PreviewRunCompletedPayload) => void;
  'preview:run:cancelled': (data: { previewSessionId: string }) => void;
  // Emitted right before the run starts when authReset='always' found and cleared
  // cookies and/or localStorage/sessionStorage from a prior run. UI should show a
  // small info banner so the user isn't surprised that their logged-in session got
  // wiped. Any of the three counters can be 0 (e.g. pure-cookie session has no
  // localStorage keys; pure-localStorage JWT has no cookies).
  'preview:run:auth-reset': (data: {
    previewSessionId: string;
    cookiesCleared: number;
    localStorageKeysCleared: number;
    sessionStorageKeysCleared: number;
    reason: string;
    timestamp: string;
  }) => void;

  // Per-step URL mismatch warning. Fires when the live preview URL differs
  // (after origin+path normalization) from the URL captured at recording
  // time for that step. Non-fatal — the run continues. Frontend uses this
  // to show a yellow badge on the step row so the user can spot why a fail
  // happened: "step recorded on /admin/users, ran on /". The most common
  // cause is the user clicking around the preview between Apply All and
  // recording the next batch, leaving step N+1's recorded fingerprint
  // pointing at a page state that no longer exists at run time.
  'preview:run:url-mismatch': (data: {
    previewSessionId: string;
    stepIndex: number;
    stepId: string;
    recordedUrl: string;
    actualUrl: string;
  }) => void;

  // Mobile editor session has expired (idle for IDLE_TTL_MS, or backend
  // detected the FE↔BE socket has gone away). Frontend should close the
  // editor modal, clear `intentTestCaseId` from the URL, toast the user,
  // and bounce back to the Repository view. The runner emulator is
  // intentionally left alive on idle so re-opening the test case is fast.
  'mobile:session:expired': (data: { reason: 'idle' | 'disconnect' }) => void;

  // Response to `preview:session:inspect`. Contains non-sensitive counts
  // + sameOrigin flag so the frontend can decide whether to prompt the
  // user before a Run. Counts are zero if the context is pristine.
  //
  // `sameOrigin` tells the UI whether the Playwright context is already
  // on the test's target origin — when false, localStorage/sessionStorage
  // cannot be inspected (origin-scoped). In that case storage counts
  // are 0 even if data exists; the banner should hint this as
  // "cookies only (localStorage will be checked after navigation)".
  'preview:session:state': (data: {
    previewSessionId: string;
    cookieCount: number;
    localStorageKeyCount: number;
    sessionStorageKeyCount: number;
    currentUrl: string;
    sameOriginAsStartUrl: boolean;
    /**
     * Names of cookies visible in the context (not values). Lets the UI
     * say "Session cookies: sessionid, csrftoken" when the user hovers
     * for detail. Capped to 20 names; trailing ones elided.
     */
    cookieNames: string[];
    /**
     * Present if the client asked for a same-origin storage snapshot
     * AND the page is same-origin. Omitted otherwise. Values are never
     * returned — just keys — so this payload is safe to log/persist.
     */
    localStorageKeys?: string[];
    timestamp: string;
  }) => void;

  // Preview DevTools events (server -> client)
  'preview:console:update': (data: PreviewConsoleUpdatePayload) => void;
  'preview:network:update': (data: PreviewNetworkUpdatePayload) => void;
  'preview:network:detail': (data: PreviewNetworkDetailPayload) => void;
  'preview:network:list': (data: PreviewNetworkListPayload) => void;
  'preview:html:update': (data: PreviewHtmlUpdatePayload) => void;
  'preview:accessibility:update': (data: PreviewAccessibilityUpdatePayload) => void;
  'preview:context:update': (data: PreviewContextUpdatePayload) => void;

  // Preview dialog events (native alert/confirm/prompt auto-dismissed)
  'preview:dialog': (data: PreviewDialogPayload) => void;

  // Preview page switch events (popup/new tab auto-switch)
  'preview:page:navigated': (data: { previewSessionId: string; url: string; previousUrl: string; reason: string; timestamp: string }) => void;

  // V15: Multi-tab events
  'preview:tab:opened': (data: { previewSessionId: string; tabs: Array<{ tabIndex: number; url: string; title?: string; isActive: boolean }>; activeTabIndex: number; timestamp: string }) => void;
  'preview:tab:switched': (data: { previewSessionId: string; tabs: Array<{ tabIndex: number; url: string; title?: string; isActive: boolean }>; activeTabIndex: number; timestamp: string }) => void;
  'preview:tab:closed': (data: { previewSessionId: string; tabs: Array<{ tabIndex: number; url: string; title?: string; isActive: boolean }>; activeTabIndex: number; closedTabIndex: number; timestamp: string }) => void;
  'preview:tab:list': (data: { previewSessionId: string; tabs: Array<{ tabIndex: number; url: string; title?: string; isActive: boolean }>; activeTabIndex: number; timestamp: string }) => void;

  // Preview loading progress (emitted during slow page loads > 5s)
  'preview:loading': (data: {
    previewSessionId: string;
    phase: 'navigating' | 'dom_ready' | 'stabilizing' | 'complete' | 'error';
    url: string;
    elapsedMs: number;
    error?: string;
  }) => void;

  // Preview session startup progress (emitted to user room — client not yet subscribed to preview room)
  'preview:session:progress': (data: {
    stage: 'launching_browser' | 'loading_page' | 'extracting_elements' | 'ready';
    progress: number;     // 0-100
    url?: string;
    elapsedMs: number;
  }) => void;

  // Login required — emitted when the preview lands on a login / auth
  // gate (URL match OR visible password field). Frontend uses this to
  // surface the "Log in now / Use existing Login" chooser over the
  // preview. Signal (one of):
  //   'url'  — the URL matches /login|/signin|/auth/ patterns
  //   'form' — the DOM contains a visible password input
  //   'both' — both signals agree (highest confidence)
  // `suggestedDomain` is the canonical hostname suitable for creating
  // a new Login resource scoped to this site.
  'preview:auth:required': (data: {
    previewSessionId: string;
    signal: 'url' | 'form' | 'both';
    url: string;
    suggestedDomain?: string;
    timestamp: string;
  }) => void;

  // Fires when the external-navigation trap reverts a cross-origin main-frame
  // navigation that wasn't user-initiated (e.g. a JS-driven location.href to
  // a payment gateway, a button.onclick redirect, a form submit). The trap
  // already restored the page to the prior safe URL before emitting this —
  // the frontend just shows a toast so the user knows what happened.
  'preview:external-nav:blocked': (data: {
    previewSessionId: string;
    blockedUrl: string;
    blockedHostname: string;
    baselineUrl: string;
    baselineHostname: string;
    timestamp: string;
  }) => void;

  // Ack for `preview:apply-resource`. `resource` is included on success so
  // the frontend can update its local cache (e.g. bump lastUsedAt) without
  // a round-trip. `error` is a user-facing message on failure.
  'preview:apply-resource:result': (data: {
    previewSessionId: string;
    success: boolean;
    resourceId: string;
    resourceName?: string;
    error?: string;
    timestamp: string;
  }) => void;

  // Ack for `preview:save-login`. On success, `resource` echoes the stored
  // row (minus sensitive fields) so the frontend can list/attach it without
  // an extra GET. On failure, `error` carries a short human-readable reason.
  'preview:save-login:result': (data: {
    previewSessionId: string;
    success: boolean;
    resource?: {
      id: string;
      name: string;
      kind: 'auth';
      status: 'active' | 'stale' | 'broken';
      capturedAt?: string;
      expiresAt?: string;
      scope?: Record<string, unknown>;
    };
    /** True when we updated an existing row, false when we created one. */
    updated?: boolean;
    error?: string;
    timestamp: string;
  }) => void;

  // Preview recording events
  'preview:recording:step': (data: PreviewRecordingStepPayload) => void;
  'preview:recording:step:update': (data: PreviewRecordingStepPayload) => void;
  'preview:recording:step:remove': (data: { previewSessionId: string; stepId: string; stepCount?: number; timestamp: string }) => void;
  'preview:recording:state': (data: PreviewRecordingStatePayload) => void;
  /**
   * Emitted when a file upload could not be captured during recording.
   * The UI should surface this so the user knows the Upload click did not
   * turn into a step (previously this path was silent).
   */
  'preview:recording:upload:warning': (data: PreviewRecordingUploadWarningPayload) => void;
  /**
   * Server -> client: a filechooser event fired on the recording page. UI
   * should render an inline file picker for this placeholder stepId and
   * respond with `preview:recording:upload:resolve` or
   * `preview:recording:upload:cancel`.
   */
  'preview:recording:upload:prompt': (data: PreviewRecordingUploadPromptPayload) => void;

  // Preview interactive control responses
  'preview:viewport': (data: PreviewViewportPayload) => void;
  'preview:mouse:result': (data: PreviewMouseResultPayload) => void;
  'preview:mouse:probe:result': (data: PreviewMouseProbeResultPayload) => void;
  'preview:page:action:result': (data: PreviewPageActionResultPayload) => void;

  // Mobile emulator boot/install progress (emitted to user room during APK upload)
  'mobile:boot:status': (data: {
    projectId: string;
    stage: 'booting' | 'installing' | 'launching' | 'ready' | 'error';
    message: string;
    sessionId?: string;
  }) => void;

  // Heartbeat response (echoes client timestamp for RTT measurement)
  pong: (data: { t?: number }) => void;

  // API Flow events
  'api:flow:parsing': (data: ApiFlowParsingPayload) => void;
  'api:flow:dag-ready': (data: ApiFlowDagReadyPayload) => void;
  'api:flow:step-start': (data: ApiFlowStepStartPayload) => void;
  'api:flow:step-complete': (data: ApiFlowStepCompletePayload) => void;
  'api:flow:variable-extracted': (data: ApiFlowVariableExtractedPayload) => void;
  'api:flow:completed': (data: ApiFlowCompletedPayload) => void;
  'api:flow:failed': (data: ApiFlowFailedPayload) => void;
}

// ============================================================================
// PAYLOAD TYPES
// ============================================================================

// Connection
export interface AuthenticatedPayload {
  userId: string;
  isAnonymous: boolean;
  timestamp: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  timestamp: string;
}

// Test Events
export interface TestCreatedPayload {
  testId: string;
  url: string;
  browsers: string[];
  userId?: string;
  timestamp: string;
}

export interface TestStartedPayload {
  testId: string;
  browser: string;
  timestamp: string;
  sessionId?: string;
  source?: 'chat' | 'regression';
}

/**
 * State diff summary for frontend visualization
 * Allows highlighting what changed after each action
 */
export interface StateDiffSummary {
  urlChanged: boolean;
  addedCount: number;      // Number of new elements
  removedCount: number;    // Number of removed elements
  changedRefs: string[];   // Refs of changed elements (for highlighting)
  newErrors: number;       // Number of new errors detected
}

export interface TestProgressPayload {
  testId: string;
  browser: string;
  progress: number; // 0-100
  phase: string; // 'initialization' | 'analysis' | 'planning' | 'execution' | 'finalization'
  currentStep?: string;
  icon?: string; // Icon name for frontend display (e.g., 'click', 'fill', 'navigate', 'wait', etc.)
  action?: {
    type: string; // 'click' | 'fill' | 'navigate' | etc.
    description: string;
    target?: string; // CSS selector
  };
  totalSteps?: number;
  completedSteps?: number;
  status?: string; // 'queued' | 'running' | 'completed' | 'failed'
  /**
   * Retry attempt number (0 = first run, 1+ = subsequent retries after
   * executePlaywrightTestWithRetry re-invokes the executor). Frontend uses
   * this to reset the live step list when a retry begins, so repeated
   * `test:step:completed` events with the same `step` don't look like cycles.
   */
  attempt?: number;
  timestamp: string;
  elapsedTime?: number; // Milliseconds since test start
  estimatedRemaining?: number; // Estimated milliseconds remaining
  diff?: StateDiffSummary; // State diff for frontend highlighting
  sessionId?: string; // Chat session ID for routing isolation
}

export interface TestStepCompletedPayload {
  testId: string;
  browser: string;
  step: number;
  /** Retry attempt number (0 = first run, 1+ = retries). See TestProgressPayload.attempt. */
  attempt?: number;
  stepDescription: string;
  success: boolean;
  timestamp: string;
  /**
   * V2: Runtime metadata for intent-based test steps
   * Provides detailed information about element resolution and execution
   */
  runtimeMeta?: {
    /** Step ID from IntentStep */
    stepId?: string;
    /** Final status: executed, healed, or failed */
    runtimeStatus?: 'executed' | 'healed' | 'failed';
    /** Source of element resolution */
    source?: 'compiled' | 'resolver' | 'self_heal';
    /** Confidence tier of the resolution */
    confidenceTier?: 'high' | 'medium' | 'low';
    /** Reason for failure (if status is failed) */
    failedReason?:
      | 'element_not_found'
      | 'assertion_failed'
      | 'heal_blocked'
      | 'timeout'
      | 'silent_backend_failure'
      | 'unexpected_validation_error'
      | 'unknown';
    /** Human-readable explanation for failure (for CI reports) */
    failureExplanation?: string;
    /** Execution time in milliseconds */
    executionMs?: number;
    /** Which locator strategy was used */
    usedLocatorStrategy?: string;
    /** Whether compiled plan was expired */
    compiledExpired?: boolean;
    /** Whether page signature matched */
    pageSignatureMatched?: boolean;
    /** Self-healing confidence (if healed) */
    healConfidence?: number;
    /**
     * Self-heal provenance — populated only when runtimeStatus === 'healed'.
     * Surfaces "what broke, what AI used instead" so the UI can show a
     * before→after tooltip on the healed badge.
     */
    /** Original selector that failed before self-heal rewrote it. */
    healedFrom?: string;
    /** Selector the self-healer resolved to (new working locator). */
    healedTo?: string;
    /** Short human-readable description of what changed during heal. */
    healWhatChanged?: string;
    /** True if step is flagged as needing review */
    needsReview?: boolean;
    /** True if step is flagged as flaky */
    flaky?: boolean;

    // ─────────────────────────────────────────────────────────────────────────
    // V6: Lookahead auto-wait (inter-step stability)
    // ─────────────────────────────────────────────────────────────────────────
    /** True if lookahead auto-wait was applied (waited > threshold) */
    autoWaitApplied?: boolean;
    /** Milliseconds waited during lookahead (if autoWaitApplied is true) */
    autoWaitMs?: number;

    // ─────────────────────────────────────────────────────────────────────────
    // V7: Resolution path + network correlation (background replay + preview run)
    // ─────────────────────────────────────────────────────────────────────────
    /** Which runtime resolution path was used */
    resolutionPath?:
      | 'compiled'
      | 'evidence'
      | 'llm_resolver'
      | 'rule_fallback'
      | 'self_heal';
    /** Root cause classification from correlated signals */
    rootCause?: 'backend' | 'ui' | 'logic';
    /** Network verdict for this step */
    networkVerdict?: 'backend_error' | 'clean' | 'warning' | 'expected_error' | 'validation_failure';
    /** Network errors correlated to this step execution window */
    networkEvidence?: Array<{
      method: string;
      url: string;
      status?: number;
      error: string;
    }>;
    /** Error counts in the step execution window */
    stepErrors?: {
      console: number;
      network: number;
      ui: number;
    };

    /** Screenshot URL captured at the moment a bug was detected */
    bugScreenshotUrl?: string;

    /**
     * Non-blocking, advisory warnings raised by the runner for this step.
     * Currently emitted by the mobile runner's `install_app` command (e.g.
     * release APK without WebView debugging). Omitted when there are none
     * — callers should truthy-check before reading `.length`.
     */
    warnings?: Array<{
      /** Stable machine code (e.g. 'WEBVIEW_DEBUGGABLE_DISABLED'). */
      code: string;
      /** Ready-to-display human message. */
      message: string;
      /** Optional app identifier the warning refers to. */
      packageName?: string;
    }>;
  };
}

// ✅ NEW: Graph visualization update payload
export interface TestGraphUpdatePayload {
  testId: string;
  type: 'full' | 'incremental';
  mode?: 'lite' | 'pro'; // ✅ NEW: Indicates test mode (Lite has no screenshots)
  data: {
    // For type='incremental': single node + edge update
    newNode?: {
      id: string;
      type: 'start' | 'end' | 'action' | 'assertion' | 'condition' | 'loop' | 'merge';
      stepType?: string;
      label: string;
      selector?: string;
      value?: any;
      meta?: {
        icon?: string;
        color?: string;
        success?: boolean;
        durationMs?: number;
        errorMessage?: string;
        urlChanged?: boolean;
        urlBefore?: string;
        urlAfter?: string;
        timestamp?: number;
        elapsedTime?: number;
        [key: string]: any;
      };
    };
    newEdge?: {
      id: string;
      source: string;
      target: string;
      type: 'normal' | 'branch' | 'loop' | 'return' | 'merge';
      label?: string;
      meta?: {
        color?: string;
        style?: 'solid' | 'dashed' | 'dotted';
        animated?: boolean;
      };
    };
    updatedNode?: {
      id: string;
      meta?: Record<string, any>;
    };

    // For type='full': complete graph
    fullGraph?: {
      nodes: Array<{
        id: string;
        type: string;
        stepType?: string;
        label: string;
        selector?: string;
        value?: any;
        meta?: Record<string, any>;
      }>;
      edges: Array<{
        id: string;
        source: string;
        target: string;
        type: string;
        label?: string;
        meta?: Record<string, any>;
      }>;
      metadata: {
        totalSteps: number;
        completedSteps: number;
        failedSteps: number;
      };
    };
  };
  timestamp: string;
  sessionId?: string; // Chat session ID for routing isolation
}

export interface TestBrowserCompletedPayload {
  testId: string;
  browser: string;
  status: 'completed' | 'failed';
  duration?: number;
  errorsCount?: number;
  /** V16: Credits ran out during execution but run was allowed to complete */
  creditsExhausted?: boolean;
  timestamp: string;
}

export interface TestCompletedPayload {
  testId: string;
  status: 'completed';
  totalBrowsers: number;
  completedBrowsers: number;
  failedBrowsers: number;
  duration?: number;
  summary?: {
    totalBugs: number;
    criticalBugs: number;
  };
  timestamp: string;
}

export interface TestFailedPayload {
  testId: string;
  browser?: string;
  error: string;
  timestamp: string;
}

export interface TestCancelledPayload {
  testId: string;
  reason?: string;
  timestamp: string;
}

// ============================================================================
// VIDEO STREAMING PAYLOADS (Chrome CDP Screencast)
// ============================================================================

/**
 * Video frame payload for live streaming
 * Sent ~12 times per second during test execution
 */
export interface TestVideoFramePayload {
  testId: string;
  browser: string;
  sessionId: string; // Unique stream ID (per worker run)
  chatSessionId?: string; // Chat session ID for routing isolation
  seq: number; // Monotonic frame number
  format: 'jpeg';
  data: string; // base64 without prefix
  width: number;
  height: number;
  timestamp: string;
  elapsedTime: number; // Milliseconds since test start (for slider sync)
  isCatchup?: boolean; // True for late join frames
}

/**
 * Video stream statistics
 * Sent every 10 seconds during streaming
 */
export interface TestVideoStatsPayload {
  testId: string;
  sessionId: string;
  chatSessionId?: string; // Chat session ID for routing isolation
  currentFPS: number;
  framesEmitted: number;
  framesDropped: number;
  avgLatency: number; // ms
  quality: 'high' | 'medium' | 'low';
  timestamp: string;
}

/**
 * Video stream paused notification
 * Sent when backpressure forces stream pause
 */
export interface TestVideoPausedPayload {
  testId: string;
  sessionId: string;
  chatSessionId?: string; // Chat session ID for routing isolation
  reason: 'backpressure' | 'redis_timeout' | 'circuit_breaker';
  timestamp: string;
}

/**
 * Video stream resumed notification
 * Sent when stream resumes after pause
 */
export interface TestVideoResumedPayload {
  testId: string;
  sessionId: string;
  chatSessionId?: string; // Chat session ID for routing isolation
  timestamp: string;
}

/**
 * Video stream stopped notification
 * Sent when streaming ends (test completed/cancelled/error)
 */
export interface TestVideoStoppedPayload {
  testId: string;
  sessionId: string;
  chatSessionId?: string; // Chat session ID for routing isolation
  reason: 'completed' | 'cancelled' | 'error' | 'timeout';
  timestamp: string;
}

/**
 * Video streaming unavailable notification
 * Sent when CDP screencast fails to start
 */
export interface TestVideoUnavailablePayload {
  testId: string;
  chatSessionId?: string; // Chat session ID for routing isolation
  reason: string; // Error message
  timestamp: string;
}

/**
 * Video stream started notification
 * Sent when streaming begins (for late join)
 */
export interface TestVideoStartedPayload {
  testId: string;
  sessionId: string;
  chatSessionId?: string; // Chat session ID for routing isolation
  url: string;
  width: number;
  height: number;
  fps: number;
  timestamp: string;
}

// Clarification Events
export interface TestClarificationRequestPayload {
  testId: string;
  questionId: string;
  question: string;
  type: 'url' | 'credentials' | 'test_data' | 'payment_approval';
  required: boolean;
  options?: string[];
  timeout?: number;
  timestamp: string;
}

export interface TestClarificationResponsePayload {
  testId: string;
  questionId: string;
  answer: string;
  timestamp: string;
}

// Result Events
export interface ResultReadyPayload {
  testId: string;
  browser: string;
  resultId: string;
  status: 'completed' | 'failed'; // ✅ NEW: Indicate if this is a success or failure result
  timestamp: string;
}

export interface ResultScreenshotPayload {
  testId: string;
  browser: string;
  screenshot: string; // base64
  timestamp: string;
}

export interface ResultErrorPayload {
  testId: string;
  browser: string;
  error: {
    type: string;
    message: string;
    stack?: string;
  };
  timestamp: string;
}

// AI Analysis Events
export interface AIAnalysisStartedPayload {
  testId: string;
  resultId: string;
  timestamp: string;
}

export interface AIAnalysisProgressPayload {
  testId: string;
  resultId: string;
  stage: 'analyzing_screenshot' | 'analyzing_logs' | 'generating_report';
  progress: number; // 0-100
  timestamp: string;
}

export interface AIAnalysisCompletedPayload {
  testId: string;
  resultId: string;
  summary: {
    summary: string;
    bugs: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low';
      message: string;
      location?: string;
    }>;
    recommendations: string[];
    confidence: number;
    // V14: Step-aware classification
    failureClassification?: 'flaky' | 'real_bug' | 'environment' | 'test_drift' | null;
    rootCauseStep?: number | null;
    classificationEvidence?: string[];
  };
  timestamp: string;
}

export interface AIBugFoundPayload {
  testId: string;
  resultId: string;
  bug: {
    severity: 'critical' | 'high' | 'medium' | 'low';
    message: string;
    location?: string;
    screenshot?: string;
  };
  timestamp: string;
}

// Chat Events
export interface ChatMessagePayload {
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface ChatTestUpdatePayload {
  sessionId: string;
  testId: string;
  message: string;
  status: 'created' | 'started' | 'progress' | 'completed' | 'failed';
  summary?: {
    totalBrowsers?: number;
    completedBrowsers?: number;
    totalBugs?: number;
    criticalBugs?: number;
    duration?: string;
  };
  links?: {
    fullReport?: string;
    screenshots?: string;
  };
  timestamp: string;
}

export interface ChatProcessingStepPayload {
  sessionId: string;
  step: 'parsing_intent' | 'enriching_context' | 'checking_autonomous' |
  'generating_questions' | 'exploring_site' | 'generating_plan' |
  'executing_test' | 'analyzing_results' | 'generating_response' |
  'generating_scenarios' | 'executing_tests' |
  'preparing_workspace' | 'checking_project' | 'validating_credentials' |
  'creating_test_plan' | 'waiting_approval' |
  // Sub-agent pipeline thinking steps
  'agent_routing' | 'agent_planning' | 'agent_executing_tool' | 'agent_formatting' |
  // Cooperative multi-agent pipeline steps
  'agent_reviewing' | 'agent_spawning' |
  // Live thinking — shows what the AI agent is currently doing/thinking
  'agent_thinking';
  message: string;
  progress?: number; // 0-100
  metadata?: Record<string, any>;
  timestamp: string;
}

export interface ApiAgentStepPayload {
  testId: string;
  runId: string;
  sessionId: string;
  stepIndex: number;
  stepType: string;
  stage: 'planning' | 'executing' | 'completed';

  /** Human-readable description of the real step being executed */
  description?: string;
  /** Human-readable expected outcome for this step */
  expectedOutcome?: string;
  /** Optional short summary for UI cards */
  summary?: string;

  // Planning stage
  reasoning?: string;
  shouldStop?: boolean;
  stopReason?: string;
  noveltyEstimate?: number;
  riskLevel?: 'safe' | 'low' | 'medium' | 'high';

  // Executing stage
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    bodyPreview?: string;
    correlationId?: string;
  };
  isRetry?: boolean;
  retryAttempt?: number;
  maxRetries?: number;

  // Completed stage
  success?: boolean;
  /** Raw HTTP ok flag (response.ok). Useful to differentiate expected 4xx from real bugs. */
  httpOk?: boolean;
  /** Step-level verdict for UI: pass | expected_error | bug */
  stepVerdict?: 'pass' | 'expected_error' | 'bug';
  /** Convenience flag: true when stepVerdict === 'bug' */
  isBug?: boolean;
  error?: string;
  response?: {
    status: number;
    statusText: string;
    durationMs: number;
    bodyPreview?: string;
  };
  findingsCount?: number;
  findings?: Array<{
    severity: string;
    title: string;
    type: string;
  }>;

  // State updates (all stages)
  novelty?: number;
  totalFindings?: number;
  aiTokensUsed?: number;

  timestamp: string;
}

// System Events
export interface SystemErrorPayload {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
}

export interface SystemMaintenancePayload {
  /**
   * V21: True when system enters maintenance/degraded mode (e.g. Supabase outage),
   * false when service is restored. Frontend uses this to show/hide a global
   * banner. When omitted, backwards-compat consumers can treat the event as
   * `active: true` (legacy: every emission used to mean "maintenance starting").
   */
  active?: boolean;
  /** User-facing reason. Free-form, e.g. "База данных недоступна" */
  message: string;
  /** Optional machine-readable code (e.g. 'supabase_down', 'queue_unreachable') */
  reason?: string;
  /** ISO timestamp when the current maintenance window started */
  since?: string;
  /** Optional estimated duration in seconds — informational only */
  estimatedDuration?: number;
  timestamp: string;
}

// Regression Run Events
export interface RegressionRunProgressPayload {
  runId: string;
  userId: string;
  /** Helpful for UI routing without extra GET /regression/runs */
  planId?: string | null;
  projectId?: string | null;
  trigger?: 'manual' | 'chat' | 'scheduled' | 'webhook';
  status: 'started' | 'level_started' | 'test_started' | 'test_completed' | 'level_completed' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  message: string;
  /** Machine-readable error code for specific failure reasons (e.g. 'INSUFFICIENT_CREDITS') */
  errorCode?: string;
  details?: {
    totalTests: number;
    completedTests: number;
    currentLevel?: number;
    totalLevels?: number;
    currentTestName?: string;
    passed?: number;
    failed?: number;
    skipped?: number;
    /**
     * Per-test lifecycle update. Emitted at key transitions so the frontend
     * can maintain a live per-test card list ("queued", "running",
     * "completed") without polling REST. Only set on events that describe
     * a specific test case — aggregate events (`level_started`,
     * `level_completed`) omit it.
     *
     * Works uniformly for web (Playwright) and mobile (runner) tests — the
     * `platform` field tells the UI which per-test detail view to render.
     */
    testExecution?: {
      /** IntentTestCase id (or api test config id) — stable across runs. */
      testCaseId: string;
      /** test_executions.id — use for REST detail fetch / report links. */
      testExecutionId: string;
      /** Matches `ExecutableTestCase.testType`. */
      testType: 'ui' | 'api';
      /** Null for web UI + all API tests; 'mobile_android' | 'mobile_ios' | 'mobile_flutter' for mobile UI. */
      platform?: string | null;
      /** Lifecycle transition. `queued` is emitted when a test is about
       *  to be dispatched but is held behind the concurrency gate;
       *  `dispatching` when the job is placed on a queue; `running`
       *  after the runner acknowledges; `completed` on terminal status. */
      event: 'queued' | 'dispatching' | 'running' | 'completed';
      /** Only set when `event === 'completed'`. */
      status?: 'passed' | 'failed' | 'skipped';
      /** Short human-readable reason for failed/skipped (≤ 200 chars). */
      errorMessage?: string;
    };
  };
  timestamp: string;
}

// ============================================================================
// EXPLORATION EVENTS
// ============================================================================

export interface ExplorationProgressPayload {
  explorationId: string;
  phase: 'survey' | 'strategizing' | 'flow' | 'evaluating' | 'complete';
  event: string;
  progressPercent: number;
  data: Record<string, any>;
  timestamp: string;
  chatSessionId?: string;
  userId?: string;
  /** Total exploration budget in ms — frontend uses for timer display */
  budgetMs?: number;
}

export interface ExplorationCompletedPayload {
  explorationId: string;
  testCasesCount: number;
  summary: Record<string, any>;
  status: 'completed' | 'failed';
  errorMessage?: string;
  timestamp: string;
  chatSessionId?: string;
  userId?: string;
}

export interface ExplorationClarificationPayload {
  explorationId: string;
  questionId: string;
  question: string;
  type: 'captcha_solve' | '2fa_code';
  timeout: number;
  chatSessionId: string;
  userId?: string;
  timestamp: string;
}

// ============================================================================
// PREVIEW EVENTS (Step Editor)
// ============================================================================

/**
 * Bounding box for element highlighting
 */
export interface PreviewBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Interactive node from page snapshot
 */
export interface PreviewInteractiveNode {
  ref?: string;
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  labelText?: string;
  ariaLabel?: string;
  placeholder?: string;
  boundingBox?: PreviewBoundingBox;
  isVisible?: boolean;
  isDisabled?: boolean;
}

/**
 * Intent step draft for linting
 * Uses shared types from preview.types.ts to stay in sync with backend IntentStep
 */
export interface PreviewIntentStep {
  id: string;
  type: IntentActionType;
  description: string;
  value?: string;
  /**
   * Assertion text for ai_check actions (V3)
   * Natural language assertion to be evaluated by LLM
   * Example: "There is a black nav bar with five links"
   * Required when type === 'ai_check'
   */
  assertionText?: string;
  /** Hints for element resolution */
  bindingHints?: BindingHints;
  /** Step execution options (shared with IntentStep) */
  options?: StepOptions;
  /** Cached evidence from recording or prior execution (used as evidence shortcut during apply/run) */
  evidence?: StepEvidence;
  /**
   * V22: Fingerprint of the element captured AT RECORDING TIME (probe snapshot).
   * Mirror of `IntentStep.recordedFingerprint` — see preview.types.ts for the
   * full rationale. Travels with the step from recorder → frontend → DB → LLM
   * resolver, so the FIRST apply already has rich identifying data.
   */
  recordedFingerprint?: TargetFingerprint;
  /** V15: Tab index this step targets (0 = initial tab, 1+ = popups) */
  tabIndex?: number;
  /**
   * V13: True when this step was created automatically (recorder nav-capture
   * or auto-inject pass) rather than by an explicit user action. Runtime uses
   * this flag to apply a softer execution policy — e.g. wait_for steps with a
   * page-settle fallback instead of a hard URL-change timeout.
   */
  isAutoInjected?: boolean;
}

/**
 * Request to lint a step
 */
export interface PreviewStepLintRequest {
  previewSessionId: string;
  stepDraft: PreviewIntentStep;
  pageRef?: string; // Optional page reference (for cached context)
  /**
   * V3: When true, include full candidate list in response (for "Show alternatives" button).
   * By default (false), needs_clarification only returns LLM message without candidate list.
   */
  includeAlternatives?: boolean;
}

/**
 * Request to apply (execute) a step
 */
export interface PreviewStepApplyRequest {
  previewSessionId: string;
  stepDraft: PreviewIntentStep;
  pageRef?: string;
  /** Optional: If provided, auto-persist appliedStep to this test case after successful apply */
  intentTestCaseId?: string;
}

/**
 * V8: Request to start "Run from start" in preview
 */
export interface PreviewRunStartRequest {
  previewSessionId: string;
  intentTestCaseId: string; // Load saved steps from DB
  /** Optional: inline steps to save-then-run ("Apply All" flow).
   *  When provided, steps are persisted to the test case first,
   *  then used directly without a second DB round-trip. */
  steps?: PreviewIntentStep[];
  /** Optional: startUrl override (used with inline steps when test case may lack a URL). */
  startUrl?: string;
  /** Optional: mobile runner session ID for mobile test cases. */
  mobileSessionId?: string;
  /**
   * Optional: override authReset behavior per-run. When omitted, backend
   * uses its default ('never' — preserve cookies/storage between runs).
   * 'always' = wipe cookies + localStorage + sessionStorage before run
   * (use when test needs a deterministic first-visit state).
   * 'never'  = keep session so repeat runs of a login flow continue
   * from the authenticated page (default behavior pre-2026-04-20).
   *
   * Frontend sources this from the SessionDetectedBanner UI — user
   * explicitly chooses when an active session is detected before Run.
   */
  authReset?: 'always' | 'never';
  /**
   * "Apply New Only" (April 2026): start execution at this step index
   * instead of step 0, preserving the live preview state. Used when the
   * user already ran Apply All on steps 0..N-1 and now wants to apply
   * only the freshly-recorded steps N..end without re-running everything
   * (faster, no auth wipe, runs against current preview state).
   *
   * When set:
   *   - Backend skips goto(startUrl) — preview stays where it is
   *   - Backend ignores authReset='always' (forced to 'never')
   *   - Steps before the index are not executed but ARE saved to DB
   *     alongside the new ones (single source of truth)
   *
   * The frontend pre-flight checks that current preview URL matches the
   * recorded `pageUrl` of step at this index before sending. Backend
   * trusts that check — unsafe values still won't crash the run, but
   * step N may fail with a "page mismatch" badge from per-step URL diag.
   */
  startFromIndex?: number;
}

/**
 * V8: Request to cancel running preview run
 */
export interface PreviewRunCancelRequest {
  previewSessionId: string;
}

/**
 * Request to inspect the preview context's session state without mutating
 * anything. Frontend sends this when the user clicks Run so we can show
 * a banner if an active session is detected. Response: `preview:session:state`.
 */
export interface PreviewSessionInspectRequest {
  previewSessionId: string;
}

/**
 * Candidate element from linting
 */
export interface PreviewLintCandidate {
  ref?: string;
  label: string;
  reason: string;
  confidence: number;
  boundingBox?: PreviewBoundingBox;
}

/**
 * Highlight instruction for UI
 */
export interface PreviewHighlight {
  ref?: string;
  boundingBox?: PreviewBoundingBox;
  type: 'success' | 'warning' | 'error';
}

/**
 * Page snapshot payload (DOM state for resolving/highlighting, no screenshot)
 * Video frames are sent separately via preview:video:frame
 */
export interface PreviewPagePayload {
  previewSessionId: string;
  url: string;
  pageTitle?: string;        // Page <title> for browser-like tab display
  domVersion: number;        // Monotonically increasing int, incremented on DOM changes
  pageSignature: string;     // Hash of URL + interactive element refs
  domNodes?: PreviewInteractiveNode[]; // Only sent when domVersion changes
  timestamp: string;
}

/**
 * Native dialog (alert/confirm/prompt) auto-dismissed payload
 */
export interface PreviewDialogPayload {
  previewSessionId: string;
  type: string;              // 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string;
  action: 'accepted' | 'dismissed';
  timestamp: string;
}

/**
 * Video frame payload for preview stream (CDP screencast)
 * ~10 fps, 1280x720, JPEG quality 60
 */
export interface PreviewVideoFramePayload {
  previewSessionId: string;
  seq: number;               // Monotonic frame number
  format: 'jpeg';
  /**
   * Frame bytes — base64 string only when binary transport is unavailable.
   * When binary transport is used (preferred), this is an empty string and
   * the actual JPEG bytes are passed as the second `emit()` argument.
   */
  data: string;
  width: number;             // 1280
  height: number;            // 720
  domVersion: number;        // Which DOM version this frame relates to
  timestamp: string;
  /** V20: byte length of the binary frame (set when binary transport is used) */
  byteLength?: number;
}

/**
 * Step lint result payload
 */
export interface PreviewStepLintResultPayload {
  status: 'resolved' | 'ambiguous' | 'not_found' | 'needs_clarification' | 'error';
  message: string;
  confidence: number;
  candidates: PreviewLintCandidate[];
  highlight: PreviewHighlight[];
  /** LLM interpretation of user intent (when AI resolver is used) */
  interpretation?: string;
  /** Clarification question from AI (in user's language) */
  clarificationQuestion?: string;
  /**
   * V3: True if this is a response to "Show alternatives" request.
   * When true, candidates list is populated even for needs_clarification.
   */
  alternativesIncluded?: boolean;
  /**
   * V3: True if Apply should be disabled (status is needs_clarification without user selection)
   */
  applyDisabled?: boolean;
  timestamp: string;
}

/**
 * Step apply result payload
 */
export interface PreviewStepApplyResultPayload {
  success: boolean;
  error?: string;
  appliedStep?: PreviewIntentStep;
  urlChanged?: boolean;
  url?: string;
  highlight?: PreviewHighlight[];
  attempts?: number;
  timestamp: string;
}

/**
 * Mobile step apply request (WebSocket)
 * Parallels PreviewStepApplyRequest but targets a mobile runner session instead of a
 * browser preview session. Frontend emits `mobile:step:apply`, backend resolves via
 * mobile-runner-client (lint-then-execute fast path with runSteps fallback), and
 * replies with `mobile:step:apply:result`.
 */
export interface MobileStepApplyRequest {
  mobileSessionId: string;
  stepDraft: PreviewIntentStep;
  /** Optional: auto-persist appliedStep to this test case after successful apply. */
  intentTestCaseId?: string;
}

/**
 * Mobile step apply result payload. Keeps web-parity so one UI code path can
 * consume either preview:step:apply:result or mobile:step:apply:result.
 */
export interface MobileStepApplyResultPayload {
  success: boolean;
  error?: string;
  appliedStep?: PreviewIntentStep;
  stepResult?: {
    success: boolean;
    error?: string;
    screenshot?: string;
    resolvedVia?: string;
    durationMs?: number;
  };
  status?: 'passed' | 'failed';
  /** Echo of the mobile runner session ID so the frontend can match the result to its current session. */
  mobileSessionId?: string;
  timestamp: string;
}

/**
 * Clarify payload (server -> client)
 * Sent when AI resolver needs user to choose between similar elements
 */
export interface PreviewClarifyPayload {
  previewSessionId: string;
  stepId: string;
  candidates: Array<{
    ref: string;
    label: string;
    reason: string;
    boundingBox?: PreviewBoundingBox;
  }>;
  /** AI interpretation of user intent */
  interpretation: string;
  /** Question to show user (in user's language) */
  message: string;
  timestamp: string;
}

/**
 * Clarify select request (client -> server)
 * User has selected one of the clarification options
 */
export interface PreviewClarifySelectRequest {
  previewSessionId: string;
  stepId: string;
  selectedRef: string;
}

/**
 * V8: Preview run started payload (server -> client)
 * Emitted when "Run from start" begins
 */
export interface PreviewRunStartedPayload {
  previewSessionId: string;
  totalSteps: number;
  timestamp: string;
}

/**
 * V8: Preview run step progress payload (server -> client)
 * Emitted for each step as it transitions through states
 */
export interface PreviewRunStepPayload {
  previewSessionId: string;
  stepIndex: number;
  stepId: string;
  status: 'pending' | 'running' | 'pass' | 'fail' | 'skipped';
  action?: string; // e.g., "click", "type", "assert", "ai_check"
  description?: string;
  error?: string;
  failedReason?: string;
  timestamp: string;
}

/**
 * V8: Preview run completed payload (server -> client)
 * Emitted when "Run from start" finishes (success, failure, or cancelled)
 */
export interface PreviewRunCompletedPayload {
  previewSessionId: string;
  success: boolean;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  cancelled?: boolean;
  duration: number; // ms
  timestamp: string;
}

// ============================================================================
// PREVIEW RECORDING PAYLOADS
// ============================================================================

/**
 * Recording start/stop request (client -> server)
 */
export interface PreviewRecordingRequest {
  previewSessionId: string;
}

/**
 * Recording step payload (server -> client)
 * Emitted each time a user interaction is captured as an IntentStep
 */
export interface PreviewRecordingStepPayload {
  previewSessionId: string;
  step: PreviewIntentStep;
  /** Bounding box for transient highlight on the recorded element */
  highlight?: PreviewBoundingBox;
  /**
   * Cumulative count of NEW steps emitted in this recording session after
   * this one is applied. Stamped server-side so the UI (badge/limit) stays
   * in sync with the server's max-steps guard. Missing on pre-counter
   * builds — treat as unknown.
   */
  stepCount?: number;
  timestamp: string;
}

/**
 * Recording upload-warning payload (server -> client).
 * Emitted when a filechooser event opened during recording but we could NOT
 * capture a step. Lets the UI tell the user why Upload "did nothing" instead
 * of silently dropping the interaction.
 *
 *   - 'no_file_selected'       — filechooser fired but user never selected a file
 *                                (cancelled the dialog, or 5s confirmation timeout)
 *   - 'capture_failed'         — exception inside the handler (probe/evaluate failed)
 *   - 'listener_setup_failed'  — filechooser listener could not be attached at
 *                                recording start (Upload will NEVER record this session)
 *   - 'headless_blocked'       — reserved: headless container has no UI for the native
 *                                file dialog (to be wired from the handler when detected)
 */
export interface PreviewRecordingUploadWarningPayload {
  previewSessionId: string;
  reason:
    | 'no_file_selected'
    | 'capture_failed'
    | 'listener_setup_failed'
    | 'headless_blocked';
  /** Optional human-readable detail (error message, element hint). Safe to show in UI. */
  detail?: string;
  /**
   * Correlates the warning with a placeholder step rendered by the inline
   * upload picker. When present, the UI MUST clear `pendingUploads[stepId]`.
   * The server additionally emits `preview:recording:step:remove` for the
   * same stepId so the placeholder row is removed in lockstep.
   */
  stepId?: string;
  timestamp: string;
}

/**
 * Recording upload-prompt payload (server -> client).
 *
 * Emitted the moment a `filechooser` event fires on the recording page. The
 * OS file dialog has opened (or is about to, in headless). Instead of waiting
 * for the user to commit a file to the native dialog — which fails for
 * cancelled dialogs, listener races, and headless browsers — we tell the UI
 * to show its own inline file picker keyed to this placeholder step.
 *
 * The frontend shows a pending "upload" step with an "Attach file" button.
 * When the user picks a file it POSTs to /api/v1/preview/upload-file, then
 * emits `preview:recording:upload:resolve` back to the server with the
 * resulting publicUrl. The server then drives setFiles() on the held
 * fileChooser so the real page sees the upload happen.
 */
export interface PreviewRecordingUploadPromptPayload {
  previewSessionId: string;
  /** Placeholder step id — used as correlation key for resolve/cancel. */
  stepId: string;
  /**
   * Multi-file support hint (from filechooser.isMultiple()). Frontend can
   * let the user pick multiple files when true.
   */
  multiple: boolean;
  /** Best-effort binding hints for the target file input (for replay). */
  bindingHints?: unknown;
  /** Page URL at the time of the prompt (for evidence). */
  pageUrl?: string;
  /**
   * Server-side timeout (ms) after which the pending chooser is auto-cancelled
   * and the placeholder step dropped. UI should render a matching countdown or
   * at least tolerate the step disappearing if the user ignores the prompt.
   */
  timeoutMs: number;
  timestamp: string;
}

/**
 * Client -> server: user picked a file in the inline picker and uploaded it
 * to /api/v1/preview/upload-file. Server will download it to a tmp path and
 * call fileChooser.setFiles() so the real page sees the upload.
 */
export interface PreviewRecordingUploadResolveRequest {
  previewSessionId: string;
  stepId: string;
  /** Public URL returned from /api/v1/preview/upload-file. */
  publicUrl: string;
  /** Original filename (for display in the captured step). */
  fileName: string;
  /** Supabase storage path (kept for future teardown / re-download). */
  storagePath?: string;
  /** Multi-file: additional files (if filechooser was isMultiple=true). */
  additionalFiles?: Array<{ publicUrl: string; fileName: string; storagePath?: string }>;
}

/**
 * Client -> server: user dismissed the inline picker. Server calls
 * fileChooser.setFiles([]) to close the native dialog and drops the
 * placeholder step.
 */
export interface PreviewRecordingUploadCancelRequest {
  previewSessionId: string;
  stepId: string;
}

/**
 * Recording state payload (server -> client)
 * Emitted on recording start/stop to confirm state
 */
export interface PreviewRecordingStatePayload {
  previewSessionId: string;
  recording: boolean;
  /**
   * Server-side reason for an auto-stop. Absent on explicit user stop.
   *   - 'max_time'  — recording exceeded WEB_RECORDING_MAX_TIME_MS
   *   - 'max_steps' — recording hit WEB_RECORDING_MAX_STEPS; user must
   *                   Apply All before recording more
   */
  reason?: 'max_time' | 'max_steps';
  /**
   * Server-side step cap for this recording session. Sent only on
   * `recording: true` so the UI can render an `X/N` badge without a
   * separate config fetch. 0 = cap disabled. Missing on pre-cap builds.
   */
  maxSteps?: number;
  timestamp: string;
}

// ============================================================================
// PREVIEW INTERACTIVE CONTROL PAYLOADS
// ============================================================================

/**
 * Mouse move request (hover)
 */
export interface PreviewMouseMoveRequest {
  previewSessionId: string;
  x: number;
  y: number;
}

/**
 * Mouse click request
 */
export interface PreviewMouseClickRequest {
  previewSessionId: string;
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number; // 1=single, 2=double
  /** V13: Modifier keys held during click (for Shift+Click multi-select, Ctrl+Click, etc.) */
  modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean };
}

/**
 * Mouse button request (down/up for drag)
 */
export interface PreviewMouseButtonRequest {
  previewSessionId: string;
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
}

/**
 * Mouse wheel request (scroll)
 */
export interface PreviewMouseWheelRequest {
  previewSessionId: string;
  deltaX: number;
  deltaY: number;
  /** Viewport coordinates where wheel event occurred (for container scroll detection) */
  x?: number;
  y?: number;
}

/**
 * Keyboard type request (insert text)
 */
export interface PreviewKeyboardTypeRequest {
  previewSessionId: string;
  text: string;
}

/**
 * Keyboard press request (key with modifiers)
 */
export interface PreviewKeyboardPressRequest {
  previewSessionId: string;
  key: string; // 'Enter', 'Escape', 'ArrowDown', etc.
  modifiers?: ('Control' | 'Shift' | 'Alt' | 'Meta')[];
}

/**
 * Viewport change request (client → server)
 */
export interface PreviewViewportSetRequest {
  previewSessionId: string;
  width: number;
  height: number;
}

/**
 * Viewport metadata payload (for coordinate mapping)
 */
export interface PreviewViewportPayload {
  previewSessionId: string;
  viewport: {
    width: number;
    height: number;
  };
  devicePixelRatio: number;
  timestamp: string;
}

/**
 * Mouse/keyboard action result (lightweight acknowledgment)
 */
export interface PreviewMouseResultPayload {
  previewSessionId: string;
  success: boolean;
  action: 'move' | 'click' | 'down' | 'up' | 'wheel' | 'type' | 'press';
  error?: string;
  timestamp: string;
}

/**
 * Mouse probe request (debug: element under point)
 */
export interface PreviewMouseProbeRequest {
  previewSessionId: string;
  x: number;
  y: number;
}

/**
 * Mouse probe result (debug: element info at given coordinates)
 * Allows frontend to verify coordinate mapping by showing what element backend sees
 */
export interface PreviewMouseProbeResultPayload {
  previewSessionId: string;
  x: number;
  y: number;
  element?: {
    tag: string;
    id?: string;
    className?: string;
    text?: string;
    ariaLabel?: string;
    ref?: string;
  };
  timestamp: string;
}

/**
 * Preview page action result (refresh, reset)
 */
export interface PreviewPageActionResultPayload {
  previewSessionId: string;
  action: 'refresh' | 'reset' | 'back' | 'forward';
  success: boolean;
  error?: string;
  timestamp: string;
}

// ============================================================================
// PREVIEW DEVTOOLS PAYLOADS
// ============================================================================

/**
 * Console log entry for DevTools Console tab
 */
export interface PreviewConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  location?: string;   // e.g., "app.js:42"
  timestamp: string;
}

/**
 * Console update payload (push, incremental)
 */
export interface PreviewConsoleUpdatePayload {
  previewSessionId: string;
  seq: number;
  entries: PreviewConsoleEntry[];
  domVersion?: number;
}

/**
 * Network request/response item for DevTools Network tab
 */
export interface PreviewNetworkItem {
  id: string;                          // Unique request ID
  phase: 'request' | 'response' | 'error';
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  resourceType?: string;               // 'xhr', 'fetch', 'document', etc.
  startTs: string;
  endTs?: string;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  size?: number;                        // Response body size in bytes
  error?: string;
  // New fields for enhanced Network tab
  domain?: string;                      // Hostname from URL
  path?: string;                        // Pathname + search
  tab?: 'xhr' | 'js' | 'css' | 'img' | 'media' | 'font' | 'doc' | 'ws' | 'manifest' | 'other'; // Tab filter type
  startTimeMs?: number;                 // Epoch ms for waterfall
  endTimeMs?: number;                   // Epoch ms for waterfall
  contentType?: string;                 // MIME type from response headers
}

/**
 * Network update payload (push, incremental metadata)
 */
export interface PreviewNetworkUpdatePayload {
  previewSessionId: string;
  seq: number;
  items: PreviewNetworkItem[];
}

/**
 * Network detail request (client -> server, on-demand)
 */
export interface PreviewNetworkDetailRequest {
  previewSessionId: string;
  id: string;                           // Request ID to get details for
}

/**
 * Network list request (client -> server, on-demand)
 * Used to get all collected network items when opening the Network tab
 */
export interface PreviewNetworkListRequest {
  previewSessionId: string;
}

/**
 * Network list payload (server -> client, on-demand)
 * Returns all collected network items
 */
export interface PreviewNetworkListPayload {
  previewSessionId: string;
  items: PreviewNetworkItem[];
}

/**
 * Network detail payload (on-demand response with bodies)
 */
export interface PreviewNetworkDetailPayload {
  previewSessionId: string;
  id: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  truncated?: boolean;                  // True if body was truncated
  contentType?: string;                 // Content-Type from response headers
  isText?: boolean;                     // True if response is text-based
  responseBodyBase64?: string;          // Base64 encoded body for binary content
}

/**
 * HTML request (client -> server, on-demand)
 */
export interface PreviewHtmlRequest {
  previewSessionId: string;
  domVersion?: number;                  // Optional: only fetch if newer
}

/**
 * HTML update payload (on-demand response)
 */
export interface PreviewHtmlUpdatePayload {
  previewSessionId: string;
  domVersion: number;
  html: string;
  truncated?: boolean;
}

/**
 * Accessibility request (client -> server, on-demand)
 */
export interface PreviewAccessibilityRequest {
  previewSessionId: string;
  domVersion?: number;
}

/**
 * Accessibility tree node (simplified)
 */
export interface PreviewAccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: PreviewAccessibilityNode[];
}

/**
 * Accessibility update payload (on-demand response)
 */
export interface PreviewAccessibilityUpdatePayload {
  previewSessionId: string;
  domVersion: number;
  tree: PreviewAccessibilityNode[];
  truncated?: boolean;
}

/**
 * Context set request (client -> server)
 * Used to update step editor env/variables
 */
export interface PreviewContextSetRequest {
  previewSessionId: string;
  data: Record<string, any>;
}

/**
 * Context update payload (server -> client)
 */
export interface PreviewContextUpdatePayload {
  previewSessionId: string;
  version: number;
  data: Record<string, any>;
  timestamp: string;
}

// ============================================================================
// SOCKET DATA
// ============================================================================

export interface SocketData {
  userId?: string;
  isAnonymous: boolean;
  authenticatedAt: string;
}

// ============================================================================
// ALLURE IMPORT EVENTS
// ============================================================================

/** Stats snapshot emitted during import progress. */
export interface AllureImportStatsWS {
  totalFiles: number;
  testsFound: number;
  testsImported: number;
  testsSkipped: number;
  modulesCreated: number;
  flowsCreated: number;
  kbDocumentsCreated: number;
  filesSkipped: number;
  videosSkipped: number;
  errors: string[];
}

export interface AllureImportProgressWSPayload {
  importId: string;
  /** Current import phase. */
  phase: 'scanning' | 'classifying' | 'tests' | 'kb' | 'done';
  current: number;
  total: number;
  message: string;
  stats: AllureImportStatsWS;
  timestamp: string;
}

/** A test case in the import result tree. */
export interface AllureImportedTestNodeWS {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
  priority: 'critical' | 'high' | 'medium' | 'low';
  stepsCount: number;
  skipped?: boolean;
}

/** A flow in the import result tree. */
export interface AllureImportedFlowNodeWS {
  id: string;
  name: string;
  isNew: boolean;
  tests: AllureImportedTestNodeWS[];
}

/** A module in the import result tree. */
export interface AllureImportedModuleNodeWS {
  id: string;
  name: string;
  isNew: boolean;
  flows: AllureImportedFlowNodeWS[];
}

/** Full hierarchy returned in the completed payload. */
export interface AllureImportResultHierarchyWS {
  modules: AllureImportedModuleNodeWS[];
  unassigned: AllureImportedTestNodeWS[];
}

export interface AllureImportCompletedWSPayload {
  importId: string;
  success: boolean;
  stats: AllureImportStatsWS;
  hierarchy: AllureImportResultHierarchyWS;
  durationMs: number;
  timestamp: string;
}

export interface AllureImportFailedWSPayload {
  importId: string;
  error: string;
  timestamp: string;
}

// ============================================================================
// SYSTEM LOG PAYLOAD (Winston ring buffer entry, live-tailed over WS)
// ============================================================================

export interface SystemLogPayload {
  seq: number;
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'http' | 'debug' | string;
  message: string;
  meta?: Record<string, unknown>;
  source?: 'api' | 'worker' | 'scheduler' | string;
}

// ============================================================================
// AI ACTION LOG PAYLOAD (one row per LLM call)
// ============================================================================

export interface AIActionLogPayload {
  id: string;
  created_at: string;
  user_id: string;
  workspace_id: string | null;
  source:
    | 'chat'
    | 'analysis'
    | 'explorer-web'
    | 'explorer-mobile'
    | 'ai-selector'
    | 'ai-check'
    | 'form-filler';
  action_type: string;
  status: 'succeeded' | 'failed';
  summary: string;
  detail: Record<string, unknown>;
  entity_type:
    | 'regression_run'
    | 'test_execution'
    | 'chat_session'
    | 'exploration_run'
    | 'mobile_run'
    | null;
  entity_id: string | null;
  iteration: number | null;
  duration_ms: number | null;
  model: string | null;
  provider: 'openai' | 'gemini' | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  error: string | null;
}

// ============================================================================
// ROOM TYPES
// ============================================================================

export type RoomType = 'test' | 'chat' | 'user' | 'preview';

export interface RoomIdentifier {
  type: RoomType;
  id: string;
}

// Helper to create room names
export const createRoomName = (type: RoomType, id: string): string => {
  // Validate inputs
  if (!type || !['test', 'chat', 'user', 'preview'].includes(type)) {
    throw new Error(`Invalid room type: ${type}. Must be 'test', 'chat', 'user', or 'preview'`);
  }

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Room id must be a non-empty string');
  }

  return `${type}:${id.trim()}`;
};

// ═══════════════════════════════════════════════════════════════════════════
// ICON UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get icon name for action type
 * Returns string identifier that frontend can use to display appropriate icon
 */
export function getActionIcon(actionType?: string, phase?: string): string | undefined {
  if (!actionType && !phase) {
    return undefined;
  }

  // If action type is provided, use it
  if (actionType) {
    const actionIconMap: Record<string, string> = {
      // Navigation
      goto: 'navigate',
      goBack: 'go-back',
      goForward: 'go-forward',
      reload: 'reload',
      // Interactions
      click: 'click',
      dblclick: 'double-click',
      fill: 'fill',
      type: 'type',
      select: 'select',
      selectOption: 'select',
      check: 'check',
      uncheck: 'uncheck',
      hover: 'hover',
      press: 'press',
      focus: 'focus',
      blur: 'blur',
      // Touch/Mobile
      dragAndDrop: 'drag-drop',
      swipe: 'swipe',
      tap: 'tap',
      // Wait & Scroll
      wait: 'wait',
      waitForSelector: 'wait-selector',
      waitForTimeout: 'wait',
      waitForLoadState: 'wait',
      waitForNavigation: 'wait-navigation',
      scroll: 'scroll',
      scrollIntoView: 'scroll-into-view',
      // File operations
      upload: 'upload',
      download: 'download',
      screenshot: 'screenshot',
      // Assertions
      assertVisible: 'assert-visible',
      assertHidden: 'assert-hidden',
      assertEnabled: 'assert-enabled',
      assertDisabled: 'assert-disabled',
      assertText: 'assert-text',
      assertValue: 'assert-value',
      assertUrl: 'assert-url',
      assertCount: 'assert-count',
      assert: 'assert',
      expect: 'assert',
      // Data extraction
      extract: 'extract',
      evaluate: 'evaluate',
    };

    return actionIconMap[actionType] || 'action';
  }

  // If only phase is provided, map phase to icon
  if (phase) {
    const phaseIconMap: Record<string, string> = {
      initialization: 'initialization',
      analysis: 'analysis',
      planning: 'planning',
      generation: 'generation',
      execution: 'execution',
      finalization: 'finalization',
    };

    return phaseIconMap[phase] || 'default';
  }

  return undefined;
}

/**
 * Get emoji for action type (for text display in logs/UI)
 * Uses the same action types as getActionIcon for consistency
 */
export function getActionEmoji(actionType?: string): string {
  if (!actionType) {
    return '🔄';
  }

  const emojiMap: Record<string, string> = {
    // Navigation
    goto: '🌐',
    goBack: '⬅️',
    goForward: '➡️',
    reload: '🔄',
    // Interactions
    click: '👆',
    dblclick: '👆👆',
    fill: '✍️',
    type: '⌨️',
    select: '📋',
    selectOption: '📋',
    check: '✅',
    uncheck: '☑️',
    hover: '🖱️',
    press: '⌨️',
    focus: '🎯',
    blur: '👁️',
    // Touch/Mobile
    dragAndDrop: '↔️',
    swipe: '👆',
    tap: '👆',
    // Wait & Scroll
    wait: '⏱️',
    waitForSelector: '⏱️',
    waitForTimeout: '⏱️',
    waitForLoadState: '⏱️',
    waitForNavigation: '⏱️',
    scroll: '📜',
    scrollIntoView: '📜',
    // File operations
    upload: '📤',
    download: '📥',
    screenshot: '📸',
    // Assertions
    assertVisible: '👁️',
    assertHidden: '🙈',
    assertEnabled: '✅',
    assertDisabled: '❌',
    assertText: '📝',
    assertValue: '💾',
    assertUrl: '🔗',
    assertCount: '🔢',
    assert: '✓',
    expect: '✓',
    // Data extraction
    extract: '📊',
    evaluate: '🔍',
  };

  return emojiMap[actionType] || '🔄';
}

// ============================================================================
// API FLOW PAYLOAD TYPES
// ============================================================================

export interface ApiFlowParsingPayload {
  flowSpecId: string; // 'pending' during initial parse
  sessionId: string;
  stage: 'fetching_spec' | 'parsing' | 'analyzing_dependencies' | 'building_dag';
  message: string;
  progress: number; // 0-100
  timestamp: string;
}

export interface ApiFlowDagReadyPayload {
  flowSpecId: string;
  sessionId: string;
  nodes: any[]; // ReactFlowNode[]
  edges: any[]; // ReactFlowEdge[]
  totalEndpoints: number;
  unsupportedEndpoints: Array<{ method: string; path: string; reason: string }>;
  variableChain: Record<string, any>;
  timestamp: string;
}

export interface ApiFlowStepStartPayload {
  flowSpecId: string;
  flowRunId: string;
  sessionId: string;
  stepIndex: number;
  nodeId: string;
  method: string;
  path: string;
  resolvedUrl: string;
  variablesInjected: string[]; // variable names used
  timestamp: string;
}

export interface ApiFlowStepCompletePayload {
  flowSpecId: string;
  flowRunId: string;
  sessionId: string;
  stepIndex: number;
  nodeId: string;
  success: boolean;
  statusCode: number;
  durationMs: number;
  variablesExtracted: Array<{ name: string; value: string }>;
  error?: string;
  timestamp: string;
}

export interface ApiFlowVariableExtractedPayload {
  flowSpecId: string;
  flowRunId: string;
  sessionId: string;
  variableName: string;
  extractedFrom: string; // e.g. "POST /auth/login → $.data.token"
  value: string; // masked for sensitive values (tokens show first 8 chars + ***)
  timestamp: string;
}

export interface ApiFlowCompletedPayload {
  flowSpecId: string;
  flowRunId: string;
  sessionId: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    totalDurationMs: number;
    variablesResolved: number;
  };
  timestamp: string;
}

export interface ApiFlowFailedPayload {
  flowSpecId: string;
  flowRunId: string;
  sessionId: string;
  error: string;
  failedAtStep?: number;
  failedAtNodeId?: string;
  timestamp: string;
}
