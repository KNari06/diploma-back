import { cosineSimilarity, generateEmbedding } from '@/services/ai/embedding.service';
import type { OverallCluster, OverallEdge } from '@/types/overall.types';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OVERALL RELATIONSHIP SERVICE - Test relationship analysis and clustering
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Analyzes relationships between tests using multiple strategies:
 * 1. URL relationships (flow continuation, shared URLs, same domain)
 * 2. Page flow patterns (logical sequences like login → dashboard)
 * 3. Temporal proximity (tests run close in time)
 * 4. Semantic similarity (embeddings-based goal matching)
 *
 * Key Features:
 * - Multi-factor relationship scoring
 * - Automatic cluster detection
 * - Rate-limited embedding calls
 * - Graceful degradation on errors
 */

// Limits for performance and API costs
const MAX_SEMANTIC_COMPARISONS = 200; // Limit expensive embedding comparisons
const SEMANTIC_SIMILARITY_THRESHOLD = 0.7; // Min similarity for edge creation

/**
 * Service for analyzing relationships between tests and building clusters
 * Uses rule-based approach with embeddings/LLM for semantic similarity
 */
export class OverallRelationshipService {
  /**
   * Build edges and clusters for project tests
   *
   * @param tests - Array of test records
   * @param sessionsMap - Map of testId -> intelligent session data
   * @returns Object with edges (relationships) and clusters (groups)
   */
  static async buildRelationshipsAndClusters(
    tests: any[],
    sessionsMap: Map<string, any>
  ): Promise<{ edges: OverallEdge[]; clusters: OverallCluster[] }> {
    try {
      logger.info('[RELATIONSHIP] Building relationships and clusters', {
        testsCount: tests.length,
      });

      if (tests.length === 0) {
        return { edges: [], clusters: [] };
      }

      // Build edges based on relationships
      const edges: OverallEdge[] = [];
      const relationshipScores = new Map<string, Map<string, RelationshipScore>>();

      // ✅ Performance: Limit semantic comparisons for large projects
      let semanticComparisonsCount = 0;

      // Compare each test pair
      for (let i = 0; i < tests.length; i++) {
        for (let j = i + 1; j < tests.length; j++) {
          const test1 = tests[i];
          const test2 = tests[j];
          const session1 = sessionsMap.get(test1.id);
          const session2 = sessionsMap.get(test2.id);

          // ✅ Performance: Skip semantic similarity if limit reached
          const skipSemantic =
            semanticComparisonsCount >= MAX_SEMANTIC_COMPARISONS;

          // Calculate relationship score
          const score = await this.calculateRelationshipScore(
            test1,
            test2,
            session1,
            session2,
            skipSemantic
          );

          if (!skipSemantic && score.usedSemantic) {
            semanticComparisonsCount++;
          }

          // Only create edge if confidence is high enough
          if (score.totalConfidence >= 0.5) {
            const edgeId = `edge_${test1.id.substring(0, 8)}_${test2.id.substring(
              0,
              8
            )}`;

            edges.push({
              id: edgeId,
              source: test1.id,
              target: test2.id,
              relationshipType: score.primaryType,
              confidence: score.totalConfidence,
              reasons: score.reasons,
            });

            // Store for clustering
            if (!relationshipScores.has(test1.id)) {
              relationshipScores.set(test1.id, new Map());
            }
            relationshipScores.get(test1.id)!.set(test2.id, score);

            if (!relationshipScores.has(test2.id)) {
              relationshipScores.set(test2.id, new Map());
            }
            relationshipScores.get(test2.id)!.set(test1.id, score);
          }
        }
      }

      if (semanticComparisonsCount >= MAX_SEMANTIC_COMPARISONS) {
        logger.warn(
          '[RELATIONSHIP] Semantic comparison limit reached, remaining comparisons skipped',
          {
            limit: MAX_SEMANTIC_COMPARISONS,
            totalPairs: (tests.length * (tests.length - 1)) / 2,
          }
        );
      }

      // Build clusters from edges
      const clusters = this.buildClusters(tests, relationshipScores);

      logger.info('[RELATIONSHIP] Relationships and clusters built', {
        edgesCount: edges.length,
        clustersCount: clusters.length,
      });

      return { edges, clusters };
    } catch (error) {
      logger.error('[RELATIONSHIP] Failed to build relationships', { error });
      // Return empty on error rather than failing completely
      return { edges: [], clusters: [] };
    }
  }

