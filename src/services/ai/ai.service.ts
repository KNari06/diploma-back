import { env } from '@/config/env';
import { AISummary, BugReport, TestResult } from '@/types';
import { handleAIError } from '@/utils/error-handler';
import { logAIAnalysis, logger } from '@/utils/logger';
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

    const context = {
      testId: testResult.testId,
      // URL is not directly in TestResult - must be provided by caller from tests table
      // This is handled in ai-analysis.job.ts via JOIN: tests(url)
      browser: testResult.browser,
      status: testResult.status,
      // ✅ Truncate errors (only last N)
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
    return `You are an expert QA engineer with 10+ years of experience in web application testing.
Your task is to analyze test results and provide comprehensive bug reports and recommendations.

You will receive:
- Test execution details (browser, status, errors)
- Console logs and network logs
- Performance metrics
- DOM structure (truncated if too large)
- Screenshot availability

Your analysis should include:
1. A concise summary of the test results
2. Detailed bug reports for any issues found
3. Actionable recommendations for improvements
4. Severity assessment (low, medium, high, critical)
5. Confidence level (0-100)

Focus on:
- Functional bugs and errors
- Performance issues
- Accessibility problems
- Visual inconsistencies
- Security vulnerabilities
- User experience issues

Be specific and actionable in your recommendations. Use your expertise to identify patterns and root causes.`;
  }

  /**
   * Get user prompt with test context
   */
  private getUserPrompt(context: string): string {
    return `Please analyze the following test results and provide a comprehensive QA report:

${context}

Please provide your analysis in the following JSON format:
{
  "summary": "Brief summary of the test results and main findings",
  "bugs": [
    {
      "title": "Bug title",
      "description": "Detailed description of the bug",
      "severity": "low|medium|high|critical",
      "category": "visual|functional|performance|accessibility|security",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expectedResult": "What should happen",
      "actualResult": "What actually happened",
      "domSelector": "CSS selector if applicable",
      "line": "Line number if applicable",
      "column": "Column number if applicable"
    }
  ],
  "recommendations": [
    "Specific recommendation 1",
    "Specific recommendation 2"
  ],
  "severity": "low|medium|high|critical",
  "confidence": 85
}

If no bugs are found, return an empty bugs array but still provide recommendations for improvements.`;
  }

  /**
   * Parse AI response and convert to AISummary
   */
  private parseAIResponse(content: string): AISummary {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error('[AI_SERVICE] No JSON found in AI response', {
          contentPreview: content.substring(0, 200),
        });
        throw new Error('No JSON found in AI response');
      }

      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        logger.error('[AI_SERVICE] Failed to parse JSON from AI response', {
          jsonPreview: jsonMatch[0].substring(0, 200),
          parseError,
        });
        throw new Error('Invalid JSON in AI response');
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

      const prompt = `Generate a concise test execution summary for the following results:
${JSON.stringify(summary, null, 2)}

Provide a brief, professional summary suitable for stakeholders.`;

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

      const prompt = `Generate a detailed bug report for the following issue:

Bug: ${bug.title}
Description: ${bug.description}
Severity: ${bug.severity}
Category: ${bug.category}
Steps: ${bug.steps.join(', ')}
Expected: ${bug.expectedResult}
Actual: ${bug.actualResult}

Context:
- URL: ${context.url}
- Browser: ${context.browser}
- Logs: ${context.logs.slice(0, 10).join('\n')}

Generate a professional bug report suitable for development teams.`;

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
