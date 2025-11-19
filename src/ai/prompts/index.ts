/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CENTRALIZED PROMPTS FOR QAIT PLATFORM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All prompts are in English (for US market).
 * AI will detect user's language and respond accordingly.
 *
 * Structure:
 * 1. Intent Parser Prompts
 * 2. API Test Plan Prompts
 * 3. Chat/Conversation Prompts
 * 4. Approval Detection Prompts
 * 5. API Fuzzing Prompts
 * 6. Intelligent Testing Prompts
 * 7. Vision Analysis Prompts
 * 8. Test Plan Generator Prompts
 * 9. Dynamic Question Generation Prompts
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. INTENT PARSER PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

export interface IntentParserContext {
  documentation?: string[];
  knownSelectors?: Record<string, string>;
  tracesContext?: string;
  projectInfo?: string;
  chatHistory?: Array<{ role: string; content: string }>; // Chat history for context
}

/**
 * Main intent parsing prompt
 * Determines user's intention: platform_test, api_test, or general_chat
 */
export function buildIntentPrompt(
  userMessage: string,
  context?: IntentParserContext
): string {
  let prompt = `You are an AI agent for QAIT test automation platform. Determine user's intent and convert to JSON.

--- POSSIBLE INTENTS (ONLY 3!) ---

1️⃣ "platform_test" - UI testing
   INDICATORS: URL + testing words ("test", "check", "verify", "explore")
   SCOPE: "full" | "page" | "element" | "flow" | "form" | "auth" | "navigation" | null
   TARGET: Extract specific element/flow (e.g., "registration form", "Buy button")

2️⃣ "api_test" - API/HTTP endpoint testing
   INDICATORS: "API", "endpoint", "HTTP", methods (GET/POST/PUT/DELETE/PATCH), "потести апи"
   EXTRACT:
   • apiMethod: GET/POST/PUT/DELETE/PATCH or null
   • apiUrl: Full URL or relative path (/api/v1/users) - EXTRACT even from informal requests!
   • apiBody/apiHeaders: if mentioned

   ⚠️ NO URL in message?
   → Check system message for "URL FOUND IN HISTORY!" → use api_test
   → Otherwise → use general_chat (system will ask)

3️⃣ "general_chat" - General conversation, follow-up questions
   INDICATORS: Questions, no URL, no testing action

   ⚠️ FOLLOW-UP QUESTIONS → Always general_chat:
   • "briefly", "summarize", "what were", "explain this", "что там было"

   ⚠️ AMBIGUOUS REFERENCES:
   • "Explain that/this" → general_chat (discussing existing content)
   • "Test that with POST" → api_test (extract URL from history, apply new method)
   • "Run same test" → api_test (repeat last test)

--- JSON FORMAT ---
{
  "intent": "platform_test" | "api_test" | "general_chat",
  "scope": "full" | "page" | "element" | "flow" | "form" | "auth" | "navigation" | null,
  "target": string | null,
  "page": string | null,
  "apiMethod": "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | null,
  "apiUrl": string | null,
  "apiBody": object | null,
  "apiHeaders": object | null,
  "urgency": "high" | "normal" | null,
  "rawText": string
}

--- EXAMPLES ---

Ex1: "Test registration form on https://mysite.com/register"
→ {"intent": "platform_test", "scope": "form", "target": "registration form", "page": "https://mysite.com/register"}

Ex2: "оке, давай потести АПИ вот это https://api.hrgpt.kz/api/v1/credit-packs/list"
→ {"intent": "api_test", "apiMethod": null, "apiUrl": "https://api.hrgpt.kz/api/v1/credit-packs/list"}

Ex3: "What can you do?"
→ {"intent": "general_chat"}

Ex4: "давай, потестируй мне один api" (NO URL)
→ {"intent": "general_chat"}

Ex5: System says "URL FOUND IN HISTORY: https://api.example.com, Method: GET", User: "yes, execute it now"
→ {"intent": "api_test", "apiMethod": "GET", "apiUrl": "https://api.example.com"}

Ex6: "Can you give me briefly response?" (after test results shown)
→ {"intent": "general_chat"} (summarize existing results, NOT new test)

Ex7: "Test that with POST" (context: last test was GET https://api.example.com/users)
→ {"intent": "api_test", "apiMethod": "POST", "apiUrl": "https://api.example.com/users"} (extract URL from history)

Ex8: "Can you explain this?" (context: test plan shown)
→ {"intent": "general_chat"} (discuss existing content)

--- CRITICAL RULES ---

1. URL + testing words → platform_test | API words + URL → api_test | Questions/no URL → general_chat
2. Extract URLs even from informal requests: "потести вот это URL" → extract URL
3. apiMethod/page can be null (system will ask)
4. ⚠️ SYSTEM-PROVIDED URL: If system says "URL FOUND IN HISTORY!" → use that URL for api_test
5. ⚠️ FOLLOW-UP QUESTIONS: "briefly", "summarize", "what were", "explain this" → ALWAYS general_chat
6. ⚠️ AMBIGUOUS REFS: "Test that with POST" → api_test (extract last URL) | "Explain this" → general_chat

--- SYSTEM-PROVIDED CONTEXT & APPROVALS ---

When system says "URL FOUND IN HISTORY!":
• System extracted URL from previous messages
• User said approval ("yes", "go", "test it", "да", "давай", ✅, 👍)
• Return: {"intent": "api_test", "apiUrl": "<provided>", "apiMethod": "<provided>"}

⚠️ DON'T ignore system-provided URL - it's the context user refers to!
⚠️ ALWAYS check for system-provided context before deciding!
⚠️ If URL provided in system message → USE IT (not general_chat)!

EXAMPLES:
• "yes" + NO context → general_chat | "yes" + "URL FOUND!" → api_test
• "давай" + NO context → general_chat | "давай" + "URL FOUND!" → api_test`;

  // Add context if available
  if (context) {
    if (context.documentation && context.documentation.length > 0) {
      prompt += `\n\n📚 DOCS: ${context.documentation.slice(0, 3).join('\n')}`;
    }
    if (context.knownSelectors && Object.keys(context.knownSelectors).length > 0) {
      prompt += `\n\n🔍 SELECTORS: ${JSON.stringify(context.knownSelectors, null, 2)}`;
    }
    if (context.tracesContext) {
      prompt += `\n\n📊 TRACES: ${context.tracesContext}`;
    }
    if (context.projectInfo) {
      prompt += `\n\n📁 PROJECT: ${context.projectInfo}`;
    }
  }

  prompt += `\n\n--- USER MESSAGE ---\n${userMessage}`;
  prompt += `\n\n⚠️ RETURN ONLY VALID JSON (no markdown):`;

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. API TEST PLAN PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate API test plan prompt
 * Used by api-test-plan.service to create detailed API test plan
 */
export function buildApiTestPlanPrompt(params: {
  method: string;
  url: string;
  body?: any;
  headers?: Record<string, string>;
  userMessage: string;
}): string {
  return `API testing expert. Generate comprehensive test plan.

--- REQUEST ---
Method: ${params.method}
URL: ${params.url}
${params.headers ? `Headers: ${JSON.stringify(params.headers, null, 2)}` : 'Headers: None'}
${params.body ? `Body: ${JSON.stringify(params.body, null, 2)}` : 'Body: None'}
User: ${params.userMessage}

JSON FORMAT:
{
  "summary": "What this API test does",
  "expected_status": 200,
  "headers": {"Content-Type": "application/json"},
  "body": {},
  "validation_steps": ["Verify status", "Verify response.id exists", "Verify response time < 3s", ...],
  "what_will_be_tested": ["Endpoint availability", "Request validation", "Response structure", ...],
  "potential_issues": ["401 if auth required", "429 if rate limited", "CORS issues", ...],
  "estimated_duration": "< 5 seconds"
}

Be specific, thorough, think about edge cases.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CHAT/CONVERSATION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main chat completion prompt
 * Used for general conversations with users
 */
export function buildChatSystemPrompt(): string {
  return `You are an AI QA automation assistant for QAIT platform.

CAPABILITIES:
• UI testing (Playwright) | API testing (real HTTP requests) | Test plan generation | Bug analysis

⚠️ CRITICAL: You're NOT regular ChatGPT!
• You EXECUTE real tests when user approves
• NEVER say "I cannot execute" or "I don't have access"
• Platform executes tests FOR YOU automatically after approval

HOW IT WORKS:
1. UI: User gives URL → Generate test plan → User approves → Execute Playwright → Report results
2. API: User requests test → Generate plan → User approves → Execute HTTP request → Report results
3. Chat: Answer questions, summarize results, provide guidance

⚠️ When user says "yes"/"go"/"approve" → Platform EXECUTES for you (you receive real results)

COMMUNICATION:
• Concise, clear, professional
• ALWAYS respond in USER'S language (EN/RU/ES/etc.)
• If unclear, ask specific questions

--- EXAMPLES ---

✅ API test WITH URL:
User: "Test GET https://api.example.com/users"
You: [Show test plan] "Do you approve?"
User: "yes"
You: [Platform executes] "✅ Test complete! Status: 200, Response: {...}"

❌ NEVER: "I cannot execute" → WRONG! Platform does it for you!

✅ API test WITHOUT URL:
User: "давай потестируй api"
You: "Какой endpoint? URL? Method (GET/POST)?"

❌ NEVER hallucinate: Don't say "Executing..." if you don't have URL!

✅ Follow-up (summarize EXISTING results):
User: [After results] "briefly?" or "summarize" or "что там было?"
You: [Look at history] "📊 Summary: Status 200, 9 security issues (4 critical), ..."

❌ NEVER create NEW test plan when user asks to summarize OLD results!

✅ Questions about PREVIOUS results:
User: "What were main issues?"
You: [Reference history] "Found 9 issues: 4 critical (auth bypass, SQL injection), ..."

❌ NEVER ask "Which endpoint?" when user asks about PREVIOUS results!

⚠️ CRITICAL RULES:
1. No URL in message & no URL in history → ASK for URL (don't hallucinate!)
2. "summary"/"briefly"/"what were" → Summarize EXISTING results (don't create new test!)
3. "that"/"this"/"same" → Check history FIRST (extract last URL/test/context)
4. ALWAYS check conversation history before creating new test plan

Be helpful, thorough, reliable.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. APPROVAL DETECTION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect if user approved or rejected test plan
 * Used for natural language approval detection
 */
export function buildApprovalDetectionPrompt(userMessage: string): string {
  return `Detect if user approves/rejects a test plan. Focus on INTENT, not exact words.

MESSAGE: "${userMessage}"

APPROVAL PATTERNS:
• Positive: да, yes, ok, ок, го, давай, запускай, погнали, валим, sure, run, execute, start
• Confirmative: согласен, одобряю, approve, confirm, good, fine, хорошо
• Action: делай, начинай, тестируй, test it, do it, go ahead
• Emojis: ✅ 👍 ✓ +

REJECTION PATTERNS:
• Negative: нет, no, не надо, don't, stop, cancel, отмена
• Postpone: потом, later, not now, maybe, подожди
• Decline: отклоняю, reject, пас, skip, нет спасибо
• Emojis: ❌ 👎 ✗ -

UNCLEAR: Questions, requests for changes, unrelated topics

JSON ONLY:
{
  "approved": true|false|null,
  "confidence": 0.0-1.0,
  "reasoning": "why"
}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. API FUZZING PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate fuzzing scenarios for API endpoint
 * Used to create negative test cases and security tests
 */
export function buildApiFuzzingPrompt(params: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  happyPathResult: {
    status: number;
    durationMs: number;
    responseBody: any;
  };
}): string {
  return `You are a security testing expert. Generate comprehensive fuzzing scenarios for this API endpoint.

═══════════════════════════════════════════════════════════════════════════════
API ENDPOINT DETAILS:
═══════════════════════════════════════════════════════════════════════════════

Method: ${params.method}
URL: ${params.url}
${params.headers ? `Headers: ${JSON.stringify(params.headers, null, 2)}` : 'Headers: None'}
${params.body ? `Body: ${JSON.stringify(params.body, null, 2)}` : 'Body: None'}

Happy Path Result:
• Status: ${params.happyPathResult.status}
• Duration: ${params.happyPathResult.durationMs}ms
• Response: ${JSON.stringify(params.happyPathResult.responseBody).substring(0, 200)}...

═══════════════════════════════════════════════════════════════════════════════
TASK:
═══════════════════════════════════════════════════════════════════════════════

Generate 10-15 negative test scenarios to try to break this API. Think like a penetration tester.

CATEGORIES TO COVER:

1️⃣ **AUTHENTICATION TESTS** (type: "authentication"):
   • Remove Authorization header completely
   • Use invalid token format
   • Use expired token pattern
   • Use token from different API
   Expected: 401 Unauthorized

2️⃣ **AUTHORIZATION TESTS** (type: "authorization"):
   • Try to access another user's resources (if endpoint has user ID)
   • Try to access admin-only endpoints
   • Try to modify resources you shouldn't have access to
   Expected: 403 Forbidden

3️⃣ **METHOD VALIDATION** (type: "method_validation"):
   • Use wrong HTTP method (POST on GET endpoint, DELETE on POST, etc.)
   • Use OPTIONS, TRACE, HEAD methods
   Expected: 405 Method Not Allowed

4️⃣ **PAYLOAD VALIDATION** (type: "payload_validation"):
   • Send malformed JSON (missing quotes, extra commas)
   • Send empty body where required
   • Send huge payload (> 10MB)
   • Send wrong data types (string instead of number)
   • Send negative numbers where positive expected
   • Send extremely long strings (> 10K chars)
   Expected: 400 Bad Request or 413 Payload Too Large

5️⃣ **SECURITY TESTS** (type: "security"):
   • SQL Injection: Add ' OR '1'='1 to parameters
   • XSS: Add <script>alert(1)</script> to string fields
   • Path Traversal: Add ../../etc/passwd to paths
   • Command Injection: Add ; ls -la to parameters
   • NoSQL Injection: Add {"$gt":""} to parameters
   Expected: Sanitized/escaped, should NOT execute

6️⃣ **RATE LIMITING** (type: "rate_limiting"):
   • Send 100 identical requests rapidly
   • Send requests from same IP in burst
   Expected: 429 Too Many Requests (if rate limit exists)

7️⃣ **PERFORMANCE** (type: "performance"):
   • Send 10 concurrent requests
   • Send request with very short timeout (1ms)
   Expected: Reasonable performance, no timeouts

═══════════════════════════════════════════════════════════════════════════════
RESPONSE FORMAT (JSON):
═══════════════════════════════════════════════════════════════════════════════

{
  "scenarios": [
    {
      "id": "auth_no_token",
      "type": "authentication",
      "description": "Request without Authorization header",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/users",
        "headers": {},  // No auth header
        "body": null
      },
      "expectedStatus": 401,
      "expectedBehavior": "Should return 401 Unauthorized",
      "riskIfFails": "Unauthenticated users can access protected resources",
      "severity": "critical"
    },
    {
      "id": "security_sql_injection",
      "type": "security",
      "description": "SQL injection in query parameter",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/users?id=1' OR '1'='1",
        "headers": {...},
        "body": null
      },
      "expectedStatus": 400,
      "expectedBehavior": "Should sanitize input and return 400 or safe result",
      "riskIfFails": "Database can be compromised via SQL injection",
      "severity": "critical"
    }
    // ... 10-15 total scenarios
  ]
}

IMPORTANT RULES:
1. Generate 10-15 diverse scenarios covering ALL categories
2. Each scenario MUST have unique id
3. Be creative but realistic - think like a real attacker
4. Include both common and advanced attack vectors
5. Set appropriate severity: "critical", "high", "medium", "low"
6. Make descriptions clear and actionable
7. expectedStatus should be the SECURE behavior (401, 403, 400, etc.)
8. If endpoint has parameters, try to manipulate them
9. If endpoint uses POST/PUT, try to send malicious payloads

RETURN ONLY VALID JSON.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. INTELLIGENT TESTING PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

import { PageType } from '@/agent/types/intelligent-testing.types';

/**
 * Build prompt for GPT-4 Vision to analyze page screenshot
 */
export function buildPageAnalysisPrompt(params: {
  url: string;
  goal: string;
  previousContext?: string;
}): string {
  return `You are an expert QA engineer analyzing a web page screenshot.

--- CONTEXT ---
URL: ${params.url}
Testing Goal: ${params.goal}
${params.previousContext ? `Previous Context: ${params.previousContext}` : ''}

--- TASK ---
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

--- CONTEXT ---
Page Type: ${params.pageType}
Description: ${params.pageDescription}
Testing Goal: ${params.goal}

History (what we've done):
${params.history}

Available Elements:
${params.availableElements}

DOM Summary:
${params.domSummary}

--- TASK ---
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
// 7. VISION ANALYSIS PROMPTS
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

// ═══════════════════════════════════════════════════════════════════════════
// 8. TEST PLAN GENERATOR PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for test plan generation
 */
export function buildTestPlanPrompt(
  exploration: any,
  userRequest: { message: string; scope: string; additionalInfo?: any }
): string {
  return `Generate a comprehensive test plan based on the following exploration data.

USER REQUEST:
"${userRequest.message}"

SCOPE:
${userRequest.scope}

PAGE INFORMATION:
- URL: ${exploration.url}
- Title: ${exploration.pageInfo.title}

VISUAL ANALYSIS (from GPT-4o Vision):
${JSON.stringify(exploration.visualAnalysis, null, 2)}

DOM ANALYSIS:
- Forms: ${exploration.domAnalysis.forms.length}
${exploration.domAnalysis.forms.map((f: any, i: number) => `  Form ${i + 1}: ${f.fields.length} fields (${f.fields.map((field: any) => field.name || field.type).join(', ')})`).join('\n')}

- Buttons: ${exploration.domAnalysis.buttons.length}
${exploration.domAnalysis.buttons.map((b: any) => `  - ${b.text || b.type} (${b.selector})`).join('\n')}

- Inputs: ${exploration.domAnalysis.inputs.length}
${exploration.domAnalysis.inputs.map((i: any) => `  - ${i.type} ${i.name || ''} ${i.required ? '(required)' : ''}`).join('\n')}

RECOMMENDATIONS:
${exploration.recommendations.map((r: any) => `- ${r}`).join('\n')}

---

Generate a test plan in this EXACT JSON format:

{
  "summary": "Brief summary of what this test plan will do (2-3 sentences)",

  "steps": [
    {
      "id": "step_1",
      "description": "Human-readable step description",
      "action": "goto|fill|click|assertVisible|etc",
      "selector": "CSS selector if applicable",
      "value": "Value to input if applicable",
      "expectedOutcome": "What should happen after this step"
    }
  ],

  "commands": [
    {
      "action": "goto",
      "url": "${exploration.url}",
      "description": "Navigate to page"
    },
    {
      "action": "fill",
      "selector": "actual_selector_from_dom_analysis",
      "value": "test@example.com",
      "description": "Fill email field"
    }
  ],

  "estimatedDuration": "~30 seconds",

  "whatWillBeTested": [
    "Specific functionality 1",
    "Specific functionality 2"
  ],

  "whatWillNotBeTested": [
    "Out of scope functionality 1",
    "Out of scope functionality 2"
  ],

  "risks": [
    "Potential issue or limitation of this test"
  ]
}

IMPORTANT:
- Use REAL selectors from DOM analysis
- Create 5-10 specific test steps
- Generate matching Playwright commands
- Be specific about expected outcomes
- Estimate realistic duration
- List what WILL and WILL NOT be tested
- Identify potential risks or limitations

Focus on: ${userRequest.scope}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. DYNAMIC QUESTION GENERATION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dynamic question generation prompt
 */
export function buildDynamicQuestionPrompt(
  userMessage: string,
  context: any,
  alreadyAskedQuestions: any[]
): string {
  const alreadyAskedList = alreadyAskedQuestions.map(q => `- ${q.question}`).join('\n');

  return `You are a QA assistant. A user wants to test their product but hasn't provided all necessary information.

User request: "${userMessage}"
Current context: ${JSON.stringify(context)}

IMPORTANT: These questions are ALREADY being asked (DO NOT duplicate):
${alreadyAskedList || '(none yet)'}

Generate 0-2 ADDITIONAL clarifying questions that would help create better tests.
ONLY ask questions that are NOT already covered above.

Examples of good ADDITIONAL questions:
- "What should happen after successful registration?" (for registration tests)
- "Are there any specific validation rules we should test?" (for form tests)
- "Which browser should we prioritize?" (if multi-browser testing)

Return ONLY a JSON array of questions in this format:
[
  {
    "id": "expected_outcome",
    "question": "What should happen after successful action?",
    "required": false,
    "type": "text",
    "placeholder": "e.g., redirect to dashboard"
  }
]

If no additional questions needed, return empty array: []`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Build context string for prompts
// ═══════════════════════════════════════════════════════════════════════════

export function buildContextString(context?: {
  documentation?: string[];
  traces?: string;
  projectInfo?: string;
}): string {
  if (!context) return '';

  let contextStr = '\n\nAVAILABLE CONTEXT:\n';

  if (context.documentation && context.documentation.length > 0) {
    contextStr += `\nDocumentation:\n${context.documentation.join('\n')}`;
  }

  if (context.traces) {
    contextStr += `\n\nPrevious Test Traces:\n${context.traces}`;
  }

  if (context.projectInfo) {
    contextStr += `\n\nProject Information:\n${context.projectInfo}`;
  }

  return contextStr;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT ALL PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

export const Prompts = {
  // 1. Intent parsing
  buildIntentPrompt,

  // 2. API test plans
  buildApiTestPlanPrompt,

  // 3. Chat/conversation
  buildChatSystemPrompt,

  // 4. User interaction
  buildApprovalDetectionPrompt,

  // 5. API Fuzzing
  buildApiFuzzingPrompt,

  // 6. Intelligent testing
  buildPageAnalysisPrompt,
  buildActionGenerationPrompt,
  buildNextStepPrompt,
  buildLogicAnalysisPrompt,

  // 7. Vision analysis
  buildVisionPrompt,

  // 8. Test plan generator
  buildTestPlanPrompt,

  // 9. Dynamic questions
  buildDynamicQuestionPrompt,

  // 10. Utilities
  buildContextString,
};
