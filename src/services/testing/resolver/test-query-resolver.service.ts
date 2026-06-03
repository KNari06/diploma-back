/**
 * Test Query Resolver
 *
 * Maps a natural-language DESCRIPTOR ("payment tests", "the login flow",
 * "smoke-tagged", "Release v2 plan") to concrete entity IDs within a project.
 *
 * Distinct from TestCaseResolverService:
 *   - TestCaseResolverService answers "does THIS message correspond to one
 *     existing test case to replay?" → returns a single best match + prefilled
 *     steps for the platform_test replay path.
 *   - TestQueryResolver answers "which entities does this DESCRIPTOR select?"
 *     → returns N candidate IDs + a resolution verdict, for management/run
 *     handlers (add_to_plan, run_by_tag, manage_*, the compound splitter).
 *
 * Both share the scoring primitives in ./resolver-scoring (DRY).
 *
 * Scope & auth: the caller passes an ALREADY workspace-validated `projectId`
 * (see resolveProjectId in src/api/chat/regression/project-resolver.ts). This
 * service never widens scope beyond that project — it only reads, never writes.
 */

import { logger } from '@/utils/core/logger';
import { fetchResolverEntities, type ResolverEntityRow } from './db/resolver-query.db';
import {
  combinedScore,
  computeNameSimilarity,
  cosineSimilarity,
  generateEmbedding,
  getCachedEmbedding,
} from './resolver-scoring';
import type { QueryCandidate, QuerySelectorType, TestQueryResult } from './resolver.types';

// ============================================================================
// CONFIG
// ============================================================================

const DEFAULT_MAX_CANDIDATES = 8;

// A candidate is a confident "unique" pick when its score clears this floor
// AND it leads the runner-up by at least this margin. Tuned conservatively:
// when unsure we return 'ambiguous' and let ENRICH/the user decide rather than
// silently acting on the wrong entity.
const UNIQUE_SCORE_FLOOR = 0.6;
const UNIQUE_LEAD_MARGIN = 0.15;

// Below this, a candidate is noise and dropped from the result entirely.
const MIN_KEEP_SCORE = 0.12;

// Embedding scoring is only worth it for free-text test/keyword descriptors.
// tag/module/plan/flow selectors resolve on name/tag overlap alone (cheaper,
// no LLM/embedding round-trip).
const EMBEDDING_TYPES: ReadonlySet<QuerySelectorType> = new Set(['test_case', 'keyword']);

const RESOLVE_TIMEOUT_MS = 5000;

// ============================================================================
// SERVICE
// ============================================================================

export interface ResolveQueryParams {
  descriptor: string;
  selectorType: QuerySelectorType;
  /** Already workspace-validated by the caller. */
  projectId: string;
  maxCandidates?: number;
}

export class TestQueryResolverService {
  /**
   * Resolve a descriptor to candidate IDs. Never throws — on any failure it
   * returns `{ candidates: [], resolution: 'none' }` so callers degrade to a
   * clarification rather than an error.
   */
  static async resolve(params: ResolveQueryParams): Promise<TestQueryResult> {
    const maxCandidates = params.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

    try {
      const rows = await fetchResolverEntities(params.selectorType, params.projectId);
      if (rows.length === 0) {
        return { candidates: [], resolution: 'none' };
      }

      // Tag selector is exact-ish set membership, not similarity ranking.
      if (params.selectorType === 'tag') {
        return this.resolveByTag(params.descriptor, rows, maxCandidates);
      }

      const scored = await this.scoreRows(params.descriptor, rows, params.selectorType);
      return this.finalize(scored, maxCandidates);
    } catch (err) {
      logger.warn('[TEST_QUERY_RESOLVER] resolve failed', {
        selectorType: params.selectorType,
        error: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], resolution: 'none' };
    }
  }

  // --------------------------------------------------------------------------
  // Tag membership
  // --------------------------------------------------------------------------

  private static resolveByTag(
    descriptor: string,
    rows: ResolverEntityRow[],
    maxCandidates: number,
  ): TestQueryResult {
    // Normalize the descriptor into one-or-more candidate tag tokens.
    const wanted = descriptor
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !STOPWORD_TAGS.has(t));

    if (wanted.length === 0) return { candidates: [], resolution: 'none' };

