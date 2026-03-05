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
      model: LITE_ENGINE_FLAGS.coreBrainModel as string,
      temperature: 0.05,
      maxTokens: 1000,
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

    // Supervisor: Recovery mode prompt injection
    const recoverySection = input.blackboard?.recoveryMode
      ? `
⚠️ RECOVERY MODE (Tier ${input.blackboard.recoveryTier}): Agent is STUCK. Focus on OBSTACLES first:
- Disabled buttons, invisible overlays, error messages, session warnings
- Navigation links to go BACK to a working page
- Form validation errors, hidden required fields
${input.blackboard.currentBlocker ? `Known blocker: ${input.blackboard.currentBlocker}` : ''}
${input.blackboard.aiDiagnosis ? `AI Diagnosis: ${input.blackboard.aiDiagnosis}` : ''}
Report obstacles as FIRST priority in your response.
`
      : '';

    // Layer 2: Obstacle facts section — raw positioned elements for LLM classification
    const obstacleFactsSection = (() => {
      if (!input.obstacleFacts || input.obstacleFacts.length === 0) return '';
      const compact = input.obstacleFacts.map(f => ({
        ref: f.ref,
        tag: f.tag,
        pos: f.position,
        z: f.zIndex,
        cov: `${Math.round(f.coverage * 100)}%`,
        cls: f.className.slice(0, 80),
        id: f.id?.slice(0, 50) || undefined,
        text: f.textPreview.slice(0, 80),
        close: f.hasCloseButton,
        interactive: f.hasInteractiveChildren,
        role: f.role || undefined,
        ariaModal: f.ariaModal || undefined,
        rect: `${f.rect.width}x${f.rect.height}@(${f.rect.left},${f.rect.top})`,
      }));
      return `
POSITIONED ELEMENTS — classify EACH from raw data (cls, id, text, role, pos, rect):
${JSON.stringify(compact, null, 1)}

CLASSIFICATION GUIDE:
- "modal": role="dialog"/"alertdialog", ariaModal=true, OR large coverage (>30%) + interactive + high z-index
- "cookie_consent": text contains "cookie"/"consent"/"privacy"/"gdpr"/"accept all"; cls/id contains "cookie"/"consent"/"onetrust"/"cookiebot"; typically bottom-positioned banner
- "chat_widget": cls/id contains "intercom"/"drift"/"crisp"/"zendesk"/"tawk"/"livechat"; bottom-right corner, small coverage (<10%)
- "toast": very small coverage (<10%), cls contains "toast"/"snack"/"notification"/"Toastify"/"sonner"; transient
- "sticky_header": pos=fixed/sticky, top≈0, height<120px, full width — permanent, scroll around
- "sticky_footer": pos=fixed/sticky, bottom≈0, height<120px, full width — permanent, scroll around
- "loading_overlay": text/cls contains "loading"/"spinner"/"skeleton"/"please wait"; transient, wait
- "dropdown": cls contains "dropdown"/"select"/"menu"/"combobox"; medium z-index, appeared after click
- "tooltip": cls contains "tooltip"/"popover"/"tippy"; very small coverage (<5%), transient
- "drawer": cls contains "drawer"/"sidebar"/"slide-over"/"off-canvas"; side-positioned, large height
- "onboarding": cls contains "tour"/"walkthrough"/"joyride"/"introjs"/"shepherd"/"onboarding"
- "paywall": text contains "subscribe"/"premium"/"login to continue"/"sign up to access"
- "unknown": does not match any pattern — default

For each, report in "classifiedObstacles":
  ref, type, isBlocking (prevents interaction?), isDismissible, dismissStrategy (be SPECIFIC: "click button ref e42 text 'Accept All'" or "press Escape"), affectedArea, reason

Also report overall "pageStateAnalysis": { isLoading, hasFullViewportOverlay, stackedObstacleCount, isFlowBlocked, blockReason }
`;
    })();

    return `You are a Page Observer (Manus-style). Analyze the page and score changes by IMPACT.

URL: ${input.url}
Title: ${input.title}
${goalContext}${credentialContext}${recoverySection}
CURRENT PAGE SNAPSHOT:
${input.snapshot}
${visualDiffSection}${driftSection}${networkSection}${visionSection}${expectationSection}${loadingSection}${metadataSection}${structureSection}${obstacleFactsSection}
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
  "overlapInfo": [{"coveredRef": "e15", "coveredBy": "cookie banner"}] or null${input.obstacleFacts?.length ? `,
  "classifiedObstacles": [{"ref":"e42","type":"cookie_consent","isBlocking":true,"isDismissible":true,"dismissStrategy":"click button ref e45 text 'Accept All'","affectedArea":"bottom 200px","reason":"Cookie consent banner"}],
  "pageStateAnalysis": {"isLoading":false,"hasFullViewportOverlay":false,"stackedObstacleCount":0,"isFlowBlocked":false}` : ''}
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
12. **Obstacle Classification**: If POSITIONED ELEMENTS section is present, classify each positioned element from its raw data (cls, id, text, role, ariaModal, pos, rect, coverage). Do NOT rely on any pre-classification. Report blocking obstacles in "obstacles" too.
13. **Page State Analysis**: Analyze the OVERALL page state: Is the page loading? Is there a full-viewport overlay blocking everything? Are multiple obstacles stacked? Is the user flow completely blocked? Report in "pageStateAnalysis".
14. Return ONLY valid JSON`;
  }
}
