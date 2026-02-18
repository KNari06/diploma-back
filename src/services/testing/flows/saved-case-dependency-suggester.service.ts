/**
 * Intent Case Dependency Suggester Service
 * Generates AI-powered dependency suggestions for intent_test_cases across a project.
 * Uses context-first approach: name matching, URL continuity, heuristics, and semantic similarity.
 *
 * NOTE: Service class name kept as SavedCaseDependencySuggester for API compatibility.
 * Now operates on intent_test_cases (unified table) instead of saved_test_cases.
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
  id: string;           // intent_test_cases.id of the suggested dependency
  name: string;         // test case name for display
  flowName?: string;    // flow name (useful for cross-flow suggestions)
  confidence: number;   // 0.0 - 1.0
  reason: string;       // Human-readable explanation
}

/**
 * Minimal intent case data needed for suggestion calculations
 */
interface IntentCaseData {
  id: string;
  name: string;
  description?: string;
  url?: string;
  start_url?: string;
  flow_id?: string;
  flow_name?: string;
  project_id?: string;
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
const MIN_CONFIDENCE_THRESHOLD = 0.25;

/** Semantic similarity threshold */
const SEMANTIC_SIMILARITY_THRESHOLD = 0.45;

/** Keywords indicating a prerequisite test (login, auth, setup) */
const PREREQ_KEYWORDS = ['login', 'auth', 'authenticate', 'sign in', 'signin', 'onboarding', 'setup', 'register', 'registration', 'create', 'add', 'new', 'init', 'open', 'navigate', 'go to'];

/** Keywords indicating dependent tests (dashboard, profile, settings, etc.) */
const DEPENDENT_KEYWORDS = ['dashboard', 'profile', 'settings', 'account', 'home', 'main', 'checkout', 'payment', 'order', 'delete', 'remove', 'edit', 'update', 'modify', 'submit', 'confirm', 'verify', 'view', 'list'];

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Service for generating dependency suggestions for intent test cases.
 * Analyzes test cases across the entire project and suggests dependencies based on:
 * 1. Name/word matching (lightweight, high recall)
 * 2. URL continuity (strongest signal)
 * 3. Keyword heuristics (login -> dashboard patterns)
 * 4. Semantic similarity (embeddings-based, most expensive)
 */
export class SavedCaseDependencySuggester {
  /**
   * Generate dependency suggestions for an intent test case.
   * Considers all candidates within the same project (cross-flow).
   *
   * @param caseId - ID of the intent test case (or null for draft)
   * @param flowId - Flow ID of the target case
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
      let targetCase: IntentCaseData;
      if (draftCase) {
        targetCase = {
          id: caseId || 'draft',
          name: draftCase.name,
          description: draftCase.description,
          url: draftCase.url,
          flow_id: flowId,
        };
      } else if (caseId) {
        const fetched = await this.getIntentCase(caseId, userId);
        if (!fetched) {
          logger.warn('[DEPENDENCY_SUGGESTER] Target case not found', { caseId });
          return [];
        }
        targetCase = fetched;
      } else {
        logger.warn('[DEPENDENCY_SUGGESTER] No caseId or draftCase provided');
        return [];
      }

      // 2. Get project_id from flow to scope candidates across entire project
      const projectId = await this.getProjectIdFromFlow(flowId, userId);
      if (!projectId) {
        logger.warn('[DEPENDENCY_SUGGESTER] Could not resolve project for flow', { flowId });
        return [];
      }

      // 3. Get candidate cases across entire project (excluding target and already-added deps)
      const candidates = await this.getCandidatesInProject(projectId, userId, caseId, targetCase.depends_on);
      if (candidates.length === 0) {
        logger.info('[DEPENDENCY_SUGGESTER] No candidates in project', { projectId });
        return [];
      }

      // 4. Score each candidate
      const scoredCandidates: Array<DependencySuggestion & { scores: number[] }> = [];
      let semanticComparisons = 0;

      for (const candidate of candidates) {
        const scores: { score: number; reason: string }[] = [];

        // 4a. Name/word matching (cheap, high recall)
        const nameScore = this.checkNameSimilarity(candidate, targetCase);
        if (nameScore.score > 0) {
          scores.push(nameScore);
        }

        // 4b. URL continuity check
        const urlScore = this.checkUrlContinuity(candidate, targetCase);
        if (urlScore.score > 0) {
          scores.push(urlScore);
        }

        // 4c. Keyword heuristics check
        const heuristicScore = this.checkKeywordHeuristics(candidate, targetCase);
        if (heuristicScore.score > 0) {
          scores.push(heuristicScore);
        }

        // 4d. Semantic similarity (limited, expensive)
        if (semanticComparisons < MAX_SEMANTIC_COMPARISONS) {
          const semanticScore = await this.checkSemanticSimilarity(candidate, targetCase);
          semanticComparisons++;
          if (semanticScore.score > 0) {
            scores.push(semanticScore);
          }
        }

        // Calculate combined confidence (take best score)
        if (scores.length > 0) {
          scores.sort((a, b) => b.score - a.score);
          const bestScore = scores[0];

          // Boost same-flow candidates slightly
          const flowBoost = candidate.flow_id === targetCase.flow_id ? 0.05 : 0;
          const finalConfidence = Math.min(1.0, bestScore.score + flowBoost);

          if (finalConfidence >= MIN_CONFIDENCE_THRESHOLD) {
            scoredCandidates.push({
              id: candidate.id,
              name: candidate.name,
              flowName: candidate.flow_name,
              confidence: Math.round(finalConfidence * 100) / 100,
              reason: bestScore.reason,
              scores: scores.map(s => s.score),
            });
          }
        }
      }

      // 5. Sort by confidence and limit
      scoredCandidates.sort((a, b) => b.confidence - a.confidence);
      const suggestions = scoredCandidates
        .slice(0, MAX_SUGGESTIONS)
        .map(({ id, name, flowName, confidence, reason }) => ({ id, name, flowName, confidence, reason }));

      logger.info('[DEPENDENCY_SUGGESTER] Generated suggestions', {
        caseId,
        flowId,
        projectId,
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
   * Get an intent test case by ID
   */
  private static async getIntentCase(
    caseId: string,
    userId: string
  ): Promise<IntentCaseData | null> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, url, start_url, flow_id, project_id, depends_on')
      .eq('id', caseId)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get intent case: ${error.message}`);
    }

    const result = data as any;
    return {
      ...result,
      url: result.url || result.start_url,
    } as IntentCaseData;
  }

  /**
   * Get project_id from flow via test_modules
   */
  private static async getProjectIdFromFlow(
    flowId: string,
    userId: string
  ): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id, test_modules!inner(project_id)')
      .eq('id', flowId)
      .eq('user_id', userId)
      .single();

    if (error || !data) return null;
    return (data as any).test_modules?.project_id || null;
  }

  /**
   * Get all candidate cases across the entire project (excluding target and existing deps)
   */
  private static async getCandidatesInProject(
    projectId: string,
    userId: string,
    excludeCaseId?: string | null,
    existingDeps?: string[]
  ): Promise<IntentCaseData[]> {
    let query = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, url, start_url, flow_id, project_id, depends_on, test_flows(name)')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (excludeCaseId) {
      query = query.neq('id', excludeCaseId);
    }

    // Exclude already-added dependencies
    if (existingDeps && existingDeps.length > 0) {
      query = query.not('id', 'in', `(${existingDeps.join(',')})`);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get candidates: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      ...row,
      url: row.url || row.start_url,
      flow_name: row.test_flows?.name,
    })) as IntentCaseData[];
  }

  // ==========================================================================
  // PRIVATE: Scoring Methods
  // ==========================================================================

  /**
   * Check name similarity using word overlap.
   * Simple but effective for catching related tests like "Login" and "Login and redirect".
   *
   * @returns Score (0.0 - 0.7) and reason
   */
  private static checkNameSimilarity(
    candidate: IntentCaseData,
    target: IntentCaseData
  ): { score: number; reason: string } {
    const candidateWords = this.extractWords(candidate.name);
    const targetWords = this.extractWords(target.name);

    if (candidateWords.length === 0 || targetWords.length === 0) {
      return { score: 0, reason: '' };
    }

    // Count shared words
    const shared = candidateWords.filter(w => targetWords.includes(w));
    if (shared.length === 0) {
      return { score: 0, reason: '' };
    }

    // Jaccard-like similarity: shared / union
    const union = new Set([...candidateWords, ...targetWords]);
    const similarity = shared.length / union.size;

    if (similarity >= 0.2) {
      const score = Math.min(0.7, 0.3 + similarity * 0.5);
      return {
        score,
        reason: `Related test: "${candidate.name}"`,
      };
    }

    return { score: 0, reason: '' };
  }

  /**
   * Check URL continuity between candidate and target.
   * If candidate's URL matches target's start URL or shares domain → potential prereq.
   *
   * @returns Score (0.0 - 0.9) and reason
   */
  private static checkUrlContinuity(
    candidate: IntentCaseData,
    target: IntentCaseData
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
      const candidatePath = this.extractPath(candidate.url);

      // If candidate is login/auth and target is something else
      if (candidatePath && PREREQ_KEYWORDS.some(k => candidatePath.toLowerCase().includes(k))) {
        return {
          score: 0.7,
          reason: `Auth flow: ${this.shortUrl(candidate.url)} → ${this.shortUrl(target.url)}`,
        };
      }

      return {
        score: 0.35,
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
    candidate: IntentCaseData,
    target: IntentCaseData
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
        score: 0.5,
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
    candidate: IntentCaseData,
    target: IntentCaseData
  ): Promise<{ score: number; reason: string }> {
    const candidateText = `${candidate.name} ${candidate.description || ''}`.trim();
    const targetText = `${target.name} ${target.description || ''}`.trim();

    // Skip if texts are too short
    if (candidateText.length < 5 || targetText.length < 5) {
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
  // PRIVATE: Utilities
  // ==========================================================================

  /**
   * Extract meaningful words from a string (lowercase, min 2 chars, no stop words)
   */
  private static extractWords(text: string): string[] {
    const stopWords = new Set(['the', 'a', 'an', 'is', 'in', 'on', 'to', 'for', 'of', 'and', 'or', 'with', 'test', 'case', 'that', 'this', 'it']);
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w));
  }

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
