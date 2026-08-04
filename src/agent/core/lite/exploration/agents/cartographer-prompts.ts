/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CARTOGRAPHER AGENT — Prompts & Parsers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds prompts and parses responses for the Cartographer agent.
 * Key design: NO truncation, NO hardcoded limits.
 * AI receives the full snapshot and decides what's relevant.
 */

import type {
  CartographerInput,
  CartographerOutput,
  CartographerEntryPoint,
  CartographerNavLink,
  CartographerInsight,
  AuthDetectionResult,
} from './agent-types';
import type { FormAnalysis } from '../../agents/types';
import type { TestFlowCategory, FlowPriority, FlowComplexity, RelatedElement } from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export const CARTOGRAPHER_SYSTEM_PROMPT = `You are a QA test discovery agent (Cartographer) performing autonomous exploration of a web application. Your job is to deeply understand a page and discover ALL testable user flows.

You produce two outputs:
1. Entry Points — testable user flows (forms, buttons, CTAs, interactive elements)
2. Navigation Links — links to other pages worth exploring

You also detect authentication:
- Is this page a login/signup page?
- Does this page require authentication to access?

RULES:
- Be comprehensive — find ALL real user journeys, not just obvious ones
- Prioritize interactive flows (forms, CTAs, buttons) over passive content
- POPULATE pageInsight.forms for EVERY form on the page: for each form list its input fields (ref, label, type, required) and the submit button. This includes forms without a <form> tag — any group of inputs + a submit control. This drives form-flow planning; an empty forms array means the planner cannot fill the form.
- Authentication flows are always critical priority
- Do NOT list truly destructive flows only (delete account, wipe all data, permanently ban user) — other delete/cancel actions like "cancel order", "remove from cart", "delete review" ARE valid test flows
- Do NOT list pure UI noise: cookie banners, generic chat widget openers, "close modal" buttons
- Do NOT include duplicate flows
- Do NOT create entry points for actions that navigate to EXTERNAL/third-party domains (e.g., "Log in to Udemy", "Buy on Amazon", "Share on Twitter"). Only include flows that stay within the application under test. SSO buttons (Google, GitHub) that are part of the app's own auth flow ARE valid.
- Goals must be SPECIFIC — bad: "Use the search", good: "Search for a product by keyword and verify results appear"
- ONE goal per entry point — do NOT combine multiple scenarios into one entry point. Bad: "validate positive AND negative login". Good: separate entry points for "Login with valid credentials" and "Attempt login with invalid credentials and verify error"
- Entry point names must be descriptive and unique — avoid generic names like "Form Submission" or "CTA: Submit". Use the page context: "Contact Form Submission", "Registration Form", "Newsletter Signup"
- Set recommendDeeper: true if the page has multiple unexplored sections, tabs, or sub-navigation
- Consider the exploration context — avoid duplicating what's already been discovered on other pages

VISUAL ANALYSIS (when screenshot is provided):
- Use the screenshot to confirm layout structure and identify visual interactive areas
- Detect navigation patterns (sidebar, top nav, breadcrumbs, hamburger menu) from visual layout
- Identify forms, CTAs, and interactive components that may not have semantic HTML markup
- Use visual hierarchy to inform priority — prominent/large CTAs are higher priority
- Detect visual indicators of auth state (user avatar, logout button, login link)
- Look for tabbed interfaces, accordions, carousels that may hide interactive content
- If the screenshot shows a mostly blank or loading page, set skipReason accordingly

CREDENTIAL DETECTION:
- Look for test credentials, demo accounts, or sample login info displayed on the page
- Common patterns: "Username: ...", "Password: ...", "Demo account:", "Test credentials:"
- Report any found in authDetection.testCredentials field

Respond with valid JSON only.`;

// ═══════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the Cartographer prompt.
 * @param input - Page data with exploration context
 * @param preFormattedSnapshot - If provided, uses this string instead of formatting input.snapshot
 */
