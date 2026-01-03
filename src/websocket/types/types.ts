/**
 * WebSocket Types and Interfaces
 * All events and payloads for client-server communication
 */

// ============================================================================
// CLIENT → SERVER EVENTS
// ============================================================================

export interface ClientToServerEvents {
  // Subscriptions
  'subscribe:test': (data: { testId: string }) => void;
  'unsubscribe:test': (data: { testId: string }) => void;
  'subscribe:chat': (data: { sessionId: string }) => void;
  'unsubscribe:chat': (data: { sessionId: string }) => void;

  // Clarification
  'test:clarification:response': (data: { testId: string; questionId: string; answer: string }) => void;

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

  // System events
  'system:error': (data: SystemErrorPayload) => void;
  'system:maintenance': (data: SystemMaintenancePayload) => void;

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
}

export interface TestStepCompletedPayload {
  testId: string;
  browser: string;
  step: number;
  stepDescription: string;
  success: boolean;
  timestamp: string;
}

// ✅ NEW: Graph visualization update payload
export interface TestGraphUpdatePayload {
  testId: string;
  type: 'full' | 'incremental';
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
        // NEW: Added for better clarity
        'preparing_workspace' | 'checking_project' | 'validating_credentials' |
        'creating_test_plan' | 'waiting_approval' ;
  message: string;
  progress?: number; // 0-100
  metadata?: Record<string, any>;
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

export type RoomType = 'test' | 'chat' | 'user';

export interface RoomIdentifier {
  type: RoomType;
  id: string;
}

// Helper to create room names
export const createRoomName = (type: RoomType, id: string): string => {
  // Validate inputs
  if (!type || !['test', 'chat', 'user'].includes(type)) {
    throw new Error(`Invalid room type: ${type}. Must be 'test', 'chat', or 'user'`);
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
