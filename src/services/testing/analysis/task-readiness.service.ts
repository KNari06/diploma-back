/**
 * Task Readiness Service
 *
 * Deterministic helpers around the Jira triage + readiness LLM call:
 *   - buildRelatedTicketsContext / buildCoverageContext — turn fetched data into
 *     bounded prompt strings.
 *   - scopeCoverageGaps — narrow a PROJECT-WIDE CoverageReport down to gaps
 *     relevant to THIS ticket's feature (by URL), so only useful signal reaches
 *     the prompt.
 *   - sanitizeReadiness — validate + clamp the LLM's readiness block and enforce
 *     the readiness/rework invariant. Pure function → unit-testable.
 *
 * No `supabaseAdmin` import — consumes data passed in by the caller (the
 * orchestrator / controller assembles the sources).
 */

import type { JiraRelatedContext } from '@/services/api/jira.service';
import type { ResolvedTestCase } from '@/services/testing/resolver/resolver.types';
import type {
  CoverageGap,
  JiraQaOutcome,
  ReadinessCoverageGap,
  ReadinessGapType,
  TaskReadinessAssessment,
} from '@/types/testing.types';
import { firstPathSegment, normalizeCoverageUrl } from '@/utils/parsing/url-scope';

const GAP_TYPES: ReadinessGapType[] = [
  'negative', 'boundary', 'related_flow', 'error_state', 'permission', 'data_variation',
];
const PRIORITIES = ['high', 'medium', 'low'] as const;
const MAX_GAPS = 8;
const MAX_SCOPED_COVERAGE = 3;
const READY_SCORE_THRESHOLD = 70;

export class TaskReadinessService {
  /**
   * Build a bounded prompt string from a ticket's related context
   * (parent/epic, subtasks, linked issues, recent comments). Empty string when
   * there is nothing to show.
   */
  static buildRelatedTicketsContext(related: JiraRelatedContext | null | undefined): string {
    if (!related) return '';
    const lines: string[] = [];

    if (related.parent?.key) {
      lines.push(`Parent/epic ${related.parent.key}: ${related.parent.summary}`.trim());
    }
    for (const s of related.subtasks || []) {
      lines.push(`Subtask ${s.key}${s.status ? ` [${s.status}]` : ''}: ${s.summary}`.trim());
    }
    for (const l of related.links || []) {
      lines.push(`${l.type} ${l.key}${l.status ? ` [${l.status}]` : ''}: ${l.summary}`.trim());
    }
    for (const c of related.comments || []) {
      const who = c.author ? `${c.author}: ` : '';
      lines.push(`Comment — ${who}${c.text}`.trim());
    }

    return lines.filter(Boolean).join('\n');
  }

  /**
   * Narrow project-wide coverage gaps to those relevant to this ticket's feature.
   * A gap is relevant when its URL normalizes to the ticket URL or a matched
   * test-case URL, OR shares the same first path segment (so `/checkout` matches
   * `/checkout/step2`). `no_test_case` gaps (no URL, project-hygiene noise) are
   * dropped. Capped to the top few by priority.
   */
  static scopeCoverageGaps(
    gaps: CoverageGap[] | null | undefined,
    ticketUrl: string | null | undefined,
    existingCases: ResolvedTestCase[] | null | undefined,
  ): CoverageGap[] {
    if (!gaps?.length) return [];

    const relevantUrls = new Set<string>();
    const relevantSegments = new Set<string>();
    const addUrl = (u?: string | null) => {
      if (!u) return;
      relevantUrls.add(normalizeCoverageUrl(u));
      const seg = firstPathSegment(u);
      if (seg) relevantSegments.add(seg);
    };
    addUrl(ticketUrl);
    for (const c of existingCases || []) addUrl(c.url);

    // Nothing to scope against → don't flood the prompt with unrelated project gaps.
    if (relevantUrls.size === 0 && relevantSegments.size === 0) return [];

    const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };

    return gaps
      .filter((g) => g.type !== 'no_test_case' && !!g.url)
      .filter((g) => {
        const norm = normalizeCoverageUrl(g.url!);
        if (relevantUrls.has(norm)) return true;
        const seg = firstPathSegment(g.url!);
        return !!seg && relevantSegments.has(seg);
      })
      .sort((a, b) => (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2))
      .slice(0, MAX_SCOPED_COVERAGE);
  }

  /** Render scoped coverage gaps into a short bulleted prompt string. */
  static buildCoverageContext(scopedGaps: CoverageGap[]): string {
    if (!scopedGaps.length) return '';
    return scopedGaps
      .map((g) => `- [${g.priority.toUpperCase()}] ${g.type}: ${g.title}`)
      .join('\n');
  }

  /**
   * Validate + clamp the LLM's `readiness` block and enforce the invariant that
   * a NEEDS_REWORK ticket is never `readyToTest`. `outcome` is the triage
   * outcome decided in the SAME response. Returns a safe default when the block
   * is missing/garbage (never throws).
   */
  static sanitizeReadiness(raw: unknown, outcome: JiraQaOutcome): TaskReadinessAssessment {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    // Score: clamp to 0-100; default mid when absent.
    let score = typeof obj.readinessScore === 'number' && Number.isFinite(obj.readinessScore)
      ? Math.round(obj.readinessScore)
      : 50;
    score = Math.max(0, Math.min(100, score));

    const gaps = this.sanitizeGaps(obj.coverageGaps);

    const blockingQuestions = Array.isArray(obj.blockingQuestions)
      ? (obj.blockingQuestions as unknown[])
          .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
          .map((q) => q.trim())
          .slice(0, 3)
      : [];

    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';

    // Invariant (enforced in code, not trusted to the LLM):
    //  - NEEDS_REWORK → cannot start → never ready.
    //  - readyToTest true only when NOT rework AND score >= threshold.
    const llmReady = obj.readyToTest === true;
    const readyToTest = outcome !== 'NEEDS_REWORK' && llmReady && score >= READY_SCORE_THRESHOLD;

    return { readinessScore: score, readyToTest, blockingQuestions, coverageGaps: gaps, summary };
  }

  private static sanitizeGaps(raw: unknown): ReadinessCoverageGap[] {
    if (!Array.isArray(raw)) return [];
    const out: ReadinessCoverageGap[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const g = item as Record<string, unknown>;
      const type = g.type as ReadinessGapType;
      const title = typeof g.title === 'string' ? g.title.trim() : '';
      const why = typeof g.why === 'string' ? g.why.trim() : '';
      // Drop unknown type or empty title/why (anti-hallucination hardening).
      if (!GAP_TYPES.includes(type) || !title || !why) continue;
      const priority = (PRIORITIES as readonly string[]).includes(g.priority as string)
        ? (g.priority as 'high' | 'medium' | 'low')
        : 'medium';
      const gap: ReadinessCoverageGap = { type, title, why, priority };
      if (typeof g.relatedTicket === 'string' && g.relatedTicket.trim()) {
        gap.relatedTicket = g.relatedTicket.trim();
      }
      out.push(gap);
      if (out.length >= MAX_GAPS) break;
    }
    return out;
  }
}
