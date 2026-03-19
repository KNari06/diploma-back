import { env } from '@/config/environment/env';
import { AISummary, BugReport, TestResult } from '@/types';
import { handleAIError } from '@/utils/core/error-handler';
import { logAIAnalysis, logger } from '@/utils/core/logger';
import OpenAI from 'openai';

// Constants
const AI_TIMEOUT = 30000; // 30 seconds
const MAX_DOM_LENGTH = 5000; // Reduced from 10000 to save tokens
const MAX_TOKENS_ANALYSIS = env.OPENAI_MAX_TOKENS || 2000;
const ANALYSIS_TEMPERATURE = 0.3; // Lower for consistency
const SUMMARY_TEMPERATURE = 0.5;

// ✅ NEW: Token management for context
const MAX_LOGS_COUNT = 20; // Only send last 20 logs
const MAX_NETWORK_LOGS_COUNT = 10; // Only send last 10 network requests
const MAX_ERRORS_COUNT = 10; // Only send last 10 errors
const MAX_NETWORK_LOG_BODY_LENGTH = 500; // Truncate response bodies to 500 chars

export class AIService {
  private openai: OpenAI;

  constructor() {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    this.openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: AI_TIMEOUT,
    });
  }

  /**
   * Analyze test results and generate AI summary
   */
  async analyzeTestResults(testResult: TestResult): Promise<AISummary> {
    // Validate input
    if (!testResult) {
      throw new Error('TestResult is required');
    }

    if (!testResult.testId) {
      throw new Error('TestResult.testId is required');
    }

    try {
      const startTime = Date.now();

      logger.info('[AI_SERVICE] Starting AI analysis', {
        testId: testResult.testId,
        browser: testResult.browser,
        status: testResult.status,
      });

      // Prepare context for AI analysis
      const context = this.prepareAnalysisContext(testResult);

      // Generate AI analysis
      const analysis = await this.generateAnalysis(context);

      const duration = Date.now() - startTime;
      logger.info('[AI_SERVICE] Analysis completed', {
        testId: testResult.testId,
        duration,
        bugsFound: analysis.bugs.length,
        severity: analysis.severity,
      });

      // Log the analysis
      logAIAnalysis(testResult.testId, analysis);

      return analysis;
    } catch (error) {
      logger.error('[AI_SERVICE] Analysis failed', {
        testId: testResult.testId,
        error,
      });
      throw handleAIError(error);
    }
  }

  /**
   * Prepare context for AI analysis
   * ✅ FIXED: Aggressive truncation to prevent context length exceeded errors
   */
  private prepareAnalysisContext(testResult: TestResult): string {
    // Note: URL should be passed from the job handler when fetching from DB
    // The job handler includes tests.url via JOIN query

    // ✅ Log original sizes for debugging
    logger.debug('[AI_SERVICE] Context sizes before truncation', {
      testId: testResult.testId,
      errorsCount: (testResult.errors || []).length,
      logsCount: (testResult.logs || []).length,
      networkLogsCount: (testResult.networkLogs || []).length,
      domLength: testResult.dom?.length || 0,
    });

    const context: Record<string, any> = {
      testId: testResult.testId,
      // URL is not directly in TestResult - must be provided by caller from tests table
      // This is handled in ai-analysis.job.ts via JOIN: tests(url)
      browser: testResult.browser,
      status: testResult.status,
      // Errors: only real errors (console, network, UI). Accessibility warnings come from qualityChecks.
      errors: this.truncateArray(testResult.errors || [], MAX_ERRORS_COUNT),
      // ✅ Truncate logs (only last N)
      logs: this.truncateArray(testResult.logs || [], MAX_LOGS_COUNT),
      // ✅ Truncate network logs (only last N) and truncate response bodies
      networkLogs: this.truncateNetworkLogs(testResult.networkLogs || []),
      performance: testResult.performance || null,
      // ✅ Truncate DOM
      dom: testResult.dom ? this.truncateDOM(testResult.dom) : null,
      screenshot: testResult.screenshot ? 'Screenshot available' : 'No screenshot',
      videoUrl: testResult.videoUrl || null,
      traceUrl: testResult.traceUrl || null,
    };

    // Accessibility warnings from quality checks (separate from errors)
    const qualityChecks = testResult.qualityChecks;
    if (qualityChecks?.accessibility?.warnings?.length > 0) {
      context.accessibilityWarnings = qualityChecks.accessibility.warnings;
    }

    const contextString = JSON.stringify(context, null, 2);

    // ✅ Log final context size
    logger.info('[AI_SERVICE] Context prepared for AI analysis', {
      testId: testResult.testId,
      contextLength: contextString.length,
      estimatedTokens: Math.ceil(contextString.length / 4), // Rough estimate: 1 token ≈ 4 chars
      errorsIncluded: context.errors.length,
      logsIncluded: context.logs.length,
      networkLogsIncluded: context.networkLogs.length,
      domLength: context.dom?.length || 0,
    });

    return contextString;
  }

  /**
   * Truncate DOM to avoid token limits
   */
  private truncateDOM(dom: string, maxLength: number = MAX_DOM_LENGTH): string {
    if (!dom || typeof dom !== 'string') {
      return '';
    }

    if (dom.length <= maxLength) {
      return dom;
    }

    // Try to find a good truncation point at a tag boundary
    const truncated = dom.substring(0, maxLength);
    const lastTag = truncated.lastIndexOf('>');

    // If we found a tag close to the end (within 20%), truncate there
    if (lastTag > maxLength * 0.8) {
      return truncated.substring(0, lastTag + 1) + '\n... [DOM truncated - showing first ' + lastTag + ' chars]';
    }

    return truncated + '\n... [DOM truncated]';
  }

  /**
   * ✅ NEW: Truncate array to max count (keep last N items)
   */
  private truncateArray<T>(array: T[], maxCount: number): T[] {
    if (!Array.isArray(array)) {
      return [];
    }

    if (array.length <= maxCount) {
      return array;
    }

    // Return last N items (most recent)
    return array.slice(-maxCount);
  }

  /**
   * ✅ NEW: Truncate network logs and their response bodies
   */
  private truncateNetworkLogs(networkLogs: any[]): any[] {
    if (!Array.isArray(networkLogs)) {
      return [];
    }

    // Take only last N network logs
    const truncatedLogs = this.truncateArray(networkLogs, MAX_NETWORK_LOGS_COUNT);

    // Truncate response bodies in each log
    return truncatedLogs.map(log => {
      if (!log) return log;

      const truncatedLog = { ...log };

      // Remove or truncate large fields
      if (truncatedLog.responseBody) {
        const bodyStr = typeof truncatedLog.responseBody === 'string'
          ? truncatedLog.responseBody
          : JSON.stringify(truncatedLog.responseBody);

        if (bodyStr.length > MAX_NETWORK_LOG_BODY_LENGTH) {
          truncatedLog.responseBody = bodyStr.substring(0, MAX_NETWORK_LOG_BODY_LENGTH) + '... [truncated]';
        }
      }

      // Remove headers to save tokens (not usually needed for analysis)
      delete truncatedLog.requestHeaders;
      delete truncatedLog.responseHeaders;

      return truncatedLog;
    });
  }

  /**
   * Generate AI analysis using GPT
   */
  private async generateAnalysis(context: string): Promise<AISummary> {
    const systemPrompt = this.getSystemPrompt();
    const userPrompt = this.getUserPrompt(context);

    logger.info('[AI_SERVICE] Calling OpenAI for analysis', {
      model: env.OPENAI_MODEL,
      maxTokens: MAX_TOKENS_ANALYSIS,
      temperature: ANALYSIS_TEMPERATURE,
    });

    const response = await this.openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: MAX_TOKENS_ANALYSIS,
      temperature: ANALYSIS_TEMPERATURE,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from AI service');
    }

    logger.info('[AI_SERVICE] Received AI response', {
      contentLength: content.length,
      tokensUsed: response.usage?.total_tokens,
    });

    return this.parseAIResponse(content);
  }

  /**
   * Get system prompt for AI analysis
   */
  private getSystemPrompt(): string {
    return `You are a senior QA engineer analyzing automated test results. Your goal is to produce an accurate, actionable bug report with zero false positives.

INPUT: You receive test execution data (browser, status, errors, console logs, network logs, DOM, performance metrics, accessibility warnings).

OUTPUT: JSON object with this exact schema:
{
  "summary": "2-3 sentence summary: what was tested, what happened, key finding",
  "bugs": [{ "title": "...", "description": "...", "severity": "low|medium|high|critical", "category": "functional|visual|performance|accessibility|security", "steps": ["..."], "expectedResult": "...", "actualResult": "...", "domSelector": "CSS selector if applicable" }],
  "recommendations": ["actionable recommendation"],
  "severity": "low|medium|high|critical",
  "confidence": 0-100
}

SEVERITY RULES (strict):
- critical: app crash, data loss, security breach, complete feature failure, 5xx errors on core flows
- high: feature partially broken, data corruption, JS errors blocking interaction, failed API calls returning wrong data
- medium: degraded UX, slow performance (>3s), broken layout on primary viewport, form validation not working
- low: cosmetic issues, minor accessibility warnings, edge case UI glitches, informational console warnings

CLASSIFICATION RULES:
1. "errors" array = REAL bugs (console errors, network failures, JS exceptions). Classify by impact.
2. "accessibilityWarnings" = WCAG automated scan findings. Default severity: low. Only medium if it blocks a form input. Never high/critical unless it prevents core functionality for disabled users.
3. If status="completed" AND errors=[] → severity="low", confidence >= 80. Do NOT manufacture bugs from warnings.
4. Console warnings (not errors) → recommendations, not bugs.
5. 404s for analytics/tracking scripts → low severity, not high.
6. CORS errors on third-party scripts (analytics, chat widgets) → low severity.
7. Never report the same issue twice with different wording.

CONFIDENCE GUIDELINES:
- 90-100: Clear errors with obvious root cause
- 70-89: Errors found but root cause uncertain
- 50-69: Potential issues based on patterns, not clear errors
- Below 50: Speculative, insufficient data

FEW-SHOT EXAMPLE:

Input: status=completed, errors=[{type:"console",message:"TypeError: Cannot read property 'map' of undefined",source:"app.js:142"}], logs=["Navigated to /dashboard","Clicked Reports tab","Error in console"], networkLogs=[{url:"/api/reports",status:500,method:"GET"}]
Output:
{
  "summary": "Dashboard reports tab crashes with TypeError due to API returning 500. The /api/reports endpoint fails, causing undefined data to be rendered.",
  "bugs": [{
    "title": "Reports tab crashes due to /api/reports 500 error",
    "description": "Clicking the Reports tab triggers a GET /api/reports call that returns HTTP 500. The frontend attempts to .map() the response without null checking, causing a TypeError.",
    "severity": "high",
    "category": "functional",
    "steps": ["Navigate to /dashboard", "Click Reports tab", "Observe console error"],
    "expectedResult": "Reports data loads and displays correctly",
    "actualResult": "TypeError: Cannot read property 'map' of undefined — reports tab shows blank/crash",
    "domSelector": null
  }],
  "recommendations": ["Add null check before .map() in reports component", "Fix /api/reports 500 error on backend", "Add error boundary around Reports tab"],
  "severity": "high",
  "confidence": 92
}`;
  }

  /**
   * Get user prompt with test context
   */
  private getUserPrompt(context: string): string {
    return `Analyze these test results and respond with JSON:

${context}`;
  }

  /**
   * Parse AI response and convert to AISummary
   */
  private parseAIResponse(content: string): AISummary {
    try {
      let parsed: any;

      // Try direct JSON.parse first (works when response_format: json_object is used)
      try {
        parsed = JSON.parse(content);
        logger.debug('[AI_SERVICE] Parsed AI response via direct JSON.parse');
      } catch {
        // Fallback: extract JSON from markdown/text wrapping
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.error('[AI_SERVICE] No JSON found in AI response', {
            contentPreview: content.substring(0, 200),
          });
          throw new Error('No JSON found in AI response');
        }
        try {
          parsed = JSON.parse(jsonMatch[0]);
          logger.debug('[AI_SERVICE] Parsed AI response via regex fallback');
        } catch (parseError) {
          logger.error('[AI_SERVICE] Failed to parse JSON from AI response', {
            jsonPreview: jsonMatch[0].substring(0, 200),
            parseError,
          });
          throw new Error('Invalid JSON in AI response');
        }
      }

      // Validate and transform the response
      const bugs: BugReport[] = (parsed.bugs || []).map((bug: any, index: number) => ({
        id: `bug-${Date.now()}-${index}`,
        title: bug.title || 'Untitled Bug',
        description: bug.description || 'No description provided',
        severity: this.validateSeverity(bug.severity),
        category: this.validateCategory(bug.category),
        steps: Array.isArray(bug.steps) ? bug.steps : ['Steps not provided'],
        expectedResult: bug.expectedResult || 'Expected result not specified',
        actualResult: bug.actualResult || 'Actual result not specified',
        screenshot: undefined, // Will be added later if needed
        domSelector: bug.domSelector || undefined,
        line: bug.line || undefined,
        column: bug.column || undefined,
      }));

      return {
        summary: parsed.summary || 'No summary provided',
        bugs,
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
        severity: this.validateSeverity(parsed.severity),
        confidence: Math.max(0, Math.min(100, parsed.confidence || 50)),
        generatedAt: new Date(),
      };
    } catch (error) {
      logger.error('[AI_SERVICE] Failed to parse AI response', { error });

      // Return a fallback analysis
      return {
        summary: 'AI analysis failed - manual review required',
        bugs: [],
        recommendations: ['Review test results manually', 'Check logs for errors'],
        severity: 'medium',
        confidence: 0,
        generatedAt: new Date(),
      };
    }
  }

  /**
   * Validate severity level
   */
  private validateSeverity(severity: any): 'low' | 'medium' | 'high' | 'critical' {
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    return validSeverities.includes(severity) ? severity : 'medium';
  }

  /**
   * Validate bug category
   */
  private validateCategory(category: any): 'visual' | 'functional' | 'performance' | 'accessibility' | 'security' {
    const validCategories = ['visual', 'functional', 'performance', 'accessibility', 'security'];
    return validCategories.includes(category) ? category : 'functional';
  }

  /**
   * Generate test execution summary
   */
  async generateTestSummary(testResults: TestResult[]): Promise<string> {
    // Validate input
    if (!testResults || !Array.isArray(testResults)) {
      logger.error('[AI_SERVICE] Invalid test results for summary');
      return 'Summary generation failed - invalid input';
    }

    if (testResults.length === 0) {
      return 'No test results available';
    }

    try {
      const summary = {
        totalTests: testResults.length,
        completedTests: testResults.filter(r => r.status === 'completed').length,
        failedTests: testResults.filter(r => r.status === 'failed').length,
        browsers: [...new Set(testResults.map(r => r.browser))],
        totalBugs: testResults.reduce((sum, r) => sum + (r.aiSummary?.bugs?.length || 0), 0),
        criticalBugs: testResults.reduce((sum, r) =>
          sum + (r.aiSummary?.bugs?.filter(b => b.severity === 'critical').length || 0), 0),
      };

      logger.info('[AI_SERVICE] Generating test summary', { summary });

      const prompt = `You are a QA lead writing a test execution summary for project stakeholders.

DATA:
${JSON.stringify(summary, null, 2)}

Write a 3-5 sentence professional summary covering:
1. Overall result (X of Y tests passed)
2. Critical findings (if any bugs, mention severity breakdown)
3. Recommendation (ship / investigate / block release)

Tone: concise, factual, no jargon. Example:
"8 of 10 tests passed across Chrome. 2 critical bugs found: checkout form validation fails and payment API returns 500 on retry. Recommend blocking release until payment flow is fixed. 3 low-severity accessibility warnings noted for backlog."`;

      const response = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: SUMMARY_TEMPERATURE,
      });

      return response.choices[0]?.message?.content || 'Summary generation failed';
    } catch (error) {
      logger.error('[AI_SERVICE] Failed to generate test summary', { error });
      return 'Summary generation failed';
    }
  }

  /**
   * Generate bug report for specific issue
   */
  async generateBugReport(
    bug: BugReport,
    context: { url: string; browser: string; logs: string[] }
  ): Promise<string> {
    // Validate inputs
    if (!bug || !context) {
      logger.error('[AI_SERVICE] Invalid parameters for bug report');
      return 'Bug report generation failed - invalid input';
    }

    try {
      logger.info('[AI_SERVICE] Generating bug report', {
        bugId: bug.id,
        severity: bug.severity,
        category: bug.category,
      });

      const stepsFormatted = bug.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');
      const logsFormatted = context.logs.slice(0, 10).join('\n');

      const prompt = `Generate a bug report for a development team using this template:

## ${bug.title}

**Severity**: ${bug.severity} | **Category**: ${bug.category}
**URL**: ${context.url} | **Browser**: ${context.browser}

### Steps to Reproduce
${stepsFormatted}

### Expected Result
${bug.expectedResult}

### Actual Result
${bug.actualResult}

### Technical Details
Relevant logs:
${logsFormatted}

---

Fill in any gaps with reasonable inferences from the logs. Keep the report under 300 words. Use markdown formatting. Do not add sections that have no data.`;

      const response = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'user', content: prompt },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      });

      return response.choices[0]?.message?.content || 'Bug report generation failed';
    } catch (error) {
      logger.error('[AI_SERVICE] Failed to generate bug report', { error, bugId: bug?.id });
      return 'Bug report generation failed';
    }
  }

  /**
   * Health check for AI service
   */
  async healthCheck(): Promise<{ status: string; latency: number }> {
    logger.info('[AI_SERVICE] Running health check');
    const startTime = Date.now();

    try {
      await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1,
      });

      const latency = Date.now() - startTime;
      return { status: 'healthy', latency };
    } catch (error) {
      const latency = Date.now() - startTime;
      logger.error('AI service health check failed:', error);
      return { status: 'unhealthy', latency };
    }
  }
}

// Export singleton instance
export const aiService = new AIService();
