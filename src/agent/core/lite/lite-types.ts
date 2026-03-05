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
  /** True if element is slotted content (light DOM rendered in shadow DOM slot) */
  isSlotted?: boolean;
  /** Name of the slot (default, named, or undefined if not slotted) */
  slotName?: string;
  /** Shadow DOM nesting depth (0 = light DOM, 1 = first level shadow, etc.) */
  shadowDepth?: number;
  /** Source iframe name/url (only for elements collected from iframes) */
  iframeSource?: string;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Custom component interactivity signals
  // ═══════════════════════════════════════════════════════════════════════════
  /** Framework event binding detected (React/Vue/Angular synthetic events) */
  frameworkClickable?: 'react' | 'vue' | 'angular';
  /** Element has contenteditable="true" (rich text editor, inline text field) */
  isContentEditable?: boolean;
  /** Element has tabindex >= 0 (explicitly keyboard-focusable) */
  tabIndex?: number;
  /** Element has onclick attribute or inline click handler */
  hasOnclick?: boolean;
  /** Element has aria-haspopup attribute (popup trigger) */
  hasAriaHaspopup?: boolean;
  /** Resolved href for <a> elements (absolute URL) */
  href?: string;
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
 * Visual content metadata for proactive vision detection
 * NEW: P0 Feature - Proactive Vision Detection
 */
export interface SnapshotMetadata {
  /** Whether page contains canvas elements */
  hasCanvas: boolean;
  /** Whether page contains SVG elements */
  hasSVG: boolean;
  /** Canvas coverage as percentage of viewport (0-1) */
  canvasArea: number;
  /** SVG coverage as percentage of viewport (0-1) */
  svgArea: number;
  /** Whether DOM has few interactive elements (<10) */
  isDOMWeak: boolean;
  /** Number of interactive elements (buttons, inputs, links) */
  interactiveElementCount: number;
  /** Whether vision analysis is recommended for this page */
  recommendVision: boolean;
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
  /** Structured facts about positioned elements for LLM obstacle classification (Layer 2) */
  obstacleFacts?: ObstacleFact[];
  /** Transient state info (loading indicators) - NEW: Lite Autonomy v3 */
  transientState?: TransientStateInfo;
  /** Truncated page text for credential extraction only (never sent to LLM/logs) */
  pageTextForExtraction?: string;
  /** Visual content metadata for proactive vision detection - NEW: P0 Feature */
  metadata?: SnapshotMetadata;
  /** Page structure metadata (tables, lists, pagination) */
  pageStructure?: PageStructureMetadata;
  /** Visible page alerts/errors (non-interactive error messages, validation errors, auth failures) */
  pageAlerts?: string[];
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
 *
 * P1 Enhancement: Full request/response interception for AI debugging
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

