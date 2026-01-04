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
 * ENHANCED: Now includes DOM context for better understanding
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

CRITICAL: You MUST return a valid JSON object matching EXACTLY this structure. No markdown, no code blocks, no additional text outside JSON.

REQUIRED JSON STRUCTURE:
{
  "pageType": "string (REQUIRED)",
  "primaryIntent": "string (REQUIRED)",
  "mainAction": "string | null (REQUIRED)",
  "requiresUserInput": true | false (REQUIRED),
  "description": "string (REQUIRED)",
  "elements": [array (REQUIRED, can be empty [])],
  "suggestions": [array (REQUIRED, can be empty [])],
  "warnings": [array (REQUIRED, use empty array [] if none)],
  "modals": [array (REQUIRED, use empty array [] if none)]
}

DETAILED FIELD SPECIFICATIONS:

1. **pageType** (REQUIRED, string, must be one of):
   "home" | "product" | "cart" | "checkout" | "login" | "register" | "search_results" | "category" | "profile" | "dashboard" | "settings" | "payment" | "error" | "unknown"
   Example: "login"

   **SPECIAL PAGE TYPES**:
   - Use "payment" if you see credit card fields, billing address, CVV, expiry date, or payment processor logos (Stripe, PayPal)
   - Use "unknown" with descriptive text if this is an onboarding/welcome/tutorial page (e.g., "Welcome screen with Skip and Get Started buttons")

2. **primaryIntent** (REQUIRED, string):
   See INTENT DETECTION RULES below.

3. **mainAction** (REQUIRED, string | null):
   See INTENT DETECTION RULES below.

4. **requiresUserInput** (REQUIRED, boolean):
   See INTENT DETECTION RULES below.

5. **description** (REQUIRED, string):
   Brief description of the page (2-3 sentences)
   Example: "Login page with email and password fields, and a 'Sign in' button"

6. **elements** (REQUIRED, array of objects, can be empty []):
   Each element object MUST have ALL these fields:
   {
     "type": "button" | "input" | "select" | "link" | "form" | "modal" | "other" (REQUIRED),
     "purpose": "string" (REQUIRED, e.g., "search", "add_to_cart", "login", "submit"),
     "text": "string" (REQUIRED, visible text on element, use empty string "" if no text, preserve original language),
     "required": true | false (REQUIRED, boolean, not string),
     "priority": "critical" | "high" | "medium" | "low" (REQUIRED, string),
     "isCTA": true | false (OPTIONAL, boolean, mark as true for Call-To-Action buttons like Skip, Next, Continue, Register, Login, Get Started, Sign Up, Start, Begin)
   }

   **IMPORTANT - Call-To-Action (CTA) Detection**:
   Mark "isCTA": true for buttons that are common navigation/flow CTAs:
   - Skip buttons (Skip, Skip for now, Пропустить)
   - Next/Continue buttons (Next, Continue, Далее, Продолжить)
   - Start/Begin buttons (Get Started, Start, Begin, Начать)
   - Registration buttons (Register, Sign Up, Регистрация)
   - Login buttons (Login, Sign In, Войти)
   - Complete/Finish buttons (Complete, Finish, Done, Завершить)

   Example CTA element:
   {
     "type": "button",
     "purpose": "skip_onboarding",
     "text": "Skip",
     "required": false,
     "priority": "medium",
     "isCTA": true
   }

   Example non-CTA element:
   {
     "type": "button",
     "purpose": "login",
     "text": "Sign In",
     "required": true,
     "priority": "critical",
     "isCTA": true
   }

7. **suggestions** (REQUIRED, array of strings, can be empty []):
   Array of test suggestions
   Example: ["Test search functionality", "Verify add to cart button"]

8. **warnings** (REQUIRED, array of strings, use [] if none):
   Flag dangerous actions or blockers
   Example: ["Payment form detected - requires manual approval", "CAPTCHA present"]

   **CRITICAL WARNINGS TO DETECT**:
   - "Payment form detected" - if you see credit card inputs, billing fields, payment buttons
   - "CAPTCHA present" - if you see any CAPTCHA/reCAPTCHA
   - "Onboarding flow detected" - if this is a welcome/tutorial/getting-started page with Skip/Next buttons
   - "Paywall detected" - if content is blocked behind payment/subscription
   - "Login required" - if page shows "Please login to continue" or similar

