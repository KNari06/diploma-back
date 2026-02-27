/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST PLAN PROMPTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prompts for:
 * - API test plan generation
 * - UI test plan generation
 * - API fuzzing scenarios
 * - Dynamic question generation
 * - URL context analysis
 */

// ═══════════════════════════════════════════════════════════════════════════
// API TEST PLAN PROMPTS
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
// API FUZZING PROMPTS
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

1. **AUTHENTICATION TESTS** (type: "authentication"):
   • Remove Authorization header completely
   • Use invalid token format
   • Use expired token pattern
   • Use token from different API
   Expected: 401 Unauthorized

2. **AUTHORIZATION TESTS** (type: "authorization"):
   • Try to access another user's resources (if endpoint has user ID)
   • Try to access admin-only endpoints
   • Try to modify resources you shouldn't have access to
   Expected: 403 Forbidden

3. **METHOD VALIDATION** (type: "method_validation"):
   • Use wrong HTTP method (POST on GET endpoint, DELETE on POST, etc.)
   • Use OPTIONS, TRACE, HEAD methods
   Expected: 405 Method Not Allowed

4. **PAYLOAD VALIDATION** (type: "payload_validation"):
   • Send malformed JSON (missing quotes, extra commas)
   • Send empty body where required → Expected: 400 Bad Request
   • Send huge payload (> 10MB) → Expected: 413 Payload Too Large
   • Send wrong data types (string instead of number) → Expected: 400 Bad Request
   • Send negative numbers where positive expected → Expected: 400 Bad Request
   • Send extremely long strings (> 10K chars) → Expected: 400 Bad Request (or 413 if size limit exceeded)

5. **SECURITY TESTS** (type: "security"):
   • SQL Injection: Add ' OR '1'='1 to parameters
   • XSS: Add <script>alert(1)</script> to string fields
   • Path Traversal: Add ../../etc/passwd to paths
   • Command Injection: Add ; ls -la to parameters
   • NoSQL Injection: Add {"$gt":""} to parameters
   Expected: Sanitized/escaped, should NOT execute

6. **RATE LIMITING** (type: "rate_limiting"):
   • Send 100 identical requests rapidly
   • Send requests from same IP in burst
   Expected: 429 Too Many Requests (if rate limit exists)

7. **PERFORMANCE** (type: "performance"):
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
      "expectedBehavior": "Should sanitize input and return 400 Bad Request (preferred) OR return safe/escaped result without executing malicious code (both are acceptable secure behaviors)",
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

// Test plan generator prompt (buildTestPlanPrompt) removed — Pro mode approval flow was deleted.

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC QUESTION GENERATION PROMPTS
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
// URL CONTEXT ANALYSIS PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for URL context analysis
 * Used to analyze URLs and provide testing insights before test plan generation
 */
export function buildUrlAnalysisPrompt(params: {
  url: string;
  hostname: string;
  pathname: string;
  searchParams?: string;
}): string {
  return `Analyze this URL and provide testing insights:

URL: ${params.url}
Hostname: ${params.hostname}
Path: ${params.pathname}
${params.searchParams ? `Query params: ${params.searchParams}` : ''}

**REQUIREMENTS:**
1. You MUST respond with valid JSON only. No markdown, no explanations, no code blocks.
2. The JSON must contain exactly these three fields: "insights", "warnings", "recommendations"
3. Each field must be an array of strings (never null, never objects, never numbers)
4. Maximum 4 items per array. Keep it concise and actionable.

**JSON Structure (REQUIRED FORMAT):**
{
  "insights": ["string 1", "string 2"],
  "warnings": ["string 1"],
  "recommendations": ["string 1", "string 2", "string 3"]
}

**Field Definitions:**
- **insights**: What type of page/functionality is this? (e.g., "Admin dashboard", "E-commerce checkout", "Authentication page")
- **warnings**: Potential issues or concerns for testing (e.g., "Financial transactions - use test credentials", "API endpoint - UI testing may not be suitable")
- **recommendations**: Specific testing focus areas (e.g., "Test form validation", "Verify role-based access control", "Test search filters and pagination")

**Example of CORRECT response:**
{
  "insights": ["Admin interface detected", "User management page"],
  "warnings": ["Requires authentication", "Data may change between test runs"],
  "recommendations": ["Test role-based access control", "Verify CRUD operations", "Test pagination"]
}

**CRITICAL: Return ONLY the JSON object. No other text before or after.**`;
}

/**
 * System prompt for URL analysis
 */
