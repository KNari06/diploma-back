/**
 * WebSocket Types and Interfaces
 * All events and payloads for client-server communication
 */

import type {
  IntentActionType,
  StepOptions,
  BindingHints,
  StepEvidence,
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

  // Preview run operations (V8: Run from start)
  'preview:run:start': (data: PreviewRunStartRequest) => void;
  'preview:run:cancel': (data: PreviewRunCancelRequest) => void;

  // Preview interactive control (mouse/keyboard)
  'preview:mouse:move': (data: PreviewMouseMoveRequest) => void;
  'preview:mouse:click': (data: PreviewMouseClickRequest) => void;
  'preview:mouse:down': (data: PreviewMouseButtonRequest) => void;
  'preview:mouse:up': (data: PreviewMouseButtonRequest) => void;
  'preview:mouse:wheel': (data: PreviewMouseWheelRequest) => void;
  'preview:mouse:probe': (data: PreviewMouseProbeRequest) => void;
  'preview:keyboard:type': (data: PreviewKeyboardTypeRequest) => void;
  'preview:keyboard:press': (data: PreviewKeyboardPressRequest) => void;

  // Preview recording
  'preview:recording:start': (data: PreviewRecordingRequest) => void;
  'preview:recording:stop': (data: PreviewRecordingRequest) => void;

  // Preview page actions (refresh, reset, back, forward)
  'preview:page:refresh': (data: { previewSessionId: string }) => void;
  'preview:page:reset': (data: { previewSessionId: string }) => void;
  'preview:page:back': (data: { previewSessionId: string }) => void;
  'preview:page:forward': (data: { previewSessionId: string }) => void;

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

  // Chat events
  'chat:message': (data: ChatMessagePayload) => void;
  'chat:test:update': (data: ChatTestUpdatePayload) => void;
  'chat:processing:step': (data: ChatProcessingStepPayload) => void;
  'api:agent:step': (data: ApiAgentStepPayload) => void;

  // Regression run events
  'regression:run:progress': (data: RegressionRunProgressPayload) => void;

  // Exploration events
  'exploration:progress': (data: ExplorationProgressPayload) => void;
  'exploration:completed': (data: ExplorationCompletedPayload) => void;
  'exploration:clarification:request': (data: ExplorationClarificationPayload) => void;

  // System events
  'system:error': (data: SystemErrorPayload) => void;
  'system:maintenance': (data: SystemMaintenancePayload) => void;

  // Preview events
  'preview:page': (data: PreviewPagePayload) => void;
  'preview:video:frame': (data: PreviewVideoFramePayload) => void;
  'preview:step:lint:result': (data: PreviewStepLintResultPayload) => void;
  'preview:step:apply:result': (data: PreviewStepApplyResultPayload) => void;
  'preview:step:clarify': (data: PreviewClarifyPayload) => void;

  // Preview run events (V8: Run from start)
  'preview:run:started': (data: PreviewRunStartedPayload) => void;
  'preview:run:step': (data: PreviewRunStepPayload) => void;
  'preview:run:completed': (data: PreviewRunCompletedPayload) => void;

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

  // Preview recording events
  'preview:recording:step': (data: PreviewRecordingStepPayload) => void;
  'preview:recording:step:update': (data: PreviewRecordingStepPayload) => void;
  'preview:recording:step:remove': (data: { previewSessionId: string; stepId: string; timestamp: string }) => void;
  'preview:recording:state': (data: PreviewRecordingStatePayload) => void;

  // Preview interactive control responses
  'preview:viewport': (data: PreviewViewportPayload) => void;
  'preview:mouse:result': (data: PreviewMouseResultPayload) => void;
  'preview:mouse:probe:result': (data: PreviewMouseProbeResultPayload) => void;
  'preview:page:action:result': (data: PreviewPageActionResultPayload) => void;

  // Heartbeat response
  pong: () => void;
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
  'agent_reviewing' | 'agent_spawning';
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
  message: string;
  estimatedDuration?: number; // seconds
  timestamp: string;
}

// Regression Run Events
export interface RegressionRunProgressPayload {
  runId: string;
  userId: string;
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
  };
  timestamp: string;
}

// ============================================================================
// EXPLORATION EVENTS
// ============================================================================

export interface ExplorationProgressPayload {
  explorationId: string;
  phase: 'survey' | 'flow' | 'complete';
  event: string;
  progressPercent: number;
  data: Record<string, any>;
  timestamp: string;
  chatSessionId?: string;
}

export interface ExplorationCompletedPayload {
  explorationId: string;
  testCasesCount: number;
  summary: Record<string, any>;
  status: 'completed' | 'failed';
  errorMessage?: string;
  timestamp: string;
  chatSessionId?: string;
}

export interface ExplorationClarificationPayload {
  explorationId: string;
  questionId: string;
  question: string;
  type: 'captcha_solve' | '2fa_code';
  timeout: number;
  chatSessionId: string;
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
}

/**
 * V8: Request to cancel running preview run
 */
export interface PreviewRunCancelRequest {
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
  data: string;              // base64 without prefix
  width: number;             // 1280
  height: number;            // 720
  domVersion: number;        // Which DOM version this frame relates to
  timestamp: string;
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
  timestamp: string;
}

/**
 * Recording state payload (server -> client)
 * Emitted on recording start/stop to confirm state
 */
export interface PreviewRecordingStatePayload {
  previewSessionId: string;
  recording: boolean;
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
