/**
 * AI prompts for intelligent testing system
 * Optimized for context understanding and action generation
 */

import { PageType } from '@/agent/types/intelligent-testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// PAGE CONTEXT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for GPT-4 Vision to analyze page screenshot
 */
export function buildPageAnalysisPrompt(params: {
  url: string;
  goal: string;
  previousContext?: string;
}): string {
  return `You are an expert QA engineer analyzing a web page screenshot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL: ${params.url}
Testing Goal: ${params.goal}
${params.previousContext ? `Previous Context: ${params.previousContext}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Analyze this screenshot and provide detailed information.

RESPONSE FORMAT (JSON):
{
  "pageType": "home|product|cart|checkout|login|register|search_results|category|profile|dashboard|settings|payment|error|unknown",
  "description": "Brief description of the page (2-3 sentences)",
  "elements": [
    {
      "type": "button|input|select|link|form|modal|other",
      "purpose": "search|add_to_cart|login|submit|etc",
      "text": "visible text on element",
      "required": true/false,
      "priority": "critical|high|medium|low"
    }
  ],
  "suggestions": [
    "Test search functionality",
    "Verify add to cart button",
    "Check form validation"
  ],
  "warnings": [
    "Payment form detected - requires manual approval",
    "CAPTCHA present - manual intervention needed"
  ]
}

IMPORTANT RULES:
1. **pageType**: Choose the most accurate type
2. **elements**: List ONLY interactive elements (buttons, inputs, links)
3. **priority**:
   - critical = required for main user journey
   - high = important functionality
   - medium = nice to have
   - low = optional features
4. **warnings**: Flag dangerous actions (payment, delete, etc.) and blockers (captcha)
5. **required**: Mark elements that MUST be interacted with before proceeding

Focus on elements relevant to the testing goal.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for generating next actions based on context
 */
export function buildActionGenerationPrompt(params: {
  pageType: PageType;
  goal: string;
  pageDescription: string;
  availableElements: string; // JSON string of elements
  history: string; // What has been done so far
  domSummary: string; // DOM analysis summary
}): string {
  return `You are an expert QA automation engineer deciding what actions to take next.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Page Type: ${params.pageType}
Description: ${params.pageDescription}
Testing Goal: ${params.goal}

History (what we've done):
${params.history}

Available Elements:
${params.availableElements}

DOM Summary:
${params.domSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate a sequence of actions to test this page based on the goal.

RESPONSE FORMAT (JSON):
{
  "reasoning": "Explain your thought process (2-3 sentences)",
  "actions": [
    {
      "action": "click|fill|select|wait|scroll|press|hover",
      "selector": "CSS selector or text selector",
      "value": "value for fill/select actions",
      "description": "What this action does",
      "expectedResult": "What should happen after this action",
      "optional": true/false,
      "timeout": 5000
    }
  ],
  "nextExpectedPage": "product|cart|etc or null if staying on same page",
  "confidence": 0.0-1.0
}

CRITICAL RULES:

1. **Logical Dependencies**:
   - On product page: MUST select size/color BEFORE "add to cart"
   - On login: MUST fill credentials BEFORE clicking login
   - On checkout: MUST fill required fields BEFORE submit

2. **Realistic Actions**:
   - Use realistic test data (real email format, valid phone numbers)
   - Don't use obvious test data like "test@test.com"
   - For search: use relevant search terms

3. **Safety First**:
   - NEVER generate actions for: delete, remove account, pay, purchase, subscribe
   - If you see payment form → set action to "wait" with description "requires manual approval"
   - If you see CAPTCHA → set action to "wait" with description "CAPTCHA detected"

4. **Validation**:
   - Always specify expectedResult (e.g., "URL changes", "cart count increases", "error message appears")
   - This is critical for detecting bugs

5. **Sequence**:
   - Generate 2-5 actions per response
   - Actions should be logically connected
   - Don't jump between unrelated features

6. **Confidence**:
   - 0.9-1.0: Very confident in these actions
   - 0.7-0.9: Reasonable confidence
   - <0.7: Uncertain, might need alternatives

Think like a real user testing the application.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEXT STEP DECISION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for deciding next step
 */
export function buildNextStepPrompt(params: {
  goal: string;
  history: string;
  currentPage: PageType;
  visitedPages: string[];
  errors: string[];
}): string {
  return `You are an expert QA engineer deciding the next step in testing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Testing Goal: ${params.goal}
Current Page: ${params.currentPage}
Visited Pages: ${params.visitedPages.join(' → ')}

History:
${params.history}

${params.errors.length > 0 ? `Errors Encountered:\n${params.errors.join('\n')}` : 'No errors so far.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Decide what to do next.

RESPONSE FORMAT (JSON):
{
  "decision": "continue|stop|wait_for_user|retry|skip",
  "reason": "Explain why (2-3 sentences)",
  "progress": 0-100,
  "goalAchieved": true/false,
  "nextTarget": "Description of next logical step or null if stopping"
}

DECISION RULES:

**continue**: Keep testing if:
- Goal not yet achieved
- Found new pages to explore
- Still have relevant actions to test

**stop**: Stop testing if:
- Goal fully achieved (e.g., completed purchase flow)
- Reached dead end (no more actions possible)
- Too many errors (>5 failures)

**wait_for_user**: Pause if:
- Encountered dangerous action (payment, delete)
- Found CAPTCHA or manual verification
- Unclear what to do next (confidence <0.5)

**retry**: Try again if:
- Temporary error that might resolve (network, timeout)
- Element not found but might load later

**skip**: Skip current page if:
- Already visited this page 3+ times (cycle detected)
- Page is irrelevant to goal
- Blocking issue (broken page)

**progress**: Estimate % of goal completion (0-100)

**goalAchieved**:
- true only if the main goal is FULLY completed
- For "test purchase": achieved only if reached checkout/payment
- For "test login": achieved only if successfully logged in

Be realistic about progress and goal achievement.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGICAL UNDERSTANDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for understanding logical dependencies
 */
export function buildLogicAnalysisPrompt(params: {
  pageType: PageType;
  elements: string; // JSON of elements
  domData: string; // DOM analysis
}): string {
  return `You are an expert QA engineer analyzing logical dependencies on a page.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Page Type: ${params.pageType}

Elements:
${params.elements}

DOM Data:
${params.domData}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Identify logical dependencies and requirements.

RESPONSE FORMAT (JSON):
{
  "requiredBeforeMain": [
    "Must select size before adding to cart",
    "Must select color before adding to cart"
  ],
  "optionalActions": [
    "Can change quantity",
    "Can read reviews"
  ],
  "blockers": [
    "Add to cart button is disabled until size selected",
    "Submit button requires all required fields"
  ],
  "mainAction": "Primary action on this page (e.g., 'Add to Cart', 'Login', 'Submit')",
  "validation": [
    "Cart count should increase after adding",
    "Success message should appear after login"
  ]
}

EXAMPLES:

Product Page:
- requiredBeforeMain: ["select size", "select color"]
- mainAction: "Add to Cart"
- validation: ["cart count increases", "success notification"]

Login Page:
- requiredBeforeMain: ["fill email", "fill password"]
- mainAction: "Login"
- validation: ["redirect to dashboard", "welcome message"]

Focus on LOGICAL dependencies, not just technical ones.`;
}
