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
  /** True if element is inside the active modal/popup/overlay layer */
  isInsideActiveModal?: boolean;
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
  /** Titles of key containers (form legend, fieldset legend, section heading, ARIA groups) */
  containerTitles?: string[];
  /** Nearest ARIA landmark role (banner, navigation, main, complementary, search, etc.) */
  nearestLandmark?: string;
  /** Phase 4: Framework event binding detected (React/Vue/Angular) */
  frameworkClickable?: 'react' | 'vue' | 'angular';
  /** Phase 4: Element has contenteditable="true" (rich text editor, inline text field) */
  isContentEditable?: boolean;
  /** Phase 4: Element has tabindex >= 0 (explicitly keyboard-focusable) */
  tabIndex?: number;
  /** Phase 4: Element has onclick attribute or inline click handler */
  hasOnclick?: boolean;
  /** Phase 4: Element has aria-haspopup attribute (popup trigger) */
  hasAriaHaspopup?: boolean;
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
 * Action type for intent steps (V2: added state-aware actions, V3: added ai_check, V4: replaced fill with type, V5: added wait_for)
 */
export type IntentActionType =
  | 'type'
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
  | 'close'
  // V3: AI-powered assertion
  | 'ai_check'
  // V5: URL wait (Momentic-like matchers + auto-insert support)
  | 'wait_for'
  // V6: File upload
  | 'upload'
  // V10: Advanced interaction types (recording)
  | 'dblclick'
  | 'contextmenu'
  | 'drag_and_drop';

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
 * Confidence tier for resolution/execution quality
 */
export type ConfidenceTier = 'high' | 'medium' | 'low';

/**
 * Resolution metadata from linting/execution
 */
export interface ResolutionMeta {
  /** Count of elements in allowed set */
  allowedCount: number;
  /** Rule IDs that were applied */
  usedRules?: string[];
  /** Whether LLM was used for element resolution */
  usedLLM: boolean;
  /** Confidence tier based on resolution quality */
  confidenceTier: ConfidenceTier;
  /** Top similarity score from LLM resolution */
  topSimilarity?: number;
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
  /** Resolution metadata from last successful lint/apply */
  resolutionMeta?: ResolutionMeta;
  /** URL where this evidence was captured (guards against cross-page ref collision in SPAs) */
  pageUrl?: string;
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
  /** Nearest ARIA landmark (Phase 7) */
  nearestLandmark?: string;
}

/**
 * Versioning metadata for compiled plans
 */
export interface CompiledPlanMeta {
  /** Version of the compiled plan format */
  compiledVersion: string;
  /** Version of the resolver that created this plan */
  resolverVersion: string;
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
    options?: StepOptions;
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
    /** Page signature hash for staleness detection */
    pageSignature?: string;
  };
  /** Versioning metadata */
  meta?: CompiledPlanMeta;
  /** Target element fingerprint (for heal comparison) */
  targetFingerprint?: TargetFingerprint;
}

/**
 * Iframe configuration for actions within iframes
 */
export interface IframeConfig {
  /** CSS selector for the iframe element */
  selector: string;
  /** Timeout for waiting for iframe to be ready (ms) */
  timeout?: number;
}

/**
 * URL matcher configuration for wait_for step (V5)
 * Supports Momentic-like matchers + internal auto-insert matcher
 */