  /**
   * Calculate relationship score between two tests
   * Uses multiple strategies and returns the strongest relationship
   *
   * @param test1 - First test record
   * @param test2 - Second test record
   * @param session1 - First test's intelligent session (may be null)
   * @param session2 - Second test's intelligent session (may be null)
   * @param skipSemantic - If true, skip expensive semantic similarity check
   * @returns Relationship score with type, confidence, and reasons
   */
  private static async calculateRelationshipScore(
    test1: any,
    test2: any,
    session1: any,
    session2: any,
    skipSemantic = false
  ): Promise<RelationshipScore> {
    const scores: Array<{ type: any; score: number; reason: string }> = [];

    // 1. URL relationship
    const urlScore = this.checkUrlRelationship(test1, test2, session1, session2);
    if (urlScore.score > 0) {
      scores.push({ type: 'url', ...urlScore });
    }

    // 2. Page flow relationship
    const flowScore = this.checkPageFlowRelationship(session1, session2);
    if (flowScore.score > 0) {
      scores.push({ type: 'page_flow', ...flowScore });
    }

    // 3. Temporal proximity
    const temporalScore = this.checkTemporalProximity(test1, test2);
    if (temporalScore.score > 0) {
      scores.push({ type: 'temporal', ...temporalScore });
    }

    // 4. Semantic similarity (with safe limits)
    let usedSemantic = false;
    if (!skipSemantic) {
      const semanticScore = await this.checkSemanticSimilarity(
        session1,
        session2
      );
      if (semanticScore.score > 0) {
        scores.push({ type: 'semantic', ...semanticScore });
        usedSemantic = true;
      }
    }

    // Determine primary type (highest score)
    scores.sort((a, b) => b.score - a.score);
    const primaryType = scores.length > 0 ? scores[0].type : 'semantic';
    const totalConfidence = scores.length > 0 ? scores[0].score : 0;
    const reasons = scores.slice(0, 3).map(s => s.reason); // Top 3 reasons

    return {
      primaryType,
      totalConfidence,
      reasons,
      allScores: scores,
      usedSemantic,
    };
  }

  /**
   * Check URL relationship (overlap or continuation)
   * Detects flow patterns like login → dashboard
   *
   * @returns Score (0-0.9) and human-readable reason
   */
  private static checkUrlRelationship(
    test1: any,
    test2: any,
    session1: any,
    session2: any
  ): { score: number; reason: string } {
    // Get URLs from tests and sessions
    const urls1 = this.extractUrls(test1, session1);
    const urls2 = this.extractUrls(test2, session2);

    if (urls1.length === 0 || urls2.length === 0) {
      return { score: 0, reason: '' };
    }

    // Check for URL continuation (last URL of test1 = first URL of test2)
    const lastUrl1 = urls1[urls1.length - 1];
    const firstUrl2 = urls2[0];

    // ✅ Improved: More robust URL normalization
    const normalizedLast = this.normalizeUrl(lastUrl1);
    const normalizedFirst = this.normalizeUrl(firstUrl2);

    if (normalizedLast && normalizedFirst && normalizedLast === normalizedFirst) {
      return {
        score: 0.9,
        reason: `Flow continuation: ${this.shortUrl(lastUrl1)} → ${this.shortUrl(
          firstUrl2
        )}`,
      };
    }

    // Check for common URLs
    const urls1Set = new Set(urls1.map(u => this.normalizeUrl(u)));
    const urls2Set = new Set(urls2.map(u => this.normalizeUrl(u)));
    const commonUrls = [...urls1Set].filter(u => urls2Set.has(u));

    if (commonUrls.length > 0) {
      const overlapRatio = commonUrls.length / Math.max(urls1.length, urls2.length);
      return {
        score: Math.min(0.7, 0.4 + overlapRatio * 0.3),
        reason: `${commonUrls.length} shared URLs`,
      };
    }

    // Check for same domain
    const domain1 = this.extractDomain(urls1[0]);
    const domain2 = this.extractDomain(urls2[0]);

    if (domain1 && domain2 && domain1 === domain2) {
      return {
        score: 0.3,
        reason: `Same domain: ${domain1}`,
      };
    }

    return { score: 0, reason: '' };
  }