9. **modals** (REQUIRED, array of objects, use [] if none):
   Each modal object MUST have ALL these fields:
   {
     "type": "cookie_banner" | "newsletter" | "popup" | "welcome" | "other" (REQUIRED),
     "description": "string" (REQUIRED),
     "hasCloseButton": true | false (REQUIRED, boolean, not string),
     "closeButtonText": "string" | null (REQUIRED, visible text on close button or null if not visible)
   }

   Example modal:
   {
     "type": "cookie_banner",
     "description": "Cookie consent banner at bottom of page",
     "hasCloseButton": true,
     "closeButtonText": "Accept"
   }

INTENT DETECTION RULES:

**primaryIntent** (REQUIRED):
Describes WHY this page exists (the business purpose), NOT what elements are shown.
Think: "What is the user trying to accomplish by visiting this page?"

Choose exactly ONE from:
- "authenticate_user" - Login, sign in, password reset pages
- "onboard_user" - Welcome screens, tutorials, getting started flows
- "purchase" - Product pages, cart, checkout, payment pages
- "browse" - Homepage, category pages, search results, product listings
- "configure" - Settings, preferences, customization pages
- "manage_account" - Profile, account settings, subscription management
- "support" - Help pages, FAQ, contact forms, documentation
- "unknown" - If purpose is unclear or doesn't fit above categories

Examples:
- Login page → "authenticate_user" (WHY: user wants to sign in)
- Product listing → "browse" (WHY: user wants to explore products)
- Checkout page → "purchase" (WHY: user wants to buy)
- Settings page → "configure" (WHY: user wants to change settings)
- Welcome screen → "onboard_user" (WHY: user is being introduced to the app)

**mainAction** (REQUIRED, string | null):
The single most important user action on this page - what button/action moves the user forward in their goal.
- Must be a short verb phrase (max 3 words)
- Examples: "Login", "Register", "Add to Cart", "Continue", "Pay", "Save", "Search", "Skip"
- If page has multiple actions but none is clearly primary → return null
- If page is purely informational (no action needed) → return null

Examples:
- Login page with "Sign In" button → "Login"
- Product page with "Add to Cart" button → "Add to Cart"
- Checkout page with "Pay Now" button → "Pay"
- Onboarding page with "Skip" and "Next" buttons → "Skip" or "Next" (choose most prominent)
- Homepage with search bar → "Search"
- Info page with no clear action → null

**requiresUserInput** (REQUIRED, boolean):
Indicates if user MUST enter data (typing, selecting, checking) to proceed with main action.

- true = User must type/select/check something (forms, inputs, dropdowns, checkboxes)
- false = User can proceed by clicking/navigating only (no data entry needed)

Examples:
- Login page (email + password fields) → true
- Product page (just "Add to Cart" button, no size/color selection) → false
- Product page (must select size/color before adding to cart) → true
- Checkout page (billing form) → true
- Homepage (just navigation links) → false
- Search results page (just click links) → false
- Settings page (must fill form to save) → true

VALIDATION RULES (MUST FOLLOW):
- ALL fields must be present in JSON (even if empty arrays)
- "pageType" must be exactly one of the allowed string values
- "primaryIntent" must be exactly one of the allowed enum values
- "mainAction" must be null or a short verb phrase (max 3 words)
- "requiresUserInput" must be boolean true/false
- "elements" array items must have 5 required fields (type, purpose, text, required, priority) + optional "isCTA" field
- "modals" array items must have ALL 4 required fields (type, description, hasCloseButton, closeButtonText)
- Use boolean true/false (NOT strings "true"/"false")
- Use null (NOT string "null") for closeButtonText when not visible
- Preserve original UI language in "text" field (do not translate)
- Max ~20 elements in "elements" array
- Include ONLY visible interactive elements (match with DOM counts if provided)
- Do NOT invent elements - if unsure, omit them
- Mark "isCTA": true for navigation/flow buttons (Skip, Next, Continue, Register, Login, Get Started)

