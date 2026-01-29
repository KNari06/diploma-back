/**
 * Saved Case Dependency Suggester Service
 * Generates AI-powered dependency suggestions for saved_test_cases within a flow.
 * Uses context-first approach: URL continuity, heuristics, and semantic similarity.
 */

import { supabaseAdmin } from '@/db/supabase';
import { cosineSimilarity, generateEmbedding } from '@/services/ai/core/embedding.service';
import { logger } from '@/utils/core/logger';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single dependency suggestion with confidence and reasoning
 */
export interface DependencySuggestion {
  id: string;           // saved_test_cases.id of the suggested dependency
  confidence: number;   // 0.0 - 1.0
  reason: string;       // Human-readable explanation
}

/**
 * Minimal saved case data needed for suggestion calculations
 */
interface SavedCaseData {
  id: string;
  name: string;
  description?: string;
  url?: string;
  flow_id?: string;
  depends_on?: string[];
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Maximum number of suggestions to return */
const MAX_SUGGESTIONS = 5;

/** Maximum number of semantic comparisons (expensive embedding calls) */
const MAX_SEMANTIC_COMPARISONS = 20;

/** Minimum confidence threshold to include in suggestions */
const MIN_CONFIDENCE_THRESHOLD = 0.4;

/** Semantic similarity threshold (higher = more strict) */
const SEMANTIC_SIMILARITY_THRESHOLD = 0.65;

/** Keywords indicating a prerequisite test (login, auth, setup) */
const PREREQ_KEYWORDS = ['login', 'auth', 'authenticate', 'sign in', 'signin', 'onboarding', 'setup', 'register', 'registration'];

/** Keywords indicating dependent tests (dashboard, profile, settings, etc.) */
const DEPENDENT_KEYWORDS = ['dashboard', 'profile', 'settings', 'account', 'home', 'main', 'checkout', 'payment', 'order'];

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Service for generating dependency suggestions for saved test cases.
 * Analyzes test cases within the same flow and suggests dependencies based on:
 * 1. URL continuity (strongest signal)
 * 2. Keyword heuristics (login -> dashboard patterns)
 * 3. Semantic similarity (embeddings-based)
 */
export class SavedCaseDependencySuggester {
  /**
   * Generate dependency suggestions for a saved test case.
   * Only considers candidates within the same flow_id.
   *
   * @param caseId - ID of the saved test case (or null for draft)
   * @param flowId - Flow ID to scope candidates
   * @param userId - User ID for access control
   * @param draftCase - Optional draft case data (when creating new case)
   * @returns Array of suggested dependencies with confidence and reasons
   */
  static async suggestForCase(
    caseId: string | null,
    flowId: string,
    userId: string,
    draftCase?: { name: string; description?: string; url?: string }
  ): Promise<DependencySuggestion[]> {
    try {
      logger.info('[DEPENDENCY_SUGGESTER] Generating suggestions', {
        caseId,
        flowId,
        userId,
        hasDraft: !!draftCase,
      });

      // 1. Get target case data
      let targetCase: SavedCaseData;
      if (draftCase) {
        targetCase = {
          id: caseId || 'draft',
          name: draftCase.name,
          description: draftCase.description,
          url: draftCase.url,
          flow_id: flowId,
        };
      } else if (caseId) {
        const fetched = await this.getSavedCase(caseId, userId);
        if (!fetched) {
          logger.warn('[DEPENDENCY_SUGGESTER] Target case not found', { caseId });
          return [];
        }
        targetCase = fetched;
      } else {
        logger.warn('[DEPENDENCY_SUGGESTER] No caseId or draftCase provided');
        return [];
      }

      // 2. Get candidate cases in the same flow (excluding target)
      const candidates = await this.getCandidatesInFlow(flowId, userId, caseId);
      if (candidates.length === 0) {
        logger.info('[DEPENDENCY_SUGGESTER] No candidates in flow', { flowId });
        return [];
      }

      // 3. Score each candidate
      const scoredCandidates: Array<DependencySuggestion & { scores: number[] }> = [];
      let semanticComparisons = 0;

      for (const candidate of candidates) {
        const scores: { score: number; reason: string }[] = [];

        // 3a. URL continuity check
        const urlScore = this.checkUrlContinuity(candidate, targetCase);
        if (urlScore.score > 0) {
          scores.push(urlScore);
        }

        // 3b. Keyword heuristics check
        const heuristicScore = this.checkKeywordHeuristics(candidate, targetCase);
        if (heuristicScore.score > 0) {
          scores.push(heuristicScore);
        }

        // 3c. Semantic similarity (limited)
        if (semanticComparisons < MAX_SEMANTIC_COMPARISONS) {
          const semanticScore = await this.checkSemanticSimilarity(candidate, targetCase);
          if (semanticScore.score > 0) {
            scores.push(semanticScore);
            semanticComparisons++;
          }
        }

        // Calculate combined confidence (take best score)
        if (scores.length > 0) {
          scores.sort((a, b) => b.score - a.score);
          const bestScore = scores[0];

          if (bestScore.score >= MIN_CONFIDENCE_THRESHOLD) {
            scoredCandidates.push({
              id: candidate.id,
              confidence: bestScore.score,
              reason: bestScore.reason,
              scores: scores.map(s => s.score),
            });
          }
        }
      }

      // 4. Sort by confidence and limit
      scoredCandidates.sort((a, b) => b.confidence - a.confidence);
      const suggestions = scoredCandidates
        .slice(0, MAX_SUGGESTIONS)
        .map(({ id, confidence, reason }) => ({ id, confidence, reason }));

      logger.info('[DEPENDENCY_SUGGESTER] Generated suggestions', {
        caseId,
        flowId,
        candidatesCount: candidates.length,
        suggestionsCount: suggestions.length,
        semanticComparisons,
      });

      return suggestions;
    } catch (error) {
      logger.error('[DEPENDENCY_SUGGESTER] Failed to generate suggestions', {
        error: error instanceof Error ? error.message : String(error),
        caseId,
        flowId,
      });
      return [];
    }
  }