  /**
   * Check page flow relationship (page types sequence)
   * Detects logical flows like login → dashboard → checkout
   *
   * @returns Score (0-0.85) and reason
   */
  private static checkPageFlowRelationship(
    session1: any,
    session2: any
  ): { score: number; reason: string } {
    if (
      !session1?.graph_data?.nodes ||
      !session2?.graph_data?.nodes ||
      !Array.isArray(session1.graph_data.nodes) ||
      !Array.isArray(session2.graph_data.nodes)
    ) {
      return { score: 0, reason: '' };
    }

    // Extract page types
    const pageTypes1 = session1.graph_data.nodes
      .map((n: any) => n.meta?.pageType)
      .filter((pt: any): pt is string => typeof pt === 'string' && pt.length > 0);
    const pageTypes2 = session2.graph_data.nodes
      .map((n: any) => n.meta?.pageType)
      .filter((pt: any): pt is string => typeof pt === 'string' && pt.length > 0);

    if (pageTypes1.length === 0 || pageTypes2.length === 0) {
      return { score: 0, reason: '' };
    }

    // Known logical flows
    const flowPatterns = [
      ['login', 'dashboard'],
      ['login', 'home'],
      ['dashboard', 'checkout'],
      ['dashboard', 'settings'],
      ['product', 'cart'],
      ['cart', 'checkout'],
      ['checkout', 'confirmation'],
    ];

    const lastPage1 = pageTypes1[pageTypes1.length - 1];
    const firstPage2 = pageTypes2[0];

    // Check for logical flow
    for (const [from, to] of flowPatterns) {
      if (lastPage1 === from && firstPage2 === to) {
        return {
          score: 0.85,
          reason: `Logical flow: ${from} → ${to}`,
        };
      }
    }

    // Check for common page types
    const types1Set = new Set(pageTypes1);
    const types2Set = new Set(pageTypes2);
    const commonTypes = [...types1Set].filter(t => types2Set.has(t));

    if (commonTypes.length > 0) {
      return {
        score: 0.5,
        reason: `Shared pages: ${commonTypes.slice(0, 2).join(', ')}`,
      };
    }

    return { score: 0, reason: '' };
  }

  /**
   * Check temporal proximity (tests run close in time)
   * Tests run within same session/timeframe are likely related
   *
   * @returns Score (0-0.7) and reason
   */
  private static checkTemporalProximity(
    test1: any,
    test2: any
  ): { score: number; reason: string } {
    // ✅ Improved: Use completed_at if available (more accurate)
    const timestamp1 = test1.completed_at || test1.created_at;
    const timestamp2 = test2.completed_at || test2.created_at;

    if (!timestamp1 || !timestamp2) {
      return { score: 0, reason: '' };
    }

    const date1 = new Date(timestamp1).getTime();
    const date2 = new Date(timestamp2).getTime();

    // ✅ Validation: Check for invalid dates
    if (isNaN(date1) || isNaN(date2)) {
      logger.warn('[RELATIONSHIP] Invalid date for temporal proximity', {
        timestamp1,
        timestamp2,
      });
      return { score: 0, reason: '' };
    }

    const diffHours = Math.abs(date1 - date2) / (1000 * 60 * 60);

    if (diffHours < 1) {
      return { score: 0.7, reason: 'Run within 1 hour' };
    }
    if (diffHours < 24) {
      return { score: 0.5, reason: 'Run within 24 hours' };
    }
    if (diffHours < 168) {
      return { score: 0.3, reason: 'Run within 1 week' };
    }

    return { score: 0, reason: '' };
  }

