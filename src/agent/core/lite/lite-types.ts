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
}

/**
 * Snapshot of page state at a point in time
 */
export interface LiteSnapshot {
  url: string;
  title: string;
  elements: LiteElement[];
  timestamp: number;
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
}

/**
 * Outcome of an action execution
 */
export type ActionOutcome =
  | 'state_changed'      // State changed after action
  | 'validation_error'   // Validation error detected
  | 'no_effect'          // Action executed but no state change
  | 'execution_error'    // Action failed to execute
  | 'critical_error';    // Critical error - page crashed/blank (needs reload)

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
 */
export interface LiteTestResult {
  success: boolean;
  reason: string;
  iterations: number;
  history: string;
  screenshots: Array<{ name: string; path: string; timestamp: number }>;
  duration?: number; // Execution duration in milliseconds
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
