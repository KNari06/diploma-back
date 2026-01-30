/**
 * Preview Session Types
 * Types for realtime step editor and preview functionality
 */

// ═══════════════════════════════════════════════════════════════════════════
// INTERACTIVE NODE (for dom_analysis storage)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bounding box for element (used for highlighting)
 */
export interface ElementBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Interactive node stored in dom_analysis
 * Structure for linting/resolving without live browser
 * V2: Includes ARIA state, validation, labels, hierarchy
 */
export interface InteractiveNode {
  /** Stable reference (data-agent-ref if available) */
  ref?: string;
  /** HTML tag */
  tag: string;
  /** ARIA role or computed role */
  role?: string;
  /** Input type (for input elements) */
  type?: string;
  inputType?: string;
  /** Text content (truncated) */
  text?: string;
  /** Associated label text (from <label for=>, wrapping <label>, aria-labelledby) */
  labelText?: string;
  /** ARIA label */
  ariaLabel?: string;
  /** HTML name attribute */
  name?: string;
  /** Placeholder text */
  placeholder?: string;
  /** HTML id attribute */
  id?: string;
  /** Test ID attribute (data-testid, data-test, etc.) */
  testIdAttr?: string;
  /** Autocomplete hint (email, username, current-password, etc.) */
  autocomplete?: string;
  /** Bounding box (for highlighting) */
  boundingBox?: ElementBoundingBox;
  /** Visibility flag */
  isVisible?: boolean;
  /** Interactive flag */
  isInteractive?: boolean;
  /** Disabled flag */
  isDisabled?: boolean;
  /** Container hints for context (legacy) */
  containerHints?: {
    formGroupTitle?: string;
    parentClassTokens?: string[];
  };
  /** True if element is topmost at its center (not covered by overlay) */
  isTopMostAtCenter?: boolean;
  /** True if id looks like a dynamic GUID/random string */
  isDynamicId?: boolean;

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: ARIA state
  // ═══════════════════════════════════════════════════════════════════════════
  /** Native checked state (for checkboxes/radios) */
  checked?: boolean;
  /** aria-expanded state (for dropdowns, accordions, menus) */
  ariaExpanded?: boolean;
  /** aria-pressed state (for toggle buttons) */
  ariaPressed?: boolean;
  /** aria-selected state (for tabs, listbox options) */
  ariaSelected?: boolean;
  /** aria-checked for custom checkboxes/switches */
  ariaChecked?: boolean | 'mixed';

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Validation state
  // ═══════════════════════════════════════════════════════════════════════════
  /** HTML required attribute */
  required?: boolean;
  /** HTML readonly attribute or aria-readonly */
  readOnly?: boolean;
  /** aria-invalid or :invalid pseudo-class */
  invalid?: boolean;
  /** True if input has a non-empty value (privacy-safe) */
  hasValue?: boolean;

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Hierarchy (parent chain for disambiguation)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Refs of key ancestor containers (closest-first, max depth 6) */
  parentRefChain?: string[];
  /** Ref of nearest form/dialog/section container */
  containerRef?: string;
  /** Titles of key containers (form legend, fieldset legend, section heading) */
  containerTitles?: string[];
}

/**
 * DOM analysis structure stored in intelligent_page_visits.dom_analysis
 */
