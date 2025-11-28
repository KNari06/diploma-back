/**
 * Types and interfaces for intelligent testing system
 * Supports dynamic, context-aware test execution
 */


// ═══════════════════════════════════════════════════════════════════════════
// PAGE CONTEXT & ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Type of page detected by AI
 */
export type PageType =
  | 'home'
  | 'product'
  | 'cart'
  | 'checkout'
  | 'login'
  | 'register'
  | 'search_results'
  | 'category'
  | 'profile'
  | 'dashboard'
  | 'settings'
  | 'payment'
  | 'error'
  | 'unknown';

/**
 * Element detected on page
 */
export interface PageElement {
  type: 'button' | 'input' | 'select' | 'link' | 'form' | 'modal' | 'other';
  purpose: string; // "search", "add_to_cart", "login", etc.
  selector: string;
  text?: string;
  required?: boolean; // Is this element required for the goal?
  priority?: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Analysis result from Vision AI
 */
export interface VisionAnalysis {
  pageType: PageType;
  description: string;
  elements: PageElement[];
  suggestions: string[];
  warnings?: string[]; // e.g., "payment form detected", "captcha present"
  modals?: Array<{ // ✅ NEW: Modal detection from Vision AI
    type: 'cookie_banner' | 'newsletter' | 'popup' | 'welcome' | 'other';
    description: string;
    hasCloseButton: boolean;
    closeButtonText?: string; // Visible text on close button (X, Close, ×, etc.)
  }>;
}

/**
 * DOM analysis result
 */
export interface DOMAnalysis {
  forms: Array<{
    action?: string;
    method?: string;
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      selector: string;
    }>;
  }>;
  buttons: Array<{
    text: string;
    type?: string;
    selector: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  links: Array<{
    href: string;
    text: string;
    selector: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  inputs: Array<{
    type: string;
    name?: string;
    required?: boolean;
    placeholder?: string;
    selector: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  checkboxes?: Array<{
    name?: string;
    label?: string;
    selector: string;
    checked: boolean;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  radios?: Array<{
    name?: string;
    label?: string;
    selector: string;
    checked: boolean;
    value?: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  interactiveElements?: Array<{
    tag: string;
    text?: string;
    selector: string;
    role?: string;
    tabindex?: number;
    reason: 'onclick' | 'cursor-pointer' | 'tabindex' | 'role';
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  modals?: Array<{
    type: 'cookie_banner' | 'newsletter' | 'popup' | 'other';
    closeSelector?: string;
  }>;
}

/**
 * Complete page context
 */
export interface PageContext {
  url: string;
  pageType: PageType;
  timestamp: number;
  vision: VisionAnalysis;
  dom: DOMAnalysis;
  screenshot?: string; // base64
  requiredActions: string[]; // Actions required before proceeding
  possibleActions: string[]; // All possible actions
  criticalElements: PageElement[];
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action generated dynamically based on context
 * NOTE: This type is used for intelligent testing (AI-driven test generation)
 * It supports a subset of PlaywrightActionType actions that are safe for automated testing
 */
export interface DynamicAction {
  action:
    // Navigation
    | 'goto'            // Navigate to URL
    // Interactions (core set for intelligent testing)
    | 'click'           // Click element
    | 'fill'            // Fill input field
    | 'type'            // Type text (with events)
    | 'select'          // Select from dropdown (maps to selectOption in executor)
    | 'check'           // Check checkbox
    | 'uncheck'         // Uncheck checkbox
    | 'hover'           // Hover over element
    | 'press'           // Press keyboard key
    // Wait & Scroll
    | 'wait'            // Wait for timeout
    | 'waitForSelector' // Wait for element to appear
    | 'waitForNavigation' // Wait for page navigation/load
    | 'scroll'          // Scroll page/element
    // Assertions (for validation)
    | 'assertVisible'   // Assert element is visible
    | 'assertText'      // Assert element contains text
    | 'assertValue'     // Assert input has value
    | 'assertUrl'       // Assert current URL matches
    | 'assertCount'     // Assert number of elements matches
    // Data extraction (for intelligent testing)
    | 'extract'         // Extract data from element
    // Screenshots (for analysis)
    | 'screenshot';     // Take screenshot for AI analysis
  selector?: string;
  value?: string;
  url?: string;
  description: string; // Human-readable description
  expectedResult?: string; // What should happen after this action
  timeout?: number;
  optional?: boolean; // Can skip if fails
  retry?: number; // Max retry attempts
  // Extract config (for extract action)
  extract?: {
    name: string; // Variable name to store extracted value
    attribute?: string; // Attribute to extract (e.g., 'href', 'src')
    property?: 'text' | 'value' | 'innerHTML'; // Property to extract
    // ✅ NEW: AI Extract with JSON schema
    useAI?: boolean; // Use AI extraction with schema validation
    schema?: any; // JSON schema for AI extraction
    mode?: 'html' | 'text' | 'auto'; // Extraction mode for AI
    instructions?: string; // Additional instructions for AI
  };
  // Assertion config (for assert actions)
  assertion?: {
    expected: string | number;
    operator?: '=' | '!=' | '>' | '<' | 'contains' | 'startsWith' | 'endsWith';
  };
}

/**
 * Result of action execution
 */
export interface ActionResult {
  action: DynamicAction;
  success: boolean;
  error?: string;
  urlChanged: boolean;
  urlBefore: string;
  urlAfter: string;
  screenshot?: string;
  timestamp: number;
  retryCount?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Page visit record
 */
export interface PageVisit {
  url: string;
  pageType: PageType;
  timestamp: number;
  actions: DynamicAction[]; // Planned actions
  actionResults?: ActionResult[]; // Actual execution results
  success: boolean;
  screenshot?: string; // ✅ NEW: Base64 screenshot from page analysis
}

/**
 * Test state
 */
export interface TestState {
  goal: string; // User's testing goal
  startUrl: string;
  currentUrl: string;
  visitedPages: PageVisit[];
  completedActions: ActionResult[];
  errors: Array<{ message: string; timestamp: number }>;
  startTime: number;
  pagesAnalyzed: number;
  maxPages: number;
  maxDuration: number; // milliseconds
  estimatedCost: number; // USD
}

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY & VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Safety check result
 */
export interface SafetyCheckResult {
  safe: boolean;
  reason?: string;
  requiresApproval?: boolean;
  suggestedAction?: string;
}

/**
 * Safety configuration
 */
export interface SafetyConfig {
  level: 'strict' | 'normal' | 'loose';
  maxPages: number;
  maxDuration: number; // milliseconds
  maxCost: number; // USD
  allowedDomains: string[];
  forbiddenActions: string[]; // Keywords in buttons/actions to avoid
  forbiddenUrls: string[]; // URL patterns to avoid
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  expected: string;
  actual: string;
  passed: boolean;
  message?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Intelligent test configuration
 */
export interface SPALoadConfig {
  maxWaitTime?: number; // Max total wait time (default: 10000ms)
  networkIdleTimeout?: number; // Network idle timeout (default: 8000ms)
  networkSettleTime?: number; // Time to wait for no new requests (default: 500ms)
  elementRetries?: number; // Number of retries for element detection (default: 3)
  elementRetryDelay?: number; // Delay between retries (default: 1500ms)
  minContentElements?: number; // Minimum real content elements (default: 3)
  minTextLength?: number; // Minimum text content length (default: 100)
  checkShadowDOM?: boolean; // Check shadow DOM (default: false)
  checkIframes?: boolean; // Check iframes (default: false)
}

export interface IntelligentTestConfig {
  mode: 'full' | 'fast' | 'balanced'; // Vision+DOM | DOM only | Selective Vision
  safety: SafetyConfig;
  goal: string;
  startUrl: string;
  browser?: string; // Browser type for progress tracking (e.g., 'chrome', 'firefox')
  credentials?: {
    username?: string;
    email?: string;
    password?: string;
  };
  userContext?: Record<string, any>; // Additional user-provided context
  spaLoadConfig?: SPALoadConfig; // ✅ NEW: Configurable SPA loading settings
}

/**
 * Test execution result
 */
export interface IntelligentTestResult {
  success: boolean;
  goal: string;
  startUrl: string;
  pagesVisited: number;
  actionsTaken: number;
  duration: number; // milliseconds
  cost: number; // USD
  errors: Array<{ message: string; page: string }>;
  warnings: string[];
  summary: string;
  pageVisits: PageVisit[];
  screenshots: Array<{ url: string; screenshot: string }>;
  graphData?: any; // ✅ NEW: Complete graph from GraphBuilder
}

// ═══════════════════════════════════════════════════════════════════════════
// DECISION MAKING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Next step decision
 */
export interface NextStepDecision {
  action: 'continue' | 'stop' | 'wait_for_user' | 'retry' | 'skip';
  reason: string;
  nextActions?: DynamicAction[];
  expectedPage?: PageType;
  confidence: number; // 0-1
}

/**
 * Cycle detection result
 */
export interface CycleDetectionResult {
  cycleDetected: boolean;
  repeatedUrl?: string;
  visitCount?: number;
  suggestion: string;
}