EXAMPLE COMPLETE VALID RESPONSE:
{
  "pageType": "login",
  "primaryIntent": "authenticate_user",
  "mainAction": "Login",
  "requiresUserInput": true,
  "description": "Login page with email input, password input, and Sign In button. Also has 'Forgot password?' link.",
  "elements": [
    {
      "type": "input",
      "purpose": "email",
      "text": "",
      "required": true,
      "priority": "critical"
    },
    {
      "type": "input",
      "purpose": "password",
      "text": "",
      "required": true,
      "priority": "critical"
    },
    {
      "type": "button",
      "purpose": "login",
      "text": "Sign In",
      "required": true,
      "priority": "critical"
    },
    {
      "type": "link",
      "purpose": "forgot_password",
      "text": "Forgot password?",
      "required": false,
      "priority": "low"
    }
  ],
  "suggestions": [
    "Test login with valid credentials",
    "Test form validation with empty fields"
  ],
  "warnings": [],
  "modals": []
}

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
  actualHTML?: string; // NEW: Actual HTML from page (limited)
  hints?: Array<{ description: string; action?: string; target?: string; value?: string; priority?: string }>; // NEW: Test hints from plan
}): string {
  // Build hints section if provided
  const hintsSection = params.hints && params.hints.length > 0
    ? `
--- TEST HINTS (User's requested steps) ---
The user wants to test the following steps. Use these as GUIDANCE but ADAPT to actual page elements:
${params.hints.map((h, i) => `${i + 1}. ${h.description}${h.action ? ` (suggested action: ${h.action})` : ''}${h.target ? ` (target: ${h.target})` : ''}${h.value ? ` (value: ${h.value})` : ''}${h.priority === 'high' ? ' [HIGH PRIORITY]' : ''}`).join('\n')}

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

**MOST IMPORTANT RULE - READ THIS FIRST**
You can ONLY use elements that exist in "Available Elements" or "DOM Summary" sections above!
- NEVER invent or imagine elements that are not listed
- NEVER use selectors that are not shown in the context
- If you need "search input" but no input is listed → you CANNOT use it
- If you need button "Математика" but it's not listed → you CANNOT click it
- If the goal requires elements that don't exist on THIS page → navigate to find them (click "Continue", "Next", etc.)
- ALWAYS check "Available Elements" and "DOM Summary" BEFORE generating any action

**If elements needed for the goal are NOT on this page:**
1. Look for navigation buttons: "Next", "Continue", "Skip", "Продолжить", "Далее"
2. Click them to navigate to the page with needed elements
3. DO NOT try to interact with non-existent elements!

**Goal**: "${params.goal}"
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
      "action": "goto|goBack|goForward|reload|click|dblclick|fill|type|select|selectOption|check|uncheck|hover|focus|blur|press|dragAndDrop|tap|swipe|wait|waitForSelector|waitForNavigation|scroll|scrollIntoView|screenshot",
      "selector": "Selector (MUST be EXACTLY from context). Prefer role=/label=/text= if available; CSS/XPath/>> are allowed ONLY if they are shown in context.",
      "url": "required ONLY for goto",
      "value": "required for fill/type/select/selectOption/press/dragAndDrop (dragAndDrop value is target selector)",
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
- **Navigation**: goto, goBack, goForward, reload
- **Interactions**: click, dblclick, fill, type, select, selectOption, check, uncheck, hover, focus, blur, press
- **Drag & Drop / Mobile**: dragAndDrop (value = target selector), tap, swipe
- **Wait**: wait, waitForSelector, waitForNavigation
- **Scroll**: scroll, scrollIntoView
- **Data**: screenshot

**IMPORTANT: Using press action:**
- Use press with value="Enter" when there's NO submit button visible
- After filling a search input → if no "Search" button exists → use press Enter on the input
- After filling a form field → if no submit button → use press Enter on the input
- Example: {"action": "press", "selector": "role=textbox[name='Search']", "value": "Enter"}
- This is equivalent to user pressing Enter key on keyboard
- NOTE: If a submit button EXISTS → prefer clicking the button instead of press Enter

CRITICAL RULES:

0. **SELECTOR USAGE (MOST IMPORTANT)**:
   - ALWAYS use the EXACT selector from "Available Elements" or "DOM Summary" sections
   - If selector is provided: use it EXACTLY as shown (e.g., role=button[name="Login"], text="Login")

   **SELECTOR FORMAT BY ACTION TYPE (CRITICAL!):**

   **REAL SELECTOR PRIORITY (as generated by system):**
   1) testid="..." (our testing framework API - highest priority, generated for data-testid attributes)
   2) role=... with name (e.g., role=button[name="Login"]) - generated when element has implicit role + accessible name
   3) #id (CSS by ID - generated when element has ID but no role)
   4) label="..." (our testing framework API - generated for inputs/selects/textarea when label is found)
   5) text="..." (our testing framework API - generated for buttons/links when accessible name is found)
   6) [data-cy="..."] (CSS - generated for data-cy attributes, our framework doesn't have getByCy API)
   7) [name="..."] (CSS - fallback for inputs when label= not available)

   For **click** actions on buttons:
   - BEST: testid="login-btn" (our testing framework API, most stable)
   - BEST: role=button[name="Login"] - finds actual <button> elements
   - GOOD: #button-id (stable CSS, generated when button has ID)
   - OK: text="Login" - USE IF IT'S THE ONLY SELECTOR IN CONTEXT (system uses getSmartLocator to find correct element)
   - OK: [data-cy="login-btn"] - CSS fallback for data-cy attributes
   - NOTE: If context shows text="Login" as the ONLY selector → use it (system will handle disambiguation automatically)

   For **fill/type** actions on inputs:
   - BEST: testid="email-input" (our testing framework API, most stable)
   - BEST: label="Email" - finds input by its label (our testing framework API)
   - GOOD: #email-input (stable CSS, generated when input has ID)
   - OK: role=textbox[name="Email"], role=searchbox (generated when input has role)
   - OK: [name="email"] (CSS fallback when label= not available)
   - NOTE: text="Email" is NOT generated for inputs (system uses label= instead)
   - NOTE: [data-testid="email"] is NOT generated (system uses testid="email" our testing framework API instead)

   **After fill/type, if NO submit button exists:**
   - Use press action with value="Enter" on the same input selector
   - Example: fill input → then press Enter (if no button to click)
   - NOTE: If submit button EXISTS → click the button instead

   For **select** actions on dropdowns:
   - BEST: testid="country-select" (our testing framework API, if dropdown has data-testid)
   - BEST: role=combobox[name="Country"] (generated when select has accessible name)
   - GOOD: label="Country" (generated when select has label)
   - GOOD: #country-select (stable CSS, generated when select has ID)
   - OK: [name="country"] (CSS fallback when label= not available)
   - NOTE: text="Select country" is NOT generated for dropdowns (system uses role=combobox or label=)

   **IMPORTANT: Selector disambiguation and smart selection:**
   - System uses getSmartLocator() to handle ambiguous selectors (e.g., text="Login" matching multiple elements)
   - If context shows text="..." as the ONLY selector → use it (system will automatically find the correct element)
   - If context shows multiple selector options → prefer testid= > role= > #id > label= > text=
   - System automatically selects the best matching element based on action type (click prefers <button>, not <span>)
   - You don't need to worry about nested elements - system handles disambiguation automatically

   **INVALID SELECTOR FORMATS (WILL CAUSE ERRORS):**
   - ".class > role=textbox" - MIXING CSS with our framework API = BROKEN
   - "div role=button" - MIXING CSS with our framework API = BROKEN
   - ".relative > text=Login" - MIXING CSS with our framework API = BROKEN
   - ":contains()" - NOT SUPPORTED (jQuery syntax)
   - Single quotes 'text' - use double quotes "text"

   **VALID SELECTOR FORMATS (USE ONLY THESE):**

   **PRIORITY (as generated by system, PREFERRED → FALLBACK):**
   1) testid="..." (our testing framework API - highest priority, generated for data-testid attributes)
   2) role=... with name (e.g., role=button[name="Login"]) - generated when element has implicit role + accessible name
   3) #id (CSS by ID) - generated when element has ID but no role
   4) label="..." (our testing framework API) - generated for inputs/selects/textarea when label is found
   5) text="..." (our testing framework API) - generated for buttons/links when accessible name is found
   6) [data-cy="..."] (CSS) - generated for data-cy attributes (our framework doesn't have getByCy API)
   7) [name="..."] (CSS) - fallback for inputs when label= not available
   8) XPath (//button... or xpath=//button...) - ONLY if shown in context (rarely generated)
   9) Shadow DOM chaining (selector1 >> selector2) - ONLY if shown in context (generated for Shadow DOM elements)

   **Our Testing Framework Locators (PREFERRED - generated by system):**
   - testid="login-btn" - our testing framework API for data-testid (HIGHEST PRIORITY)
   - role=button[name="Login"] - ARIA role with name
   - role=textbox - ARIA role without name
   - role=link[name="Sign up"] - link by accessible name
   - label="Email" - input by label text (our testing framework API)
   - text="Login" - exact text match (our testing framework API, but may match nested elements)

   **CSS Selectors (FALLBACK - generated when our testing framework API not available):**
   - #element-id - by ID (stable, generated when element has ID but no role)
   - [data-cy="value"] - by data-cy attribute (generated for data-cy, our framework doesn't have getByCy API)
   - [name="email"] - by name attribute (fallback for inputs when label= not available)
   - input[type="email"] - by tag + attribute (rarely generated)
   - .class-name - NOT generated (unstable, removed from system)
   - [data-testid="..."] - NOT generated (system uses testid="..." our testing framework API instead)

   **XPath (ALSO VALID, ONLY IF SHOWN IN CONTEXT):**
   - //button[@id="login"]
   - xpath=//button[@id="login"]

   **Shadow DOM chaining (ALSO VALID, ONLY IF SHOWN IN CONTEXT):**
   - .shadow-host >> role=button[name="Continue"]

   **CRITICAL: NEVER COMBINE CSS + OUR FRAMEWORK API IN ONE SELECTOR!**
   If you need element inside container, use ONLY the inner element's selector.
   Example: For input inside .relative div, use: role=textbox (NOT .relative > role=textbox)

   **EMPTY SELECTOR RULE (CRITICAL):**
   - If "Available Elements" shows Selector: "" (empty) → DO NOT generate action for that element
   - If Vision element has empty selector → check "DOM Summary" for the SAME element (match by text/type) and use its selector
   - If both are empty → skip that element and choose another element from context that has a valid selector
   - Empty selector means element cannot be reliably selected (no stable identifier found)
   - System automatically skips elements with empty selectors during DOM analysis

   - NEVER invent selectors - ONLY use ones from "Available Elements" or "DOM Summary"
   - NEVER modify selectors - use them EXACTLY as provided in context
   - If element is NOT in context → DO NOT generate action for it (navigate to find it instead)
   - DO NOT assume elements exist based on goal - CHECK THE CONTEXT FIRST!
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
   - **MODAL CLOSING**: Only close modals if a close selector is provided in "DOM Summary"
   - If modal is detected but NO close selector is shown → DO NOT generate close action (set optional: true or skip)
   - If you see "No close button selector found" → DO NOT try to close the modal

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
  return `You are an expert QA engineer deciding the next step in an autonomous UI test.
Your goal is to make progress reliably with minimal risk and minimal redundant steps.

--- CONTEXT ---
Testing Goal: ${params.goal}
Current Page Type: ${params.currentPage}
Visited Pages (order): ${params.visitedPages.join(' -> ')}

Recent History (most recent last):
${params.history}

Errors Encountered:
${params.errors.length > 0 ? params.errors.join('\n') : 'None'}

--- TASK ---
Decide what to do next. Choose ONE decision:
- continue: proceed with the next logical test step
- retry: repeat an attempt with a safer/more reliable strategy (wait/reload/navigate_back/alternative target)
- skip: skip the current page/branch and choose a different route
- wait_for_user: pause because user approval or manual action is required
- stop: stop only if goal is fully achieved or further progress is not possible without unsafe actions

--- SAFETY RULES ---
- If the next step can cause irreversible changes (payment, purchase, subscribe, delete, remove, logout, account changes, submit order, data loss), choose wait_for_user.
- If CAPTCHA / 2FA / email verification / manual verification is required, choose wait_for_user.
- Prefer deterministic steps (navigation/menu links, stable CTAs) over speculative steps.
- Avoid loops: if you see repeated states/pages without progress, choose skip and propose a loop-breaking nextTarget.

--- RELIABILITY RULES ---
- If errors suggest a transient issue (timeout, network, element not ready), choose retry and specify retryStrategy.
- If errors suggest a permanent blocker (broken page, 404, missing permissions), choose skip or stop and explain why.
- If the goal likely requires authentication and the user is not authenticated, route toward login before continuing the goal flow.

--- RESPONSE FORMAT (STRICT JSON ONLY, no markdown) ---
{
  "decision": "continue|stop|wait_for_user|retry|skip",
  "reason": "1-2 concise sentences. Mention key evidence from history/errors.",
  "confidence": 0.0-1.0,
  "progress": 0-100,
  "goalAchieved": true/false,
  "riskLevel": "low|medium|high",
  "blockingSignals": ["captcha|2fa|auth_required|rate_limit|modal_overlay|validation_errors|broken_page|none"],
  "retryStrategy": "wait|reload|navigate_back|choose_alternative_target|reduce_scope|null",
  "nextTarget": {
    "type": "page|element|flow",
    "description": "What to try next in plain English",
    "successCriteria": "What would confirm progress",
    "avoid": ["Optional list of things to avoid or not repeat"]
  }
}

Return only valid JSON.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIC ANALYSIS PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for understanding logical dependencies
 * ENHANCED: Now accepts richer context for better causal understanding
 */
export function buildLogicAnalysisPrompt(params: {
  pageType: PageType;
  elements: string; // JSON of elements
  domData: string; // DOM analysis
  goal?: string; // Testing goal
  historySummary?: string; // Recent actions/pages/errors
  pageDescription?: string; // From Vision analysis
  warnings?: string[]; // Warnings from Vision
  criticalElements?: string; // JSON of critical elements
  navButtonsSummary?: string; // CTA buttons summary
  formsSummary?: string; // Forms with required/disabled fields
  url?: string; // Current URL
  pageTitle?: string; // Page title
  hints?: string; // Test hints from plan
  errorSignals?: string; // Error summary from ErrorCollectorService
}): string {
  const goalSection = params.goal ? `\nTesting Goal: ${params.goal}` : '';
  const historySection = params.historySummary ? `\n\n--- HISTORY ---\n${params.historySummary}` : '';
  const pageDescSection = params.pageDescription ? `\n\nPage Description (from Vision):\n${params.pageDescription}` : '';
  const warningsSection = params.warnings && params.warnings.length > 0 ? `\n\nWarnings:\n${params.warnings.join('\n')}` : '';
  const criticalElSection = params.criticalElements ? `\n\nCritical Elements:\n${params.criticalElements}` : '';
  const navButtonsSection = params.navButtonsSummary ? `\n\nNavigation/CTA Buttons:\n${params.navButtonsSummary}` : '';
  const formsSection = params.formsSummary ? `\n\nForms Summary:\n${params.formsSummary}` : '';
  const urlSection = params.url ? `\nURL: ${params.url}` : '';
  const pageTitleSection = params.pageTitle ? `\nPage Title: ${params.pageTitle}` : '';
  const hintsSection = params.hints ? `\n\n--- TEST HINTS ---\n${params.hints}` : '';
  const errorsSection = params.errorSignals ? `\n\n--- ERROR SIGNALS ---\n${params.errorSignals}` : '';

  return `You are an expert QA engineer analyzing logical dependencies on a page.

--- CONTEXT ---
Page Type: ${params.pageType}${urlSection}${pageTitleSection}${goalSection}${pageDescSection}${warningsSection}${historySection}${hintsSection}${errorsSection}

Elements:
${params.elements}

DOM Data:
${params.domData}${criticalElSection}${navButtonsSection}${formsSection}

--- TASK ---
Identify logical dependencies and requirements. Consider the testing goal, page context, navigation flow, and any detected issues.

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
  ],
  "skipHints": [
    "OPTIONAL: Hints about when/how to skip this page (e.g., 'Click Skip button if goal is registration', 'This is onboarding, can skip if not testing onboarding flow')"
  ],
  "navigationActions": [
    "OPTIONAL: Suggested navigation actions (e.g., 'Click Continue to reach next step', 'Click Register to reach registration form')"
  ]
}

**SPECIAL GUIDANCE**:

**Onboarding/Welcome Pages**:
- If this is an onboarding/welcome/tutorial page AND the goal is NOT to test onboarding:
  - Add to skipHints: "Onboarding page detected. Click Skip/Next button to reach main app"
  - Add to navigationActions: "Click [Button Text] to skip onboarding"

**Payment Pages**:
- If this is a payment/checkout page with credit card fields:
  - Add to blockers: "Payment form detected - requires manual approval or test card data"
  - Add to skipHints: "Stop test before entering payment info. Request test payment data from user"

**Login/Registration Required**:
- If page shows "Login required" or blocking paywall:
  - Add to blockers: "Login/registration required to continue"
  - Add to navigationActions: "Navigate to login/register page" OR "Request credentials from user"

**Missing Critical Data**:
- If goal requires data not available on current page:
  - Add to navigationActions: "Navigate to [target page] to find required elements"
  - Add to skipHints: "Current page doesn't match goal. Continue navigation"

EXAMPLES:

Product Page:
- requiredBeforeMain: ["select size", "select color"]
- mainAction: "Add to Cart"
- validation: ["cart count increases", "success notification"]

Login Page:
- requiredBeforeMain: ["fill email", "fill password"]
- mainAction: "Login"
- validation: ["redirect to dashboard", "welcome message"]

Onboarding Page (goal is "test registration"):
- requiredBeforeMain: []
- mainAction: "Skip or Next"
- skipHints: ["Onboarding page detected. Goal is registration, so skip this step"]
- navigationActions: ["Click Skip button to reach main app", "Click Next to continue onboarding"]

Payment Page:
- requiredBeforeMain: ["fill billing address", "fill card number"]
- mainAction: "Submit Payment"
- blockers: ["Payment form detected - requires test card or manual approval"]
- skipHints: ["Stop automated test here. Request payment test data from user"]

Focus on LOGICAL dependencies, not just technical ones. Consider the testing GOAL and current page context to provide smart navigation advice.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// VISION ANALYSIS PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for vision analysis based on scope
 * ENHANCED: Now matches buildPageAnalysisPrompt structure with full validation
 * Uses AI to dynamically understand context without hardcoded checks
 */
export function buildVisionPrompt(scope: string, url: string): string {
  return `You are an expert QA engineer analyzing a web page screenshot.
- CONTEXT -
URL: ${url}
User's Testing Focus: "${scope}"

- TASK -
Analyze this screenshot and provide detailed information about interactive elements relevant to the user's testing focus.

CRITICAL: You MUST return a valid JSON object matching EXACTLY this structure. No markdown, no code blocks, no additional text outside JSON.

REQUIRED JSON STRUCTURE:
{
  "pageType": "string (REQUIRED)",
  "description": "string (REQUIRED)",
  "elements": [array (REQUIRED, can be empty [])],
  "suggestions": [array (REQUIRED, can be empty [])],
  "warnings": [array (REQUIRED, use empty array [] if none)],
  "modals": [array (REQUIRED, use empty array [] if none)],
  "layout": "string (REQUIRED, brief description of page layout)"
}

DETAILED FIELD SPECIFICATIONS:

1. **pageType** (REQUIRED, string, must be one of):
   "home" | "product" | "cart" | "checkout" | "login" | "register" | "search_results" | "category" | "profile" | "dashboard" | "settings" | "payment" | "error" | "unknown"
   Example: "login"

   **SPECIAL PAGE TYPES**:
   - Use "payment" if you see credit card fields, billing address, CVV, expiry date, or payment processor logos (Stripe, PayPal)
   - Use "unknown" with descriptive text if this is an onboarding/welcome/tutorial page

2. **description** (REQUIRED, string):
   Brief description of the page (2-3 sentences)
   Example: "Login page with email and password fields, and a 'Sign in' button"

3. **elements** (REQUIRED, array of objects, can be empty []):
   Each element object MUST have ALL these fields:
   {
     "type": "button" | "input" | "select" | "link" | "form" | "modal" | "other" (REQUIRED),
     "purpose": "string" (REQUIRED, e.g., "search", "add_to_cart", "login", "submit"),
     "text": "string" (REQUIRED, visible text on element, use empty string "" if no text, preserve original language),
     "location": "string" (REQUIRED, where on page, e.g., "top-left form", "center of page"),
     "required": true | false (REQUIRED, boolean, not string),
     "priority": "critical" | "high" | "medium" | "low" (REQUIRED, string),
     "isCTA": true | false (OPTIONAL, boolean, mark as true for Call-To-Action buttons like Skip, Next, Continue, Register, Login, Get Started, Sign Up, Start, Begin)
   }

   **IMPORTANT - Call-To-Action (CTA) Detection**:
   Mark "isCTA": true for buttons that are common navigation/flow CTAs:
   - Skip buttons (Skip, Skip for now, Пропустить)
   - Next/Continue buttons (Next, Continue, Далее, Продолжить)
   - Start/Begin buttons (Get Started, Start, Begin, Начать)
   - Registration buttons (Register, Sign Up, Регистрация)
   - Login buttons (Login, Sign In, Войти)
   - Complete/Finish buttons (Complete, Finish, Done, Завершить)

4. **suggestions** (REQUIRED, array of strings, can be empty []):
   Array of specific test case suggestions based on user's focus and visible elements
   Example: ["Test login with valid credentials", "Verify form validation with empty fields"]

5. **warnings** (REQUIRED, array of strings, use [] if none):
   Flag dangerous actions or blockers
   Example: ["Payment form detected - requires manual approval", "CAPTCHA present"]

   **CRITICAL WARNINGS TO DETECT**:
   - "Payment form detected" - if you see credit card inputs, billing fields, payment buttons
   - "CAPTCHA present" - if you see any CAPTCHA/reCAPTCHA
   - "Onboarding flow detected" - if this is a welcome/tutorial/getting-started page with Skip/Next buttons
   - "Paywall detected" - if content is blocked behind payment/subscription
   - "Login required" - if page shows "Please login to continue" or similar

6. **modals** (REQUIRED, array of objects, use [] if none):
   Each modal object MUST have ALL these fields:
   {
     "type": "cookie_banner" | "newsletter" | "popup" | "welcome" | "other" (REQUIRED),
     "description": "string" (REQUIRED),
     "hasCloseButton": true | false (REQUIRED, boolean, not string),
     "closeButtonText": "string" | null (REQUIRED, visible text on close button or null if not visible)
   }

7. **layout** (REQUIRED, string):
   Brief description of page layout and structure
   Example: "Single-column layout with header navigation, main content area, and footer"

VALIDATION RULES (MUST FOLLOW):
- ALL fields must be present in JSON (even if empty arrays)
- "pageType" must be exactly one of the allowed string values
- "elements" array items must have 6 required fields (type, purpose, text, location, required, priority) + optional "isCTA" field
- "modals" array items must have ALL 4 required fields (type, description, hasCloseButton, closeButtonText)
- Use boolean true/false (NOT strings "true"/"false")
- Use null (NOT string "null") for closeButtonText when not visible
- Preserve original UI language in "text" field (do not translate)
- Max ~20 elements in "elements" array
- Include ONLY visible interactive elements relevant to user's testing focus
- Do NOT invent elements - if unsure, omit them
- Mark "isCTA": true for navigation/flow buttons (Skip, Next, Continue, Register, Login, Get Started)

SCOPE-SPECIFIC FOCUS:
Based on user's testing focus "${scope}", intelligently identify relevant elements:

- For registration/signup pages: Focus on email/username, passwords, confirm password, terms/privacy checkboxes, social login
- For login/signin/auth pages: Focus on credentials, "Remember me", "Forgot password" links, social login options
- For forms: Focus on all input types, required vs optional fields, validation rules, submit/cancel buttons, file uploads, dropdowns
- For e-commerce: Focus on product selection, cart, checkout flows, payment forms
- For dashboards: Focus on navigation, data display, interactive widgets, filters
- For checkout/payment: Focus on payment forms, billing address, shipping options, order summary
- For navigation: Focus on menus, links, breadcrumbs, navigation buttons

ADDITIONAL GUIDELINES:
- Note required fields (asterisk, 'required' label, red border, validation hints)
- Pay attention to validation messages, error states, loading indicators
- Identify accessibility features (aria labels, alt text, keyboard navigation)
- Be intelligent: If user says "test checkout", focus on payment-related elements. If they say "verify navigation", focus on menus and links.

EXAMPLE COMPLETE VALID RESPONSE:
{
  "pageType": "login",
  "description": "Login page with email input, password input, and Sign In button. Also has 'Forgot password?' link.",
  "elements": [
    {
      "type": "input",
      "purpose": "email",
      "text": "",
      "location": "center form, top field",
      "required": true,
      "priority": "critical"
    },
    {
      "type": "input",
      "purpose": "password",
      "text": "",
      "location": "center form, below email",
      "required": true,
      "priority": "critical"
    },
    {
      "type": "button",
      "purpose": "login",
      "text": "Sign In",
      "location": "center form, below password",
      "required": true,
      "priority": "critical",
      "isCTA": true
    },
    {
      "type": "link",
      "purpose": "forgot_password",
      "text": "Forgot password?",
      "location": "below login button",
      "required": false,
      "priority": "low"
    }
  ],
  "suggestions": [
    "Test login with valid credentials",
    "Test form validation with empty fields",
    "Verify forgot password link functionality"
  ],
  "warnings": [],
  "modals": [],
  "layout": "Centered single-column layout with login form in the middle of the page"
}

Focus on elements relevant to the testing goal: "${scope}".`;
}