export interface DomAnalysisData {
  /** Interactive elements on the page */
  interactiveNodes: InteractiveNode[];
  /** Page URL at time of capture */
  url?: string;
  /** Page title */
  title?: string;
  /** Timestamp of capture */
  capturedAt: number;
  /** Version for future migrations */
  version: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTENT STEP (for user-authored test cases)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action type for intent steps (V2: added state-aware actions)
 */
export type IntentActionType =
  | 'fill'
  | 'click'
  | 'wait'
  | 'assert'
  | 'navigate'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'press'
  // V2: State-aware action types
  | 'check'
  | 'uncheck'
  | 'toggle'
  | 'open'
  | 'close';

/**
 * Binding hints for element resolution
 * Helps the linting engine find the right element
 */
export interface BindingHints {
  /** ARIA role or tag-based role */
  role?: string;
  /** Label text to match */
  label?: string;
  /** Placeholder text to match */
  placeholder?: string;
  /** Nearby text for context */
  nearText?: string;
  /** URL pattern where this step applies */
  urlPattern?: string;
  /** Page type (login, checkout, etc.) */
  pageType?: string;
  /** Autocomplete hint (email, password, etc.) */
  autocomplete?: string;
  /** Input type (text, email, password, etc.) */
  type?: string;
}

/**
 * Evidence cache from last successful execution
 * Used as optimization hint, not as truth
 */
export interface StepEvidence {
  /** Last successful element ref */
  lastSuccessRef?: string;
  /** Last successful selector */
  lastSuccessSelector?: string;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Node IDs from graph that evidence this step */
  evidenceNodeIds?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPILED STEP PLAN (for reliable execution with fallback and heal)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Single locator strategy
 * Represents one way to find an element (primary or fallback)
 */
export interface LocatorEntry {
  /** Strategy type: role, label, testId, placeholder, css, ref */
  strategy: 'role' | 'label' | 'testId' | 'placeholder' | 'css' | 'ref';
  /** Playwright locator string or params */
  value: string;
  /** Optional role name for getByRole */
  roleName?: string;
  /** Confidence score when generated (0-1) */
  confidence?: number;
}

/**
 * Target element fingerprint for heal comparison
 * Stores identifying characteristics to help AI find the element if it changed
 */
export interface TargetFingerprint {
  tag?: string;
  role?: string;
  labelText?: string;
  ariaLabel?: string;
  testIdAttr?: string;
  placeholder?: string;
  boundingBox?: ElementBoundingBox;
  containerTitles?: string[];
}

/**
 * Compiled execution plan for a step
 * Generated after successful apply, enables direct Playwright execution
 */
export interface CompiledStepPlan {
  /** Ordered list of locators to try (primary first, then fallbacks) */
  locatorPlan: LocatorEntry[];
  /** Action to perform */
  action: {
    type: IntentActionType;
    value?: string;
    options?: {
      timeout?: number;
      replaceContent?: boolean;
      pressEnter?: boolean;
    };
  };
  /** Pre-conditions to check before action */
  preconditions?: ('visible' | 'enabled' | 'attached' | 'stable')[];
  /** Post-conditions / expected outcomes */
  postconditions?: ('navigation' | 'domChange' | 'urlChange' | 'stateChange')[];
  /** Context snapshot reference */
  context: {
    pageUrl: string;
    pageTitle?: string;
    /** Reference to dom_analysis snapshot (e.g., intelligent_page_visits.id) */
    snapshotRef?: string;
    /** Screenshot storage path (optional) */
    screenshotRef?: string;
    /** Timestamp when compiled */
    compiledAt: string;
  };
  /** Target element fingerprint (for heal comparison) */
  targetFingerprint?: TargetFingerprint;
}

/**
 * Intent step - user-authored test step with plain text description
 */
export interface IntentStep {
  /** Unique step ID */
  id: string;
  /** Action type */
  type: IntentActionType;
  /** Plain text description (user's intent) */
  description: string;
  /** Value for fill actions */
  value?: string;
  /** Options for the action */
  options?: {
    timeout?: number;
    replaceContent?: boolean;
    pressEnter?: boolean;
  };
  /** Hints for element resolution */
  bindingHints?: BindingHints;
  /** Cached evidence from last execution (optimization, not truth) */
  evidence?: StepEvidence;
  /** Compiled execution plan (generated after successful apply) */
  compiled?: CompiledStepPlan;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINT RESULT (from linting engine)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lint status
 */
export type LintStatus = 'resolved' | 'ambiguous' | 'not_found' | 'needs_clarification' | 'error';

/**
 * Candidate element from linting
 */
export interface LintCandidate {
  /** Element ref */
  ref?: string;
  /** Human-readable label */
  label: string;
  /** Why this candidate matched */
  reason: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Bounding box for highlighting */
  boundingBox?: ElementBoundingBox;
  /** Full InteractiveNode data for compiled plan generation */
  node?: InteractiveNode;
}

/**
 * Lint result from step validation
 */
export interface LintResult {
  /** Status of linting */
  status: LintStatus;
  /** Human-readable message */
  message: string;
  /** Overall confidence (0-1) */
  confidence: number;
  /** Candidate elements (for ambiguous cases) */
  candidates: LintCandidate[];
  /** Elements to highlight on UI */
  highlight: Array<{
    ref?: string;
    boundingBox?: ElementBoundingBox;
    type: 'success' | 'warning' | 'error';
  }>;
  /** V2: True if AI fallback is recommended (ambiguous/low confidence) */
  needsAiFallback?: boolean;
  /** V2: AI resolved ref (if AI fallback was used) */
  aiResolvedRef?: string;
  /** V2: AI reasoning (if AI fallback was used) */
  aiReason?: string;
  /** V3: AI interpretation of user intent */
  interpretation?: string;
  /** V3: Clarification question for user (in user's language) */
  clarificationQuestion?: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // V4: Embeddings-based resolver fields
  // ═══════════════════════════════════════════════════════════════════════════
  /** True if embeddings failed and rule-based fallback was used */
  degradedMode?: boolean;
  /** Reason for degraded mode (e.g., "embeddings_timeout", "rate_limited") */
  degradedReason?: string;
  /** Top similarity score from embeddings ranking */
  topSimilarity?: number;
  /** Delta between top and second similarity */
  similarityDelta?: number;
  /** Whether embeddings cache was hit */
  cacheHit?: boolean;
  /** Embeddings latency in milliseconds */
  embeddingsLatencyMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW SESSION (runtime state)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Preview session state (in-memory)
 */
export interface PreviewSession {
  /** Session ID */
  id: string;
  /** User ID */
  userId: string;
  /** Project ID */
  projectId: string;
  /** Start URL */
  startUrl: string;
  /** Current page state */
  pageState: {
    url: string;
    pageType?: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
  };
  /** Creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastSeenAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// API PAYLOADS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request to start preview session
 */
export interface StartPreviewRequest {
  projectId: string;
  startUrl: string;
}

/**
 * Response from start preview
 */
export interface StartPreviewResponse {
  previewSessionId: string;
  url: string;
  domNodes: InteractiveNode[];
  screenshot?: string;
  viewport?: {
    width: number;
    height: number;
  };
  devicePixelRatio?: number;
}

/**
 * Request to create intent test case
 */
export interface CreateIntentTestCaseRequest {
  projectId: string;
  name: string;
  description?: string;
  startUrl: string;
  steps: IntentStep[];
  /** Optional link to test flow */
  flowId?: string;
  /** Optional link to saved test case (replay entity) */
  savedTestCaseId?: string;
}

/**
 * Intent test case (DB entity)
 */
export interface IntentTestCase {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  startUrl: string;
  stepsJson: IntentStep[];
  /** Optional link to test flow (enables "open flow → load draft steps") */
  flowId?: string;
  /** Optional link to saved test case (replay entity) */
  savedTestCaseId?: string;
  createdAt: string;
  updatedAt: string;
}
