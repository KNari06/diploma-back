/**
 * AI Selector Engine Types
 * Intent-based adaptive selector resolution
 */

// ═══════════════════════════════════════════════════════════════════════════
// DOM NODE TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enhanced DOM node with bounding box and metadata
 */
export interface DOMNode {
  nodeId: string; // Unique ID (node-{index} or CDP nodeId)
  tag: string; // Element tag name (e.g., 'button', 'input')
  text: string; // Text content (trimmed, max 200 chars)
  attributes: Record<string, string>; // All element attributes
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  selector?: string; // Static selector (fallback)
  isVisible: boolean; // Is element visible on screen
  role?: string; // ARIA role
  // Shadow DOM support
  shadowHost?: {
    tag: string; // Shadow host tag name
    id?: string; // Shadow host ID
    attributes: Record<string, string>; // Shadow host attributes
  };
  // CDP-specific (optional, for advanced use)
  cdpNodeId?: number; // Chrome DevTools Protocol node ID
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR ENGINE INPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input for AI Selector Engine
 */
export interface SelectorResolveRequest {
  intent: string; // Natural language description (e.g., "primary CTA under hero title")
  dom: string; // Full page HTML (page.content())
  nodes: DOMNode[]; // Enhanced node list with bounding boxes
  screenshot?: string; // Base64 screenshot (optional, for Vision AI)
  metadata: {
    url: string; // Current page URL
    viewport: { width: number; height: number }; // Viewport size
    projectId?: string; // Project ID (for cache)
    userId?: string; // User ID (for multi-tenant cache)
  };
  mode?: 'fast' | 'accurate'; // Fast: DOM only, Accurate: DOM + Vision
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR ENGINE OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Selector type priority (most stable to least stable)
 */
export type SelectorType =
  | 'getByRole' // Playwright role selector (most stable)
  | 'getByLabel' // Playwright label selector
  | 'getByText' // Playwright text selector
  | 'data-testid' // data-testid attribute
  | 'contextual' // Contextual locator (section >> button)
  | 'css' // CSS selector
  | 'xpath'; // XPath (least stable, fallback only)

/**
 * Selector candidate with metadata
 */
export interface SelectorCandidate {
  type: SelectorType;
  selector: string; // Actual selector string
  confidence: number; // 0.0 - 1.0 (how confident we are this is correct)
  reasoning: string; // Why this selector was chosen
  stability: number; // 0.0 - 1.0 (how stable is this selector)
}

/**
 * Selected node result
 */
export interface SelectedNode {
  nodeId: string; // Node ID of selected element
  primarySelector: string; // Best selector (most stable)
  selectorType: SelectorType; // Type of primary selector
  confidence: number; // 0.0 - 1.0 (overall confidence)
  boundingBox: DOMNode['boundingBox']; // Bounding box for highlight
  element: {
    tag: string;
    text: string;
    attributes: Record<string, string>;
  };
}

/**
 * AI Selector Engine response
 */
export interface SelectorResolveResponse {
  success: boolean;
  selectedNode?: SelectedNode; // Selected element (if found)
  fallbackSelectors: SelectorCandidate[]; // 2-3 backup selectors
  explanation: string; // Human-readable explanation
  alternatives?: SelectedNode[]; // Alternative matches (if ambiguous)
  warning?: string; // Warning if confidence is low
  // Performance metrics
  metrics: {
    totalDuration: number; // Total time taken (ms)
    aiDuration?: number; // AI processing time (ms)
    cacheHit: boolean; // Was result from cache
    /** True if Gemini Vision was used for resolution */
    visionUsed?: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parsed intent structure
 */
export interface ParsedIntent {
  action: 'click' | 'fill' | 'select' | 'check' | 'hover' | 'extract'; // Action to perform
  target: {
    type: 'button' | 'link' | 'input' | 'checkbox' | 'select' | 'element'; // Element type
    description: string; // What element (e.g., "primary CTA", "login button")
    text?: string; // Expected text content
    role?: string; // Expected ARIA role
    attributes?: Record<string, string>; // Expected attributes
  };
  context?: {
    parent?: string; // Parent element (e.g., "under hero title", "in navigation")
    position?: 'first' | 'last' | number; // Position if multiple matches
    visibility?: 'visible' | 'hidden'; // Visibility requirement
  };
  confidence: number; // 0.0 - 1.0 (how well we understood the intent)
}

// ═══════════════════════════════════════════════════════════════════════════
// SELF-HEALING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Self-healing result
 */
export interface SelfHealingResult {
  success: boolean;
  oldSelector: string; // Original selector that failed
  newSelector?: string; // New working selector
  diff: {
    what_changed: string; // Description of what changed
    old_strategy: SelectorType; // Old selector type
    new_strategy: SelectorType; // New selector type
    confidence: number; // Confidence in new selector
  };
  suggestion: string; // Human-readable suggestion
  autoApplied: boolean; // Was auto-healing applied

  // ── Phase 1: Vision escalation ──────────────────────────────────────
  /** True if fast mode failed and healing was retried with accurate (screenshot) mode */
  escalated?: boolean;
  /** True if vision AI (Gemini multimodal) was used to resolve the element */
  visionUsed?: boolean;

  // ── Phase 3: Iframe support ─────────────────────────────────────────
  /** Iframe context if element was found inside an iframe */
  iframeContext?: {
    frameName?: string;
    frameUrl?: string;
  };

  // ── Phase 6: Coordinate-based fallback ──────────────────────────────
  /** Pixel coordinates for coordinate-based clicking (last resort when no selector works) */
  coordinates?: { x: number; y: number };

  // ── Phase 8: Verification ───────────────────────────────────────────
  /** Whether the healed selector was verified by the visual verification agent */
  verified?: boolean;
  /** Confidence from the verification agent (0.0-1.0) */
  verificationConfidence?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cache key components
 */
export interface CacheKeyComponents {
  projectId: string;
  intent: string; // Normalized intent
  domHash: string; // SHA256 hash of DOM structure
  viewport: string; // "1920x1080"
  modelVersion: string; // AI model version (e.g., "gpt-4o-2024-11-20")
  engineVersion: string; // Selector engine version (e.g., "1.0.0")
}

/**
 * Cached selector result
 */
export interface CachedSelectorResult {
  cacheKey: string; // Full cache key
  result: SelectorResolveResponse; // Cached result
  createdAt: number; // Timestamp
  expiresAt: number; // Expiration timestamp
  hitCount: number; // How many times used
}
