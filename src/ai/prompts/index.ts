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
 * 2. Test Plan Generation Prompts (UI)
 * 3. API Test Plan Prompts
 * 4. Chat/Conversation Prompts
 * 5. Approval Detection Prompts
 * 6. Question Generation Prompts
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. INTENT PARSER PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

export interface IntentParserContext {
  documentation?: string[];
  knownSelectors?: Record<string, string>;
  tracesContext?: string;
  projectInfo?: string;
}

/**
 * Main intent parsing prompt
 * Determines user's intention: platform_test, api_test, or general_chat
 */
export function buildIntentPrompt(
  userMessage: string,
  context?: IntentParserContext
): string {
  let prompt = `You are an AI agent for QAIT test automation platform. Determine the user's intent and convert it to JSON.

═══════════════════════════════════════════════════════════════════════════════
POSSIBLE INTENTS (ONLY 3!):
═══════════════════════════════════════════════════════════════════════════════

1️⃣ "platform_test" - UI testing of web platform/website/application
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INDICATORS:
   • Has website URL (http:// or https://)
   • Words: "test", "check", "verify", "explore", "analyze", "validate" and other words related to testing and automation.
   • Mentions: "platform", "website", "page", "form", "element", "button" and other keywords related to web testing.

   MUST DETERMINE SCOPE (what exactly to test):
   • "full" - entire platform/website (if "whole", "entire", "complete")
   • "page" - specific page (if specific page URL provided)
   • "element" - specific element (if "button", "input", "field")
   • "flow" - sequence of actions (if "flow", "process", "from A to B")
   • "form" - form testing (if "form")
   • "auth" - authentication process (if "login", "sign in", "authentication")
   • "navigation" - site navigation (if "navigation", "menu")
   • null - if unclear from message (will ask user)

   EXTRACT TARGET (what specifically):
   • If "registration form" → target: "registration form"
   • If "Buy button" → target: "Buy button"
   • If "checkout process" → target: "checkout"
   • If not specified → target: null

2️⃣ "api_test" - API/HTTP endpoint testing
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INDICATORS:
   • Mentions: "API", "endpoint", "HTTP", "request"
   • HTTP methods: GET, POST, PUT, DELETE, PATCH
   • Words: "test API", "check endpoint", "make request"
   • URL looks like API (contains /api/, /v1/, etc.)

   EXTRACT:
   • apiMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
   • apiUrl: full URL or path
   • apiBody: request body (if mentions JSON, data)
   • apiHeaders: headers (if mentioned)

3️⃣ "general_chat" - General conversation (NO testing)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INDICATORS:
   • Questions: "what can you do?", "how does it work?", "tell me about..."
   • No URL present
   • No mention of testing/checking
   • General conversation

═══════════════════════════════════════════════════════════════════════════════
RESPONSE FORMAT (STRICT JSON):
═══════════════════════════════════════════════════════════════════════════════

{
  "intent": "platform_test" | "api_test" | "general_chat",

  // For platform_test:
  "scope": "full" | "page" | "element" | "flow" | "form" | "auth" | "navigation" | null,
  "target": string | null,
  "page": string | null,  // URL if present

  // For api_test:
  "apiMethod": "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | null,
  "apiUrl": string | null,
  "apiBody": object | null,
  "apiHeaders": object | null,

  // Common:
  "rawText": string  // original user message
}

═══════════════════════════════════════════════════════════════════════════════
EXAMPLES:
═══════════════════════════════════════════════════════════════════════════════

📝 Example 1: UI form test
Input: "Test the registration form on https://mysite.com/register"
Output:
{
  "intent": "platform_test",
  "scope": "form",
  "target": "registration form",
  "page": "https://mysite.com/register",
  "apiMethod": null,
  "apiUrl": null,
  "apiBody": null,
  "apiHeaders": null,
  "rawText": "Test the registration form on https://mysite.com/register"
}

📝 Example 2: Full platform test
Input: "Explore and test the entire platform https://shop.com"
Output:
{
  "intent": "platform_test",
  "scope": "full",
  "target": null,
  "page": "https://shop.com",
  "apiMethod": null,
  "apiUrl": null,
  "apiBody": null,
  "apiHeaders": null,
  "rawText": "Explore and test the entire platform https://shop.com"
}

📝 Example 3: API GET test
Input: "Check that GET request to https://api.example.com/users returns 200"
Output:
{
  "intent": "api_test",
  "scope": null,
  "target": null,
  "page": null,
  "apiMethod": "GET",
  "apiUrl": "https://api.example.com/users",
  "apiBody": null,
  "apiHeaders": null,
  "rawText": "Check that GET request to https://api.example.com/users returns 200"
}

📝 Example 4: General chat
Input: "What can you do?"
Output:
{
  "intent": "general_chat",
  "scope": null,
  "target": null,
  "page": null,
  "apiMethod": null,
  "apiUrl": null,
  "apiBody": null,
  "apiHeaders": null,
  "rawText": "What can you do?"
}

═══════════════════════════════════════════════════════════════════════════════
IMPORTANT RULES:
═══════════════════════════════════════════════════════════════════════════════

1. If URL + testing words → "platform_test"
2. If API/HTTP/endpoint → "api_test"
3. If just questions/chat → "general_chat"
4. Always extract scope for platform_test
5. Always extract apiMethod and apiUrl for api_test
6. Preserve rawText - original message

═══════════════════════════════════════════════════════════════════════════════`;

  // Add context if available
  if (context) {
    if (context.documentation && context.documentation.length > 0) {
      prompt += `\n\n📚 AVAILABLE DOCUMENTATION:\n${context.documentation.slice(0, 3).join('\n')}`;
    }

    if (context.knownSelectors && Object.keys(context.knownSelectors).length > 0) {
      prompt += `\n\n🔍 KNOWN SELECTORS:\n${JSON.stringify(context.knownSelectors, null, 2)}`;
    }

    if (context.tracesContext) {
      prompt += `\n\n📊 CONTEXT FROM TRACES:\n${context.tracesContext}`;
    }

    if (context.projectInfo) {
      prompt += `\n\n📁 PROJECT INFO:\n${context.projectInfo}`;
    }
  }

  prompt += `\n\n═══════════════════════════════════════════════════════════════════════════════`;
  prompt += `\n\n📝 USER MESSAGE:\n${userMessage}`;
  prompt += `\n\n═══════════════════════════════════════════════════════════════════════════════`;
  prompt += `\n\n⚠️ RETURN ONLY VALID JSON (no comments, no markdown):`;

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. UI TEST PLAN GENERATION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate UI test plan prompt
 * Used by autonomous-explorer to create comprehensive test plan
 */
export function buildUiTestPlanPrompt(params: {
  url: string;
  scope: string;
  target?: string;
  screenshot?: string;
  domAnalysis?: any;
  userMessage: string;
}): string {
  return `You are a QA automation expert. Generate a comprehensive UI test plan based on the exploration data.

TARGET INFORMATION:
═══════════════════════════════════════════════════════════════════════════════
URL: ${params.url}
Scope: ${params.scope}
${params.target ? `Target: ${params.target}` : ''}
User Request: ${params.userMessage}

${params.domAnalysis ? `DOM Analysis:\n${JSON.stringify(params.domAnalysis, null, 2)}` : ''}
═══════════════════════════════════════════════════════════════════════════════

TASK:
Generate a detailed test plan that covers all important aspects of testing.

RESPONSE FORMAT (JSON):
{
  "summary": "Brief description of what will be tested",
  "steps": [
    "Step 1: Navigate to URL",
    "Step 2: Verify page loaded",
    "Step 3: ...",
    // Include 5-10 detailed steps
  ],
  "commands": [
    {
      "action": "goto",
      "url": "${params.url}",
      "description": "Navigate to target page"
    },
    // Playwright commands for each test step
  ],
  "estimated_duration": "~3-5 minutes",
  "what_will_be_tested": [
    "Page accessibility",
    "Form validation",
    "Button functionality",
    // List 5-7 specific aspects
  ],
  "what_will_not_be_tested": [
    "Email verification process",
    "Payment processing",
    // Things out of scope
  ],
  "risks": [
    "Captcha might block automation",
    "Dynamic content may load slowly",
    // Potential issues
  ]
}

Be thorough, professional, and specific. Think like a senior QA engineer.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. API TEST PLAN PROMPTS
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
  return `You are an API testing expert. Generate a detailed test plan for this API request.

API REQUEST DETAILS:
═══════════════════════════════════════════════════════════════════════════════
Method: ${params.method}
URL: ${params.url}
${params.headers ? `Headers: ${JSON.stringify(params.headers, null, 2)}` : 'Headers: None specified'}
${params.body ? `Body: ${JSON.stringify(params.body, null, 2)}` : 'Body: None'}

User Request: ${params.userMessage}
═══════════════════════════════════════════════════════════════════════════════

TASK:
Generate a comprehensive API test plan with validation steps.

RESPONSE FORMAT (JSON):
{
  "summary": "Brief description of what this API test does",
  "expected_status": number,  // Expected HTTP status code (200, 201, 400, etc.)
  "headers": {
    // Recommended headers (Content-Type, Authorization, etc.)
    "Content-Type": "application/json"
  },
  "body": {
    // Request body if needed (validated/improved version)
  },
  "validation_steps": [
    "Verify response status code equals expected value",
    "Verify response contains 'id' field",
    "Verify response.email matches request",
    "Verify response time is under 3 seconds",
    // 5-8 specific validation checks
  ],
  "what_will_be_tested": [
    "API endpoint availability",
    "Request body validation",
    "Response data structure",
    "Error handling",
    // 5-7 aspects being tested
  ],
  "potential_issues": [
    "Authentication might be required (401)",
    "Rate limiting could block request (429)",
    "CORS might prevent browser requests",
    // Possible problems
  ],
  "estimated_duration": "< 5 seconds"
}

Be specific, thorough, and think about edge cases.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CHAT/CONVERSATION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main chat completion prompt
 * Used for general conversations with users
 */
export function buildChatSystemPrompt(): string {
  return `You are an AI-powered QA automation assistant for the QAIT platform.

YOUR CAPABILITIES:
• Autonomous testing of web platforms (UI testing)
• API endpoint testing
• Test plan generation and execution
• Bug analysis and reporting

HOW PLATFORM WORKS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. UI TESTING:
   User provides a URL → You explore the platform autonomously
   → Generate a detailed test plan → User approves
   → Execute tests with Playwright → Analyze results
   → Report bugs and issues

2. API TESTING:
   User requests API test → You analyze the endpoint
   → Generate test plan with validations → User approves
   → Execute HTTP request → Validate response
   → Report results

3. TEST PLANS:
   IMPORTANT: Always show test plan to user BEFORE execution
   → User must approve the plan
   → This ensures they understand what will be tested

COMMUNICATION STYLE:
• Be concise, clear, and professional
• Explain what you're doing in simple terms
• If something is unclear, ask specific questions
• When showing test plans, be detailed but organized

IMPORTANT: Always respond in the SAME language the user is using.
If they write in English - respond in English.
If they write in Russian - respond in Russian.
If they write in Spanish - respond in Spanish.
This is critical for user experience.

Be helpful, thorough, and reliable.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. APPROVAL DETECTION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect if user approved or rejected test plan
 * Used for natural language approval detection
 */
export function buildApprovalDetectionPrompt(userMessage: string): string {
  return `Analyze this user message and determine if they are approving or rejecting a test plan.

USER MESSAGE: "${userMessage}"

TASK:
Determine if the user is:
1. APPROVING (agreeing, accepting, confirming)
2. REJECTING (declining, canceling, refusing)
3. UNCLEAR (ambiguous, needs clarification)

APPROVAL INDICATORS (any language):
• English: "yes", "approve", "ok", "sure", "go ahead", "proceed", "do it", "run it"
• Russian: "да", "одобряю", "давай", "запускай", "хорошо", "согласен"
• Spanish: "sí", "apruebo", "adelante", "está bien"
• General: ✓, ✅, 👍, +1, positive emojis

REJECTION INDICATORS (any language):
• English: "no", "reject", "cancel", "don't", "stop", "not now"
• Russian: "нет", "отклоняю", "отмена", "не надо", "стоп"
• Spanish: "no", "rechazo", "cancela", "detente"
• General: ✗, ❌, 👎, -1, negative emojis

RESPONSE FORMAT (JSON):
{
  "approved": true | false | null,  // null if unclear
  "confidence": number,  // 0-1, how confident you are
  "reasoning": "Brief explanation of your decision"
}

Examples:
"yes, run the test" → {"approved": true, "confidence": 1.0, "reasoning": "Clear approval"}
"да, давай" → {"approved": true, "confidence": 1.0, "reasoning": "Russian approval"}
"no thanks" → {"approved": false, "confidence": 1.0, "reasoning": "Clear rejection"}
"maybe later" → {"approved": null, "confidence": 0.3, "reasoning": "Ambiguous response"}

RETURN ONLY JSON:`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. QUESTION GENERATION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate clarifying questions
 * Used when we need more information from user
 */
export function buildQuestionGenerationPrompt(params: {
  userMessage: string;
  intent: string;
  missingInfo: string[];
}): string {
  return `Generate clarifying questions to gather missing information for test setup.

USER REQUEST: ${params.userMessage}
INTENT: ${params.intent}
MISSING INFORMATION: ${params.missingInfo.join(', ')}

TASK:
Generate 1-3 specific questions to gather the missing information.

GUIDELINES:
• Be specific and clear
• Ask one thing at a time
• Provide examples or options when helpful
• Keep questions concise

RESPONSE FORMAT (JSON):
{
  "questions": [
    {
      "id": "url",
      "question": "What is the URL of your platform?",
      "required": true,
      "type": "url",
      "example": "https://example.com"
    }
  ]
}

RETURN ONLY JSON:`;
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
  // Intent parsing
  buildIntentPrompt,

  // Test plan generation
  buildUiTestPlanPrompt,
  buildApiTestPlanPrompt,

  // Chat/conversation
  buildChatSystemPrompt,

  // User interaction
  buildApprovalDetectionPrompt,
  buildQuestionGenerationPrompt,

  // Utilities
  buildContextString,
};