export function buildCartographerPrompt(input: CartographerInput, preFormattedSnapshot?: string): string {
  const sections: string[] = [];

  sections.push(`PAGE URL: ${input.url}`);
  sections.push(`PAGE TITLE: ${input.title}`);
  sections.push(`BFS DEPTH: ${input.depth}`);

  if (input.productContext) {
    sections.push(`PRODUCT CONTEXT:\n${input.productContext}`);
  }

  if (input.pageHealth) {
    sections.push(`PAGE HEALTH WARNINGS:
${input.pageHealth}
If the page is still loading or showing an error, say so in skipReason instead of
inventing entry points from a broken render.`);
  }

  if (input.scopeHint) {
    sections.push(`SCOPE HINT: Focus on "${input.scopeHint}" related flows, but also identify other important flows.`);
  }

  if (input.hasCredentials) {
    sections.push(`CREDENTIALS: Available for authentication flows. Mark requiresAuth=true for flows behind login.`);
  }

  // Exploration context — tells AI what's already been found
  const ctx = input.explorationContext;
  if (ctx.pagesVisited > 0) {
    sections.push(`EXPLORATION CONTEXT:
- Pages visited so far: ${ctx.pagesVisited}
- Categories found: ${ctx.categoriesSeen.length > 0 ? ctx.categoriesSeen.join(', ') : 'none yet'}
- Entry points discovered so far: ${ctx.entryPointsSoFar}
- Recent page types: ${ctx.recentPageTypes.length > 0 ? ctx.recentPageTypes.join(' → ') : 'none'}
Note: Avoid duplicating flows already discovered on other pages.`);
  }

  if (input.overlaysDismissed && input.overlaysDismissed.length > 0) {
    sections.push(`OVERLAYS DISMISSED: ${input.overlaysDismissed.join(', ')}
These overlays were auto-dismissed before this snapshot. Ignore them.`);
  }

  // Full snapshot — NO truncation
  const snapshotText = preFormattedSnapshot || formatSnapshotForPrompt(input.snapshot);
  sections.push(`PAGE STATE (DOM elements):\n${snapshotText}`);

  sections.push(`RESPONSE FORMAT (JSON):
{
  "pageType": "string (e.g., home, login, dashboard, product_list, settings, etc.)",
  "entryPoints": [
    {
      "name": "Human-readable test name",
      "goal": "Specific actionable goal with concrete steps",
      "category": "authentication|navigation|search|form_submission|crud|e_commerce|content|user_management|error_handling|other",
      "priority": "critical|high|medium|low",
      "requiresAuth": false,
      "estimatedComplexity": "simple|medium|complex",
      "relatedElements": [{"ref": "e5", "role": "textbox", "name": "Email", "tag": "input"}],
      "dependsOn": null
    }
  ],
  "navigationLinks": [
    {"ref": "e15", "label": "Products", "estimatedPageType": "product_list", "relevance": "main navigation"}
  ],
  "authDetection": {
    "isLoginPage": false,
    "isAuthGated": false,
    "loginFormRef": null,
    "loginUrl": null
  },
  "pageInsight": {
    "forms": [
      {
        "formRef": "e5",
        "fields": [
          {"ref": "e6", "label": "Email", "type": "email", "required": true},
          {"ref": "e7", "label": "Phone", "type": "tel", "required": true},
          {"ref": "e8", "label": "I agree to processing", "type": "checkbox", "required": true}
        ],
        "submitButtonRef": "e9",
        "submitButtonText": "Submit"
      }
    ],
    "interactiveAreas": ["navigation bar", "search section", "product grid"],
    "dataEntities": ["products", "categories"],
    "stateIndicators": ["cart has 0 items"],
    "complexity": "moderate",
    "relatedPages": ["/products", "/about", "/contact"]
  },
  "recommendDeeper": true,
  "skipReason": null
}`);

  return sections.join('\n\n');
}

/**
 * Format a LiteSnapshot for prompt inclusion.
 * Includes ALL elements — no truncation.
 */
