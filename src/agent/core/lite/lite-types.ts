/**
 * Lite Engine Types
 * Core type definitions for the Lite Engine testing system
 */

/**
 * Bounding box for Visual Anchors (spatial lookup)
 * Used for geometric element identification when selectors are unstable
 */
export interface ElementBounds {
  /** Left position relative to viewport */
  x: number;
  /** Top position relative to viewport */
  y: number;
  width: number;
  height: number;
}

/**
 * Element with parent context for better AI understanding
 * Includes semantic attributes for field classification (Level 1-3 hierarchy)
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
  isInsideActiveModal?: boolean; // True if element is inside active modal
  isInsideShadowDOM?: boolean;   // PHASE D: True if element is inside a shadow DOM
  // Semantic attributes for field classification (Level 1 signals)
  autocomplete?: string;  // e.g., "current-password", "email", "tel", "username"
  inputmode?: string;     // e.g., "tel", "email", "numeric"
  htmlName?: string;      // HTML name attribute (e.g., "password", "email")
  htmlId?: string;        // HTML id attribute (e.g., "login-email")
  // Z-Index / Layering signals for overlay/modal awareness (no hardcoded thresholds)
  /** Parsed z-index from getComputedStyle (null if 'auto' or non-numeric) */
  computedZIndex?: number | null;
  /** True if position !== 'static' (participates in stacking context) */
  isPositioned?: boolean;
  /** True if element is the topmost at its center point (not covered by overlay) */
  isTopMostAtCenter?: boolean;
  // Visual Anchors: Bounding box for spatial lookup (fallback when selectors fail)
  /** Element bounding box relative to viewport (for Visual Anchor matching) */
  bounds?: ElementBounds;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP EDITOR V2: ARIA state, validation, labels, hierarchy
  // ═══════════════════════════════════════════════════════════════════════════

  // ARIA state (for non-native widgets like custom dropdowns, checkboxes, toggles)
  /** aria-expanded state (for dropdowns, accordions, menus) */
  ariaExpanded?: boolean;
  /** aria-pressed state (for toggle buttons) */
  ariaPressed?: boolean;
  /** aria-selected state (for tabs, listbox options) */
  ariaSelected?: boolean;
  /** aria-checked for custom checkboxes/switches (native `checked` takes priority) */
  ariaChecked?: boolean | 'mixed';

  // Validation state
  /** HTML required attribute */
  required?: boolean;
  /** HTML readonly attribute or aria-readonly */
  readOnly?: boolean;
  /** aria-invalid or :invalid pseudo-class */
  invalid?: boolean;
  /** True if input has a non-empty value (for state-aware actions) */
  hasValue?: boolean;

  // Label extraction (separate fields for better scoring)
  /** Direct aria-label attribute */
  ariaLabel?: string;
  /** Computed label text (from <label for=>, wrapping <label>, aria-labelledby) */
  labelText?: string;

  // Hierarchy (parent chain for disambiguation)
  /** Refs of key ancestor containers (closest-first, max depth 6) */
  parentRefChain?: string[];
  /** Ref of nearest form/dialog/section container */
  containerRef?: string;
  /** Titles of key containers (form legend, fieldset legend, section heading) */
  containerTitles?: string[];
}

/**
 * Visual Anchor direction (relative position of anchor to target element)
 */
export type AnchorDirection = 'top' | 'bottom' | 'left' | 'right';

/**
 * Visual Anchor type (stable element categories)
 */
export type AnchorType = 'heading' | 'label' | 'icon' | 'text';

/**
 * Visual Anchor - a stable neighboring element used for spatial lookup
 * Part of VisualSignature for identifying elements when selectors change
 */
export interface VisualAnchor {
  /** Type of anchor element */
  type: AnchorType;
  /** Text content of anchor (heading text, label text, etc.) */
  value: string;
  /** Direction from target element to this anchor */
  direction: AnchorDirection;
  /** Distance in pixels from target element center to anchor center */
  distance: number;
}

/**
 * Visual Signature - spatial fingerprint of an element
 * Used to re-identify elements when their selectors/refs change (dynamic sites)
 */
export interface VisualSignature {
  /** Element's own text content */
  ownText: string;
  /** Element tag name */
  tag: string;
  /** Input type if applicable */
  type?: string;
  /** Nearby stable anchor elements (max 5) */
  anchors: VisualAnchor[];
  /** Timestamp when signature was created */
  createdAt: number;
}

/**
 * Transient state info (loading indicators)
 */
export interface TransientStateInfo {
  /** Whether page is in transient/loading state */
  isTransient: boolean;
  /** Type of indicator detected */
  type?: 'progressbar' | 'aria-busy' | 'aria-live' | 'loading-text' | 'spinner' | 'skeleton';
  /** Ref of the loading indicator element */
  ref?: string;
  /** Text content of loading indicator (if any) */
  text?: string;
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
  /** Transient state info (loading indicators) - NEW: Lite Autonomy v3 */
  transientState?: TransientStateInfo;
  /** Truncated page text for credential extraction only (never sent to LLM/logs) */
  pageTextForExtraction?: string;
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
  /** Semantic weight (State Change Index) - sum of weights of added/removed elements. Manus Style. */
  semanticWeight: number;
  /** Whether change is meaningful (>= 0.1, not noise like ads/counters). */
  meaningfulChange: boolean;
  /** Whether change is significant (>= 0.5, successful state shift). */
  significantChange: boolean;
  /** Progress sentiment for AI (Major Progress, Significant Change, Minor Change, No Effect, Negative Change). */
  progressSentiment: ProgressSentiment;
  /** Successful API responses detected during action (Manus Style: fetch/xhr, mutating methods + API patterns). */
  successfulApiResponses?: NetworkSuccess[];
  /** Validation errors from API (400-499 with extracted message/errors from response body). */
  validationApiErrors?: NetworkValidationError[];
}

