/**
 * Types and interfaces for intelligent testing system
 * Supports dynamic, context-aware test execution
 */

import { PlaywrightCommand } from '@/types';

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
  }>;
  links: Array<{
    href: string;
    text: string;
    selector: string;
  }>;
  inputs: Array<{
    type: string;
    name?: string;
    required?: boolean;
    placeholder?: string;
    selector: string;
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
 */
export interface DynamicAction {
  action: 'goto' | 'click' | 'fill' | 'select' | 'wait' | 'scroll' | 'press' | 'hover';
  selector?: string;
  value?: string;
  url?: string;
  description: string; // Human-readable description
  expectedResult?: string; // What should happen after this action
  timeout?: number;
  optional?: boolean; // Can skip if fails
  retry?: number; // Max retry attempts
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
  actions: DynamicAction[];
  success: boolean;
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
export interface IntelligentTestConfig {
  mode: 'full' | 'fast' | 'balanced'; // Vision+DOM | DOM only | Selective Vision
  safety: SafetyConfig;
  goal: string;
  startUrl: string;
  credentials?: {
    username?: string;
    email?: string;
    password?: string;
  };
  userContext?: Record<string, any>; // Additional user-provided context
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