export function buildUrlAnalysisSystemPrompt(): string {
  return 'You are a QA testing expert. You MUST respond with valid JSON only. Analyze URLs and provide concise, actionable testing insights in the exact format specified. Never include markdown, code blocks, or explanations - only pure JSON.';
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE STRATEGY GENERATION PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for generating custom scope strategy via AI
 * Used when user provides a scope that's not in VALID_SCOPES
 */
export function buildCustomScopeStrategyPrompt(params: {
  customScope: string;
  urlContext?: { insights: string[]; warnings: string[]; recommendations: string[] };
}): string {
  const urlContextSection = params.urlContext
    ? `
URL CONTEXT:
- Insights: ${params.urlContext.insights.join(', ')}
- Warnings: ${params.urlContext.warnings.join(', ')}
- Recommendations: ${params.urlContext.recommendations.join(', ')}
`
    : '';

  return `Generate a testing strategy for a custom scope: "${params.customScope}"

${urlContextSection}
**REQUIREMENTS:**
1. You MUST respond with valid JSON only. No markdown, no explanations, no code blocks.
2. The JSON must contain exactly these fields: "description", "estimatedDuration", "focusAreas", "testTypes"
3. "focusAreas" and "testTypes" must be arrays of strings
4. Keep it concise and actionable (3-6 focus areas, 2-4 test types)

**JSON Structure (REQUIRED FORMAT):**
{
  "description": "Brief description of what this scope tests",
  "estimatedDuration": "X-Y minutes",
  "focusAreas": ["area 1", "area 2", "area 3"],
  "testTypes": ["type1", "type2"]
}

**Guidelines:**
- Base the strategy on the scope name and context
- Consider what "custom scope" typically means for testing
- Make focus areas specific and actionable
- Choose appropriate test types (functional, visual, accessibility, performance, integration, smoke, security, validation, error-handling, unit)
- Estimate duration based on scope complexity

**Example for scope "checkout":**
{
  "description": "E-commerce checkout process testing",
  "estimatedDuration": "5-8 minutes",
  "focusAreas": [
    "Payment form validation",
    "Cart calculations",
    "Shipping options",
    "Order confirmation flow"
  ],
  "testTypes": ["functional", "validation", "security"]
}

**CRITICAL: Return ONLY the JSON object. No other text before or after.**`;
}

/**
 * System prompt for custom scope strategy generation
 */
export function buildCustomScopeStrategySystemPrompt(): string {
  return 'You are a QA testing expert. You MUST respond with valid JSON only. Generate testing strategies for custom scopes based on their meaning and context. Never include markdown, code blocks, or explanations - only pure JSON.';
}

/**
 * Build prompt for AI-guided page navigation
 * Analyzes user's goal and selects best link to navigate to target page
 */
export function buildPageNavigationPrompt(params: {
  userMessage: string;
  availableLinks: Array<{
    text: string;
    href: string;
    selector: string;
    context?: string; // Parent heading/section context
    isVisible?: boolean; // Viewport visibility
    section?: string; // Section grouping
  }>;
  currentUrl: string;
}): string {
  const formatLinkLine = (link: any, i: number): string => {
    const contextInfo = link.context ? ` | Context: "${link.context}"` : '';
    const visibilityInfo =
      typeof link.isVisible === 'boolean'
        ? link.isVisible
          ? ' [VISIBLE]'
          : ' [OFF-SCREEN]'
        : '';
    const sectionInfo = link.section ? ` | Section: ${link.section}` : '';
    return `${i + 1}. Text: "${link.text}"${contextInfo}${visibilityInfo}${sectionInfo} | Href: "${link.href}" | Selector: ${link.selector}`;
  };

  const linksSection = (() => {
    if (params.availableLinks.length === 0) return 'No links/buttons found on this page';

    // Group by section to help the model navigate large pages.
    const groups: Record<string, any[]> = { header: [], nav: [], main: [], footer: [], other: [] };
    for (const link of params.availableLinks) {
      const section = (link.section || 'other').toLowerCase();
      if (section in groups) groups[section].push(link);
      else groups.other.push(link);
    }

    const parts: string[] = [];
    const pushGroup = (name: string, items: any[]) => {
      if (items.length === 0) return;
      parts.push(`${name.toUpperCase()} LINKS:`);
      parts.push(items.map(formatLinkLine).join('\n'));
      parts.push(''); // Spacer
    };

    pushGroup('header', groups.header);
    pushGroup('nav', groups.nav);
    pushGroup('main', groups.main);
    pushGroup('footer', groups.footer);
    pushGroup('other', groups.other);

    return parts.join('\n').trim();
  })();

  return `Analyze the user's testing goal and select the best link to navigate to the target page.

USER'S GOAL:
"${params.userMessage}"

CURRENT PAGE:
${params.currentUrl}

AVAILABLE LINKS AND BUTTONS:
${linksSection}

TASK:
Based on the user's goal, determine if navigation is needed and select the best link to reach the target page.

EXAMPLES:
- If goal mentions "registration" or "sign up" → select link with "Register", "Sign Up", "Create Account"
- If goal mentions "login" or "sign in" → select link with "Login", "Sign In", "Log In"
- If goal mentions "checkout" or "cart" → select link with "Cart", "Checkout", "Shopping Bag"
- If goal mentions "search" → select link with "Search" or search icon
- If goal mentions "homepage" or current page matches goal → no navigation needed

CRITICAL RULES:
1. ONLY select from the available links above - do NOT invent links
2. Match user's intent (registration, login, etc.) with link text/href AND context
3. If NO suitable link found → set shouldNavigate: false
4. If current page already matches goal → set shouldNavigate: false
5. Prefer exact matches (e.g., "Register" for registration) over partial matches
6. PRIORITIZE [VISIBLE] links over [OFF-SCREEN] links when possible
7. Use context field to disambiguate (e.g., "More" in "Prices" context vs "More" in "FAQ" context)
8. Prefer HEADER/NAV links for top-level navigation; prefer MAIN links for page content actions

RESPONSE FORMAT (JSON):
{
  "shouldNavigate": true/false,
  "targetSelector": "CSS selector from available links (if shouldNavigate: true)",
  "targetText": "Text of selected link",
  "reasoning": "1-2 sentences explaining why this link was selected or why navigation is not needed",
  "confidence": 0.0-1.0
}`;
}

/**
 * System prompt for page navigation
 */
export function buildPageNavigationSystemPrompt(): string {
  return `You are a web navigation expert. Your task is to analyze user goals and select the best navigation path.

CRITICAL RULES:
- Return ONLY valid JSON
- NEVER invent links - only use links provided in the context
- If no suitable link exists, set shouldNavigate: false
- Match user intent precisely (e.g., "registration" requires registration-related links)
- No markdown, no explanations outside JSON`;
}