  // P1: Full Request/Response Interception
  /** Request body (for POST/PUT/PATCH) - helps AI understand what was sent */
  requestBody?: any;
  /** Full response body - provides complete error context */
  responseBody?: any;
  /** Response headers (especially retry-after for rate limiting) */
  headers?: Record<string, string>;
  /** Parsed field-level validation errors: [{field: 'email', message: 'invalid format'}] */
  fieldErrors?: Array<{ field: string; message: string }>;
  /** Rate limit info extracted from headers */
  rateLimitInfo?: {
    retryAfter?: number; // seconds
    limit?: number;
    remaining?: number;
    reset?: number; // timestamp
  };
  /** Authentication error hint (e.g., 'token_expired', 'invalid_credentials') */
  authErrorHint?: string;
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
  | 'rate_limited'       // HTTP 429 / rate limiting detected - should back off and wait
  | 'critic_rejected';   // Critic agent vetoed the action before execution

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
  /** Layer 3: Exact blocker identified after click interception */
  blockerInfo?: BlockerInfo;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL OBSTACLE INTELLIGENCE (3-Layer)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Obstacle type classification — covers ALL UI blockers, not just modals.
 * Used by Layer 1 (deterministic hints), Layer 2 (LLM classification),
 * and Layer 3 (reactive blocker detection).
 */
export type ObstacleType =
  | 'modal'              // Dialog, alertdialog, aria-modal (blocking, must dismiss)
  | 'cookie_consent'     // GDPR/CCPA banners (blocking, auto-dismissible)
  | 'chat_widget'        // Intercom/Drift/Zendesk (persistent, usually non-blocking)
  | 'toast'              // Notification toasts (transient, wait or dismiss)
  | 'sticky_header'      // Fixed headers/navbars (permanent, scroll around)
  | 'sticky_footer'      // Fixed footers/cookie bars (permanent, scroll around)
  | 'loading_overlay'    // Spinners, progress bars (transient, wait)
  | 'dropdown'           // Open dropdown/menu (dismissible with Escape/click-away)
  | 'tooltip'            // Tooltip/popover (transient, moves on hover)
  | 'drawer'             // Side drawer/panel (blocking, dismiss with close/Escape)
  | 'onboarding'         // Welcome tour/walkthrough (dismissible)
  | 'paywall'            // Login wall/paywall (blocking, needs auth/payment)
  | 'unknown';           // Unclassified positioned element

/**
 * Layer 2: Structured facts about positioned elements for LLM classification.
 * Collected by snapshot-collector, passed to Observer for intelligent classification.
 * Covers ALL positioned elements — modals, cookie banners, chat widgets,
 * sticky headers, toast notifications, loading overlays, dropdowns, tooltips, etc.
 */
export interface ObstacleFact {
  /** Element ref (e.g. "e42") */
  ref: string;
  /** HTML tag name */
  tag: string;
  /** CSS position property */
  position: 'fixed' | 'absolute' | 'sticky';
  /** Computed z-index */
  zIndex: number;
  /** Viewport coverage ratio (0-1) */
  coverage: number;
  /** CSS class names (first 200 chars) */
  className: string;
  /** Inner text preview (first 200 chars) */
  textPreview: string;
  /** HTML id attribute (first 100 chars) */
  id?: string;
  /** Whether element contains a close/dismiss button */
  hasCloseButton: boolean;
  /** Whether element contains interactive children (buttons, inputs, links) */
  hasInteractiveChildren: boolean;
  /** ARIA role if present */
  role?: string;
  /** aria-modal="true" if present */
  ariaModal?: boolean;
  /** Bounding rect in viewport coordinates */
  rect: { top: number; left: number; width: number; height: number };
  /** Deterministic pre-classification hint (may be wrong for ambiguous elements) */
  hintType?: ObstacleType;
  /** Refs of elements that this obstacle is visually covering */
  coveredRefs?: string[];
}

/**
 * Layer 3: Exact blocker identified via elementFromPoint after click interception.
 * Provides precise identity of what blocked a click, enabling type-specific recovery.
 */
export interface BlockerInfo {
  /** Ref of the blocking element (if it has data-agent-ref) */
  blockerRef?: string;
  /** HTML tag of the blocker */
  blockerTag: string;
  /** CSS class of the blocker (first 200 chars) */
  blockerClass: string;
  /** Text content preview of the blocker (first 100 chars) */
  blockerText: string;
  /** Ref of the target element that was blocked */
  targetRef: string;
  /** Coordinates where the click was attempted */
  point: { x: number; y: number };
  /** Deterministic guess of blocker type */
  hintType?: ObstacleType;
  /** Suggested recovery action based on blocker type */
  suggestedRecovery?: 'dismiss_escape' | 'dismiss_button' | 'scroll_around' | 'wait' | 'click_away' | 'navigate_back';
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
  action: 'click' | 'fill' | 'press' | 'goto' | 'scroll' | 'select' | 'hover' | 'wait'
    | 'toggle' | 'setRange' | 'clear' | 'selectDate';
  ref?: string;           // target element ref
  value?: string;         // for fill, select, setRange (target value), selectDate (date string)
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
  /** Multi-agent pipeline metrics (present when enableMultiAgentBrain=true) */
  multiAgentMetrics?: import('./agents/types').MultiAgentRunMetrics;
  /** Page visits constructed from iteration records (for DB storage) */
  pageVisits?: import('@/agent/types/intelligent-testing.types').PageVisit[];
  /** Actual count of unique pages visited */
  uniquePagesVisited?: number;
  /** Structured executed steps for /full endpoint */
  executedSteps?: Array<{ ts: string; type: 'step_completed'; data: { step: number; action: string; description: string; success: boolean; url: string } }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE STRUCTURE METADATA (Tables, Lists, Pagination)
// ═══════════════════════════════════════════════════════════════════════════

/** Table structure detected in page */
export interface TableMetadata {
  ref: string;
  headers: string[];
  rowCount: number;
  columnCount: number;
  isSortable: boolean;
  hasPagination: boolean;
  hasCheckboxes: boolean;
  hasInlineEditing: boolean;
}

/** List structure detected in page */
export interface ListMetadata {
  ref: string;
  itemCount: number;
  isVirtualized: boolean;
  hasLoadMore: boolean;
}

/** Pagination controls detected on page */
export interface PaginationMetadata {
  currentPage?: number;
  totalPages?: number;
  nextRef?: string;
  prevRef?: string;
}

/** Composite page structure metadata */
export interface PageStructureMetadata {
  tables: TableMetadata[];
  lists: ListMetadata[];
  pagination: PaginationMetadata | null;
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
  /** Prefilled steps from Smart Test Case Resolver for fast replay before AI loop */
  prefilledSteps?: import('@/services/testing/resolver/resolver.types').PrefilledStep[];
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
  role?: string;
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

