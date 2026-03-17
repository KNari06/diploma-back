/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION AGENT — AI Prompts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two main prompts:
 * 1. Page Classification — Survey phase: analyze page → discover entry points
 * 2. Branch Detection — Flow phase: after flow completion, find new entry points
 *
 * Both use GPT-4.1 vision (DOM snapshot + screenshot).
 */

import type { TestFlowCategory, FlowPriority, FlowComplexity, RelatedElement } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// PAGE CLASSIFICATION PROMPT (Phase 1 — Survey)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the page classification prompt for the Survey Agent.
 * Sent with both DOM snapshot text and a screenshot image.
 */
export function buildPageClassificationPrompt(params: {
  formattedSnapshot: string;
  url: string;
  title: string;
  scopeHint?: string;
  hasCredentials: boolean;
  depth: number;
  structureSummary?: string;
  overlaySummary?: string;
}): string {
  const sections: string[] = [];

  sections.push(`You are a QA test discovery agent analyzing a web application page to find all testable user flows.`);

  sections.push(`PAGE URL: ${params.url}`);
  sections.push(`PAGE TITLE: ${params.title}`);

  if (params.scopeHint) {
    sections.push(`SCOPE HINT: Focus on "${params.scopeHint}" related flows, but also identify other important flows.`);
  }

  if (params.hasCredentials) {
    sections.push(`CREDENTIALS: Available for authentication flows.`);
  }

  if (params.structureSummary) {
    sections.push(`PAGE STRUCTURE SUMMARY:\n${params.structureSummary}`);
  }

  if (params.overlaySummary) {
    sections.push(`OVERLAY STATUS:\n${params.overlaySummary}\nNote: Overlays listed above were auto-dismissed before this snapshot was taken. Some overlays (sticky headers/footers) are permanent page elements — they are NOT testable flows.`);
  }

  sections.push(`PAGE STATE (DOM elements):\n${params.formattedSnapshot}`);

  sections.push(`INSTRUCTIONS:
Analyze this page (both the DOM elements above AND the screenshot) and identify:

1. ALL testable user flows visible from this page
2. Navigation links that lead to other major pages worth exploring

For each testable flow, provide:
- name: Human-readable test case name (e.g., "User Login", "Product Search")
- goal: A specific, actionable test goal (e.g., "Login with valid email and password credentials")
- category: One of: authentication, navigation, search, form_submission, crud, e_commerce, content, user_management, error_handling, other
- priority: critical (auth, core business), high (main features), medium (secondary features), low (edge cases)
- requiresAuth: Whether this flow needs login first
- estimatedComplexity: simple (1-3 steps), medium (4-7 steps), complex (8+ steps)
- relatedElements: Array of {ref, role, name, tag} for elements involved in this flow
- dependsOn: ID of another flow that must complete first (e.g., login before profile edit), or omit

Also identify navigation links:
- ref: Element ref from the DOM
- label: Link/button text
- estimatedPageType: What kind of page it leads to (e.g., "products", "about", "settings")

RULES:
- Be comprehensive but practical — find real user journeys, not every tiny link
- Prioritize interactive flows (forms, CTAs, buttons) over passive content viewing
- Authentication flows are always critical priority
- Do NOT list destructive flows (delete account, cancel subscription, remove data)
- Do NOT list duplicate flows (if same form appears in modal and page, list once)
- Max 15 entry points per page
- For navigation links, focus on main navigation (header, sidebar, footer main links)
- Do NOT list navigation links that go to external sites
- Each entry point must have a unique, descriptive name
- IGNORE overlay/popup elements: Do NOT list "Accept Cookies", "Close Modal", "Dismiss Banner", "Subscribe to Newsletter" as testable flows — these are UI noise
- Elements inside permanent overlays (sticky headers, sticky footers) are navigation elements, not separate test flows
- If the screenshot shows an overlay but the DOM snapshot does not contain it, the overlay was auto-dismissed — ignore it`);

  sections.push(`RESPONSE FORMAT (JSON):
{
  "pageType": "home|login|registration|dashboard|product_list|product_detail|cart|checkout|settings|profile|search|about|contact|error|other",
  "entryPoints": [
    {
      "name": "User Login",
      "goal": "Login with valid email and password credentials",
      "category": "authentication",
      "priority": "critical",
      "requiresAuth": false,
      "estimatedComplexity": "simple",
      "relatedElements": [{"ref": "e5", "role": "textbox", "name": "Email", "tag": "input"}],
      "dependsOn": null
    }
  ],
  "navigationLinks": [
    {"ref": "e15", "label": "Products", "estimatedPageType": "product_list"}
  ]
}`);

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH DETECTION PROMPT (Phase 2 — after flow completion)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the branch detection prompt.
 * Called after a flow completes to discover new entry points on the final page.
 */
export function buildBranchDetectionPrompt(params: {
  formattedSnapshot: string;
  url: string;
  completedFlowName: string;
  completedFlowGoal: string;
  existingFlowNames: string[];
}): string {
  const sections: string[] = [];

  sections.push(`You are a QA test discovery agent. A test flow just completed successfully.`);

  sections.push(`COMPLETED FLOW: "${params.completedFlowName}" — ${params.completedFlowGoal}`);
  sections.push(`CURRENT PAGE URL: ${params.url}`);

  if (params.existingFlowNames.length > 0) {
    sections.push(`ALREADY DISCOVERED FLOWS (do NOT duplicate these):\n${params.existingFlowNames.map((n) => `- ${n}`).join('\n')}`);
  }

  sections.push(`CURRENT PAGE STATE:\n${params.formattedSnapshot}`);

  sections.push(`INSTRUCTIONS:
Look at the current page state after completing "${params.completedFlowName}".
Identify NEW testable flows that are now visible/accessible that were NOT part of the completed flow.

For example:
- After "User Registration" → you might see "Edit Profile", "Verify Email", "Complete Onboarding"
- After "Add to Cart" → you might see "Proceed to Checkout", "Continue Shopping", "Apply Coupon"
- After "Login" → you might see "Dashboard Actions", "Settings", "Notifications"

RULES:
- Only list flows that are NEW — not already in the discovered list above
- Only list flows visible on the current page
- Do NOT list destructive flows (delete, cancel, remove)
- Max 5 new entry points
- Each must have a unique, descriptive name

RESPONSE FORMAT (JSON):
{
  "branchPoints": [
    {
      "name": "Edit User Profile",
      "goal": "Navigate to profile settings and update user information",
      "category": "user_management",
      "priority": "medium",
      "requiresAuth": true,
      "estimatedComplexity": "medium",
      "relatedElements": [{"ref": "e12", "role": "link", "name": "Profile", "tag": "a"}]
    }
  ]
}

If no new flows are visible, return: {"branchPoints": []}
`);

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSERS
// ═══════════════════════════════════════════════════════════════════════════

const VALID_CATEGORIES: TestFlowCategory[] = [
  'authentication', 'navigation', 'search', 'form_submission',
  'crud', 'e_commerce', 'content', 'user_management', 'error_handling', 'other',
];

const VALID_PRIORITIES: FlowPriority[] = ['critical', 'high', 'medium', 'low'];

const VALID_COMPLEXITIES: FlowComplexity[] = ['simple', 'medium', 'complex'];

/**
 * Parse and validate the page classification AI response.
 */
export function parsePageClassificationResponse(raw: string): {
  pageType: string;
  entryPoints: Array<{
    name: string;
    goal: string;
    category: TestFlowCategory;
    priority: FlowPriority;
    requiresAuth: boolean;
    estimatedComplexity: FlowComplexity;
    relatedElements: RelatedElement[];
    dependsOn?: string;
  }>;
  navigationLinks: Array<{
    ref: string;
    label: string;
    estimatedPageType: string;
  }>;
} {
  try {
    const parsed = JSON.parse(raw);

    const pageType = typeof parsed.pageType === 'string' ? parsed.pageType : 'other';

    const entryPoints = Array.isArray(parsed.entryPoints)
      ? parsed.entryPoints
          .filter((ep: any) => ep && typeof ep.name === 'string' && typeof ep.goal === 'string')
          .slice(0, 15)
          .map((ep: any) => ({
            name: String(ep.name).slice(0, 100),
            goal: String(ep.goal).slice(0, 300),
            category: VALID_CATEGORIES.includes(ep.category) ? ep.category : 'other' as TestFlowCategory,
            priority: VALID_PRIORITIES.includes(ep.priority) ? ep.priority : 'medium' as FlowPriority,
            requiresAuth: Boolean(ep.requiresAuth),
            estimatedComplexity: VALID_COMPLEXITIES.includes(ep.estimatedComplexity) ? ep.estimatedComplexity : 'medium' as FlowComplexity,
            relatedElements: Array.isArray(ep.relatedElements)
              ? ep.relatedElements
                  .filter((el: any) => el && typeof el.ref === 'string')
                  .map((el: any) => ({
                    ref: String(el.ref),
                    role: String(el.role || ''),
                    name: String(el.name || ''),
                    tag: String(el.tag || ''),
                  }))
              : [],
            dependsOn: typeof ep.dependsOn === 'string' ? ep.dependsOn : undefined,
          }))
      : [];

    const navigationLinks = Array.isArray(parsed.navigationLinks)
      ? parsed.navigationLinks
          .filter((nl: any) => nl && typeof nl.ref === 'string')
          .map((nl: any) => ({
            ref: String(nl.ref),
            label: String(nl.label || ''),
            estimatedPageType: String(nl.estimatedPageType || 'other'),
          }))
      : [];

    return { pageType, entryPoints, navigationLinks };
  } catch {
    return { pageType: 'unknown', entryPoints: [], navigationLinks: [] };
  }
}

/**
 * Parse and validate the branch detection AI response.
 */
export function parseBranchDetectionResponse(raw: string): Array<{
  name: string;
  goal: string;
  category: TestFlowCategory;
  priority: FlowPriority;
  requiresAuth: boolean;
  estimatedComplexity: FlowComplexity;
  relatedElements: RelatedElement[];
}> {
  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed.branchPoints)) return [];

    return parsed.branchPoints
      .filter((bp: any) => bp && typeof bp.name === 'string' && typeof bp.goal === 'string')
      .slice(0, 5)
      .map((bp: any) => ({
        name: String(bp.name).slice(0, 100),
        goal: String(bp.goal).slice(0, 300),
        category: VALID_CATEGORIES.includes(bp.category) ? bp.category : 'other' as TestFlowCategory,
        priority: VALID_PRIORITIES.includes(bp.priority) ? bp.priority : 'medium' as FlowPriority,
        requiresAuth: Boolean(bp.requiresAuth),
        estimatedComplexity: VALID_COMPLEXITIES.includes(bp.estimatedComplexity) ? bp.estimatedComplexity : 'medium' as FlowComplexity,
        relatedElements: Array.isArray(bp.relatedElements)
          ? bp.relatedElements
              .filter((el: any) => el && typeof el.ref === 'string')
              .map((el: any) => ({
                ref: String(el.ref),
                role: String(el.role || ''),
                name: String(el.name || ''),
                tag: String(el.tag || ''),
              }))
          : [],
      }));
  } catch {
    return [];
  }
}