export interface UrlMatcher {
  /** Match if URL contains this substring */
  substring?: string;
  /** Match using glob pattern (e.g., 'checkout' or 'products/*') */
  glob?: string;
  /** Match using regex pattern */
  regex?: string;
  /** Match if URL domain equals this value (strict host match) */
  domain?: string;
  /** Internal: wait until URL changes from this value (used by auto-insert) */
  changedFrom?: string;
  /** Case-sensitive matching (default: false) */
  caseSensitive?: boolean;
  /** Negate the match (wait until URL does NOT match) */
  negate?: boolean;
  /** Timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
}

/**
 * Step options - shared between IntentStep and CompiledStepPlan
 */
export interface StepOptions {
  /** Action timeout in milliseconds */
  timeout?: number;
  /**
   * Human-like execution mode for UI actions.
   * When enabled, the backend tries to emulate real user behavior:
   * - type: gradual typing (per-character delays) instead of instant fill
   * - click: hover + small pause before clicking; sometimes clicks at a random point inside the element
   */
  humanLike?: boolean;
  /** If false, append text instead of replacing (for type actions) */
  replaceContent?: boolean;
  /** Press Enter after filling */
  pressEnter?: boolean;
  /** Delay between keystrokes in milliseconds (for type actions) */
  keyPressDelay?: number;
  /** Manual CSS selector override - bypasses AI resolution */
  cssSelector?: string;
  /** Skip visibility/enabled checks before action */
  disableStabilityChecks?: boolean;
  /** Force fresh element lookup, skip evidence cache */
  disableCaching?: boolean;
  /** Iframe configuration for actions within iframes */
  iframe?: IframeConfig;
  /**
   * AI context mode for ai_check assertions (V3)
   * Specifies what context to provide to the LLM for evaluation
   * - 'html': HTML content only
   * - 'screenshot': Screenshot only
   * - 'html+a11y': HTML + accessibility tree (no screenshot)
   * - 'html+screenshot': HTML + screenshot
   * - 'html+a11y+screenshot': HTML + accessibility tree + screenshot (default, most comprehensive)
   */
  aiContextMode?: 'html' | 'screenshot' | 'html+a11y' | 'html+screenshot' | 'html+a11y+screenshot';
  /**
   * URL matcher configuration for wait_for step (V5)
   * Supports Momentic-like matchers (substring/glob/regex/domain) + internal changedFrom for auto-insert
   */
  urlMatcher?: UrlMatcher;
  /**
   * Advanced: Disable lookahead wait before this step.
   * Use when intentionally running on not-yet-ready element (rare).
   * Default: false (lookahead wait is enabled)
   */
  disableLookaheadWait?: boolean;
  /**
   * Override lookahead wait timeout for this step (ms).
   * Default: 10000. Use lower values for fast SPAs, higher for slow pages.
   */
  lookaheadTimeoutMs?: number;
  /** V10: CSS selector for drag-and-drop target element */
  dropTarget?: string;
  /** Upload configuration for upload step (V6) */
  upload?: {
    /** Source type: 'url' (download from public URL) or 'storage' (pre-uploaded file) */
    sourceType: 'url' | 'storage';
    /** Optional filename override */
    filename?: string;
    /** Store uploaded file path in environment variable */
    envVar?: string;
    /** Max file size in bytes (default: 50MB) */
    maxSizeBytes?: number;
  };
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
  /** Value for type actions */
  value?: string;
  /**
   * Assertion text for ai_check actions (V3)
   * Natural language assertion to be evaluated by LLM
   * Example: "There is a black nav bar with five links"
   * Required when type === 'ai_check'
   */
  assertionText?: string;
  /** Options for the action */
  options?: StepOptions;
  /** Hints for element resolution */
  bindingHints?: BindingHints;
  /** Cached evidence from last execution (optimization, not truth) */
  evidence?: StepEvidence;
  /** Compiled execution plan (generated after successful apply) */
  compiled?: CompiledStepPlan;
  /**
   * Expected outcome for this step (V11: negative test support)
   * - 'success': Step should complete without errors (default)
   * - 'error': Step is a negative test — expects 4xx / validation error / error toast
   * Must be explicitly set by the LLM or user. Falls back to 'success' if not set.
   */
  expectedOutcome?: ExpectedStepOutcome;
  /** True if this step was auto-injected (e.g., auto wait_for URL change). Soft failure — won't fail the test. */
  isAutoInjected?: boolean;
}

/**
 * Expected outcome classification for a test step.
 * Used to distinguish negative tests (expected 4xx) from regression bugs (unexpected 4xx).
 */
export type ExpectedStepOutcome = 'success' | 'error';

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
  /** V2: Reason for AI fallback (semantic_zero, ambiguous, low_confidence) */
  aiFallbackReason?: 'semantic_zero' | 'ambiguous' | 'low_confidence';
  /** V2: AI resolved ref (if AI fallback was used) */
  aiResolvedRef?: string;
  /** V2: AI reasoning (if AI fallback was used) */
  aiReason?: string;
  /** V3: AI interpretation of user intent */
  interpretation?: string;
  /** V3: Clarification question for user (in user's language) */
  clarificationQuestion?: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // V7: LLM-based resolver fields
  // ═══════════════════════════════════════════════════════════════════════════
  /** True if LLM resolver failed and rule-based fallback was used */
  degradedMode?: boolean;
  /** Reason for degraded mode (e.g., "llm_circuit_breaker", "rate_limited") */
  degradedReason?: string;
  /** Top similarity score from LLM resolution */
  topSimilarity?: number;
  /** Delta between top and second similarity */
  similarityDelta?: number;
  /** Whether LLM cache was hit */
  cacheHit?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME EXECUTION TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Runtime execution status for a step
 */
export type RuntimeStatus = 'executed' | 'healed' | 'failed';

/**
 * Source of the element resolution at runtime
 */
export type RuntimeSource = 'compiled' | 'resolver' | 'self_heal';

/**
 * Reason for step failure
 */
export type FailedReason =
  | 'element_not_found'
  | 'assertion_failed'
  | 'heal_blocked'
  | 'timeout'
  | 'silent_backend_failure'
  | 'unexpected_validation_error'
  | 'unknown';

/**
 * Resolution path used to find element at runtime
 */
export type ResolutionPath = 
  | 'compiled'
  | 'evidence'
  | 'llm_resolver'
  | 'rule_fallback'
  | 'self_heal';

/**
 * Root cause classification for failures
 */
export type RootCause = 'backend' | 'ui' | 'logic';

/**
 * Network verdict classification
 */
export type NetworkVerdict = 'backend_error' | 'clean' | 'warning' | 'expected_error' | 'validation_failure';

/**
 * Runtime metadata for step execution
 * Used for reporting and debugging
 */
export interface StepRuntimeMeta {
  /** Final status of the step execution */
  runtimeStatus: RuntimeStatus;
  /** Source of the element resolution */
  source: RuntimeSource;
  /** Confidence tier of the resolution */
  confidenceTier: ConfidenceTier;
  /** Reason for failure (if runtimeStatus === 'failed') */
  failedReason?: FailedReason;
  /** Human-readable explanation for failure (for CI reports) */
  failureExplanation?: string;
  /** True if step should be reviewed for flakiness */
  needsReview?: boolean;
  /** True if step is flagged as flaky */
  flaky?: boolean;
  /** Execution time in milliseconds */
  executionMs?: number;
  /** Which locator strategy worked (if any) */
  usedLocatorStrategy?: string;
  /** Whether compiled plan was expired */
  compiledExpired?: boolean;
  /** Whether page signature matched */
  pageSignatureMatched?: boolean;
  /** Self-healing confidence (if healed) */
  healConfidence?: number;
  /**
   * V6: True if lookahead auto-wait was applied (waited > threshold)
   * Indicates significant inter-step wait due to element not being ready
   */
  autoWaitApplied?: boolean;
  /**
   * V6: Milliseconds waited during lookahead (if autoWaitApplied is true)
   */
  autoWaitMs?: number;

