import { env } from '@/config/environment/env';
import { AISummary, BugReport, TestResult } from '@/types';
import { handleAIError } from '@/utils/core/error-handler';
import { logAIAnalysis, logger } from '@/utils/core/logger';
import type OpenAI from 'openai';
import { getSharedOpenAIClient } from '@/services/ai/core/openai.service';

// Constants
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
    this.openai = getSharedOpenAIClient();
  }

  /**
   * Analyze test results and generate AI summary
   */
  async analyzeTestResults(testResult: TestResult, options?: { integrationContext?: string }): Promise<AISummary> {
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
      let context = this.prepareAnalysisContext(testResult);

      // Append integration context if available
      if (options?.integrationContext) {
        context += `\n\nConnected integrations: ${options.integrationContext}`;
      }

      // Generate AI analysis
      const analysis = await this.generateAnalysis(context);

      // Definition-of-bug code-gate: an automated WCAG scan finding (missing
      // alt text, missing landmark, unlabeled input, ...) is advisory, not a
      // bug — see demoteAdvisoryAccessibilityBugs for the full rationale.
      // Runs unconditionally (unlike the scrub below) because these findings
      // are never bugs, even on a run that also has a real, unrelated defect.
      const demoted = this.demoteAdvisoryAccessibilityBugs(analysis);

      // Anti-hallucination code-gate. Prompt rule #3 tells the LLM not to
      // manufacture bugs on a clean run, but a soft instruction isn't a
      // guarantee — a model seeing only accessibility warnings / perf metrics
      // can still invent a "bug" (and it costs 5 credits + pollutes Jira). Here
      // we ENFORCE it: if the run is a clean pass with zero real error signal
      // (status completed, no errors, no 4xx/5xx network), scrub any bugs the
      // LLM returned. A failed/timeout run — or any genuine error/5xx — is a
      // legitimate bug source and is left untouched (assertion failures and
      // element-not-found drift produce no console error but ARE real).
      const scrubbed = this.scrubHallucinatedBugs(testResult, demoted);

      const duration = Date.now() - startTime;
      logger.info('[AI_SERVICE] Analysis completed', {
        testId: testResult.testId,
        duration,
        bugsFound: scrubbed.bugs.length,
        bugsDemoted: analysis.bugs.length - demoted.bugs.length,
        bugsScrubbed: demoted.bugs.length - scrubbed.bugs.length,
        severity: scrubbed.severity,
      });

      // Log the analysis
      logAIAnalysis(testResult.testId, scrubbed);

      return scrubbed;
    } catch (error) {
      logger.error('[AI_SERVICE] Analysis failed', {
        testId: testResult.testId,
        error,
      });
      throw handleAIError(error);
    }
  }

  /**
   * Definition of "bug" (code-enforced, not just a prompt instruction): a bug
   * is a defect where the app's actual behavior is broken or diverges from
   * expected behavior — something errors, fails, or doesn't work. An
   * automated WCAG scan finding (missing alt text, missing landmark region,
   * unlabeled input, heading-level skip, ...) is a lint-style observation
   * about markup, not evidence that anything broke — it's advisory, and
   * belongs in `recommendations`, never in `bugs`.
   *
   * Prompt rule #2 already tells the LLM this, but a soft instruction isn't a
   * guarantee (same reasoning as scrubHallucinatedBugs below) — and unlike
   * that scrub, this one must run unconditionally: an accessibility lint
   * finding doesn't become a "real bug" just because the same run also has an
   * unrelated genuine defect (e.g. a failed network call) riding alongside
   * it. That's exactly the case the code-gate below would otherwise miss —
   * scrubHallucinatedBugs only fires on a fully clean run, so a low-severity
   * accessibility "bug" that hitched a ride on a real bug's `hasRealSignal`
   * would previously survive untouched and permanently inflate bug counts
   * (Bug Summary totals, release-verdict `ready_with_warnings`, Jira sync,
   * the 5-credit bug-report charge) across every future report that reads
   * this run's `ai_summary`.
   *
   * The one exception: a high/critical accessibility bug is left alone. Per
   * the prompt, that severity is reserved for a case where the model has
   * actual evidence an accessibility issue prevents a disabled user from
   * completing a task — that's a real functional break, not lint noise.
   * Pure + side-effect-free so it's unit-testable.
   *
   * When demotion empties `bugs` entirely, `severity` and (if it was the
   * demoted item's own justification) `failureClassification` are kept in
   * sync — otherwise a caller can end up with the self-contradictory
   * `{bugs: [], severity: 'medium'}`, or a `failureClassification: 'real_bug'`
   * with no bug left to back it. `scrubHallucinatedBugs` below normalizes
   * `severity` too, but only when IT does the dropping — its own guard
   * early-returns on an already-empty `bugs` array, so it never runs when
   * demotion alone was what zeroed the list. Fixing it here means both
   * fields stay correct regardless of which gate did the emptying.
   */
  private demoteAdvisoryAccessibilityBugs(analysis: AISummary): AISummary {
    if (!analysis.bugs || analysis.bugs.length === 0) return analysis;

    const advisory = analysis.bugs.filter(
      (bug) => bug.category === 'accessibility' && (bug.severity === 'low' || bug.severity === 'medium'),
    );
    if (advisory.length === 0) return analysis;

    logger.debug('[AI_SERVICE] Demoting advisory accessibility findings to recommendations', {
      count: advisory.length,
      titles: advisory.map((b) => b.title).slice(0, 5),
    });

    const remaining = analysis.bugs.filter((bug) => !advisory.includes(bug));
    const emptied = remaining.length === 0;
    // 'real_bug' means "reproducible failure with clear error evidence" — if
    // the only evidence was the accessibility item we just demoted, that
    // classification no longer holds. Other classifications (flaky/
    // environment/test_drift) describe the failure mechanism itself, not
    // "there is a bug", so they're left untouched.
    const dropRealBugClassification = emptied && analysis.failureClassification === 'real_bug';

    return {
      ...analysis,
      bugs: remaining,
      severity: emptied ? 'low' : analysis.severity,
      failureClassification: dropRealBugClassification ? null : analysis.failureClassification,
      classificationEvidence: dropRealBugClassification ? [] : analysis.classificationEvidence,
      recommendations: [...analysis.recommendations, ...advisory.map((b) => b.title)],
    };
  }

  /**
   * Enforce prompt rule #3 in code: on a genuinely clean run, an LLM must not
   * invent bugs. "Clean" = the test PASSED (status 'completed') AND there is no
   * real error signal — no `errors[]` entries and no 4xx/5xx network responses.
   * In that case any `bugs` the model returned are hallucinations (fabricated
   * from accessibility warnings / perf metrics / speculation), so we drop them
   * and force a low-severity clean summary.
   *
   * We deliberately do NOT scrub when the run FAILED/timed out or has any real
   * error signal — those are legitimate bug sources even with an empty console
   * (assertion failures, element-not-found / test-drift produce no console
   * error but ARE real). Pure + side-effect-free so it's unit-testable.
   *
   * Exemption: a high/critical `category:'accessibility'` bug that survived
   * `demoteAdvisoryAccessibilityBugs` above is, by that method's own contract,
   * the one case the prompt allows without console/network evidence — a
   * "failed interaction" (e.g. a keyboard focus trap) legitimately produces
   * neither. Wiping it here on a console/network-quiet run would silently
   * contradict that guarantee and discard a real, disabled-user-blocking
   * defect. Every other bug (any severity, any other category) is still
   * scrubbed exactly as before — this exemption is intentionally as narrow
   * as the prompt's own carve-out, not a general "spare high-severity bugs"
   * rule.
   */
  private scrubHallucinatedBugs(testResult: TestResult, analysis: AISummary): AISummary {
    if (!analysis.bugs || analysis.bugs.length === 0) return analysis;

    const passed = testResult.status === 'completed';
    const hasErrors = (testResult.errors?.length ?? 0) > 0;
    const hasHttpFailure = (testResult.networkLogs ?? []).some(
      (n) => typeof n?.status === 'number' && n.status >= 400,
    );
    const hasRealSignal = !passed || hasErrors || hasHttpFailure;
    if (hasRealSignal) return analysis; // legitimate bug source — leave untouched

    const isExemptAccessibilityBug = (bug: BugReport) =>
      bug.category === 'accessibility' && (bug.severity === 'high' || bug.severity === 'critical');
    const toDrop = analysis.bugs.filter((bug) => !isExemptAccessibilityBug(bug));
    if (toDrop.length === 0) return analysis; // everything left is exempt — nothing to scrub

    logger.warn('[AI_SERVICE] Scrubbing hallucinated bugs on a clean run', {
      testId: testResult.testId,
      droppedBugs: toDrop.length,
      droppedTitles: toDrop.map((b) => b.title).slice(0, 5),
    });
    const remaining = analysis.bugs.filter(isExemptAccessibilityBug);
    return {
      ...analysis,
      bugs: remaining,
      severity: remaining.length > 0 ? analysis.severity : 'low',
      // Keep the model's recommendations (advisory a11y/perf notes are fine as
      // recommendations — rule #4 in the prompt — just not as bugs).
    };
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

    // V14: Include per-step telemetry timeline for root cause analysis
    const stepTelemetry = qualityChecks?.stepTelemetry;
    if (stepTelemetry?.entries?.length > 0) {
      context.stepTimeline = stepTelemetry.entries.map((e: any) => ({
        step: e.stepIndex,
        action: e.actionType,
        desc: e.description?.slice(0, 60),
        status: e.status,
        durationMs: e.durationMs,
        urlChanged: e.urlChanged || undefined,
        error: e.error?.slice(0, 150) || undefined,
        consoleErrors: e.newConsoleErrors?.length > 0 ? e.newConsoleErrors.slice(0, 3) : undefined,
        networkErrors: e.newNetworkErrors?.length > 0 ? e.newNetworkErrors.slice(0, 3) : undefined,
        retried: e.retried || undefined,
      }));
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
      max_completion_tokens: MAX_TOKENS_ANALYSIS,
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

WHAT COUNTS AS A BUG:
A bug is a defect where the app's actual behavior is broken or diverges from
expected behavior — something errors, fails, crashes, or doesn't work. It is
NOT a lint-style observation about markup quality. If you can't point to
something that actually broke (an error, a failed request, an interaction
that didn't do what it should), it isn't a bug — it's a recommendation.

SEVERITY RULES (strict):
- critical: app crash, data loss, security breach, complete feature failure, 5xx errors on core flows
- high: feature partially broken, data corruption, JS errors blocking interaction, failed API calls returning wrong data
- medium: degraded UX, slow performance (>3s), broken layout on primary viewport, form validation not working
- low: cosmetic issues, edge case UI glitches, informational console warnings

CLASSIFICATION RULES:
1. "errors" array = REAL bugs (console errors, network failures, JS exceptions). Classify by impact.
2. "accessibilityWarnings" = automated WCAG scan findings (missing alt text, missing landmark region, unlabeled input, heading-level skip, non-descriptive link text, ...). These are markup lint results, not evidence anything broke — they are NEVER bugs. Always put them in "recommendations", never in "bugs" — even when the same run also has real, unrelated bugs elsewhere. The only exception: if you have actual evidence (a console error, a failed interaction) that an accessibility issue makes a task genuinely impossible to complete for a disabled user, report that as a bug with category "accessibility" and severity high/critical — never low/medium, since anything milder than that is advisory by definition.
3. If status="completed" AND errors=[] → severity="low", confidence >= 80. Do NOT manufacture bugs from warnings.
4. Console warnings (not errors) → recommendations, not bugs.
5. 404s for analytics/tracking scripts → low severity, not high.
6. CORS errors on third-party scripts (analytics, chat widgets) → low severity.
7. Never report the same issue twice with different wording.
8. "summary" must only narrate what's in "bugs". Never describe an accessibility warning (or anything else that belongs in "recommendations" per rule 2/4) as an "issue", "problem", or "bug" in the summary prose — describe it as a noted/advisory finding instead, matching how "recommendations" already frames it.

CONFIDENCE GUIDELINES:
- 90-100: Clear errors with obvious root cause
- 70-89: Errors found but root cause uncertain
- 50-69: Potential issues based on patterns, not clear errors
- Below 50: Speculative, insufficient data

STEP TIMELINE ANALYSIS (when "stepTimeline" is present in input):
- Identify which step CAUSED the failure ("rootCauseStep" = step index).
- If network errors appeared BEFORE the failing step, that earlier step is "causedByStep" (cascading failure).
- If retried=true and no persistent errors at that step, likely flaky.
- If no stepTimeline, set rootCauseStep to null.

FAILURE CLASSIFICATION (always include for failed tests):
"failureClassification" field — pick exactly one:
- "real_bug": Reproducible failure with clear error evidence (console errors, API errors, assertion failures).
- "flaky": Transient failure from timing/race conditions. Indicators: retried step, timeout without network errors, element not found briefly.
- "environment": Infrastructure failure (DNS, connection refused, SSL, 503 on all endpoints).
- "test_drift": Test expects changed behavior (element renamed, URL restructured, UI redesigned). Indicators: element_not_found on previously-passing steps with no errors.
Set to null if test passed or insufficient evidence.

EXTENDED OUTPUT FIELDS (add alongside existing fields):
"rootCauseStep": <step index number or null>,
"causedByStep": <step index number or null>,
"failureClassification": "real_bug"|"flaky"|"environment"|"test_drift"|null,
"classificationEvidence": ["<reason1>", "<reason2>"]

DRIFT SIGNALS (ONLY when failureClassification === "test_drift"):
Add a "driftSignals" object so a downstream aggregator can group this
failure with similar drifts in other tests of the same regression run.
Normalized, machine-readable — NOT prose.

"driftSignals": {
  "urlPattern": "<normalized URL — replace GUID/numeric id segments with ':id'>",
  "targetElementKey": "<stable key: '<tag>:<visible text or aria-label>' e.g. 'button:Подготовка к ВОУД', 'input:email', 'a:Sign in'>",
  "errorShape": "selector_not_found"|"timeout_on_visible"|"covered_by_overlay"|"value_mismatch",
  "beforeState": { "visible": <bool>, "covered": <bool> },   // optional, omit if unknown
  "afterState":  { "visible": <bool>, "domChanged": <bool> } // optional, omit if unknown
}

errorShape rules:
- "selector_not_found": resolver returned nothing / element removed / renamed.
- "timeout_on_visible": element found & visible but click never completed.
- "covered_by_overlay": element present but an overlay/modal intercepts the click
  (new banner, tour, cookie consent, promo popup).
- "value_mismatch": the step was a verify/assert that saw a different value.

If failureClassification !== "test_drift", OMIT driftSignals entirely (do not
include null — just skip the key).

DRIFT EXAMPLE:
Input: status=failed, errors=[], stepTimeline=[{step:12,action:"click",desc:"click podgotovka k VOUD",status:"failed",error:"Timeout 10000ms exceeded waiting for locator"}]
Output (excerpt):
{
  ...
  "failureClassification": "test_drift",
  "classificationEvidence": ["no console/network errors", "step timed out waiting for a previously-resolving selector"],
  "driftSignals": {
    "urlPattern": "/tutors/:id",
    "targetElementKey": "button:Подготовка к ВОУД",
    "errorShape": "selector_not_found"
  }
}

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
}

CLEAN-RUN EXAMPLE (do NOT manufacture bugs — rule #3):

Input: status=completed, errors=[], networkLogs=[{url:"/api/user",status:200,method:"GET"}], accessibilityWarnings=["Image missing alt text","Low contrast on footer link"]
Output:
{
  "summary": "Test completed successfully. No functional errors or failed requests. Two minor accessibility warnings noted.",
  "bugs": [],
  "recommendations": ["Add alt text to the flagged image", "Increase footer link contrast to meet WCAG AA"],
  "severity": "low",
  "confidence": 90
}

ACCESSIBILITY-WARNINGS-DO-NOT-RIDE-ALONG EXAMPLE (rule #2 — a real bug elsewhere never promotes an automated scan finding into a bug):

Input: status=completed, errors=[], networkLogs=[{url:"/api/checkout",status:500,method:"POST"}], accessibilityWarnings=["2 buttons without accessible name","Page missing <main> landmark region"]
Output:
{
  "summary": "Checkout submission fails with a 500 error. Two automated accessibility warnings noted (missing button names, missing main landmark) — advisory only, not related to the checkout failure.",
  "bugs": [{
    "title": "Checkout submission fails with 500 error",
    "description": "POST /api/checkout returns HTTP 500, so the checkout flow cannot complete.",
    "severity": "critical",
    "category": "functional",
    "steps": ["Fill checkout form", "Submit"],
    "expectedResult": "Order is placed and confirmation is shown",
    "actualResult": "Server returns 500, no confirmation shown",
    "domSelector": null
  }],
  "recommendations": ["Fix /api/checkout 500 error", "Add accessible names to the 2 flagged buttons", "Add a <main> landmark region to the page"],
  "severity": "critical",
  "confidence": 90
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

      const failureClassification = this.validateClassification(parsed.failureClassification);
      return {
        summary: parsed.summary || 'No summary provided',
        bugs,
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
        severity: this.validateSeverity(parsed.severity),
        confidence: Math.max(0, Math.min(100, parsed.confidence || 50)),
        generatedAt: new Date(),
        // V14: Step-aware root cause analysis
        rootCauseStep: typeof parsed.rootCauseStep === 'number' ? parsed.rootCauseStep : null,
        causedByStep: typeof parsed.causedByStep === 'number' ? parsed.causedByStep : null,
        failureClassification,
        classificationEvidence: Array.isArray(parsed.classificationEvidence) ? parsed.classificationEvidence : [],
        // Phase-1: drift signals — only meaningful when classification is test_drift.
        // Even if the LLM mistakenly returns driftSignals on a non-drift classification,
        // we strip them here so the downstream aggregator never sees noise.
        driftSignals:
          failureClassification === 'test_drift'
            ? this.validateDriftSignals(parsed.driftSignals)
            : null,
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
   * Validate bug category. Case/whitespace-insensitive — `demoteAdvisoryAccessibilityBugs`
   * gates on an exact `category === 'accessibility'` match, so a near-miss
   * the model returns (` Accessibility`, `ACCESSIBILITY`) must still
   * normalize to the real value here, not silently fall through to
   * 'functional' and bypass that gate entirely.
   */
  private validateCategory(category: any): 'visual' | 'functional' | 'performance' | 'accessibility' | 'security' {
    const validCategories = ['visual', 'functional', 'performance', 'accessibility', 'security'] as const;
    const normalized = typeof category === 'string' ? category.trim().toLowerCase() : '';
    return (validCategories as readonly string[]).includes(normalized)
      ? (normalized as (typeof validCategories)[number])
      : 'functional';
  }

  /**
   * Validate failure classification from AI response.
   * Returns null for invalid/missing values (backward compatible).
   */
  private validateClassification(classification: any): 'flaky' | 'real_bug' | 'environment' | 'test_drift' | null {
    const valid = ['flaky', 'real_bug', 'environment', 'test_drift'];
    return valid.includes(classification) ? classification : null;
  }

  /**
   * Validate / shape the `driftSignals` object returned by the LLM.
   * Only the three required primitives (urlPattern, targetElementKey,
   * errorShape) are strict. `beforeState` / `afterState` are optional
   * and silently dropped if malformed — they're diagnostic only.
   *
   * Returns null if any required field is missing/invalid. The upstream
   * caller (parseAIResponse) already guards on
   * `failureClassification === 'test_drift'` before invoking this helper,
   * so null here means "the LLM labelled it drift but didn't produce
   * usable signals" — Regression Doctor will ignore the record.
   */
  private validateDriftSignals(raw: any): import('@/types').DriftSignals | null {
    if (!raw || typeof raw !== 'object') return null;
    const urlPattern = typeof raw.urlPattern === 'string' ? raw.urlPattern.trim() : '';
    const targetElementKey = typeof raw.targetElementKey === 'string' ? raw.targetElementKey.trim() : '';
    const validShapes = ['selector_not_found', 'timeout_on_visible', 'covered_by_overlay', 'value_mismatch'];
    const errorShape = validShapes.includes(raw.errorShape) ? raw.errorShape : null;
    if (!urlPattern || !targetElementKey || !errorShape) return null;

    const normalizeState = (s: any): { visible: boolean; covered?: boolean; domChanged?: boolean } | undefined => {
      if (!s || typeof s !== 'object') return undefined;
      if (typeof s.visible !== 'boolean') return undefined;
      const out: { visible: boolean; covered?: boolean; domChanged?: boolean } = { visible: s.visible };
      if (typeof s.covered === 'boolean') out.covered = s.covered;
      if (typeof s.domChanged === 'boolean') out.domChanged = s.domChanged;
      return out;
    };

    const before = normalizeState(raw.beforeState);
    const after = normalizeState(raw.afterState);

    return {
      urlPattern,
      targetElementKey,
      errorShape: errorShape as import('@/types').DriftSignals['errorShape'],
      ...(before ? { beforeState: { visible: before.visible, covered: before.covered ?? false } } : {}),
      ...(after ? { afterState: { visible: after.visible, domChanged: after.domChanged ?? false } } : {}),
    };
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
        max_completion_tokens: 500,
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
        max_completion_tokens: 1000,
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
        max_completion_tokens: 1,
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
