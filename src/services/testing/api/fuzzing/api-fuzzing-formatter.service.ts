import { FuzzingReport, SecurityIssue, IssueSeverity } from '@/types';

/**
 * API Fuzzing Report Formatter
 * Formats fuzzing results into user-friendly reports
 */
export class ApiFuzzingFormatterService {
  /**
   * Format comprehensive fuzzing report for user
   */
  static formatComprehensiveReport(report: FuzzingReport): string {
    let formatted = '';

    // Header
    formatted += this.formatHeader();

    // Summary
    formatted += this.formatSummary(report);

    // Issues (if any)
    if (report.issues.length > 0) {
      formatted += this.formatIssues(report.issues);
    } else {
      formatted += '\n\n✅ **No Security Issues Found!**\n';
      formatted += 'All negative test scenarios passed. The API appears to be well-secured.\n';
    }

    // Security Score
    formatted += this.formatSecurityScore(report.securityScore);

    // Good Practices
    formatted += this.formatGoodPractices(report);

    // Recommendations
    if (report.recommendations.length > 0) {
      formatted += this.formatRecommendations(report.recommendations);
    }

    // Footer
    formatted += this.formatFooter();

    return formatted;
  }

  /**
   * Format report header
   */
  private static formatHeader(): string {
    return `🔒 **Comprehensive API Security Testing Report**\n\n`;
  }

  /**
   * Format test summary
   */
  private static formatSummary(report: FuzzingReport): string {
    const { summary } = report;
    const passRate = ((summary.passed / summary.totalTests) * 100).toFixed(1);

    let formatted = '📊 **Test Summary**\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    formatted += `• Total Tests: ${summary.totalTests}\n`;
    formatted += `• Passed: ✅ ${summary.passed} (${passRate}%)\n`;
    formatted += `• Failed: ❌ ${summary.failed}\n`;
    formatted += `• Duration: ${(summary.duration / 1000).toFixed(2)}s\n\n`;

    // Test categories breakdown
    const byType = this.groupByType(report);
    formatted += '**Test Categories:**\n';
    Object.entries(byType).forEach(([type, count]) => {
      formatted += `• ${this.formatTypeName(type)}: ${count}\n`;
    });

    return formatted + '\n';
  }