  /**
   * Check semantic similarity using embeddings
   * With safe rate limits to avoid overloading OpenAI API
   *
   * @param session1 - First test's intelligent session
   * @param session2 - Second test's intelligent session
   * @returns Similarity score and reason
   */
  private static async checkSemanticSimilarity(
    session1: any,
    session2: any
  ): Promise<{ score: number; reason: string }> {
    // Only use embeddings if we have goals/summaries
    const text1 = session1?.goal || session1?.summary;
    const text2 = session2?.goal || session2?.summary;

    // ✅ Validation: Check text exists and has minimum length
    if (
      !text1 ||
      !text2 ||
      typeof text1 !== 'string' ||
      typeof text2 !== 'string' ||
      text1.length < 10 ||
      text2.length < 10
    ) {
      return { score: 0, reason: '' };
    }

    // ✅ Performance: Truncate very long texts (API limit protection)
    const MAX_TEXT_LENGTH = 8000; // OpenAI limit is ~8K tokens
    const truncatedText1 = text1.substring(0, MAX_TEXT_LENGTH);
    const truncatedText2 = text2.substring(0, MAX_TEXT_LENGTH);

    try {
      // Generate embeddings for both texts and compare
      const [embedding1, embedding2] = await Promise.all([
        generateEmbedding(truncatedText1),
        generateEmbedding(truncatedText2),
      ]);

      const similarity = cosineSimilarity(embedding1, embedding2);

      if (similarity > SEMANTIC_SIMILARITY_THRESHOLD) {
        return {
          score: similarity,
          reason: `Similar goals (${Math.round(similarity * 100)}% match)`,
        };
      }

      return { score: 0, reason: '' };
    } catch (error) {
      logger.warn('[RELATIONSHIP] Failed to compute semantic similarity', {
        error: error instanceof Error ? error.message : String(error),
        text1Length: text1.length,
        text2Length: text2.length,
      });
      return { score: 0, reason: '' };
    }
  }

  /**
   * Build clusters from relationship scores
   * Groups tests into clusters based on relationship confidence
   *
   * @param tests - Array of test records
   * @param relationshipScores - Map of testId -> (relatedTestId -> score)
   * @returns Array of clusters (spheres)
   */
  private static buildClusters(
    tests: any[],
    relationshipScores: Map<string, Map<string, RelationshipScore>>
  ): OverallCluster[] {
    const clusters: OverallCluster[] = [];
    const processed = new Set<string>();

    for (const test of tests) {
      if (processed.has(test.id)) continue;

      // Find all related tests for this test
      const related = relationshipScores.get(test.id);
      if (!related || related.size === 0) {
        processed.add(test.id);
        continue;
      }

      // Build cluster starting from this test
      const clusterMembers = [test.id];
      const relatedIds = Array.from(related.keys());

      // ✅ Performance: Limit cluster size
      const MAX_CLUSTER_SIZE = 50;

      for (const relatedId of relatedIds) {
        if (clusterMembers.length >= MAX_CLUSTER_SIZE) {
          logger.warn('[RELATIONSHIP] Cluster size limit reached', {
            clusterId: test.id,
            limit: MAX_CLUSTER_SIZE,
          });
          break;
        }

        const score = related.get(relatedId);
        if (
          score &&
          score.totalConfidence >= 0.6 &&
          !processed.has(relatedId)
        ) {
          clusterMembers.push(relatedId);
          processed.add(relatedId);
        }
      }

      // ✅ Only create cluster if multiple members
      if (clusterMembers.length > 1) {
        // Sort for deterministic cluster ID
        clusterMembers.sort();
        const clusterId = this.generateClusterId(clusterMembers);

        // Collect reasons
        const allReasons: string[] = [];
        for (const memberId of clusterMembers) {
          const memberRelated = relationshipScores.get(memberId);
          if (memberRelated) {
            for (const score of memberRelated.values()) {
              allReasons.push(...score.reasons);
            }
          }
        }

        // Get unique reasons (top 3)
        const uniqueReasons = [...new Set(allReasons)].slice(0, 3);

        // Calculate cluster confidence (average of top relationships)
        const topScores: number[] = [];
        for (const memberId of clusterMembers) {
          const memberRelated = relationshipScores.get(memberId);
          if (memberRelated) {
            for (const score of memberRelated.values()) {
              topScores.push(score.totalConfidence);
            }
          }
        }
        topScores.sort((a, b) => b - a);
        const avgConfidence =
          topScores.length > 0
            ? topScores.slice(0, 3).reduce((a, b) => a + b, 0) /
              Math.min(3, topScores.length)
            : 0;

        clusters.push({
          clusterId,
          label: `Flow Cluster (${clusterMembers.length} tests)`,
          memberNodeIds: clusterMembers,
          confidence: avgConfidence,
          reasons: uniqueReasons,
        });
      }

      processed.add(test.id);
    }

    return clusters;
  }

