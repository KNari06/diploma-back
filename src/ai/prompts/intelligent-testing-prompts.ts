/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTELLIGENT TESTING PROMPTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prompts for:
 * - Page analysis (Vision API)
 * - Action generation
 * - Next step decision
 * - Logic analysis
 * - Vision analysis
 */

import { PageType } from '@/agent/types/intelligent-testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// PAGE ANALYSIS PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for GPT-4 Vision to analyze page screenshot
 * ✅ ENHANCED: Now includes DOM context for better understanding
 */
export function buildPageAnalysisPrompt(params: {
  url: string;
  goal: string;
  previousContext?: string;
  domContext?: {
    formsCount: number;
    buttonsCount: number;
    inputsCount: number;
    linksCount: number;
    hasModals: boolean;
    interactiveElementsCount: number;
  };
}): string {
  const domContextSection = params.domContext
    ? `
- DOM STRUCTURE (for context) -
Forms: ${params.domContext.formsCount}
Buttons: ${params.domContext.buttonsCount}
Inputs: ${params.domContext.inputsCount}
Links: ${params.domContext.linksCount}
Interactive Elements: ${params.domContext.interactiveElementsCount}
Modals Detected: ${params.domContext.hasModals ? 'Yes' : 'No'}

Note: Use this DOM context to better understand the page structure. Match visual elements you see with the DOM structure.
`
    : '';

  return `You are an expert QA engineer analyzing a web page screenshot.
- CONTEXT -
URL: ${params.url}
Testing Goal: ${params.goal}
${params.previousContext ? `Previous Context: ${params.previousContext}` : ''}${domContextSection}
- TASK -
Analyze this screenshot and provide detailed information. Use the DOM context to better understand which elements are interactive and match visual elements with DOM structure.

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
  ],
  "modals": [
    {
      "type": "cookie_banner|newsletter|popup|welcome|other",
      "description": "Brief description of the modal",
      "hasCloseButton": true/false,
      "closeButtonText": "X|Close|Закрыть|etc or null if not visible"
    }
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
6. **modals**: List ALL visible modals, popups, overlays, cookie banners, welcome screens
   - Include modals that block interaction with the page
   - Specify if close button is visible and its text (X, Close, ×, etc.)
   - This is CRITICAL for test automation - modals must be closed before testing

Focus on elements relevant to the testing goal.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION GENERATION PROMPTS
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
  actualHTML?: string; // ✅ NEW: Actual HTML from page (limited)
  hints?: Array<{ description: string; action?: string; target?: string; value?: string; priority?: string }>; // ✅ NEW: Test hints from plan
}): string {
  // Build hints section if provided
  const hintsSection = params.hints && params.hints.length > 0
    ? `
--- TEST HINTS (User's requested steps) ---
The user wants to test the following steps. Use these as GUIDANCE but ADAPT to actual page elements:
${params.hints.map((h, i) => `${i + 1}. ${h.description}${h.action ? ` (suggested action: ${h.action})` : ''}${h.target ? ` (target: ${h.target})` : ''}${h.value ? ` (value: ${h.value})` : ''}${h.priority === 'high' ? ' ⚠️ HIGH PRIORITY' : ''}`).join('\n')}

IMPORTANT: These hints describe WHAT the user wants to test, not exact commands.
- Find the ACTUAL elements on the page that match these hints
- Use REAL selectors from "Available Elements" section
- If a hint cannot be matched to any element, skip it and continue with others
`
    : '';

  return `You are an expert QA automation engineer deciding what actions to take next.

--- CONTEXT ---
Page Type: ${params.pageType}
Description: ${params.pageDescription}
Testing Goal: ${params.goal}
${hintsSection}
History (what we've done):
${params.history}

Available Elements:
${params.availableElements}

DOM Summary:
${params.domSummary}
${params.actualHTML ? `\n--- ACTUAL HTML (for reference) ---\n${params.actualHTML}\n` : ''}

--- TASK ---
Generate a sequence of actions to test this page based on the goal.

🚨🚨🚨 **MOST IMPORTANT RULE - READ THIS FIRST** 🚨🚨🚨
You can ONLY use elements that exist in "Available Elements" or "DOM Summary" sections above!
- ❌ NEVER invent or imagine elements that are not listed
- ❌ NEVER use selectors that are not shown in the context
- ❌ If you need "search input" but no input is listed → you CANNOT use it
- ❌ If you need button "Математика" but it's not listed → you CANNOT click it
- ✅ If the goal requires elements that don't exist on THIS page → navigate to find them (click "Continue", "Next", etc.)
- ✅ ALWAYS check "Available Elements" and "DOM Summary" BEFORE generating any action

**If elements needed for the goal are NOT on this page:**
1. Look for navigation buttons: "Next", "Continue", "Skip", "Продолжить", "Далее"
2. Click them to navigate to the page with needed elements
3. DO NOT try to interact with non-existent elements!

⚠️ **Goal**: "${params.goal}"
If the goal mentions specific elements (like "search", "registration form") but they are NOT in the context above,
you should navigate first to find those elements.

Even if the goal is vague or generic, as long as the page has interactive elements
you MUST propose at least 1-3 concrete, safe actions (clicks, fills, scrolls, simple assertions)
that explore the UI. Only return an empty "actions" array if the page is truly empty
(no buttons, inputs, links, forms) or blocked (CAPTCHA, hard paywall, fatal error).

RESPONSE FORMAT (JSON):
{
  "reasoning": "Explain your thought process (2-3 sentences)",
  "actions": [
    {
      "action": "click|dblclick|fill|type|select|check|uncheck|hover|focus|blur|press|dragAndDrop|tap|swipe|wait|scroll|scrollIntoView|goBack|goForward|reload|assertVisible|assertText|assertValue|assertUrl|assertCount|extract|screenshot",
      "selector": "CSS selector or Playwright text selector (use EXACT selector from context)",
      "value": "value for fill/select/type/press/dragAndDrop actions",
      "description": "What this action does",
      "expectedResult": "What should happen after this action",
      "optional": true/false,
      "timeout": 10000
    }
  ],
  "nextExpectedPage": "home|product|cart|checkout|login|register|search_results|category|profile|dashboard|settings|payment|error|unknown|null (if staying on same page)",
  "confidence": 0.0-1.0
}

AVAILABLE ACTIONS (choose appropriate one):
- **Interactions**: click, dblclick, fill, type, select, check, uncheck, hover, focus, blur, press
- **Drag & Drop**: dragAndDrop (value = target selector), tap, swipe
- **Navigation**: goBack, goForward, reload
- **Scroll**: scroll, scrollIntoView
- **Wait**: wait, waitForSelector
- **Assertions**: assertVisible, assertText, assertValue, assertUrl, assertCount
- **Data**: extract, screenshot

**📝 IMPORTANT: Using press action:**
- ✅ Use press with value="Enter" when there's NO submit button visible
- ✅ After filling a search input → if no "Search" button exists → use press Enter on the input
- ✅ After filling a form field → if no submit button → use press Enter on the input
- ✅ Example: {"action": "press", "selector": "role=textbox[name='Search']", "value": "Enter"}
- ✅ This is equivalent to user pressing Enter key on keyboard
- ⚠️ If a submit button EXISTS → prefer clicking the button instead of press Enter

CRITICAL RULES:

0. **SELECTOR USAGE (MOST IMPORTANT)**:
   - ✅ ALWAYS use the EXACT selector from "Available Elements" or "DOM Summary" sections
   - ✅ If selector is provided: use it EXACTLY as shown (e.g., role=button[name="Login"], text="Login")

   **🎯 SELECTOR FORMAT BY ACTION TYPE (CRITICAL!):**

   For **click** actions on buttons:
   - ✅ BEST: role=button[name="Login"] - finds actual <button> elements
   - ✅ GOOD: #button-id, [data-testid="login-btn"] - unique identifiers
   - ⚠️ AVOID: text="Login" - may find <span> inside button instead of button itself!

   For **fill/type** actions on inputs:
   - ✅ BEST: label="Email" - finds input by its label
   - ✅ GOOD: #email-input, [data-testid="email"], [name="email"]
   - ✅ OK: role=textbox[name="Email"], role=searchbox
   - ⚠️ AVOID: text="Email" - may find label text, not the input!

   **After fill/type, if NO submit button exists:**
   - ✅ Use press action with value="Enter" on the same input selector
   - ✅ Example: fill input → then press Enter (if no button to click)
   - ⚠️ If submit button EXISTS → click the button instead

   For **select** actions on dropdowns:
   - ✅ BEST: role=combobox[name="Country"], #country-select
   - ✅ GOOD: [data-testid="country-dropdown"], [name="country"]
   - ⚠️ AVOID: text="Select country" - may find placeholder text!

   For **assertText/assertVisible** (any element is fine):
   - ✅ OK: text="Welcome", role=heading[name="Title"]

   **⚠️ WARNING: text="..." selector finds ANY element with that text!**
   If page has: <button><span>Login</span></button>
   - text="Login" → finds <span> (WRONG for click!)
   - role=button[name="Login"] → finds <button> (CORRECT!)

   🚫 **INVALID SELECTOR FORMATS (WILL CAUSE ERRORS):**
   - ❌ ".class > role=textbox" - MIXING CSS with Playwright = BROKEN
   - ❌ "div role=button" - MIXING CSS with Playwright = BROKEN
   - ❌ ".relative > text=Login" - MIXING CSS with Playwright = BROKEN
   - ❌ "button:has-text()" - NOT SUPPORTED
   - ❌ ":contains()" - NOT SUPPORTED (jQuery syntax)
   - ❌ Single quotes 'text' - use double quotes "text"

   ✅ **VALID SELECTOR FORMATS (USE ONLY THESE):**

   **Playwright Locators (PREFERRED):**
   - role=button[name="Login"] - ARIA role with name
   - role=textbox - ARIA role without name
   - role=link[name="Sign up"] - link by accessible name
   - text="Login" - exact text match
   - label="Email" - input by label text

   **CSS Selectors (ALSO VALID):**
   - #element-id - by ID
   - .class-name - by class
   - [data-testid="value"] - by data attribute
   - [name="email"] - by name attribute
   - input[type="email"] - by tag + attribute

   **⚠️ CRITICAL: NEVER COMBINE CSS + PLAYWRIGHT IN ONE SELECTOR!**
   If you need element inside container, use ONLY the inner element's selector.
   Example: For input inside .relative div, use: role=textbox (NOT .relative > role=textbox)

   - ❌ NEVER invent selectors - ONLY use ones from "Available Elements" or "DOM Summary"
   - ❌ If element is NOT in context → DO NOT generate action for it (navigate to find it instead)
   - ❌ DO NOT assume elements exist based on goal - CHECK THE CONTEXT FIRST!
   - Example: If DOM shows Selector: "role=button[name=\"Login\"]" → use EXACTLY that
   - Example: If DOM shows Selector: "label=\"Email\"" → use EXACTLY that
   - Example: If goal says "search for products" but NO search input in context → click navigation button first!

1. **Logical Dependencies**:
   - On product page: MUST select size/color BEFORE "add to cart"
   - On login: MUST fill credentials BEFORE clicking login
   - On checkout: MUST fill required fields BEFORE submit
   - **After fill**: If no submit button exists → use press with Enter on the same input
     Example sequence:
     [
       {"action": "fill", "selector": "role=searchbox", "value": "Математика", "description": "Fill search input"},
       {"action": "press", "selector": "role=searchbox", "value": "Enter", "description": "Press Enter to submit search"}
     ]

2. **Realistic Actions**:
   - Use realistic test data (real email format, valid phone numbers)
   - Don't use obvious test data like "test@test.com"
   - For search: use relevant search terms

3. **Safety First**:
   - NEVER generate actions for: delete, remove account, pay, purchase, subscribe
   - If you see payment form → set action to "wait" with description "requires manual approval"
   - If you see CAPTCHA → set action to "wait" with description "CAPTCHA detected"
   - ⚠️ **MODAL CLOSING**: Only close modals if a close selector is provided in "DOM Summary"
   - If modal is detected but NO close selector is shown → DO NOT generate close action (set optional: true or skip)
   - If you see "⚠️ No close button selector found" → DO NOT try to close the modal

4. **Validation**:
   - Always specify expectedResult (e.g., "URL changes", "cart count increases", "error message appears")
   - This is critical for detecting bugs

5. **Sequence**:
   - Generate 2-5 actions per response
   - Actions should be logically connected
   - Don't jump between unrelated features

6. **Confidence**:
   - 0.9-1.0: Very confident in these actions (elements clearly match goal)
   - 0.7-0.9: Reasonable confidence (elements likely match goal)
   - <0.7: Uncertain - elements may not fully match goal, consider generating alternative actions or navigating to find better elements

Think like a real user testing the application.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEXT STEP PROMPTS
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

--- CONTEXT ---
Testing Goal: ${params.goal}
Current Page: ${params.currentPage}
Visited Pages: ${params.visitedPages.join(' → ')}

History:
${params.history}

${params.errors.length > 0 ? `Errors Encountered:\n${params.errors.join('\n')}` : 'No errors so far.'}

--- TASK ---
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
// LOGIC ANALYSIS PROMPTS
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

--- CONTEXT ---
Page Type: ${params.pageType}

Elements:
${params.elements}

DOM Data:
${params.domData}

--- TASK ---
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

// ═══════════════════════════════════════════════════════════════════════════
// VISION ANALYSIS PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for vision analysis based on scope
 * Uses AI to dynamically understand context without hardcoded checks
 */
export function buildVisionPrompt(scope: string, url: string): string {
  return `Analyze this screenshot of a web page (URL: ${url}).

Task: Identify all interactive elements and provide testing recommendations.
User's testing focus: "${scope}"

Based on the user's focus and what you see in the screenshot, intelligently identify relevant elements.

Return JSON in this format:
{
  "elements": [
    {
      "type": "input|button|link|select|checkbox|etc",
      "purpose": "What this element does",
      "location": "Where on page",
      "required": true/false
    }
  ],
  "layout": "Brief description of page layout",
  "suggestions": ["Specific test case suggestions based on user's focus"]
}

Guidelines (adapt based on what you see):
- Identify ALL interactive elements relevant to the user's testing focus
- For registration/signup pages: Focus on email/username, passwords, confirm password, terms/privacy checkboxes, social login
- For login/signin/auth pages: Focus on credentials, "Remember me", "Forgot password" links, social login options
- For forms: Focus on all input types, required vs optional fields, validation rules, submit/cancel buttons, file uploads, dropdowns
- For e-commerce: Focus on product selection, cart, checkout flows, payment forms
- For dashboards: Focus on navigation, data display, interactive widgets, filters
- Note required fields (asterisk, 'required' label, red border, validation hints)
- Pay attention to validation messages, error states, loading indicators
- Identify accessibility features (aria labels, alt text, keyboard navigation)
- Suggest specific test cases that match the user's testing focus

Be intelligent: If user says "test checkout", focus on payment-related elements. If they say "verify navigation", focus on menus and links.`;
}