  /** ✅ NEW: URL change tracking for login/register success detection */
  urlBefore?: string;
  urlAfter?: string;
  urlChanged?: boolean;

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

  /** ✅ NEW: Current flow state for multi-step processes */
  flowState?: FlowState;

  /** Auth-specific signals for login/register goal validation */
  authSignals?: {
    /** Credential auto-fill completed (fill username → fill password → click submit) */
    credentialsFilled?: boolean;
    /** Successful network responses after submit (e.g. POST /auth → 200) */
    successfulResponses?: Array<{ url: string; method: string; status: number }>;
    /** Network errors after submit (e.g. POST /auth → 401) */
    failedResponses?: Array<{ url: string; method: string; status: number; error: string }>;
    /** Page title changed (e.g. "Login" → "Dashboard") */
    titleBefore?: string;
    titleAfter?: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Flow State Tracking (Task #21)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Flow state for multi-step processes (login, register, checkout)
 * Helps AI understand current step and make correct next decisions
 */
export interface FlowState {
  /** Flow type (authentication, e-commerce, search, settings, form, navigation, etc.) */
  flowType: string;

  /** Current step in the flow */
  currentStep: FlowStep;

  /** Previous step (for rollback detection) */
  previousStep?: FlowStep;

  /** When this state was set (timestamp) */
  timestamp: number;

  /** Confidence in state detection (0-1) */
  confidence: number;
}

/**
 * Individual step in a multi-step flow
 */
export type FlowStep =
  | 'initial'              // Starting point, no form visible
  | 'form_visible'         // Auth/checkout form is visible
  | 'filling_credentials'  // User filling username/password
  | 'submitting'           // Form submitted, waiting for response
  | 'redirecting'          // URL change detected, navigating
  | 'verify_email'         // Email verification required
  | 'verify_phone'         // Phone/SMS verification required
  | 'verify_2fa'           // 2FA/OTP verification required
  | 'reset_password'       // Password reset flow
  | 'complete_profile'     // Additional profile info required
  | 'success'              // Flow completed successfully
  | 'error';               // Error state

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
 * AI-based goal completion evaluator result.
 * gpt-4o-mini decides whether the goal is achieved by comparing before/after state.
 */
export interface GoalCompletionResult {
  /** AI verdict: whether the user goal is fully achieved. */
  isDone: boolean;
  /** AI confidence score (0..1). */
  confidence: number;
  /** AI-generated explanation of the decision. */
  reason: string;
  /** Compact transition summary injected into next AI prompt and traces. */
  transitionSummary: string;
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
// NEGATIVE REINFORCEMENT: Failed Action Tracking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entry tracking a failed action attempt
 * Keyed by "{action}:{ref}" (e.g., "click:e5")
 */
export interface FailedActionEntry {
  /** Action type (click, fill, etc.) */
  action: string;
  /** Element ref */
  ref: string;
  /** Element name/label for prompt display */
  elementName: string;
  /** Number of times this action failed */
  failureCount: number;
  /** Last failure outcome (no_effect, execution_error, validation_error) */
  lastOutcome: ActionOutcome;
  /** Last error message (if any) */
  lastError?: string;
  /** Iteration when first failure occurred */
  firstFailureIteration: number;
  /** Iteration when last failure occurred */
  lastFailureIteration: number;
}

/**
 * A blacklisted action that should not be repeated
 * Created when failureCount >= threshold
 */
export interface BlacklistedAction {
  /** Action key "{action}:{ref}" */
  key: string;
  /** Action type */
  action: string;
  /** Element ref */
  ref: string;
  /** Element name for display */
  elementName: string;
  /** Total failure count */
  failureCount: number;
  /** Last outcome type */
  lastOutcome: ActionOutcome;
  /** Last error message */
  lastError?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE DRIFT AUDITOR TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Confidence scoring for state drift reliability
 */
export interface DriftConfidence {
  /** Confidence score 0-1 */
  score: number;
  /** Suggested AI behavior based on confidence */
  suggestedBehavior: 'conservative' | 'normal' | 'aggressive';
  /** Reasons for degradation */
  degradationReasons: string[];
}

/**
 * Change attribution explaining WHY progress was assessed
 */
export interface ChangeAttribution {
  /** Top contributors with percentages */
  contributors: Array<{ factor: string; percentage: number }>;
  /** Human-readable summary */
  summary: string;
}

/**
 * Repetition detection for loop/error patterns
 */
export interface RepetitionDetection {
  /** Whether a navigation loop is detected */
  loopDetected: boolean;
  /** Human-readable loop description */
  loopDescription?: string;
  /** URL visit counts that triggered detection */
  urlVisitCounts?: Record<string, number>;
  /** Repeated error messages */
  repeatedErrors?: Array<{ message: string; count: number }>;
}

/**
 * Anomaly detection for unusual state changes
 */
export interface AnomalyDetection {
  /** Elements that flicker (appear-disappear-appear) */
  flickeringElements: string[];
  /** Form fields that were lost */
  lostFormFields: string[];
  /** Error trend direction */
  errorTrend: 'increasing' | 'decreasing' | 'stable';
}

/**
 * Diff quality metrics
 */
export interface DiffQualityMetrics {
  /** Whether loading indicators were detected */
  loadingDetected: boolean;
  /** Whether pending network requests exist */
  pendingNetworkRequests: boolean;
  /** Number of gray-zone elements (no AI confirmation) */
  grayZoneElementCount: number;
}

/**
 * Complete state drift audit result
 */
export interface StateDriftAuditResult {
  /** Confidence in the diff */
  confidence: DriftConfidence;
  /** Attribution of progress assessment */
  attribution: ChangeAttribution;
  /** Loop and repetition detection */
  repetition: RepetitionDetection;
  /** Anomaly detection */
  anomalies: AnomalyDetection;
  /** Diff quality metrics */
  diffQuality: DiffQualityMetrics;
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
  /** Content hash for SPA-aware recovery (TASK 8) */
  contentHash?: string;
}
