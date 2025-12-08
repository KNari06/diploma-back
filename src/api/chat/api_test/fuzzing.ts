import { logger } from '@/utils/logger';
import { IntelligentApiFuzzerService } from '@/services/testing/api/fuzzing/intelligent-api-fuzzer.service';
import { ApiFuzzingExecutorService } from '@/services/testing/api/fuzzing/api-fuzzing-executor.service';
import { CONSTANTS } from '../shared/constants';
import { emitProcessingStep } from '../shared/utils';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: RUN API FUZZING (REFACTORED + FOLLOW-ON)
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX #1: Proper AbortController for timeout
 * FIX #2: Cleanup on timeout
 * FIX #5: Progress reporting during fuzzing
 * FIX #8: Static imports (moved to top)
 * NEW: Intelligent follow-on scenario generation based on findings
 */
export async function runApiFuzzing(
  apiTestResult: any,
  apiDetails: any,
  url: string,
  chatSessionId?: string
): Promise<any | null> {
  // Only run if happy path succeeded
  if (!apiTestResult.success || !chatSessionId) {
    return null;
  }

  // FIX #1: Create AbortController for proper cleanup
  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    logger.info('[API_FUZZING] Starting intelligent fuzzing', {
      method: apiDetails.method,
      url,
      timeout: CONSTANTS.FUZZING_TIMEOUT,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Initial Fuzzing (Broad Coverage)
    // ═══════════════════════════════════════════════════════════════════════
    emitProcessingStep(chatSessionId, 'analyzing_results', '🔍 Generating initial security scenarios...', 70);

    const initialScenarios = await IntelligentApiFuzzerService.generateFuzzingScenarios(
      {
        method: apiDetails.method || 'GET',
        url,
        body: apiDetails.body,
        headers: apiDetails.headers || {},
        expectedStatus: apiDetails.expectedStatus || 200,
      },
      apiTestResult
    );

    if (!initialScenarios || initialScenarios.length === 0) {
      logger.warn('[API_FUZZING] No initial scenarios generated');
      return null;
    }

    emitProcessingStep(
      chatSessionId,
      'analyzing_results',
      `🎯 Testing ${initialScenarios.length} initial security scenarios...`,
      73
    );

    // FIX #1: Setup timeout that aborts all requests
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort(); // ← Cancel all ongoing requests
        reject(new Error('Fuzzing timeout'));
      }, CONSTANTS.FUZZING_TIMEOUT);
    });

    // FIX #5: Progress callback for initial phase (70% → 85%)
    const onInitialProgress = (completed: number, total: number) => {
      const progressPercent = 73 + Math.floor((completed / total) * 12); // 73% → 85%
      emitProcessingStep(
        chatSessionId,
        'analyzing_results',
        `🔒 Testing security [Phase 1] (${completed}/${total})...`,
        progressPercent
      );
    };

    // Execute initial fuzzing
    const initialFuzzingPromise = ApiFuzzingExecutorService.executeFuzzingScenarios(
      initialScenarios,
      apiTestResult,
      abortController.signal,
      onInitialProgress
    );

    const initialReport = await Promise.race([initialFuzzingPromise, timeoutPromise]) as any;

    logger.info('[API_FUZZING] Initial fuzzing completed', {
      totalTests: initialReport.summary.totalTests,
      passed: initialReport.summary.passed,
      failed: initialReport.summary.failed,
      issuesFound: initialReport.issues.length,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Follow-On Fuzzing (Targeted Deep Dive)
    // ═══════════════════════════════════════════════════════════════════════

    // Check if we found critical/high issues that warrant follow-on testing
    const criticalIssues = initialReport.issues.filter(
      (issue: any) => issue.severity === 'critical' || issue.severity === 'high'
    );

    let followOnReport: any = null;

    if (criticalIssues.length > 0 && !abortController.signal.aborted) {
      logger.info('[API_FUZZING] Critical issues found, generating follow-on scenarios', {
        criticalCount: criticalIssues.length,
      });

      emitProcessingStep(
        chatSessionId,
        'analyzing_results',
        `⚠️ ${criticalIssues.length} critical issue(s) found! Generating targeted exploits...`,
        85
      );

      try {
        const followOnScenarios = await IntelligentApiFuzzerService.generateFollowOnScenarios(
          {
            method: apiDetails.method || 'GET',
            url,
            body: apiDetails.body,
            headers: apiDetails.headers || {},
            expectedStatus: apiDetails.expectedStatus || 200,
          },
          {
            scenarios: initialReport.scenarios,
            issues: initialReport.issues,
          },
          criticalIssues
        );

        if (followOnScenarios && followOnScenarios.length > 0 && !abortController.signal.aborted) {
          emitProcessingStep(
            chatSessionId,
            'analyzing_results',
            `🎯 Testing ${followOnScenarios.length} follow-on scenarios...`,
            87
          );

          // Progress callback for follow-on phase (87% → 97%)
          const onFollowOnProgress = (completed: number, total: number) => {
            const progressPercent = 87 + Math.floor((completed / total) * 10); // 87% → 97%
            emitProcessingStep(
              chatSessionId,
              'analyzing_results',
              `🔥 Deep exploit testing [Phase 2] (${completed}/${total})...`,
              progressPercent
            );
          };

          const followOnPromise = ApiFuzzingExecutorService.executeFuzzingScenarios(
            followOnScenarios,
            apiTestResult,
            abortController.signal,
            onFollowOnProgress
          );

          followOnReport = await Promise.race([followOnPromise, timeoutPromise]) as any;

          logger.info('[API_FUZZING] Follow-on fuzzing completed', {
            totalTests: followOnReport.summary.totalTests,
            passed: followOnReport.summary.passed,
            failed: followOnReport.summary.failed,
            newIssuesFound: followOnReport.issues.length,
          });
        } else {
          logger.info('[API_FUZZING] No follow-on scenarios generated or aborted');
        }
      } catch (followOnError) {
        logger.error('[API_FUZZING] Follow-on fuzzing failed, using initial results only', {
          error: followOnError instanceof Error ? followOnError.message : String(followOnError),
        });
        // Continue with initial results
      }
    } else {
      logger.info('[API_FUZZING] No critical issues found, skipping follow-on testing', {
        issuesCount: initialReport.issues.length,
        aborted: abortController.signal.aborted,
      });
    }

    // FIX #2: Clear timeout if completed successfully
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Merge Reports
    // ═══════════════════════════════════════════════════════════════════════

    const finalReport = followOnReport
      ? mergeFuzzingReports(initialReport, followOnReport)
      : initialReport;

    logger.info('[API_FUZZING] Fuzzing completed (all phases)', {
      totalTests: finalReport.summary.totalTests,
      passed: finalReport.summary.passed,
      failed: finalReport.summary.failed,
      issuesFound: finalReport.issues.length,
      securityScore: finalReport.securityScore,
      hadFollowOn: !!followOnReport,
    });

    emitProcessingStep(
      chatSessionId,
      'analyzing_results',
      `✅ Security analysis complete! Found ${finalReport.issues.length} issue(s) across ${followOnReport ? '2 phases' : '1 phase'}`,
      100
    );

    return finalReport;
  } catch (fuzzingError) {
    const isTimeout = fuzzingError instanceof Error && fuzzingError.message === 'Fuzzing timeout';
    const isAborted = fuzzingError instanceof Error && fuzzingError.message.includes('aborted');

    logger.error('[API_FUZZING] Fuzzing failed, continuing without it', {
      error: fuzzingError instanceof Error ? fuzzingError.message : String(fuzzingError),
      isTimeout,
      isAborted,
      maxTimeout: CONSTANTS.FUZZING_TIMEOUT,
    });

    if ((isTimeout || isAborted) && chatSessionId) {
      emitProcessingStep(
        chatSessionId,
        'analyzing_results',
        `⚠️ Security analysis timed out (max ${CONSTANTS.FUZZING_TIMEOUT / 1000}s), skipping fuzzing`,
        100
      );
    }

    return null;
  } finally {
    // FIX #2: Always cleanup timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: MERGE FUZZING REPORTS
 * ═══════════════════════════════════════════════════════════════════════════
 * Combines initial and follow-on fuzzing reports into a single comprehensive report
 */
export function mergeFuzzingReports(initialReport: any, followOnReport: any): any {
  if (!initialReport) return followOnReport;
  if (!followOnReport) return initialReport;

  logger.info('[API_FUZZING] Merging fuzzing reports', {
    initialTests: initialReport.summary.totalTests,
    followOnTests: followOnReport.summary.totalTests,
    initialIssues: initialReport.issues.length,
    followOnIssues: followOnReport.issues.length,
  });

  // Merge scenarios (deduplicate by ID)
  const allScenarios = [...initialReport.scenarios];
  const existingIds = new Set(initialReport.scenarios.map((s: any) => s.scenario?.id));

  for (const scenario of followOnReport.scenarios) {
    if (scenario.scenario?.id && !existingIds.has(scenario.scenario.id)) {
      allScenarios.push(scenario);
      existingIds.add(scenario.scenario.id);
    }
  }

  // Merge issues (deduplicate by type + description)
  const allIssues = [...initialReport.issues];
  const existingIssueKeys = new Set(
    initialReport.issues.map((i: any) => `${i.type}:${i.description}`)
  );

  for (const issue of followOnReport.issues) {
    const issueKey = `${issue.type}:${issue.description}`;
    if (!existingIssueKeys.has(issueKey)) {
      allIssues.push(issue);
      existingIssueKeys.add(issueKey);
    }
  }

  // Merge summary
  const mergedSummary = {
    totalTests: initialReport.summary.totalTests + followOnReport.summary.totalTests,
    passed: initialReport.summary.passed + followOnReport.summary.passed,
    failed: initialReport.summary.failed + followOnReport.summary.failed,
    duration: initialReport.summary.duration + followOnReport.summary.duration,
  };

  // Recalculate security score based on all issues
  const criticalCount = allIssues.filter((i: any) => i.severity === 'critical').length;
  const highCount = allIssues.filter((i: any) => i.severity === 'high').length;
  const mediumCount = allIssues.filter((i: any) => i.severity === 'medium').length;

  // Security score: 10 - (critical*3 + high*2 + medium*1), min 0
  const securityScore = Math.max(
    0,
    10 - (criticalCount * 3 + highCount * 2 + mediumCount * 1)
  );

  // Merge recommendations (deduplicate)
  const allRecommendations = [
    ...(initialReport.recommendations || []),
    ...(followOnReport.recommendations || []),
  ];
  const uniqueRecommendations = [...new Set(allRecommendations)];

  const mergedReport = {
    happyPathResult: initialReport.happyPathResult, // Keep original
    scenarios: allScenarios,
    summary: mergedSummary,
    issues: allIssues,
    securityScore,
    recommendations: uniqueRecommendations,
    metadata: {
      hadFollowOn: true,
      initialPhase: {
        tests: initialReport.summary.totalTests,
        issues: initialReport.issues.length,
      },
      followOnPhase: {
        tests: followOnReport.summary.totalTests,
        issues: followOnReport.issues.length,
      },
    },
  };

  logger.info('[API_FUZZING] Reports merged successfully', {
    totalTests: mergedReport.summary.totalTests,
    totalIssues: mergedReport.issues.length,
    securityScore: mergedReport.securityScore,
  });

  return mergedReport;
}
