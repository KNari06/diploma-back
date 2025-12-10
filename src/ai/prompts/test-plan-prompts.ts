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
   • Send empty body where required → Expected: 400 Bad Request
   • Send huge payload (> 10MB) → Expected: 413 Payload Too Large
   • Send wrong data types (string instead of number) → Expected: 400 Bad Request
   • Send negative numbers where positive expected → Expected: 400 Bad Request
   • Send extremely long strings (> 10K chars) → Expected: 400 Bad Request (or 413 if size limit exceeded)

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

// ═══════════════════════════════════════════════════════════════════════════
// TEST PLAN GENERATOR PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for test plan generation
 */
export function buildTestPlanPrompt(
  exploration: any,
  userRequest: { message: string; scope: string; additionalInfo?: any }
): string {
  // Helper: safe access with defaults
  const safe = (v: any, fallback: any) => (v === undefined || v === null ? fallback : v);

  // Helper: truncate long strings to avoid token overflow
  const truncate = (s: string, max = 4000) => {
    if (typeof s !== 'string') return s;
    return s.length > max ? s.slice(0, max) + '\n... (truncated)' : s;
  };

  const dom = safe(exploration?.domAnalysis, { buttons: [], inputs: [], forms: [], links: [] });
  const visual = safe(exploration?.visualAnalysis, null);
  const recs = Array.isArray(exploration?.recommendations) ? exploration.recommendations : [];

  const mapList = (list: any[], mapper: (item: any, idx: number) => string, emptyText = '  (none)') =>
    Array.isArray(list) && list.length > 0 ? list.map(mapper).join('\n') : emptyText;

  const buttonsList = mapList(dom.buttons || [], (b: any, idx: number) =>
    `${idx + 1}. Text: "${safe(b.text, b.type || '')}" → USE THIS SELECTOR: "${safe(b.selector, '(no selector)')}"`
  );

  const inputsList = mapList(dom.inputs || [], (i: any, idx: number) =>
    `${idx + 1}. Type: ${safe(i.type, 'unknown')}, Name: ${safe(i.name, 'none')}, Placeholder: ${safe(i.placeholder, 'none')} → USE THIS SELECTOR: "${safe(i.selector, '(no selector)')}"`
  );

  const formsList = Array.isArray(dom.forms) && dom.forms.length > 0
    ? dom.forms.map((f: any, i: number) => {
        const fields = (f.fields || []).slice(0, 50).map((field: any) =>
          `    - ${safe(field.name, field.type || 'field')} (${field.required ? 'required' : 'optional'}) → SELECTOR: "${safe(field.selector, '(no selector)')}"`
        ).join('\n');
        const more = (f.fields && f.fields.length > 50) ? `\n    ... and ${f.fields.length - 50} more fields (truncated)` : '';
        return `  Form ${i + 1}:\n${fields}${more}`;
      }).join('\n')
    : '  (no forms found)';

  const linksList = mapList(dom.links || [], (l: any, idx: number) =>
    `${idx + 1}. Text: "${safe(l.text, '')}" → USE THIS SELECTOR: "${safe(l.selector, '(no selector)')}"`
  );

  const safeVisualString = visual ? truncate(typeof visual === 'string' ? visual : JSON.stringify(visual, null, 2)) : '(none)';
  const recommendationsString = recs.length > 0 ? recs.slice(0, 20).map((r: any) => `- ${r}`).join('\n') : '  (no recommendations)';

  // Extract additional context if provided
  const additionalInfo = userRequest.additionalInfo || {};
  const scopeDescription = additionalInfo.scopeDescription || '';
  const focusAreas = Array.isArray(additionalInfo.focusAreas) ? additionalInfo.focusAreas : [];
  const testTypes = Array.isArray(additionalInfo.testTypes) ? additionalInfo.testTypes : [];
  const estimatedDuration = additionalInfo.estimatedDuration || '';
  const urlInsights = Array.isArray(additionalInfo.urlInsights) ? additionalInfo.urlInsights : [];
  const urlWarnings = Array.isArray(additionalInfo.urlWarnings) ? additionalInfo.urlWarnings : [];
  const urlRecommendations = Array.isArray(additionalInfo.recommendations) ? additionalInfo.recommendations : [];

  // Build scope guidance section
  const scopeGuidance = scopeDescription || focusAreas.length > 0
    ? `
TESTING SCOPE GUIDANCE:
${scopeDescription ? `Strategy: ${scopeDescription}` : ''}
${estimatedDuration ? `Estimated Duration: ${estimatedDuration}` : ''}
${focusAreas.length > 0 ? `Focus Areas:\n${focusAreas.map((area: string) => `  - ${area}`).join('\n')}` : ''}
${testTypes.length > 0 ? `Test Types: ${testTypes.join(', ')}` : ''}
`
    : '';

  // Build URL context section
  const urlContextSection = urlInsights.length > 0 || urlWarnings.length > 0 || urlRecommendations.length > 0
    ? `
URL CONTEXT ANALYSIS:
${urlInsights.length > 0 ? `Insights:\n${urlInsights.map((i: string) => `  - ${i}`).join('\n')}` : ''}
${urlWarnings.length > 0 ? `Warnings:\n${urlWarnings.map((w: string) => `  ⚠️ ${w}`).join('\n')}` : ''}
${urlRecommendations.length > 0 ? `Recommendations:\n${urlRecommendations.map((r: string) => `  ✅ ${r}`).join('\n')}` : ''}
`
    : '';

  // Prompt: strict JSON schema + clear rules
  const prompt = `Generate a comprehensive test plan based on the following exploration data.

USER REQUEST:
"${userRequest.message}"

SCOPE:
${userRequest.scope}
${scopeGuidance}${urlContextSection}
PAGE INFORMATION:
- URL: ${safe(exploration?.url, '(unknown)')}
- Title: ${safe(exploration?.pageInfo?.title, '(unknown)')}

VISUAL ANALYSIS (trimmed):
${safeVisualString}

DOM ANALYSIS (USE THESE EXACT SELECTORS - DO NOT INVENT NEW ONES):

AVAILABLE BUTTONS (${(dom.buttons || []).length}):
${buttonsList}

AVAILABLE INPUTS (${(dom.inputs || []).length}):
${inputsList}

AVAILABLE FORMS (${(dom.forms || []).length}):
${formsList}

AVAILABLE LINKS (${(dom.links || []).length}):
${linksList}

RECOMMENDATIONS:
${recommendationsString}

---

IMPORTANT: You MUST return a single valid JSON object only. NO MARKDOWN, NO EXTRA TEXT, NO COMMENTS. The JSON must be parsable by JSON.parse. Follow schema EXACTLY.

SCHEMA (EXACT):
{
  "summary": string, // 2-3 sentence summary
  "steps": [
    {
      "id": string, // e.g. "step_1"
      "description": string,
      "action": "goto"|"fill"|"click"|"assertVisible"|"assertText"|"assertValue"|"select"|"wait"|"scroll"|"extract",
      "selector": string | null, // MUST use selector from DOM ANALYSIS if interacting with element, otherwise null
      "value": string | null,
      "optional": boolean,
      "confidence": number, // 0.0 - 1.0
      "expectedOutcome": {
        "type": "url_change"|"toast"|"element_visible"|"count_increase"|"form_submitted"|"other",
        "selector": string | null,
        "expectedValue": string | null,
        "timeoutMs": number
      }
    }
  ],
  "commands": [ { "action": string, "url"?: string, "selector"?: string, "value"?: string, "description"?: string } ],
  "estimatedDuration": string,
  "whatWillBeTested": string[],
  "whatWillNotBeTested": string[],
  "risks": string[],
  "notes": string | null
}

RULES (MUST FOLLOW):
1) Use ONLY selectors provided in the DOM ANALYSIS above. If a needed element is NOT present in DOM ANALYSIS, set "optional": true for that step and put a clear note in "notes".
2) Limit steps to 5-10 focused steps. Steps should be logically connected and help achieve the user's scope.
3) Include a numeric "confidence" (0-1) for each step and a structured "expectedOutcome" per step.
4) If DOM_ANALYSIS is empty or insufficient, return "steps": [] and populate "notes" with what is missing (so the system can ask clarifying questions).
5) Return valid JSON only. If you cannot produce a test plan due to missing data, return a valid JSON with an empty steps array and an explanatory "notes" field.

ADDITIONAL GUIDANCE:
- Be specific: selectors must exactly match the "USE THIS SELECTOR" strings above.
- Do NOT invent selectors like text=:has-text() or CSS not present. Use provided selectors even if they look verbose.
- For fill/select steps, provide realistic test values (emails, names, phone formats). Avoid obviously disposable emails like "test@test.com".
- For actions that could perform destructive operations (delete, pay), instead create a step with "action": "wait" and description: "requires manual approval" and mark optional=true.

RETURN ONLY THE JSON OBJECT NOW (no explanations).`;

  return prompt;
}

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
  availableLinks: Array<{ text: string; href: string; selector: string }>;
  currentUrl: string;
}): string {
  const linksSection = params.availableLinks.length > 0
    ? params.availableLinks
        .map((link, i) => `${i + 1}. Text: "${link.text}" | Href: "${link.href}" | Selector: ${link.selector}`)
        .join('\n')
    : 'No links/buttons found on this page';

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
2. Match user's intent (registration, login, etc.) with link text/href
3. If NO suitable link found → set shouldNavigate: false
4. If current page already matches goal → set shouldNavigate: false
5. Prefer exact matches (e.g., "Register" for registration) over partial matches

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
