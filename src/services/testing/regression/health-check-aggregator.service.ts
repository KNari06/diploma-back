import type {
  HealthCheckFinding,
  ExecutionHealthChecks,
  HealthSummary,
} from '@/types/testing.types';

/**
 * Aggregates existing test result data (console logs, network logs, JS errors)
 * into structured health check findings. No new data collection needed —
 * all data is already captured by ResultCollector during test execution.
 */
export class HealthCheckAggregatorService {
  /**
   * Aggregate health check findings from a single test result.
   * Reads from fields already stored in test_results by ResultCollector.
   */
  static aggregateFromTestResult(
    testResult: any,
    opts?: { isMobile?: boolean },
  ): ExecutionHealthChecks {
    if (!testResult) {
      return { findings: [], checkedAt: new Date().toISOString() };
    }

    const findings: HealthCheckFinding[] = [];
    const isMobile = !!opts?.isMobile;

    // Console + network apply to both platforms in principle, but on mobile
    // neither signal is currently observable — see `checkConsoleLogs` /
    // `checkNetworkLogs` for why each reports `not_available` there.
    findings.push(this.checkConsoleLogs(testResult.logs, isMobile));
    findings.push(this.checkNetworkLogs(testResult.network_logs, isMobile));

    // JS exceptions / broken images / page-responsive are WEB-only concepts.
    // Skip them for mobile: Flutter/native apps have no JS, no <img> resources,
    // no browser viewport — and `checkJsExceptions` would otherwise mislabel a
    // step/app failure in `errors` as an "unhandled JS exception".
    if (!isMobile) {
      findings.push(this.checkJsExceptions(testResult.errors));
      findings.push(this.checkBrokenImages(testResult));
      findings.push(this.checkPageResponsive(testResult));
    }

    return {
      findings,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Aggregate health checks across all executions into a summary.
   */
  static buildHealthSummary(
    allChecks: (ExecutionHealthChecks | undefined)[],
  ): HealthSummary {
    const mergedFindings: HealthCheckFinding[] = [];
    let passed = 0;
    let warnings = 0;
    let failures = 0;
    let notAvailable = 0;

    // Merge findings by category — take worst severity per category across executions
    const byCat = new Map<string, HealthCheckFinding>();

    for (const checks of allChecks) {
      if (!checks) continue;
      for (const f of checks.findings) {
        const existing = byCat.get(f.category);
        if (!existing || this.severityRank(f.severity) > this.severityRank(existing.severity)) {
          byCat.set(f.category, f);
        } else if (this.severityRank(f.severity) === this.severityRank(existing.severity) && f.details?.length) {
          // Merge details only when severities are equal (same level across executions)
          existing.details = [...(existing.details || []), ...f.details];
        }
      }
    }

    for (const finding of byCat.values()) {
      mergedFindings.push(finding);
      switch (finding.severity) {
        case 'pass': passed++; break;
        case 'warning': warnings++; break;
        case 'fail': failures++; break;
        case 'not_available': notAvailable++; break;
      }
    }

    return {
      totalChecks: mergedFindings.length,
      passed,
      warnings,
      failures,
      notAvailable,
      findings: mergedFindings,
    };
  }

  // `not_available` ranks BELOW pass: if any execution actually observed the
  // signal, that real observation must win the per-category merge over an
  // execution that could not observe it at all.
  private static severityRank(severity: string): number {
    switch (severity) {
      case 'fail': return 3;
      case 'warning': return 2;
      case 'pass': return 1;
      case 'not_available': return 0;
      default: return 0;
    }
  }

  private static checkConsoleLogs(logs: any, isMobile = false): HealthCheckFinding {
    // MOBILE: not observable. The runner only reads `logcat -d *:E` on the
    // FAILURE path (ErrorEvidenceCollector.collectFailureEvidence), so a
    // passing run has no logs at all; and what it does capture is unfiltered
    // system-daemon noise (TcpSocketTracker, Netd) rather than the app under
    // test. Grading that would produce false alarms, so we report the gap
    // instead of inventing a verdict either way.
    if (isMobile) {
      return {
        category: 'console_errors',
        severity: 'not_available',
        message: 'Not checked on mobile',
        unavailableReason: 'Device logs are not captured for native app runs.',
      };
    }

    // Absent data is NOT a pass — the collector should always have attached a
    // console listener, so a missing array means the signal was lost, not that
    // the run was clean.
    if (!logs || !Array.isArray(logs)) {
      return {
        category: 'console_errors',
        severity: 'not_available',
        message: 'No console data captured',
        unavailableReason: 'The run recorded no console output to evaluate.',
      };
    }

    const errors = logs.filter(
      (l: string) => typeof l === 'string' && /\[error\]/i.test(l),
    );

    if (errors.length === 0) {
      return { category: 'console_errors', severity: 'pass', message: 'No console errors' };
    }

    return {
      category: 'console_errors',
      severity: errors.length >= 5 ? 'fail' : 'warning',
      message: `${errors.length} console error${errors.length > 1 ? 's' : ''} detected`,
      details: errors.slice(0, 10).map((e: string) => ({ text: e.slice(0, 200) })),
    };
  }

  private static checkNetworkLogs(networkLogs: any, isMobile = false): HealthCheckFinding {
    // MOBILE: the runner populates network entries only from the CDP Network
    // domain, which is attached exclusively on an Android WebView context
    // switch — never for native Android, native iOS, or Flutter. Treat the
    // absence as unknown rather than clean. When a WebView run DOES yield
    // entries the check below still grades them, so this only fires on the
    // (overwhelmingly common) empty case.
    const hasEntries = Array.isArray(networkLogs) && networkLogs.length > 0;
    if (isMobile && !hasEntries) {
      return {
        category: 'network_errors',
        severity: 'not_available',
        message: 'Not checked on mobile',
        unavailableReason: 'Network traffic is not captured for native app runs.',
      };
    }

    if (!networkLogs || !Array.isArray(networkLogs)) {
      return {
        category: 'network_errors',
        severity: 'not_available',
        message: 'No network data captured',
        unavailableReason: 'The run recorded no network activity to evaluate.',
      };
    }

    const errors = networkLogs.filter(
      (nl: any) => nl.status && nl.status >= 400,
    );

    if (errors.length === 0) {
      return { category: 'network_errors', severity: 'pass', message: 'No network errors' };
    }

    const has5xx = errors.some((e: any) => e.status >= 500);

    return {
      category: 'network_errors',
      severity: has5xx ? 'fail' : 'warning',
      message: `${errors.length} network error${errors.length > 1 ? 's' : ''} (${has5xx ? 'includes 5xx' : '4xx only'})`,
      details: errors.slice(0, 10).map((e: any) => ({
        url: e.url?.slice(0, 200),
        status: e.status,
      })),
    };
  }

  // Console/network noise that is NOT a JS application bug and must never be
  // reported as an "unhandled JS exception": resources blocked by the runner's
  // own browser (ad-blockers / extensions) and generic resource-load failures.
  // These dominate the list (often dozens of identical lines) and turn a clean
  // run red for reasons the app under test has no control over.
  private static readonly JS_EXCEPTION_NOISE = [
    'err_blocked_by_client',
    'failed to load resource',
    'net::err_',
    'err_blocked_by_response',
  ];

  private static checkJsExceptions(errors: any): HealthCheckFinding {
    if (!errors || !Array.isArray(errors) || errors.length === 0) {
      return { category: 'js_exceptions', severity: 'pass', message: 'No JS exceptions' };
    }

    // Normalize each entry to a clean, non-empty string. Objects may carry the
    // text under message/text/description; anything that ends up empty is
    // dropped (previously these rendered as a literal "undefined" line).
    const normalized = errors
      .map((e: any) => {
        const raw =
          typeof e === 'string'
            ? e
            : (e?.message || e?.text || e?.description || '');
        return String(raw).trim();
      })
      .filter((s: string) => s.length > 0);

    // Drop runner/ad-blocker noise — not application JS exceptions.
    const real = normalized.filter(
      (s: string) => !this.JS_EXCEPTION_NOISE.some((n) => s.toLowerCase().includes(n)),
    );

    if (real.length === 0) {
      return { category: 'js_exceptions', severity: 'pass', message: 'No JS exceptions' };
    }

    // Dedupe identical messages, keeping a count so "x27" reads as one row.
    const counts = new Map<string, number>();
    for (const s of real) {
      const key = s.slice(0, 200);
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const details = Array.from(counts.entries())
      .slice(0, 5)
      .map(([text, count]) => ({ text: count > 1 ? `${text}  (×${count})` : text }));

    return {
      category: 'js_exceptions',
      severity: 'fail',
      message: `${real.length} unhandled JS exception${real.length > 1 ? 's' : ''}`,
      details,
    };
  }

  private static checkBrokenImages(testResult: any): HealthCheckFinding {
    // Quality checks may include broken resources from QualityChecksCollector
    const brokenResources = testResult.quality_checks?.brokenResources;
    if (!brokenResources || !Array.isArray(brokenResources) || brokenResources.length === 0) {
      return { category: 'broken_images', severity: 'pass', message: 'No broken images' };
    }

    return {
      category: 'broken_images',
      severity: 'warning',
      message: `${brokenResources.length} broken resource${brokenResources.length > 1 ? 's' : ''}`,
      details: brokenResources.slice(0, 10).map((r: any) => ({
        url: typeof r === 'string' ? r.slice(0, 200) : (r.url || '').slice(0, 200),
      })),
    };
  }

  private static checkPageResponsive(testResult: any): HealthCheckFinding {
    // If test completed without timeout/crash, page is considered responsive
    // A failed test with timeout may indicate unresponsive page
    const hasTimeout = testResult.error_message
      && typeof testResult.error_message === 'string'
      && /timeout|timed?\s*out/i.test(testResult.error_message);

    if (hasTimeout) {
      return {
        category: 'page_responsive',
        severity: 'fail',
        message: 'Page became unresponsive (timeout detected)',
      };
    }

    return { category: 'page_responsive', severity: 'pass', message: 'Page responsive' };
  }
}