  /**
   * Format security issues
   */
  private static formatIssues(issues: SecurityIssue[]): string {
    let formatted = '🐛 **Security Issues Found**\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    issues.forEach((issue, index) => {
      formatted += this.formatSingleIssue(issue, index + 1);
      formatted += '\n';
    });

    return formatted;
  }

  /**
   * Format single security issue
   */
  private static formatSingleIssue(issue: SecurityIssue, number: number): string {
    const severityEmoji = this.getSeverityEmoji(issue.severity);
    const severityLabel = issue.severity.toUpperCase();

    let formatted = `**${number}. ${severityEmoji} ${severityLabel}: ${issue.title}**\n\n`;
    formatted += `**Category:** ${this.formatTypeName(issue.type)}\n`;
    formatted += `**Description:** ${issue.description}\n\n`;
    formatted += `**Risk:** ${issue.risk}\n\n`;
    formatted += `**Recommendation:** ${issue.recommendation}\n\n`;

    if (issue.cwe) {
      formatted += `**Reference:** [${issue.cwe}](https://cwe.mitre.org/data/definitions/${issue.cwe.replace('CWE-', '')}.html)\n\n`;
    }

    // Evidence with full test details
    formatted += `**📋 Test Details:**\n`;
    formatted += '```\n' + issue.evidence + '\n```\n\n';
    formatted += '─────────────────────────────────────────────\n\n';

    return formatted;
  }

  /**
   * Format security score
   */
  private static formatSecurityScore(score: number): string {
    let formatted = '🎯 **Security Score**\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    const scoreEmoji = this.getScoreEmoji(score);
    const scoreLabel = this.getScoreLabel(score);

    formatted += `${scoreEmoji} **${score.toFixed(1)}/10** - ${scoreLabel}\n\n`;

    // Score explanation
    formatted += this.getScoreExplanation(score) + '\n\n';

    return formatted;
  }

  /**
   * Format good practices found
   */
  private static formatGoodPractices(report: FuzzingReport): string {
    const passedScenarios = report.scenarios.filter(s => s.passed);

    if (passedScenarios.length === 0) {
      return '';
    }

    let formatted = '✅ **Good Security Practices Detected**\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    // Group passed tests by type
    const byType = passedScenarios.reduce((acc, s) => {
      acc[s.scenario.type] = (acc[s.scenario.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Generate positive messages
    if (byType.authentication) {
      formatted += `• Authentication properly enforced (${byType.authentication} tests passed)\n`;
    }
    if (byType.authorization) {
      formatted += `• Authorization controls working (${byType.authorization} tests passed)\n`;
    }
    if (byType.security) {
      formatted += `• Input sanitization active (${byType.security} tests passed)\n`;
    }
    if (byType.method_validation) {
      formatted += `• HTTP methods properly validated (${byType.method_validation} tests passed)\n`;
    }
    if (byType.payload_validation) {
      formatted += `• Request validation working (${byType.payload_validation} tests passed)\n`;
    }

    return formatted + '\n';
  }

  /**
   * Format recommendations
   */
  private static formatRecommendations(recommendations: string[]): string {
    let formatted = '📈 **Recommendations**\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    recommendations.forEach((rec, index) => {
      formatted += `${index + 1}. ${rec}\n`;
    });

    return formatted + '\n';
  }

  /**
   * Format report footer
   */
  private static formatFooter(): string {
    let formatted = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    formatted += '💡 **Next Steps:**\n';
    formatted += '• Review and fix critical/high severity issues immediately\n';
    formatted += '• Implement recommended security controls\n';
    formatted += '• Re-test after fixes to verify improvements\n';
    formatted += '• Consider regular security testing as part of CI/CD\n\n';
    formatted += '_Report generated by QAIT Intelligent API Fuzzer_\n';

    return formatted;
  }

  /**
   * Get emoji for severity level
   */
  private static getSeverityEmoji(severity: IssueSeverity): string {
    const emojiMap: Record<IssueSeverity, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🔵',
      info: '⚪',
    };
    return emojiMap[severity];
  }

  /**
   * Get emoji for score
   */
  private static getScoreEmoji(score: number): string {
    if (score >= 9) return '🏆';
    if (score >= 7) return '✅';
    if (score >= 5) return '⚠️';
    return '❌';
  }

  /**
   * Get score label
   */
  private static getScoreLabel(score: number): string {
    if (score >= 9) return 'Excellent Security';
    if (score >= 7) return 'Good Security';
    if (score >= 5) return 'Moderate Security';
    if (score >= 3) return 'Poor Security';
    return 'Critical Security Issues';
  }

  /**
   * Get score explanation
   */
  private static getScoreExplanation(score: number): string {
    if (score >= 9) {
      return 'Your API demonstrates excellent security practices with minimal vulnerabilities.';
    }
    if (score >= 7) {
      return 'Your API has good security controls, but there are some areas for improvement.';
    }
    if (score >= 5) {
      return 'Your API has moderate security. Several vulnerabilities need attention.';
    }
    if (score >= 3) {
      return 'Your API has significant security weaknesses that should be addressed urgently.';
    }
    return 'Your API has critical security issues that require immediate attention.';
  }

  /**
   * Format type name for display
   */
  private static formatTypeName(type: string): string {
    const nameMap: Record<string, string> = {
      authentication: '🔒 Authentication',
      authorization: '🚫 Authorization',
      method_validation: '⚠️ Method Validation',
      payload_validation: '💣 Payload Validation',
      security: '🛡️ Security',
      rate_limiting: '⚡ Rate Limiting',
      performance: '⏱️ Performance',
    };
    return nameMap[type] || type;
  }

  /**
   * Group scenarios by type
   */
  private static groupByType(report: FuzzingReport): Record<string, number> {
    return report.scenarios.reduce((acc, s) => {
      acc[s.scenario.type] = (acc[s.scenario.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }
}
