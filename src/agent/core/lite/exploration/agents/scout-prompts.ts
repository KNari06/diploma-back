/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCOUT AGENT — Prompts & Parsers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds prompts and parses responses for the Scout agent.
 * Called after each flow completes to discover NEW testable flows
 * on the final page state.
 *
 * Key design: NO caps on branch points. AI returns what it finds.
 * Scout receives the actual execution steps so it understands app state.
 */

import type { ScoutInput, ScoutOutput, CartographerEntryPoint } from './agent-types';
import type { TestFlowCategory, FlowPriority, FlowComplexity, RelatedElement, DiscoveredStep } from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export const SCOUT_SYSTEM_PROMPT = `You are a QA branch discovery agent (Scout). A test flow just completed. Your job is to analyze the current page state and discover NEW testable flows that became accessible after the flow completed.

For example:
- After "User Login" → dashboard reveals "Edit Profile", "View Orders", "Change Settings"
- After "Add to Cart" → cart page shows "Proceed to Checkout", "Apply Coupon", "Remove Item"
- After "Submit Registration" → confirmation page shows "Verify Email", "Complete Profile"

RULES:
- Only discover flows that are NEW — not already in the known list
- Only flows visible on the current page (not hypothetical)
- Do NOT list destructive flows (delete, cancel, remove)
- Do NOT list overlay noise (close modal, dismiss, OK, got it)
- Do NOT list success confirmations or post-action popups as flows
- Goals must be specific and actionable
- Consider what the app state is after the completed flow

Also identify new pages worth exploring (URLs not yet visited).

Respond with valid JSON only.`;

// ═══════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

export function buildScoutPrompt(input: ScoutInput): string {
  const sections: string[] = [];

  // Completed flow context
  const flow = input.completedFlow;
  sections.push(`COMPLETED FLOW: "${flow.name}"
- Goal: ${flow.goal}
- Category: ${flow.category}
- Outcome: ${flow.status}
- Steps taken: ${flow.steps.length}
- Errors found: ${flow.errorsFound}
- Final URL: ${flow.finalUrl}`);

  // What steps were actually executed
  if (flow.steps.length > 0) {
    sections.push(`STEPS EXECUTED:\n${formatSteps(flow.steps)}`);
  }

  sections.push(`CURRENT PAGE URL: ${input.completedFlow.finalUrl}`);

  // Known flows (dedup)
  if (input.knownFlows.length > 0) {
    sections.push(`ALREADY DISCOVERED FLOWS (do NOT duplicate these):\n${input.knownFlows.map((n) => `- ${n}`).join('\n')}`);
  }

  // Known pages
  if (input.knownPages.length > 0) {
    sections.push(`ALREADY VISITED PAGES:\n${input.knownPages.map((u) => `- ${u}`).join('\n')}`);
  }

  // Cartographer insight for context
  if (input.pageInsight) {
    sections.push(`PAGE INSIGHT (from previous analysis):
- Page type: ${input.pageInsight.pageType}
- Interactive areas: ${input.pageInsight.interactiveAreas.join(', ') || 'none'}
- Data entities: ${input.pageInsight.dataEntities.join(', ') || 'none'}
- State indicators: ${input.pageInsight.stateIndicators.join(', ') || 'none'}`);
  }

  // Budget context
  sections.push(`BUDGET: ${input.flowsRemaining} flows remaining to explore.`);

  // Current page snapshot
  sections.push(`CURRENT PAGE STATE:\n${formatSnapshotForScout(input.snapshot)}`);

  sections.push(`RESPONSE FORMAT (JSON):
{
  "newEntryPoints": [
    {
      "name": "Edit User Profile",
      "goal": "Navigate to profile settings and update user information",
      "category": "user_management",
      "priority": "medium",
      "requiresAuth": true,
      "estimatedComplexity": "medium",
      "relatedElements": [{"ref": "e12", "role": "link", "name": "Profile", "tag": "a"}]
    }
  ],
  "newPages": ["/settings", "/notifications"],
  "insight": "After login, dashboard revealed navigation to settings and profile management"
}

If no new flows are visible, return:
{"newEntryPoints": [], "newPages": [], "insight": "No new flows discovered"}`);

  return sections.join('\n\n');
}

function formatSteps(steps: DiscoveredStep[]): string {
  return steps
    .map((s) => `  ${s.stepNumber}. [${s.action}] ${s.description}${s.value ? ` (value: "${s.isSensitive ? '***' : s.value}")` : ''}`)
    .join('\n');
}

function formatSnapshotForScout(snapshot: any): string {
  if (!snapshot) return '(no snapshot available)';
  if (typeof snapshot === 'string') return snapshot;

  const lines: string[] = [];
  if (snapshot.url) lines.push(`URL: ${snapshot.url}`);
  if (snapshot.title) lines.push(`Title: ${snapshot.title}`);

  if (Array.isArray(snapshot.elements)) {
    lines.push(`\nInteractive Elements (${snapshot.elements.length}):`);
    for (const el of snapshot.elements) {
      const parts: string[] = [`[${el.ref}]`];
      if (el.role) parts.push(el.role);
      if (el.tag) parts.push(`<${el.tag}>`);
      if (el.name) parts.push(`"${el.name}"`);
      if (el.disabled) parts.push('[disabled]');
      if (el.context) parts.push(`ctx="${el.context}"`);
      lines.push('  ' + parts.join(' '));
    }
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
 * Parse Scout AI response. NO caps on results.
 */
export function parseScoutResponse(raw: string): ScoutOutput {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const newEntryPoints: CartographerEntryPoint[] = Array.isArray(parsed.newEntryPoints)
      ? parsed.newEntryPoints
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

    const newPages: string[] = Array.isArray(parsed.newPages)
      ? parsed.newPages.filter((p: any) => typeof p === 'string').map(String)
      : [];

    const insight = typeof parsed.insight === 'string'
      ? parsed.insight
      : 'No additional insight';

    return { newEntryPoints, newPages, insight };
  } catch {
    return { newEntryPoints: [], newPages: [], insight: 'Failed to parse Scout response' };
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