  /**
   * Generate deterministic cluster ID from member IDs
   * Uses SHA-256 hash for consistent cluster identification
   *
   * @param memberIds - Array of test UUIDs in cluster
   * @returns Cluster ID (e.g., "cluster_a1b2c3d4e5f6g7h8")
   */
  private static generateClusterId(memberIds: string[]): string {
    const sorted = [...memberIds].sort();
    const hash = crypto.createHash('sha256');
    hash.update(sorted.join(','));
    return `cluster_${hash.digest('hex').substring(0, 16)}`;
  }

  /**
   * Extract URLs from test and session
   * Collects all URLs visited during test execution
   *
   * @returns Array of unique URLs (deduplicated)
   */
  private static extractUrls(test: any, session: any): string[] {
    const urls: string[] = [];

    // From test
    if (test.url && typeof test.url === 'string') {
      urls.push(test.url);
    }

    // From graph_data nodes
    if (session?.graph_data?.nodes && Array.isArray(session.graph_data.nodes)) {
      for (const node of session.graph_data.nodes) {
        if (!node) continue;

        // Node value might be a URL
        if (
          node.value &&
          typeof node.value === 'string' &&
          this.isUrl(node.value)
        ) {
          urls.push(node.value);
        }

        // Meta fields with URLs
        if (node.meta) {
          if (node.meta.urlAfter && typeof node.meta.urlAfter === 'string') {
            urls.push(node.meta.urlAfter);
          }
          if (node.meta.urlBefore && typeof node.meta.urlBefore === 'string') {
            urls.push(node.meta.urlBefore);
          }
        }
      }
    }

    // Deduplicate and return
    return [...new Set(urls.filter(u => u && u.length > 0))];
  }

  /**
   * Normalize URL (origin + path, no query/hash)
   * Used for comparing URLs regardless of query params
   *
   * @returns Normalized URL or null if invalid
   */
  private static normalizeUrl(url: string): string | null {
    if (!url || typeof url !== 'string') {
      return null;
    }

    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return null; // ✅ Return null instead of original URL for invalid URLs
    }
  }

  /**
   * Extract domain from URL
   *
   * @returns Domain (hostname) or null if invalid
   */
  private static extractDomain(url: string): string | null {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return null;
    }
  }

  /**
   * Shorten URL for display
   * Removes protocol and shows only hostname + path
   *
   * @returns Shortened URL (e.g., "example.com/login")
   */
  private static shortUrl(url: string): string {
    if (!url || typeof url !== 'string') {
      return '';
    }

    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname}`;
    } catch {
      // ✅ Improved: Fallback to truncated string
      return url.length > 40 ? url.substring(0, 40) + '...' : url;
    }
  }

  /**
   * Check if string is a valid URL
   *
   * @returns true if valid URL, false otherwise
   */
  private static isUrl(str: string): boolean {
    if (!str || typeof str !== 'string' || str.length === 0) {
      return false;
    }

    try {
      new URL(str);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Internal type for relationship scoring
 */
interface RelationshipScore {
  primaryType: 'url' | 'page_flow' | 'semantic' | 'temporal';
  totalConfidence: number;
  reasons: string[];
  allScores: Array<{ type: any; score: number; reason: string }>;
  usedSemantic?: boolean; // Track if semantic analysis was used (for rate limiting)
}