function formatSnapshotForPrompt(snapshot: any): string {
  if (!snapshot) return '(no snapshot available)';

  // If snapshot has a pre-formatted text representation, use it
  if (typeof snapshot === 'string') return snapshot;

  // Build text from elements array
  const lines: string[] = [];

  if (snapshot.url) lines.push(`URL: ${snapshot.url}`);
  if (snapshot.title) lines.push(`Title: ${snapshot.title}`);

  if (Array.isArray(snapshot.elements)) {
    lines.push(`\nInteractive Elements (${snapshot.elements.length} total):`);
    for (const el of snapshot.elements) {
      const parts: string[] = [];
      parts.push(`[${el.ref}]`);
      if (el.role) parts.push(el.role);
      if (el.tag) parts.push(`<${el.tag}>`);
      if (el.name) parts.push(`"${el.name}"`);
      if (el.type) parts.push(`type=${el.type}`);
      if (el.value) parts.push(`value="${String(el.value).slice(0, 50)}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.disabled) parts.push('[disabled]');
      if (el.required) parts.push('[required]');
      if (el.checked) parts.push('[checked]');
      if (el.ariaExpanded) parts.push(`[expanded=${el.ariaExpanded}]`);
      // Radix/shadcn `data-state` for explore-time entry-point ranking.
      // Cartographer needs to see "this menu trigger is already open"
      // to skip it as a goal-progressing click. Skip when redundant
      // with ariaExpanded (most aria-* implementations on dropdowns
      // do mirror to data-state, so duplication is common).
      if (el.dataState && !(
        (el.dataState === 'open' && el.ariaExpanded === true)
        || (el.dataState === 'closed' && el.ariaExpanded === false)
      )) {
        parts.push(`[state=${el.dataState}]`);
      }
      if (el.isInsideActiveModal) parts.push('[in-modal]');
      if (el.context) parts.push(`context="${el.context}"`);
      lines.push('  ' + parts.join(' '));
    }
  }

  if (snapshot.pageAlerts && snapshot.pageAlerts.length > 0) {
    lines.push(`\nPage Alerts: ${snapshot.pageAlerts.join('; ')}`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSER
// ═══════════════════════════════════════════════════════════════════════════

const VALID_CATEGORIES: TestFlowCategory[] = [
  'authentication', 'navigation', 'search', 'form_submission',
  'crud', 'e_commerce', 'content', 'user_management', 'error_handling', 'other',
];

const VALID_PRIORITIES: FlowPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_COMPLEXITIES: FlowComplexity[] = ['simple', 'medium', 'complex'];

/**
 * Parse and validate the Cartographer AI response.
 * NO hardcoded caps — returns everything AI found.
 */
export function parseCartographerResponse(raw: string, pageId: string): CartographerOutput {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const pageType = typeof parsed.pageType === 'string' ? parsed.pageType : 'other';

    // Entry points — NO CAP
    const entryPoints: CartographerEntryPoint[] = Array.isArray(parsed.entryPoints)
      ? parsed.entryPoints
          .filter((ep: any) => ep && typeof ep.name === 'string' && typeof ep.goal === 'string')
          .map((ep: any): CartographerEntryPoint => ({
            name: String(ep.name),
            goal: String(ep.goal),
            category: VALID_CATEGORIES.includes(ep.category) ? ep.category : 'other',
            priority: VALID_PRIORITIES.includes(ep.priority) ? ep.priority : 'medium',
            requiresAuth: Boolean(ep.requiresAuth),
            estimatedComplexity: VALID_COMPLEXITIES.includes(ep.estimatedComplexity)
              ? ep.estimatedComplexity : 'medium',
            relatedElements: parseRelatedElements(ep.relatedElements),
            dependsOn: typeof ep.dependsOn === 'string' ? ep.dependsOn : undefined,
          }))
      : [];

    // Navigation links — NO CAP
    const navigationLinks: CartographerNavLink[] = Array.isArray(parsed.navigationLinks)
      ? parsed.navigationLinks
          .filter((nl: any) => nl && typeof nl.ref === 'string')
          .map((nl: any): CartographerNavLink => ({
            ref: String(nl.ref),
            label: String(nl.label || ''),
            estimatedPageType: String(nl.estimatedPageType || 'other'),
            relevance: typeof nl.relevance === 'string' ? nl.relevance : undefined,
          }))
      : [];

    // Auth detection
    const authDetection: AuthDetectionResult = parsed.authDetection
      ? {
          isLoginPage: Boolean(parsed.authDetection.isLoginPage),
          isAuthGated: Boolean(parsed.authDetection.isAuthGated),
          loginFormRef: typeof parsed.authDetection.loginFormRef === 'string'
            ? parsed.authDetection.loginFormRef : undefined,
          loginUrl: typeof parsed.authDetection.loginUrl === 'string'
            ? parsed.authDetection.loginUrl : undefined,
          testCredentials: parsed.authDetection.testCredentials && typeof parsed.authDetection.testCredentials === 'object'
            ? {
                username: typeof parsed.authDetection.testCredentials.username === 'string'
                  ? parsed.authDetection.testCredentials.username : undefined,
                password: typeof parsed.authDetection.testCredentials.password === 'string'
                  ? parsed.authDetection.testCredentials.password : undefined,
              }
            : undefined,
        }
      : { isLoginPage: false, isAuthGated: false };

    // Page insight
    const insight = parsed.pageInsight || {};
    const pageInsight: CartographerInsight = {
      pageId,
      pageType,
      forms: Array.isArray(insight.forms) ? insight.forms : [],
      interactiveAreas: Array.isArray(insight.interactiveAreas)
        ? insight.interactiveAreas.map(String) : [],
      dataEntities: Array.isArray(insight.dataEntities)
        ? insight.dataEntities.map(String) : [],
      stateIndicators: Array.isArray(insight.stateIndicators)
        ? insight.stateIndicators.map(String) : [],
      complexity: typeof insight.complexity === 'string' ? insight.complexity : 'moderate',
      relatedPages: Array.isArray(insight.relatedPages)
        ? insight.relatedPages.map(String) : [],
    };

    return {
      pageType,
      entryPoints,
      navigationLinks,
      authDetection,
      pageInsight,
      recommendDeeper: Boolean(parsed.recommendDeeper),
      skipReason: typeof parsed.skipReason === 'string' ? parsed.skipReason : undefined,
    };
  } catch {
    return {
      pageType: 'unknown',
      entryPoints: [],
      navigationLinks: [],
      authDetection: { isLoginPage: false, isAuthGated: false },
      pageInsight: {
        pageId,
        pageType: 'unknown',
        forms: [],
        interactiveAreas: [],
        dataEntities: [],
        stateIndicators: [],
        complexity: 'unknown',
        relatedPages: [],
      },
      recommendDeeper: false,
      skipReason: undefined,
    };
  }
}

function parseRelatedElements(raw: any): RelatedElement[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((el: any) => el && typeof el.ref === 'string')
    .map((el: any) => ({
      ref: String(el.ref),
      role: String(el.role || ''),
      name: String(el.name || ''),
      tag: String(el.tag || ''),
    }));
}
