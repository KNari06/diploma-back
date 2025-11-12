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
  'test:step:completed': (data: TestStepCompletedPayload) => void;
  'test:browser:completed': (data: TestBrowserCompletedPayload) => void;
  'test:completed': (data: TestCompletedPayload) => void;
  'test:failed': (data: TestFailedPayload) => void;
  'test:cancelled': (data: TestCancelledPayload) => void;

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

export interface TestProgressPayload {
  testId: string;
  browser: string;
  progress: number; // 0-100
  phase: string; // 'initialization' | 'analysis' | 'planning' | 'execution' | 'finalization'
  currentStep?: string;
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
}

export interface TestStepCompletedPayload {
  testId: string;
  browser: string;
  step: number;
  stepDescription: string;
  success: boolean;
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
        'creating_test_plan' | 'waiting_approval';
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
  return `${type}:${id}`;
};
