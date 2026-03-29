/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION AGENT — AI Prompts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two main prompts:
 * 1. Page Classification — Survey phase: analyze page → discover entry points
 * 2. Branch Detection — Flow phase: after flow completion, find new entry points
 *
 * Page Classification uses GPT-5.4-mini vision (DOM snapshot + screenshot).
 * Branch Detection uses GPT-4.1-mini (text-only, DOM snapshot).
 */

import type { TestFlowCategory, FlowPriority, FlowComplexity, RelatedElement } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// PAGE CLASSIFICATION PROMPT (Phase 1 — Survey)
// ═══════════════════════════════════════════════════════════════════════════

// Legacy buildPageClassificationPrompt() removed — Cartographer prompts are in cartographer-prompts.ts

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
  overlaySummary?: string;
  hasCredentials?: boolean;
  flowOutcome?: string;
}): string {
  const sections: string[] = [];

  sections.push(`You are a QA test discovery agent. A test flow just completed.`);

  sections.push(`COMPLETED FLOW: "${params.completedFlowName}" — ${params.completedFlowGoal}`);

  if (params.flowOutcome) {
    sections.push(`FLOW OUTCOME: ${params.flowOutcome}`);
  }

  sections.push(`CURRENT PAGE URL: ${params.url}`);

  if (params.hasCredentials) {
    sections.push(`CREDENTIALS: Available. Mark requiresAuth=true for flows that need authentication.`);
  }

  if (params.existingFlowNames.length > 0) {
    sections.push(`ALREADY DISCOVERED FLOWS (do NOT duplicate these):\n${params.existingFlowNames.map((n) => `- ${n}`).join('\n')}`);
  }

  if (params.overlaySummary) {
    sections.push(`OVERLAY STATUS:\n${params.overlaySummary}\nNote: Overlays listed above were auto-dismissed after flow completion. Do NOT create branch points from overlay elements (modals, toasts, banners).`);
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
- IGNORE overlay/popup elements: Do NOT list "Close Modal", "Dismiss", "OK", "Got it" as testable flows — these are UI noise
- Success confirmations, toasts, and post-action popups are NOT new testable flows

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
