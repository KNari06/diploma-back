import { ApiFuzzingFormatterService } from '../api-fuzzing-formatter.service';

// Minimal FuzzingReport-shaped fixture (cast through any — we exercise the
// formatter's public output, not the type).
const makeReport = (overrides: any = {}): any => ({
  summary: { totalTests: 10, passed: 8, failed: 2, duration: 3400 },
  issues: [],
  securityScore: 8,
  scenarios: [
    { passed: true, scenario: { type: 'authentication' } },
    { passed: true, scenario: { type: 'authorization' } },
    { passed: false, scenario: { type: 'security' } },
  ],
  recommendations: [],
  ...overrides,
});

const format = (o?: any) => ApiFuzzingFormatterService.formatComprehensiveReport(makeReport(o));

describe('formatComprehensiveReport — structure', () => {
  it('includes the header, disclaimer, summary, score, and footer', () => {
    const out = format();
    expect(out).toContain('Comprehensive API Security Testing Report');
    expect(out).toContain('No state mutation');
    expect(out).toContain('Test Summary');
    expect(out).toContain('Total Tests: 10');
    expect(out).toContain('Security Score');
    expect(out).toContain('Next Steps');
  });

  it('computes the pass rate and renders the duration in seconds', () => {
    const out = format();
    expect(out).toContain('(80.0%)'); // 8/10
    expect(out).toContain('3.40s'); // 3400ms
  });

  it('breaks down the test categories with friendly names', () => {
    const out = format();
    expect(out).toContain('🔒 Authentication');
    expect(out).toContain('🚫 Authorization');
  });
});

describe('formatComprehensiveReport — issues', () => {
  it('shows the no-issues message when the report is clean', () => {
    const out = format({ issues: [] });
    expect(out).toContain('No Security Issues Found');
  });

  it('renders each issue with severity, CWE reference, and evidence', () => {
    const out = format({
      issues: [
        {
          severity: 'critical',
          title: 'SQL Injection',
          type: 'security',
          description: 'Injectable parameter',
          risk: 'Data exfiltration',
          recommendation: 'Use parameterized queries',
          cwe: 'CWE-89',
          evidence: 'payload: 1 OR 1=1',
        },
      ],
    });
    expect(out).toContain('Security Issues Found');
    expect(out).toContain('🔴 CRITICAL: SQL Injection');
    expect(out).toContain('cwe.mitre.org/data/definitions/89.html');
    expect(out).toContain('payload: 1 OR 1=1');
    expect(out).not.toContain('No Security Issues Found');
  });
});

describe('formatComprehensiveReport — security score thresholds', () => {
  it.each([
    [9.5, '🏆', 'Excellent Security'],
    [7.5, '✅', 'Good Security'],
    [5.5, '⚠️', 'Moderate Security'],
    [3.5, '❌', 'Poor Security'],
    [1, '❌', 'Critical Security Issues'],
  ])('score %s → %s %s', (score, emoji, label) => {
    const out = format({ securityScore: score });
    expect(out).toContain(`${(score as number).toFixed(1)}/10`);
    expect(out).toContain(emoji as string);
    expect(out).toContain(label as string);
  });
});

describe('formatComprehensiveReport — good practices & recommendations', () => {
  it('lists good practices derived from passed scenarios', () => {
    const out = format();
    expect(out).toContain('Good Security Practices Detected');
    expect(out).toContain('Authentication properly enforced (1 tests passed)');
    expect(out).toContain('Authorization controls working (1 tests passed)');
  });

  it('omits the good-practices block when no scenario passed', () => {
    const out = format({ scenarios: [{ passed: false, scenario: { type: 'security' } }] });
    expect(out).not.toContain('Good Security Practices Detected');
  });

  it('renders numbered recommendations when present', () => {
    const out = format({ recommendations: ['Add rate limiting', 'Enforce HTTPS'] });
    expect(out).toContain('Recommendations');
    expect(out).toContain('1. Add rate limiting');
    expect(out).toContain('2. Enforce HTTPS');
  });
});
