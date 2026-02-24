import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import type { CommandFingerprint, OverallCluster, OverallEdge } from '@/types/overall.types';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OVERALL RELATIONSHIP SERVICE - Test relationship analysis and clustering
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Analyzes relationships between tests using three strategies:
 * 1. URL relationships (flow continuation, shared URLs, same domain)
 * 2. Page flow patterns (logical sequences like login → dashboard)
 * 3. Command fingerprint (shared selectors/actions extracted from test steps)
 *
 * Key Features:
 * - Command fingerprinting: extracts "meaning" of each test from its steps
 * - Multi-factor relationship scoring
 * - Automatic cluster detection
 * - Distance field for frontend edge length (1 - confidence)
 */

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
  ): Promise<{ edges: OverallEdge[]; clusters: OverallCluster[]; fingerprints: Map<string, CommandFingerprint> }> {
    try {
      logger.info('[RELATIONSHIP] Building relationships and clusters', {
        testsCount: tests.length,
      });

      if (tests.length === 0) {
        return { edges: [], clusters: [], fingerprints: new Map() };
      }

      // Phase 1: Build fingerprints for all tests (once)
      const fingerprints = new Map<string, CommandFingerprint>();
      for (const test of tests) {
        const session = sessionsMap.get(test.id);
        fingerprints.set(test.id, this.extractFingerprint(test, session));
      }

      // Phase 2: Get AI similarity scores via GPT-4o-mini (single batch call)
      const aiScores = await this.getAISimilarityScores(tests, fingerprints);

      // Phase 3: Compare each test pair using URL/page_flow + AI scores
      const edges: OverallEdge[] = [];
      const relationshipScores = new Map<string, Map<string, RelationshipScore>>();

      for (let i = 0; i < tests.length; i++) {
        for (let j = i + 1; j < tests.length; j++) {
          const test1 = tests[i];
          const test2 = tests[j];
          const session1 = sessionsMap.get(test1.id);
          const session2 = sessionsMap.get(test2.id);

          // Get pre-computed AI score for this pair
          const pairKey = `${i}-${j}`;
          const aiScore = aiScores.get(pairKey);

          const score = this.calculateRelationshipScore(
            test1,
            test2,
            session1,
            session2,
            aiScore
          );

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
              distance: 1 - score.totalConfidence,
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

      // Build clusters from edges
      const clusters = this.buildClusters(tests, relationshipScores);

      logger.info('[RELATIONSHIP] Relationships and clusters built', {
        edgesCount: edges.length,
        clustersCount: clusters.length,
      });

      return { edges, clusters, fingerprints };
    } catch (error) {
      logger.error('[RELATIONSHIP] Failed to build relationships', { error });
      return { edges: [], clusters: [], fingerprints: new Map() };
    }
  }

  /**
   * Calculate relationship score between two tests
   * Uses URL, page flow, and AI-based command analysis
   */
  private static calculateRelationshipScore(
    test1: any,
    test2: any,
    session1: any,
    session2: any,
    aiScore?: { score: number; reason: string }
  ): RelationshipScore {
    const scores: Array<{ type: 'url' | 'page_flow' | 'command'; score: number; reason: string }> = [];

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

    // 3. AI-based command similarity (from GPT-4o-mini batch)
    if (aiScore && aiScore.score > 0) {
      scores.push({ type: 'command', ...aiScore });
    }

    // Determine primary type (highest score)
    scores.sort((a, b) => b.score - a.score);
    const primaryType = scores.length > 0 ? scores[0].type : 'url';
    const totalConfidence = scores.length > 0 ? scores[0].score : 0;
    const reasons = scores.map(s => s.reason).filter(r => r.length > 0);

    return {
      primaryType,
      totalConfidence,
      reasons,
      allScores: scores,
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

    // Check for common URLs (filter out null from failed normalization)
    const urls1Normalized = urls1.map(u => this.normalizeUrl(u)).filter((u): u is string => u !== null);
    const urls2Normalized = urls2.map(u => this.normalizeUrl(u)).filter((u): u is string => u !== null);
    const urls1Set = new Set(urls1Normalized);
    const urls2Set = new Set(urls2Normalized);
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

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND FINGERPRINTING - Extract "meaning" from test steps
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract fingerprint from a test's steps
   * Parses graph_data.nodes to understand what the test does
   *
   * Example output:
   *   actions: ["goto", "fill", "click", "assertVisible"]
   *   selectors: ["input[name=email]", "button.submit", ".dashboard"]
   *   urls: ["/login", "/dashboard"]
   *   summary: "login flow (fill email, fill password, click submit)"
   */
  static extractFingerprint(test: any, session: any): CommandFingerprint {
    const actions: Set<string> = new Set();
    const selectors: Set<string> = new Set();
    const urls: Set<string> = new Set();
    const stepDescriptions: string[] = [];

    // Extract from graph_data nodes
    const nodes = session?.graph_data?.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (!node || node.type === 'start' || node.type === 'end') continue;

        // Action type (click, fill, goto, assertVisible, etc.)
        if (node.stepType && typeof node.stepType === 'string') {
          actions.add(node.stepType);
        }

        // Selector — normalize to remove dynamic parts
        if (node.selector && typeof node.selector === 'string') {
          selectors.add(this.normalizeSelector(node.selector));
        }

        // URLs from navigation
        if (node.stepType === 'goto' && node.value && typeof node.value === 'string') {
          const path = this.extractPath(node.value);
          if (path) urls.add(path);
        }
        if (node.meta?.urlAfter && typeof node.meta.urlAfter === 'string') {
          const path = this.extractPath(node.meta.urlAfter);
          if (path) urls.add(path);
        }

        // Step description for summary
        if (node.stepType && node.stepType !== 'goto') {
          const target = node.selector
            ? this.selectorToHumanName(node.selector)
            : '';
          if (target) {
            stepDescriptions.push(`${node.stepType} ${target}`);
          }
        }
      }
    }

    // Also extract from test.commands if available (for non-intelligent tests)
    if (Array.isArray(test.commands)) {
      for (const cmd of test.commands) {
        if (!cmd) continue;
        if (cmd.action) actions.add(cmd.action);
        if (cmd.selector) selectors.add(this.normalizeSelector(cmd.selector));
        if (cmd.action === 'goto' && cmd.url) {
          const path = this.extractPath(cmd.url);
          if (path) urls.add(path);
        }
      }
    }

    // Start URL
    if (test.url && typeof test.url === 'string') {
      const path = this.extractPath(test.url);
      if (path) urls.add(path);
    }

    // Build summary: "login → dashboard (fill email, fill password, click submit)"
    const urlParts = [...urls].map(u => u.replace(/^\//, '')).filter(Boolean);
    const flow = urlParts.length > 0 ? urlParts.join(' → ') : 'unknown';
    const uniqueSteps = [...new Set(stepDescriptions)];
    const topSteps = uniqueSteps.slice(0, 4).join(', ');
    const summary = topSteps ? `${flow} (${topSteps})` : flow;

    return {
      actions: [...actions],
      selectors: [...selectors],
      urls: [...urls],
      summary,
    };
  }

  /**
   * Get AI similarity scores for all test pairs via GPT-4o-mini
   * Sends fingerprint summaries in batch requests, including cross-batch comparisons
   * Returns a map of "i-j" → { score, reason }
   */
  private static async getAISimilarityScores(
    tests: any[],
    fingerprints: Map<string, CommandFingerprint>
  ): Promise<Map<string, { score: number; reason: string }>> {
    const results = new Map<string, { score: number; reason: string }>();

    // Build test summaries list (keep original indices for mapping back)
    const summaries: Array<{ index: number; summary: string }> = [];
    for (let i = 0; i < tests.length; i++) {
      const fp = fingerprints.get(tests[i].id);
      if (fp && fp.summary && fp.summary !== 'unknown') {
        summaries.push({ index: i, summary: fp.summary });
      }
    }

    if (summaries.length < 2) {
      return results;
    }

    // For small sets (<=50), single call covers all pairs
    // For larger sets, we batch but also need cross-batch comparisons
    const BATCH_SIZE = 50;

    if (summaries.length <= BATCH_SIZE) {
      // Single batch — all pairs covered
      try {
        const batchResults = await this.callGPTForSimilarity(summaries);
        for (const [key, value] of batchResults) {
          results.set(key, value);
        }
      } catch (error) {
        logger.warn('[RELATIONSHIP] GPT similarity failed, falling back to URL/page_flow only', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      // Multiple batches: intra-batch + cross-batch with overlap
      for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
        // Intra-batch: compare within this chunk
        const batch = summaries.slice(i, i + BATCH_SIZE);
        try {
          const batchResults = await this.callGPTForSimilarity(batch);
          for (const [key, value] of batchResults) {
            results.set(key, value);
          }
        } catch (error) {
          logger.warn('[RELATIONSHIP] GPT similarity batch failed', {
            error: error instanceof Error ? error.message : String(error),
            batchStart: i,
          });
        }

        // Cross-batch: take last 10 from previous + first 10 of next
        if (i + BATCH_SIZE < summaries.length) {
          const overlapStart = Math.max(i + BATCH_SIZE - 10, i);
          const overlapEnd = Math.min(i + BATCH_SIZE + 10, summaries.length);
          const crossBatch = summaries.slice(overlapStart, overlapEnd);
          if (crossBatch.length >= 2) {
            try {
              const crossResults = await this.callGPTForSimilarity(crossBatch);
              for (const [key, value] of crossResults) {
                if (!results.has(key)) {
                  results.set(key, value);
                }
              }
            } catch {
              // Cross-batch is best-effort
            }
          }
        }
      }
    }

    logger.info('[RELATIONSHIP] AI similarity scores computed', {
      testsAnalyzed: summaries.length,
      pairsFound: results.size,
    });

    return results;
  }

  /**
   * Single GPT-4o-mini call to analyze similarity between a batch of tests
   * Returns pairs with confidence >= 0.5
   */
  private static async callGPTForSimilarity(
    batch: Array<{ index: number; summary: string }>
  ): Promise<Map<string, { score: number; reason: string }>> {
    const results = new Map<string, { score: number; reason: string }>();

    const testList = batch
      .map(t => `[${t.index}] ${t.summary}`)
      .join('\n');

    const response = await getChatCompletionWithMessages(
      [
        {
          role: 'system',
          content: `You are a QA test relationship analyzer. You receive summaries of automated UI test cases. Each summary has this format:
"[index] url_path (action element, action element, ...)"

Example: "[3] login → dashboard (fill email, fill password, click submit-btn)"
This means: test #3 navigates from /login to /dashboard, fills email and password fields, then clicks submit.

Your job: identify pairs of tests that are FUNCTIONALLY RELATED — they test the same feature, page, form, or user flow.

Scoring guide:
- 0.8-0.9: Tests interact with the SAME form/elements (e.g., both fill email + password = both test login)
- 0.6-0.7: Tests cover the SAME feature area but different scenarios (e.g., login success vs login with wrong password)
- 0.5-0.6: Tests share a page/flow but do different things (e.g., both start at /settings but test different settings)
- Below 0.5: Do NOT include. Different features that happen to share generic elements (like a navbar) are NOT related.

Important:
- Use the original [index] numbers from input, not array positions
- "reason" should be 3-8 words explaining WHY they are related
- Do not hallucinate pairs — if tests are clearly about different features, omit them`,
        },
        {
          role: 'user',
          content: `Analyze these ${batch.length} test cases and find related pairs:

${testList}

Return JSON:
{"pairs": [{"a": <index>, "b": <index>, "score": <0.5-1.0>, "reason": "<short reason>"}]}

If no tests are related, return: {"pairs": []}`,
        },
      ],
      {
        model: AI_TASK_MODELS.testVisualization,
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }
    );

    try {
      const parsed = JSON.parse(response.content);
      const pairs: Array<{ a: number; b: number; score: number; reason: string }> =
        parsed.pairs || parsed.results || [];

      if (!Array.isArray(pairs)) {
        logger.warn('[RELATIONSHIP] GPT returned non-array pairs', { parsed: typeof parsed });
        return results;
      }

      for (const pair of pairs) {
        if (
          typeof pair.a !== 'number' ||
          typeof pair.b !== 'number' ||
          typeof pair.score !== 'number' ||
          pair.a === pair.b ||
          pair.score < 0.5
        ) {
          continue;
        }

        // Validate indices exist in batch
        const validIndices = new Set(batch.map(b => b.index));
        if (!validIndices.has(pair.a) || !validIndices.has(pair.b)) {
          logger.warn('[RELATIONSHIP] GPT returned invalid index', {
            a: pair.a,
            b: pair.b,
            validRange: `${batch[0]?.index}-${batch[batch.length - 1]?.index}`,
          });
          continue;
        }

        const lo = Math.min(pair.a, pair.b);
        const hi = Math.max(pair.a, pair.b);
        const key = `${lo}-${hi}`;

        results.set(key, {
          score: Math.min(1, pair.score),
          reason: pair.reason || 'Related tests',
        });
      }
    } catch (parseError) {
      logger.warn('[RELATIONSHIP] Failed to parse GPT similarity response', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        content: response.content.substring(0, 200),
      });
    }

    return results;
  }

  /**
   * Normalize selector — remove dynamic IDs, indices, and noise
   * "div#app > form > input[name='email']" → "input[name=email]"
   * "#id-12345 .btn-primary" → ".btn-primary"
   */
  private static normalizeSelector(selector: string): string {
    if (!selector || typeof selector !== 'string') return '';

    let s = selector.trim();

    // Remove dynamic IDs (e.g., #react-12a4b5c6, #el-5f3a2b, #:r1:, #radix-123)
    // Only targets IDs with hex-heavy patterns or framework prefixes, not stable IDs like #main or #login-form
    s = s.replace(/#:r\d+:/g, '');                          // React auto IDs (#:r1:, #:r2:)
    s = s.replace(/#[a-zA-Z]*[-_][0-9a-f]{6,}/g, '');      // Hex-heavy IDs (#el-abc123def)
    s = s.replace(/#[0-9a-f]{8,}/g, '');                    // Pure hex IDs (#a1b2c3d4e5f6)

    // Remove nth-child / nth-of-type indices (volatile)
    s = s.replace(/:nth-child\(\d+\)/g, '');
    s = s.replace(/:nth-of-type\(\d+\)/g, '');

    // Keep only the last meaningful part (the target element)
    // "div > section > form > input[name=email]" → "input[name=email]"
    const parts = s.split(/\s*>\s*|\s+/);
    const meaningful = parts.filter(p => {
      const trimmed = p.trim();
      // Keep parts with attributes, classes, or semantic tags
      return (
        trimmed.includes('[') ||
        trimmed.includes('.') ||
        /^(input|button|select|textarea|a|form|nav|header|footer|main|h[1-6])/.test(trimmed)
      );
    });

    if (meaningful.length > 0) {
      // Return last 2 meaningful parts max
      return meaningful.slice(-2).join(' > ').replace(/['"]/g, '');
    }

    // Fallback: return cleaned full selector
    return s.replace(/['"]/g, '');
  }

  /**
   * Convert selector to human-readable name for summary
   * "input[name=email]" → "email"
   * "button.submit-btn" → "submit-btn"
   * "[data-testid=login-form]" → "login-form"
   */
  private static selectorToHumanName(selector: string): string {
    // data-testid
    const testIdMatch = selector.match(/data-testid[=~]*["']?([^"'\]\s]+)/);
    if (testIdMatch) return testIdMatch[1];

    // name attribute
    const nameMatch = selector.match(/name[=~]*["']?([^"'\]\s]+)/);
    if (nameMatch) return nameMatch[1];

    // class
    const classMatch = selector.match(/\.([a-zA-Z][\w-]*)/);
    if (classMatch) return classMatch[1];

    // id
    const idMatch = selector.match(/#([a-zA-Z][\w-]*)/);
    if (idMatch) return idMatch[1];

    // placeholder/aria-label
    const placeholderMatch = selector.match(/placeholder[=~]*["']?([^"'\]\s]+)/);
    if (placeholderMatch) return placeholderMatch[1];

    return '';
  }

  /**
   * Extract path from URL (strip origin)
   * "https://example.com/login?next=/dashboard" → "/login"
   */
  private static extractPath(url: string): string | null {
    if (!url || typeof url !== 'string') return null;
    try {
      const u = new URL(url);
      return u.pathname;
    } catch {
      // Maybe it's already a path
      if (url.startsWith('/')) return url.split('?')[0];
      return null;
    }
  }

  /**
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
  primaryType: 'url' | 'page_flow' | 'command';
  totalConfidence: number;
  reasons: string[];
  allScores: Array<{ type: 'url' | 'page_flow' | 'command'; score: number; reason: string }>;
}
