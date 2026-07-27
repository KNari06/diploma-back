import { TaskReadinessService } from '../task-readiness.service';
import type { JiraRelatedContext } from '@/services/api/jira.service';
import type { CoverageGap } from '@/types/testing.types';
import type { ResolvedTestCase } from '@/services/testing/resolver/resolver.types';

describe('TaskReadinessService.sanitizeReadiness', () => {
  it('enforces the invariant: NEEDS_REWORK is never readyToTest, even if the LLM says so', () => {
    const r = TaskReadinessService.sanitizeReadiness(
      { readinessScore: 95, readyToTest: true, coverageGaps: [], summary: 'looks fine' },
      'NEEDS_REWORK',
    );
    expect(r.readyToTest).toBe(false);
  });

  it('allows readyToTest only when outcome is not rework AND score >= threshold', () => {
    expect(
      TaskReadinessService.sanitizeReadiness(
        { readinessScore: 80, readyToTest: true, coverageGaps: [] }, 'CAN_RUN_AUTO',
      ).readyToTest,
    ).toBe(true);

    // Below threshold → not ready even if the LLM claims ready.
    expect(
      TaskReadinessService.sanitizeReadiness(
        { readinessScore: 60, readyToTest: true, coverageGaps: [] }, 'CAN_RUN_AUTO',
      ).readyToTest,
    ).toBe(false);
  });

  it('drops gaps with an unknown type or empty title/why (anti-hallucination hardening)', () => {
    const r = TaskReadinessService.sanitizeReadiness(
      {
        readinessScore: 70,
        readyToTest: false,
        coverageGaps: [
          { type: 'negative', title: 'Bad email rejected', why: 'form validation' }, // keep
          { type: 'made_up_type', title: 'x', why: 'y' },                              // drop (type)
          { type: 'boundary', title: '', why: 'missing title' },                       // drop (title)
          { type: 'permission', title: 'guest access', why: '' },                      // drop (why)
        ],
      },
      'PREPARE_MANUAL',
    );
    expect(r.coverageGaps).toHaveLength(1);
    expect(r.coverageGaps[0].type).toBe('negative');
  });

  it('clamps score to 0-100 and an unknown priority to medium', () => {
    const r = TaskReadinessService.sanitizeReadiness(
      {
        readinessScore: 999,
        readyToTest: false,
        coverageGaps: [{ type: 'error_state', title: 't', why: 'w', priority: 'urgent' }],
      },
      'PREPARE_MANUAL',
    );
    expect(r.readinessScore).toBe(100);
    expect(r.coverageGaps[0].priority).toBe('medium');
  });

  it('caps gaps at 8', () => {
    const gaps = Array.from({ length: 20 }, (_, i) => ({
      type: 'negative', title: `t${i}`, why: `w${i}`,
    }));
    const r = TaskReadinessService.sanitizeReadiness(
      { readinessScore: 50, readyToTest: false, coverageGaps: gaps }, 'PREPARE_MANUAL',
    );
    expect(r.coverageGaps).toHaveLength(8);
  });

  it('returns a safe default (never throws) when the block is missing/garbage', () => {
    expect(() => TaskReadinessService.sanitizeReadiness(undefined, 'PREPARE_MANUAL')).not.toThrow();
    const r = TaskReadinessService.sanitizeReadiness('not-an-object' as unknown, 'CAN_RUN_AUTO');
    expect(r.coverageGaps).toEqual([]);
    expect(typeof r.readinessScore).toBe('number');
    expect(r.readyToTest).toBe(false); // no readyToTest flag → false
  });

  it('preserves relatedTicket when present', () => {
    const r = TaskReadinessService.sanitizeReadiness(
      {
        readinessScore: 55, readyToTest: false,
        coverageGaps: [{ type: 'related_flow', title: 'checkout breaks', why: 'linked', relatedTicket: 'PROJ-88' }],
      },
      'CAN_RUN_AUTO',
    );
    expect(r.coverageGaps[0].relatedTicket).toBe('PROJ-88');
  });
});

describe('TaskReadinessService.buildRelatedTicketsContext', () => {
  it('renders parent, subtasks, links, and comments; empty for null', () => {
    expect(TaskReadinessService.buildRelatedTicketsContext(null)).toBe('');

    const related: JiraRelatedContext = {
      parent: { key: 'EPIC-1', summary: 'Checkout epic' },
      subtasks: [{ key: 'SUB-2', summary: 'Add card form', status: 'In Progress' }],
      links: [{ type: 'blocks', direction: 'outward', key: 'PROJ-88', summary: 'Payment refactor', status: 'Done' }],
      comments: [{ author: 'Dana', created: '2026-07-01', text: 'Repro only on Safari' }],
    };
    const out = TaskReadinessService.buildRelatedTicketsContext(related);
    expect(out).toContain('EPIC-1');
    expect(out).toContain('SUB-2');
    expect(out).toContain('PROJ-88');
    expect(out).toContain('Repro only on Safari');
  });
});

describe('TaskReadinessService.scopeCoverageGaps', () => {
  const gap = (url: string, type: CoverageGap['type'] = 'untested_url'): CoverageGap => ({
    type, title: `gap ${url}`, description: 'd', url, priority: 'high',
  });

  it('keeps gaps whose URL matches the ticket URL or shares its first path segment', () => {
    const gaps: CoverageGap[] = [
      gap('https://app.example.com/checkout'),
      gap('https://app.example.com/checkout/step2'),
      gap('https://app.example.com/settings'), // unrelated
    ];
    const scoped = TaskReadinessService.scopeCoverageGaps(gaps, 'https://app.example.com/checkout', []);
    const urls = scoped.map((g) => g.url);
    expect(urls).toContain('https://app.example.com/checkout');
    expect(urls).toContain('https://app.example.com/checkout/step2');
    expect(urls).not.toContain('https://app.example.com/settings');
  });

  it('matches against matched test-case URLs too', () => {
    const cases = [{ url: 'https://app.example.com/login' } as ResolvedTestCase];
    const scoped = TaskReadinessService.scopeCoverageGaps(
      [gap('https://app.example.com/login')], null, cases,
    );
    expect(scoped).toHaveLength(1);
  });

  it('drops no_test_case gaps and returns [] when there is nothing to scope against', () => {
    const gaps: CoverageGap[] = [
      { type: 'no_test_case', title: 'orphan', description: 'd', priority: 'low' },
      gap('https://app.example.com/x'),
    ];
    // No ticket URL and no cases → nothing to scope against → empty.
    expect(TaskReadinessService.scopeCoverageGaps(gaps, null, [])).toEqual([]);
  });
});