/**
 * Progress sentiment for AI communication (Manus Style)
 * Helps AI quickly understand what happened and adjust behavior
 */
export type ProgressSentiment =
  | 'Major Progress'        // semanticWeight >= 0.5 OR URL changed OR goal-specific form appeared
  | 'Significant Change'    // semanticWeight >= 0.5 OR network success without visual changes
  | 'Minor Change'          // semanticWeight >= 0.1 && < 0.5 (meaningful but not significant)
  | 'No Effect'             // semanticWeight < 0.1 (noise) AND no URL change AND no network success
  | 'Negative Change';      // errors detected (page/console/network/validation)

/**
 * Successful network response (Manus Style)
 * Tracks successful API calls as progress signal even before UI updates
 */
export interface NetworkSuccess {
  url: string;
  method: string;
  status: number;
  timestamp: number;
  resourceType: 'fetch' | 'xhr';
  iteration?: number;
}

/**
 * Network validation error (400-499 with parsed body)
 * Manus Style: extract message/errors from response body to help AI understand why validation failed
 */
export interface NetworkValidationError {
  url: string;
  method: string;
  status: number;
  timestamp: number;
  /** Extracted from response body: body.message or body.error.message */
  message?: string;
  /** Extracted from response body: body.errors array */
  errors?: string[];
  iteration?: number;
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
 * Modal dismiss attempt result
 */
export interface ModalDismissInfo {
  /** Whether dismissal was attempted */
  attempted: boolean;
  /** Whether modal was successfully dismissed */
  dismissed: boolean;
  /** Whether modal is still present after attempts */
  stillPresent: boolean;
  /** Method used for dismissal (if attempted) */
  method?: 'escape' | 'button' | 'none';
  /** Classification of the modal */
  modalType?: 'system' | 'validation' | 'unexpected' | 'goal';
  /** Reason for the attempt */
  reason?: string;
  /** Preview of modal text (for AI context) */
  modalTextPreview?: string;
}

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
  /** Modal dismiss attempt info (Lite Autonomy v3) */
  modalDismissInfo?: ModalDismissInfo;
  /** Whether force click was used (for QA tracking) */
  usedForceClick?: boolean;
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
  /**
   * AI hint: marks the field as containing sensitive data (password/email/phone/username).
   * System validates this hint - it's only honored if the classifier agrees.
   * Use this when filling credential fields to help with redaction.
   */
  isSensitive?: boolean;
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
 * Deep reasoning analysis (pre-action audit)
 * Forces AI to analyze page state before deciding action
 */
export interface DeepAnalysis {
  /** Current page state summary */
  pageState: string;
  /** Available relevant actions on current page */
  availableActions: string[];
  /** Detected obstacles (overlays, hidden elements, missing content) */
  obstacles: string[];
}

/**
 * AI decision response
 */
export interface AIDecision {
  /** Optional pre-action analysis (Deep Reasoning Chain) */
  analysis?: DeepAnalysis;
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
 * Credentials for Lite mode (secure: never sent to LLM)
 * Used for automatic fill of login/password/phone fields
 */
export interface LiteCredentials {
  email?: string;
  username?: string;
  phone?: string;
  password: string;
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
  /** User-provided credentials for login (SECURE: never sent to LLM, only used for field filling) */
  credentials?: LiteCredentials;
  /** Chat session ID for WebSocket routing isolation */
  chatSessionId?: string;
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

// ═══════════════════════════════════════════════════════════════════════════
// L5 VISION TYPES (Manus Style)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Vision analysis hints for DOM-weak scenarios.
 * Generated by GPT-4o Vision when:
 * - Very few interactive elements detected
 * - Canvas-heavy page
 * - Consecutive "No Effect" actions
 */
export interface VisionHints {
  /** Visible CTA buttons with location hints */
  visibleButtons: Array<{
    text: string;
    location: string; // e.g., "top-right", "center"
  }>;

  /** Detected form fields */
  formFields: Array<{
    type: string;
    label: string;
  }>;

  /** Active modals/dialogs */
  modals: Array<{
    description: string;
    hasCloseButton: boolean;
  }>;

  /** Layout description for context */
  layoutHint: string;

  /**
   * WORKSTREAM 5: Vision↔DOM conflict hints
   * Populated when Vision sees an element but DOM reports issues
   */
  conflicts?: Array<{
    /** Text Vision detected (button text, label, etc.) */
    visionText: string;
    /** DOM element ref if found */
    domRef?: string;
    /** DOM element name if found */
    domName?: string;
    /** Type of conflict detected */
    issue: 'disabled' | 'covered' | 'hidden' | 'not_found';
    /** Human-readable explanation */
    note: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKSTREAM 4: State Recovery Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FunnelPhase type alias (imported from funnel-analyzer in LiteEngine)
 * Re-declared here to avoid circular import in lite-types
 */
export type FunnelPhaseType = 'discovery' | 'selection' | 'pre_action' | 'conversion';

/**
 * Recovery point - a snapshot of "last known good" state
 * Used for deterministic state restoration when agent gets stuck
 */
export interface RecoveryPoint {
  /** URL at this recovery point */
  url: string;
  /** Snapshot at this recovery point (for element comparison) */
  snapshot: LiteSnapshot;
  /** Funnel phase when point was recorded */
  funnelPhase: FunnelPhaseType;
  /** Timestamp when point was recorded (for TTL checks) */
  timestamp: number;
  /** Iteration number when point was recorded */
  iteration: number;
  /** Whether this point has been invalidated (zombie) */
  invalidated?: boolean;
}