    const matched = rows.filter((r) =>
      (r.tags || []).some((tag) => {
        const t = tag.toLowerCase();
        return wanted.some((w) => t === w || t.includes(w) || w.includes(t));
      }),
    );

    // Tag matches are equally valid set members — score 1, never "unique".
    const candidates: QueryCandidate[] = matched
      .slice(0, maxCandidates)
      .map((r) => ({ id: r.id, name: r.name, url: r.url, tags: r.tags, score: 1 }));

    return {
      candidates,
      resolution: candidates.length === 0 ? 'none' : 'ambiguous',
    };
  }

  // --------------------------------------------------------------------------
  // Similarity scoring (hybrid for test/keyword, name-only otherwise)
  // --------------------------------------------------------------------------

  private static async scoreRows(
    descriptor: string,
    rows: ResolverEntityRow[],
    selectorType: QuerySelectorType,
  ): Promise<QueryCandidate[]> {
    const useEmbeddings = EMBEDDING_TYPES.has(selectorType);

    let messageEmbedding: number[] | null = null;
    let candidateEmbeddings: (number[] | null)[] = [];

    if (useEmbeddings) {
      // Bound embedding work by a timeout; on miss, fall back to name-only.
      const embedded = await Promise.race([
        this.embedAll(descriptor, rows),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS)),
      ]).catch(() => null);

      if (embedded) {
        messageEmbedding = embedded.message;
        candidateEmbeddings = embedded.candidates;
      } else {
        logger.warn('[TEST_QUERY_RESOLVER] embedding timeout, name-only fallback', {
          selectorType,
        });
      }
    }

    return rows.map((row, idx) => {
      const nameSim = computeNameSimilarity(
        descriptor,
        [row.name, row.description].filter(Boolean).join(' '),
      );
      const embeddingSim =
        messageEmbedding && candidateEmbeddings[idx]
          ? cosineSimilarity(messageEmbedding, candidateEmbeddings[idx]!)
          : 0;

      // URL is not a meaningful signal for descriptor selection (the descriptor
      // is "payment tests", not a page), so urlScore stays 0 here; the weights
      // renormalize naturally because name+embedding dominate.
      const score = messageEmbedding
        ? combinedScore(embeddingSim, nameSim, 0)
        : nameSim;

      return { id: row.id, name: row.name, url: row.url, tags: row.tags, score };
    });
  }

  private static async embedAll(
    descriptor: string,
    rows: ResolverEntityRow[],
  ): Promise<{ message: number[]; candidates: (number[] | null)[] }> {
    const [message, candidates] = await Promise.all([
      generateEmbedding(descriptor),
      Promise.all(
        rows.map((r) =>
          getCachedEmbedding(
            `tqr:${r.id}`,
            [r.name, r.description].filter(Boolean).join(' — '),
          ),
        ),
      ),
    ]);
    return { message, candidates };
  }

  // --------------------------------------------------------------------------
  // Finalize: sort, drop noise, decide resolution
  // --------------------------------------------------------------------------

  private static finalize(scored: QueryCandidate[], maxCandidates: number): TestQueryResult {
    return decideResolution(scored, maxCandidates);
  }
}

/**
 * Pure decision step: rank, drop noise, and classify as unique/ambiguous/none.
 * Exported for unit testing the threshold logic without a DB.
 */
export function decideResolution(
  scored: QueryCandidate[],
  maxCandidates: number,
): TestQueryResult {
  const ranked = scored
    .filter((c) => c.score >= MIN_KEEP_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);

  if (ranked.length === 0) return { candidates: [], resolution: 'none' };

  const top = ranked[0];
  const runnerUp = ranked[1];
  const isUnique =
    top.score >= UNIQUE_SCORE_FLOOR &&
    (!runnerUp || top.score - runnerUp.score >= UNIQUE_LEAD_MARGIN);

  return {
    candidates: ranked,
    resolution: isUnique ? 'unique' : 'ambiguous',
    topId: isUnique ? top.id : undefined,
  };
}

// Common filler words that should never be treated as tag tokens.
const STOPWORD_TAGS = new Set([
  'the', 'all', 'my', 'tests', 'test', 'tag', 'tagged', 'with',
  'все', 'мои', 'тесты', 'тест', 'тег', 'тегом', 'с',
]);
