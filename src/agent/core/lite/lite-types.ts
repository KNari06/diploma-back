/**
 * Lite Engine Types
 * Core type definitions for the Lite Engine testing system
 */

/**
 * Element with parent context for better AI understanding
 */
export interface LiteElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  visible: boolean;
  context?: string; // "inside: Product Card 'iPhone 15'"
  isInsideActiveModal?: boolean; // ✅ NEW: True if element is inside active modal
}

/**
 * Snapshot of page state at a point in time
 */
export interface LiteSnapshot {
  url: string;
  title: string;
  elements: LiteElement[];
  timestamp: number;
  activeModalRef?: string; // Ref of active modal container (if detected)
}

/**
 * Difference between two snapshots
 */
export interface StateDiff {
  urlChanged: boolean;
  urlBefore: string;
  urlAfter: string;
  addedElements: LiteElement[];
  removedRefs: string[];
  changedElements: Array<{ ref: string; field: string; before: unknown; after: unknown }>;
  hasVisualChange: boolean;
  newPageErrors: string[];
  newConsoleErrors: string[];
  /** Network errors detected during action (e.g., HTTP 429/5xx). Already time-filtered by caller. */
  newNetworkErrors?: string[];
}

/**
 * Outcome of an action execution
 */
export type ActionOutcome =
  | 'state_changed'      // State changed after action
  | 'validation_error'   // Validation error detected
  | 'no_effect'          // Action executed but no state change
  | 'execution_error'    // Action failed to execute
  | 'critical_error'     // Critical error - page crashed/blank (needs reload)
  | 'rate_limited';      // HTTP 429 / rate limiting detected - should back off and wait

/**
 * Result of action execution with fallback info
 */
export interface ExecutionResult {
  success: boolean;
  error?: string;
  duration: number;
  startTime: number;
  usedFallback?: boolean;
  fallbackInfo?: string;
}

/**
 * Stuck detection result
 */
export interface StuckCheck {
  stuck: boolean;
  reason?: string;
  suggestion?: string;
}

/**
 * AI command (SECURE: no arbitrary code)
 */
export interface AICommand {
  action: 'click' | 'fill' | 'press' | 'goto' | 'scroll' | 'select' | 'hover' | 'wait';
  ref?: string;           // target element ref
  value?: string;         // for fill, select
  key?: string;           // for press
  url?: string;           // for goto
  direction?: 'up' | 'down'; // for scroll
  /** For scroll: optional amount in pixels (positive number). */
  amount?: number;
  /** For scroll: optional target element ref to scroll into view. */
  targetRef?: string;
}

/**
 * Structured blocked info for better UX
 * Provides reason and whether user can help resolve the block
 */
export interface BlockedInfo {
  reason: string;
  canUserHelp: boolean;
}

/**
 * AI decision response
 */
export interface AIDecision {
  thought: string;
  command: AICommand;  // CHANGED: structured command instead of code
  done?: boolean;
  blocked?: string;  // Legacy: keep for backward compatibility
  blockedInfo?: BlockedInfo;  // New: structured format with canUserHelp flag
}

/**
 * Test result with full history and artifacts
 * Screenshots are stored as Buffer for efficient upload to storage
 * ✅ NEW: Now includes graphData for Pro-compatible visualization
 */
/**
 * Collected error (Pro-grade)
 */
export interface CollectedError {
  message: string;
  page: string; // URL where error occurred
  type: 'execution' | 'validation' | 'console' | 'network' | 'page' | 'ui';
  iteration?: number;
  timestamp: number;
  screenshotUrl?: string;
  details?: Record<string, unknown>;
}

export interface LiteTestResult {
  success: boolean;
  reason: string;
  iterations: number;
  history: string;
  // ✅ FIX: Screenshots can be either Buffers (during execution) or URLs (after upload)
  // For Lite mode: only final screenshot URL after completion
  screenshots: Array<{ url: string; screenshot: string }> | Array<{ name: string; buffer: Buffer; timestamp: number }>;
  duration?: number; // Execution duration in milliseconds
  errors: CollectedError[]; // Pro-grade error collection
  graphData?: {
    nodes: any[];
    edges: any[];
    metadata: {
      totalNodes: number;
      totalEdges: number;
      totalActions: number;
      completedSteps: number;
      failedSteps: number;
      startNodeId: string | null;
      endNodeId: string | null;
      generatedAt: string;
      version: string;
    };
  };
}

/**
 * Engine configuration
 */
export interface LiteEngineConfig {
  testId: string;
  userId?: string;
  browser?: string;
  goal: string;
  url: string;
  timeout?: number;
}

/**
 * Iteration record for state tracking
 */
export interface IterationRecord {
  iteration: number;
  decision: AIDecision;
  result: {
    outcome: ActionOutcome;
    success: boolean;
    error?: string;
    duration: number;
    usedFallback?: boolean;
    fallbackInfo?: string;
    stateDiff: StateDiff;
  };
  stateBefore: {
    url: string;
    elementCount: number;
    pageErrors?: string[];
  };
  stateAfter: {
    url: string;
    elementCount: number;
    pageErrors?: string[];
  };
}

/**
 * Element info for fallback strategies
 */
export interface ElementInfo {
  text: string;
  placeholder?: string;
  ariaLabel?: string;
  tag: string;
  type?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// GOAL DETECTION TYPES (for GoalDetector with AI Fallback)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full context passed to GoalDetector on each iteration
 * Contains all information needed to evaluate goal progress
 */
export interface GoalContext {
  /** Current test goal */
  goal: string;

  /** Current page info */
  page: {
    url: string;
    title: string;
  };

  /**
   * Compact snapshot summary (max 50 elements)
   * Only forms, CTAs, headings, inputs - not all page elements
   * Format: "tag[type]:name" (e.g., "button:Sign Up", "input[email]:Email address")
   */
  snapshotSummary: string[];

  /** Last 5-7 iterations (compact format) */
  history: string;

  /** Result of last action */
  lastOutcome?: string;

  /** Stuck detection state */
  stuckCheck: StuckCheck;

  /** Number of consecutive stuck iterations */
  consecutiveStuckCount: number;

  /** Last 3-5 unique errors (deduplicated by message+type) */
  recentErrors: Array<{ message: string; type: string }>;

  /** Current iteration number */
  iteration: number;
}

/**
 * Result from AI Goal Evaluator (fallback)
 * Returned when heuristic is uncertain and AI is called
 */
export interface GoalEval {
  /** Whether the goal has been reached */
  goalReached: boolean;

  /** Progress score (0..1) */
  progressScore: number;

  /** Confidence in the evaluation (0..1) */
  confidence: number;

  /** Human-readable reason */
  reason: string;

  /**
   * Concrete evidence from the page supporting the evaluation
   * E.g., ["URL contains /success", "Found 'Thank you' heading", "Form submitted"]
   */
  evidence: string[];

  /**
   * Optional next subgoal to pursue if not yet reached
   * Used to guide the agent when stuck
   */
  nextSubgoal?: string;
}

/**
 * Guidance from AI fallback to inject into prompt
 * Used when agent is stuck to help it recover
 */
export interface GoalGuidance {
  /** Guidance text to include in prompt */
  guidance: string;

  /** Specific next subgoal to pursue */
  nextSubgoal?: string;

  /** Iteration when guidance was added (for lifetime tracking) */
  addedAtIteration: number;
}
