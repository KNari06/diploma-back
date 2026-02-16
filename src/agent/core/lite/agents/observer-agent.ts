/**
 * Observer Agent — "What do I see?"
 * Analyzes the page snapshot and produces a structured understanding.
 * Temperature: 0.05 (near-deterministic)
 * ~10k input tokens, ~400 output tokens
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';
import type { ObserverInput, ObserverOutput } from './types';

export class ObserverAgent {
  /**
   * Analyze the current page state and produce structured observation
   */
  static async observe(input: ObserverInput): Promise<ObserverOutput | null> {
    const prompt = ObserverAgent.buildPrompt(input);

    const result = await LitePromptBuilder.askJson<ObserverOutput>(prompt, {
      model: LITE_ENGINE_FLAGS.coreBrainModel as 'gpt-4o' | 'gpt-4o-mini',
      temperature: 0.05,
      maxTokens: 700,
      timeoutMs: LITE_ENGINE_FLAGS.multiAgentObserverTimeoutMs,
    });

    if (!result || !result.pageType) {
      logger.warn('[OBSERVER] Failed to produce observation');
      return null;
    }

    // Ensure arrays are present
    result.availableActions = result.availableActions || [];
    result.obstacles = result.obstacles || [];

    logger.debug('[OBSERVER] Observation complete', {
      pageType: result.pageType,
      actions: result.availableActions.length,
      obstacles: result.obstacles.length,
      hasForm: !!result.formAnalysis,
    });

    return result;
  }

  private static buildPrompt(input: ObserverInput): string {
    const visionSection = input.visionHints
      ? `\nVISION HINTS: ${JSON.stringify({
          buttons: input.visionHints.visibleButtons,
          fields: input.visionHints.formFields,
          modals: input.visionHints.modals,
          layout: input.visionHints.layoutHint,
        })}\n`
      : '';

    const driftSection = input.stateDrift
      ? `\nSTATE CHANGES (from last action): ${input.stateDrift}\n`
      : '';

    // Manus enhancement: Previous snapshot for visual diff
    const visualDiffSection = input.previousSnapshot
      ? `\nPREVIOUS SNAPSHOT (for spatial comparison):\n${input.previousSnapshot}\n`
      : '';

    // Manus enhancement: Network activity
    const networkSection = input.networkActivity
      ? `\nNETWORK ACTIVITY:
- Pending requests: ${input.networkActivity.hasPendingRequests ? 'YES (data in transit, DOM may change soon)' : 'NO'}
- Recent requests: ${input.networkActivity.recentRequests?.map(r => `${r.method} ${r.url} (${r.status || 'pending'})`).join(', ') || 'none'}
- Async work triggered: ${input.networkActivity.asyncWorkTriggered ? 'YES (wait for response)' : 'NO'}
`
      : '';

    // Manus enhancement: Expectation tracking
    const expectationSection = input.lastExpectation && input.lastAction
      ? `\nLAST ACTION: ${input.lastAction}
EXPECTED RESULT: ${input.lastExpectation}
Validate: Did the expected result happen? If not, what happened instead?
`
      : '';

    // Credential awareness: deprioritize "Forgot Password" when creds exist
    const credentialContext = input.hasCredentials
      ? `
CONTEXT: User has provided login credentials. When analyzing available actions:
- Mark "Forgot Password" / "Reset Password" links as LOW priority — credentials are ready for direct login
- Prioritize form field interactions (fill email, fill password) over navigation links
`
      : '';

    // Goal context: helps Observer understand what actions are relevant
    const goalContext = input.goal
      ? `GOAL: ${input.goal}\n`
      : '';

    // Loading state context
    const loadingSection = input.transientState?.isTransient
      ? `\nLOADING STATE: Active ${input.transientState.type || 'loading'} indicator${input.transientState.ref ? ` at ${input.transientState.ref}` : ''}. Mark affected area in loadingState, set asyncWorkTriggered=true.\n`
      : '';

    // DOM weakness context
    const metadataSection = input.pageMetadata?.isDOMWeak
      ? `\nDOM WEAKNESS: Only ${input.pageMetadata.interactiveElementCount} interactive elements. Visual content may exist outside DOM.\n`
      : '';

    // Page structure context
    const structureSection = (() => {
      if (!input.pageStructure) return '';
      const parts: string[] = [];
      if (input.pageStructure.tables.length > 0)
        parts.push(`TABLES: ${input.pageStructure.tables.length} table(s) — analyze structure for tableAnalysis`);
      if (input.pageStructure.lists.length > 0)
        parts.push(`LISTS: ${input.pageStructure.lists.length} list(s)${input.pageStructure.lists.some(l => l.hasLoadMore) ? ' (some with Load More)' : ''}`);
      if (input.pageStructure.pagination)
        parts.push(`PAGINATION: Page ${input.pageStructure.pagination.currentPage || '?'}/${input.pageStructure.pagination.totalPages || '?'}`);
      return parts.length > 0 ? '\n' + parts.join('\n') + '\n' : '';
    })();

    return `You are a Page Observer (Manus-style). Analyze the page and score changes by IMPACT.

URL: ${input.url}
Title: ${input.title}
${goalContext}${credentialContext}
CURRENT PAGE SNAPSHOT:
${input.snapshot}
${visualDiffSection}${driftSection}${networkSection}${visionSection}${expectationSection}${loadingSection}${metadataSection}${structureSection}
Respond with JSON (Manus-style with Impact Scoring):
{
  "pageType": "login_form | registration_form | dashboard | product_page | error_page | ...",
  "availableActions": ["fill email field", "click Submit button", ...],
  "obstacles": ["modal overlay blocking content", ...] or [],
  "formAnalysis": {
    "formRef": "e3",
    "fields": [{"ref": "e5", "type": "email", "label": "Email", "hasValue": false, "required": true}],
    "submitButtonRef": "e10",
    "submitButtonText": "Submit"
  } or null,
  "errorState": "Invalid email address" or null,
  "modalInfo": "Cookie consent modal with Accept button" or null,

  "impactScores": [
    {"change": "Login form appeared", "significance": "HIGH", "type": "Progress"},
    {"change": "Error banner visible", "significance": "HIGH", "type": "Regression"},
    {"change": "Footer scrolled into view", "significance": "LOW", "type": "Neutral"}
  ] or [],

  "spatialDrift": {
    "detected": true,
    "description": "Content shifted 200px down",
    "movedElements": [{"ref": "e10", "shift": "moved down 200px"}]
  } or {"detected": false},

  "networkActivity": {
    "hasPendingRequests": true,
    "asyncWorkTriggered": true
  } or null,

  "expectationDiff": {
    "expected": "Login form to appear",
    "actual": "Error modal appeared instead",
    "met": false,
    "mismatch": "Expected login form but got error modal - possible auth failure"
  } or null,

  "tableAnalysis": { "ref": "e20", "headers": ["Name","Email"], "rowCount": 25, "isSortable": true, "hasPagination": true, "hasBulkActions": true, "hasInlineEditing": false } or null,
  "listAnalysis": { "ref": "l0", "estimatedItems": 50, "hasLoadMore": true, "isVirtualized": false, "scrollDirection": "vertical" } or null,
  "loadingState": { "isLoading": true, "type": "skeleton", "affectedArea": "main table", "ref": "e20" } or null,
  "overlapInfo": [{"coveredRef": "e15", "coveredBy": "cookie banner"}] or null
}

CRITICAL MANUS RULES:
1. **Impact Scoring**: For EVERY significant change, score it (HIGH/MEDIUM/LOW, Progress/Regression/Neutral)
2. **Spatial Diff**: If elements in PREVIOUS vs CURRENT differ by >100px → flag as spatial drift
3. **Network Awareness**: If network activity pending → set asyncWorkTriggered=true, warn that DOM may still change
4. **Expectation Validation**: If last action had expectation, validate if it was met
5. **Be factual**: No speculation, only what you see
6. **Shadow/Iframe Awareness**: [SHADOW] elements are in web components. [IFRAME] elements are in embedded frames. Both work normally — note their context.
7. **Loading State Detection**: If LOADING_STATE header present or elements show [COVERED] with skeleton indicators, populate loadingState and set asyncWorkTriggered=true. Do NOT suggest clicking in loading areas.
8. **Z-Index Overlap**: Elements marked [COVERED] are hidden behind overlays. In overlapInfo, identify what covers them. Suggest dismissing the overlay first.
9. **Pagination/Scroll Detection**: If PAGINATION or LIST with [HAS_LOAD_MORE] present, include "Click Next/Load More" or "Scroll to discover more" in availableActions.
10. **Table Analysis**: If TABLE header present, populate tableAnalysis. Note [SELECTABLE] for bulk actions, [SORTABLE] for sort capability.
11. **Validation Awareness**: [REQUIRED] = must fill, [INVALID] = has validation errors (check errorState), [HAS_VALUE] = already filled — skip unless goal requires changing.
12. Return ONLY valid JSON`;
  }
}