  // ==========================================================================
  // PRIVATE: Data Fetching
  // ==========================================================================

  /**
   * Get a saved test case by ID
   */
  private static async getSavedCase(
    caseId: string,
    userId: string
  ): Promise<SavedCaseData | null> {
    const { data, error } = await supabaseAdmin
      .from('saved_test_cases')
      .select('id, name, description, url, flow_id, depends_on')
      .eq('id', caseId)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get saved case: ${error.message}`);
    }

    return data as SavedCaseData;
  }

  /**
   * Get all candidate cases in the same flow (excluding target)
   */
  private static async getCandidatesInFlow(
    flowId: string,
    userId: string,
    excludeCaseId?: string | null
  ): Promise<SavedCaseData[]> {
    let query = supabaseAdmin
      .from('saved_test_cases')
      .select('id, name, description, url, flow_id, depends_on')
      .eq('flow_id', flowId)
      .eq('user_id', userId);

    if (excludeCaseId) {
      query = query.neq('id', excludeCaseId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get candidates: ${error.message}`);
    }

    return (data || []) as SavedCaseData[];
  }

  // ==========================================================================
  // PRIVATE: Scoring Methods
  // ==========================================================================

  /**
   * Check URL continuity between candidate and target.
   * If candidate's URL matches target's start URL or shares domain → potential prereq.
   *
   * @returns Score (0.0 - 0.9) and reason
   */
  private static checkUrlContinuity(
    candidate: SavedCaseData,
    target: SavedCaseData
  ): { score: number; reason: string } {
    if (!candidate.url || !target.url) {
      return { score: 0, reason: '' };
    }

    const candidateUrl = this.normalizeUrl(candidate.url);
    const targetUrl = this.normalizeUrl(target.url);

    if (!candidateUrl || !targetUrl) {
      return { score: 0, reason: '' };
    }

    // Exact match (candidate ends where target starts)
    if (candidateUrl === targetUrl) {
      return {
        score: 0.75,
        reason: `Same URL: ${this.shortUrl(candidate.url)}`,
      };
    }

    // Same domain
    const candidateDomain = this.extractDomain(candidate.url);
    const targetDomain = this.extractDomain(target.url);

    if (candidateDomain && targetDomain && candidateDomain === targetDomain) {
      // Check path relationship
      const candidatePath = this.extractPath(candidate.url);
      // const targetPath = this.extractPath(target.url);

      // If candidate is login/auth and target is something else
      if (candidatePath && PREREQ_KEYWORDS.some(k => candidatePath.toLowerCase().includes(k))) {
        return {
          score: 0.7,
          reason: `Auth flow: ${this.shortUrl(candidate.url)} → ${this.shortUrl(target.url)}`,
        };
      }

      return {
        score: 0.4,
        reason: `Same domain: ${candidateDomain}`,
      };
    }

    return { score: 0, reason: '' };
  }

  /**
   * Check keyword heuristics (login/auth → dashboard/profile patterns).
   *
   * @returns Score (0.0 - 0.8) and reason
   */
  private static checkKeywordHeuristics(
    candidate: SavedCaseData,
    target: SavedCaseData
  ): { score: number; reason: string } {
    const candidateText = `${candidate.name} ${candidate.description || ''} ${candidate.url || ''}`.toLowerCase();
    const targetText = `${target.name} ${target.description || ''} ${target.url || ''}`.toLowerCase();

    // Check if candidate is a prereq type and target is a dependent type
    const candidateIsPrereq = PREREQ_KEYWORDS.some(k => candidateText.includes(k));
    const targetIsDependent = DEPENDENT_KEYWORDS.some(k => targetText.includes(k));

    if (candidateIsPrereq && targetIsDependent) {
      return {
        score: 0.8,
        reason: `"${candidate.name}" is typically required before "${target.name}"`,
      };
    }

    // Check if candidate is explicitly a prereq based on name
    if (candidateIsPrereq && !PREREQ_KEYWORDS.some(k => targetText.includes(k))) {
      return {
        score: 0.6,
        reason: `"${candidate.name}" is a setup/auth test`,
      };
    }

    return { score: 0, reason: '' };
  }

  /**
   * Check semantic similarity using embeddings.
   * Compares name + description text.
   *
   * @returns Score (0.0 - 0.9) and reason
   */
  private static async checkSemanticSimilarity(
    candidate: SavedCaseData,
    target: SavedCaseData
  ): Promise<{ score: number; reason: string }> {
    const candidateText = `${candidate.name} ${candidate.description || ''}`.trim();
    const targetText = `${target.name} ${target.description || ''}`.trim();

    // Skip if texts are too short
    if (candidateText.length < 10 || targetText.length < 10) {
      return { score: 0, reason: '' };
    }

    try {
      const [candidateEmbedding, targetEmbedding] = await Promise.all([
        generateEmbedding(candidateText),
        generateEmbedding(targetText),
      ]);

      const similarity = cosineSimilarity(candidateEmbedding, targetEmbedding);

      if (similarity >= SEMANTIC_SIMILARITY_THRESHOLD) {
        return {
          score: Math.min(0.9, similarity),
          reason: `Similar context (${Math.round(similarity * 100)}% match)`,
        };
      }

      return { score: 0, reason: '' };
    } catch (error) {
      logger.warn('[DEPENDENCY_SUGGESTER] Semantic similarity failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { score: 0, reason: '' };
    }
  }

  // ==========================================================================
  // PRIVATE: URL Utilities
  // ==========================================================================

  /**
   * Normalize URL for comparison (lowercase, remove trailing slash, etc.)
   */
  private static normalizeUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Extract domain from URL
   */
  private static extractDomain(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Extract path from URL
   */
  private static extractPath(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.pathname.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Get a short version of URL for display
   */
  private static shortUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.length > 20
        ? `${parsed.pathname.substring(0, 17)}...`
        : parsed.pathname;
      return `${parsed.hostname}${path}`;
    } catch {
      return url.length > 30 ? `${url.substring(0, 27)}...` : url;
    }
  }
}