  // ═══════════════════════════════════════════════════════════════════════════
  // V7: Resolution path and network correlation
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Which resolution path was used to find the element
   */
  resolutionPath?: ResolutionPath;
  /**
   * Root cause classification for step failures (from correlation)
   */
  rootCause?: RootCause;
  /**
   * Network verdict for this step
   */
  networkVerdict?: NetworkVerdict;
  /**
   * Network errors that occurred during step execution (as evidence)
   */
  networkEvidence?: Array<{
    method: string;
    url: string;
    status?: number;
    error: string;
  }>;
  /**
   * Error counts during step execution window
   */
  stepErrors?: {
    console: number;
    network: number;
    ui: number;
  };
  /**
   * Slow API calls during this step execution window (>2s response time)
   */
  slowApiCalls?: Array<{
    url: string;
    method: string;
    responseTime: number;
  }>;
}

/**
 * TTL values for compiled plan expiration (in milliseconds)
 * Type actions have shorter TTL since form fields change more often
 */
export const COMPILED_TTL_MS: Record<string, number> = {
  type: 7 * 24 * 60 * 60 * 1000,      // 7 days
  click: 14 * 24 * 60 * 60 * 1000,    // 14 days
  select: 7 * 24 * 60 * 60 * 1000,    // 7 days
  check: 14 * 24 * 60 * 60 * 1000,    // 14 days
  uncheck: 14 * 24 * 60 * 60 * 1000,  // 14 days
  hover: 14 * 24 * 60 * 60 * 1000,    // 14 days
  upload: 14 * 24 * 60 * 60 * 1000,  // 14 days
  default: 14 * 24 * 60 * 60 * 1000,  // 14 days
};

/**
 * Check if a compiled plan is expired based on action type.
 *
 * ── BUG FIX: Malformed compiledAt now treated as expired ──
 * Previously, `new Date(invalidString).getTime()` returned NaN,
 * and `NaN > number` = false → TTL check was silently bypassed.
 * Now: if compiledAt is missing or unparseable → treat as expired.
 */
export function isCompiledPlanExpired(
  compiledAt: string,
  actionType: string
): boolean {
  if (!compiledAt) return true;

  const ttl = COMPILED_TTL_MS[actionType] || COMPILED_TTL_MS.default;
  const compiledTime = new Date(compiledAt).getTime();

  // NaN check: if compiledAt is malformed, treat as expired
  if (isNaN(compiledTime)) return true;

  const now = Date.now();
  return now > compiledTime + ttl;
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
    pageTitle?: string;
    pageType?: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
    /** Visible text content of the page (up to 3k chars, for AI chat context) */
    pageText?: string;
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
 * Intent test case status for lifecycle management
 */
export type IntentTestCaseStatus = 'draft' | 'published' | 'archived';

/**
 * Intent test case kind (classification)
 */
export type IntentTestCaseKind = 'standalone' | 'regression_member';

/**
 * Replay strategy for test execution
 */
export type ReplayStrategy = 'commands' | 'graph_extract';

/**
 * Request to create intent test case
 */
export interface CreateIntentTestCaseRequest {
  projectId: string;
  name: string;
  description?: string;
  startUrl?: string;
  steps: IntentStep[];
  /** Optional link to test flow */
  flowId?: string;
  /** Lifecycle status (defaults to 'draft') */
  status?: IntentTestCaseStatus;
  /** Classification */
  kind?: IntentTestCaseKind;
}

/**
 * Intent test case (DB entity) - unified table for UI test cases
 * This is now the single source of truth for UI test cases,
 * supporting both draft/preview authoring and published regression tests.
 */
export interface IntentTestCase {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;

  // URL fields
  startUrl?: string;
  url?: string;

  // Steps for authoring
  stepsJson: IntentStep[];

  // Lifecycle
  status: IntentTestCaseStatus;
  kind: IntentTestCaseKind;

  // Replay data (populated when saved from completed test or published)
  replayStrategy?: ReplayStrategy;
  commands?: any[];
  graphRef?: any;
  parametersSchema?: Record<string, any>;

  // Organization
  flowId?: string;
  flowName?: string;
  dependsOn?: string[];
  resolvedDependencies?: Array<{ id: string; name: string }>;

  // Metadata
  tags?: string[];
  priority?: 'critical' | 'high' | 'medium' | 'low';
  preconditions?: string[];
  setupSteps?: any[];
  teardownSteps?: any[];
  expectedResult?: string;

  // Provenance (when saved from a completed test)
  sourceTestId?: string;
  sourceIntelligentSessionId?: string;

  createdAt: string;
  updatedAt: string;
}
