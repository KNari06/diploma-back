/**
 * Intent Case Dependency Suggester Service
 * Generates AI-powered dependency suggestions for intent_test_cases across a project.
 * Uses LLM classification (gemini-2.5-flash-lite) + URL continuity boost.
 *
 * NOTE: Service class name kept as SavedCaseDependencySuggester for API compatibility.
 * Now operates on intent_test_cases (unified table) instead of saved_test_cases.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
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
 * Combined result so the API can return both confident matches and
 * "near-miss" candidates the LLM considered but didn't endorse. The
 * UI uses `nearMisses` only when `suggestions` is empty so users see
 * that the AI did look and what it weighed, instead of a blank state.
 */
export interface DependencySuggestionResult {
  suggestions: DependencySuggestion[];
  nearMisses: DependencySuggestion[];
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
  /**
   * Short, plain-text summary of the first STEP_PREVIEW_LIMIT steps, e.g.
   *   "navigate https://shop.com/login; type 'email field' = user@example.com; click 'Sign in'"
   * Built once per row from `steps_json` and sent to the LLM so the model
   * judges by what the test does, not only by what it's called.
   */
  steps_preview?: string;
}

/** Shape of individual suggestion from LLM */
interface LLMDependencySuggestion {
  id: string;
  confidence: number;
  reason: string;
}

/** Shape of the full LLM JSON response */
interface LLMClassificationResponse {
  suggestions: LLMDependencySuggestion[];
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// --- Limits ---
const MAX_SUGGESTIONS = 5;

// --- Thresholds ---
const MIN_CONFIDENCE_THRESHOLD = 0.25;

// --- URL Continuity Scoring (Strategy 2 — language-independent, kept as-is) ---
const SCORE_URL_SAME_PAGE = 0.75;
const SCORE_URL_AUTH_PATH = 0.7;
const SCORE_URL_SAME_DOMAIN = 0.35;

/** Auth-related keywords for URL path matching */
const AUTH_PATH_KEYWORDS = [
  'login', 'auth', 'signin', 'sign-in',
  'register', 'signup', 'sign-up', 'onboarding',
];

// --- LLM Configuration ---
const LLM_MODEL = AI_TASK_MODELS.dependencySuggestion;
const LLM_TEMPERATURE = 0.1;
const LLM_MAX_TOKENS = 800;
const MAX_LLM_CANDIDATES = 35;

// --- Score Combination ---
const URL_BOOST_WEIGHT = 0.15;
// Tests in the same flow are usually dependent on each other ("Login → see
// dashboard → click profile" all live in one flow). 0.03 was rounding noise;
// 0.10 is meaningful without overpowering the LLM signal.
const SAME_FLOW_BOOST = 0.10;

// --- Steps preview ---
// How many step descriptions to include in the LLM prompt per test case.
// 5 is enough to capture intent without bloating tokens (target × 5 + 35
// candidates × 5 ≈ 180 short lines, still well under flash-lite's window).
const STEP_PREVIEW_LIMIT = 5;
const STEP_DESCRIPTION_MAX_CHARS = 80;

// --- Near-miss surfacing ---
// When nothing clears MIN_CONFIDENCE_THRESHOLD, expose items at or above this
// floor under a separate channel so the UI can show "Other candidates" rather
// than a blank "no suggestions" toast. Caller decides whether to render them.
const NEAR_MISS_FLOOR = 0.15;
const MAX_NEAR_MISSES = 3;

// ============================================================================
// LLM PROMPT
// ============================================================================

const DEPENDENCY_CLASSIFIER_SYSTEM_PROMPT = `You are a Senior QA test dependency analyzer. You determine which test cases must run BEFORE a target test case.

A dependency means: the candidate test MUST succeed before the target test can run.
Common patterns:
- Login/auth tests are dependencies for tests that require authenticated state
- Data creation tests (e.g. "Create product") are dependencies for tests that consume that data (e.g. "Edit product", "Delete product")
- Registration is a dependency for login (user must exist)
- Setup/config tests are dependencies for feature tests that need that configuration

Rules:
- Only suggest genuine execution-order dependencies, not just "related" tests
- Understand directionality: "Login" depends on nothing; "Dashboard" depends on "Login"
- Tests with the same goal but different scenarios (e.g. "Login valid" vs "Login invalid") are NOT dependencies of each other
- Consider the test names, descriptions, URLs, flow context, AND the first few steps when provided
- Steps reveal what a test actually does (e.g. "click Login", "type email", "click Submit"). Treat them as the strongest signal of intent — names can lie, steps usually don't
- Work with ANY language (English, Russian, Kazakh, Turkish, Chinese, etc.) — understand semantics, not keywords
- Return between 0 and 5 suggestions, sorted by confidence (highest first)
- If no candidates are true dependencies, return an empty suggestions array

Return JSON: {"suggestions": [{"id": "<candidate_id>", "confidence": <0.0-1.0>, "reason": "<concise explanation, 5-15 words>"}]}
If no dependencies found: {"suggestions": []}`;

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Service for generating dependency suggestions for intent test cases.
 * Analyzes test cases across the entire project and suggests dependencies using:
 * 1. LLM classification (understands semantics, directionality, any language)
 * 2. URL continuity boost (same page/auth path/same domain — language-independent)
 */
export class SavedCaseDependencySuggester {
  /**
   * Generate dependency suggestions for an intent test case.
   * Considers all candidates within the same project (cross-flow).
   */
  static async suggestForCase(
    caseId: string | null,
    flowId: string,
    userId: string,
    draftCase?: { name: string; description?: string; url?: string; steps?: unknown[] }
  ): Promise<DependencySuggestionResult> {
    const empty: DependencySuggestionResult = { suggestions: [], nearMisses: [] };
    try {
      logger.info('[DEPENDENCY_SUGGESTER] Generating suggestions', {
        caseId, flowId, userId, hasDraft: !!draftCase,
      });

      // 1. Get target case data
      const targetCase = await this.resolveTargetCase(caseId, flowId, userId, draftCase);
      if (!targetCase) return empty;

      // 2. Get project_id from flow
      const projectId = await this.getProjectIdFromFlow(flowId, userId);
      if (!projectId) {
        logger.warn('[DEPENDENCY_SUGGESTER] Could not resolve project for flow', { flowId });
        return empty;
      }

      // 3. Get candidates across entire project
      const candidates = await this.getCandidatesInProject(projectId, userId, caseId, targetCase.depends_on);
      if (candidates.length === 0) {
        logger.info('[DEPENDENCY_SUGGESTER] No candidates in project', { projectId });
        return empty;
      }

      // 4. Score and rank candidates
      const result = await this.scoreAndRankCandidates(candidates, targetCase);

      logger.info('[DEPENDENCY_SUGGESTER] Generated suggestions', {
        caseId, flowId, projectId,
        candidatesCount: candidates.length,
        suggestionsCount: result.suggestions.length,
        nearMissCount: result.nearMisses.length,
      });

      return result;
    } catch (error) {
      logger.error('[DEPENDENCY_SUGGESTER] Failed to generate suggestions', {
        error: error instanceof Error ? error.message : String(error),
        caseId, flowId,
      });
      return empty;
    }
  }

  // ==========================================================================
  // PRIVATE: Orchestration
  // ==========================================================================

  private static async resolveTargetCase(
    caseId: string | null,
    flowId: string,
    userId: string,
    draftCase?: { name: string; description?: string; url?: string; steps?: unknown[] }
  ): Promise<IntentCaseData | null> {
    if (draftCase) {
      return {
        id: caseId || 'draft',
        name: draftCase.name,
        description: draftCase.description,
        url: draftCase.url,
        flow_id: flowId,
        steps_preview: this.summarizeSteps(draftCase.steps),
      };
    }

    if (caseId) {
      const fetched = await this.getIntentCase(caseId, userId);
      if (!fetched) {
        logger.warn('[DEPENDENCY_SUGGESTER] Target case not found', { caseId });
      }
      return fetched;
    }

    logger.warn('[DEPENDENCY_SUGGESTER] No caseId or draftCase provided');
    return null;
  }

  private static async scoreAndRankCandidates(
    candidates: IntentCaseData[],
    targetCase: IntentCaseData
  ): Promise<DependencySuggestionResult> {
    if (candidates.length === 0) return { suggestions: [], nearMisses: [] };

    // Stage 1: Pre-compute URL continuity scores (free, fast)
    const urlScores = new Map<string, { score: number; reason: string }>();
    for (const candidate of candidates) {
      const urlResult = this.checkUrlContinuity(candidate, targetCase);
      if (urlResult.score > 0) {
        urlScores.set(candidate.id, urlResult);
      }
    }

    // Stage 2: Select candidates for LLM (truncate if needed)
    const llmCandidates = this.selectCandidatesForLLM(candidates, urlScores);

    // Stage 3: Call LLM classifier
    const llmSuggestions = await this.classifyWithLLM(targetCase, llmCandidates);

    // Stage 4: Combine LLM confidence with URL boost
    const validCandidateIds = new Set(candidates.map(c => c.id));
    const candidateMap = new Map(candidates.map(c => [c.id, c]));
    // We compute scores for ALL LLM suggestions first (no threshold), then
    // split into suggestions vs near-misses at the end. This lets the API
    // tell the UI "the AI did look — here are the things it weighed" when
    // nothing clears the main bar, instead of returning a blank list.
    const scored: DependencySuggestion[] = [];

    for (const suggestion of llmSuggestions) {
      // Guard: filter out hallucinated IDs
      if (!validCandidateIds.has(suggestion.id)) {
        logger.warn('[DEPENDENCY_SUGGESTER] LLM returned unknown candidate ID, skipping', {
          hallucinatedId: suggestion.id,
        });
        continue;
      }

      let finalConfidence = suggestion.confidence;
      const candidate = candidateMap.get(suggestion.id)!;

      // Apply URL continuity boost
      const urlScore = urlScores.get(suggestion.id);
      if (urlScore) {
        finalConfidence = Math.min(1.0, finalConfidence + urlScore.score * URL_BOOST_WEIGHT);
      }

      // Apply same-flow boost
      if (candidate.flow_id === targetCase.flow_id) {
        finalConfidence = Math.min(1.0, finalConfidence + SAME_FLOW_BOOST);
      }

      scored.push({
        id: suggestion.id,
        name: candidate.name,
        flowName: candidate.flow_name,
        confidence: Math.round(finalConfidence * 100) / 100,
        reason: suggestion.reason,
      });
    }

    scored.sort((a, b) => b.confidence - a.confidence);

    const suggestions: DependencySuggestion[] = [];
    const nearMisses: DependencySuggestion[] = [];
    for (const s of scored) {
      if (s.confidence >= MIN_CONFIDENCE_THRESHOLD) {
        if (suggestions.length < MAX_SUGGESTIONS) suggestions.push(s);
      } else if (s.confidence >= NEAR_MISS_FLOOR) {
        if (nearMisses.length < MAX_NEAR_MISSES) nearMisses.push(s);
      }
    }

    // Only surface near-misses when the main bucket is empty — otherwise
    // they'd just be noise next to confident matches.
    return {
      suggestions,
      nearMisses: suggestions.length === 0 ? nearMisses : [],
    };
  }

  // ==========================================================================
  // PRIVATE: LLM Classification
  // ==========================================================================

  /**
   * Select candidates to send to LLM within token budget.
   * Prioritizes candidates with URL continuity scores.
   */
  private static selectCandidatesForLLM(
    candidates: IntentCaseData[],
    urlScores: Map<string, { score: number; reason: string }>
  ): IntentCaseData[] {
    if (candidates.length <= MAX_LLM_CANDIDATES) return candidates;

    const withUrl: IntentCaseData[] = [];
    const withoutUrl: IntentCaseData[] = [];

    for (const c of candidates) {
      if (urlScores.has(c.id)) {
        withUrl.push(c);
      } else {
        withoutUrl.push(c);
      }
    }

    const remaining = MAX_LLM_CANDIDATES - withUrl.length;
    const selected = [...withUrl, ...withoutUrl.slice(0, Math.max(0, remaining))];

    logger.info('[DEPENDENCY_SUGGESTER] Truncated candidates for LLM', {
      total: candidates.length,
      selected: selected.length,
      withUrlScore: withUrl.length,
    });

    return selected;
  }

  /**
   * Build user prompt for LLM classification.
   */
  private static buildLLMUserPrompt(
    targetCase: IntentCaseData,
    candidates: IntentCaseData[]
  ): string {
    const targetBlock = [
      `Name: ${targetCase.name || '(unnamed)'}`,
      targetCase.description ? `Description: ${targetCase.description}` : null,
      targetCase.url ? `URL: ${targetCase.url}` : null,
      targetCase.steps_preview ? `First steps: ${targetCase.steps_preview}` : null,
    ].filter(Boolean).join('\n');

    const candidateLines = candidates.map((c, i) => {
      const parts = [
        `  id: ${c.id}`,
        `  name: ${c.name || '(unnamed)'}`,
      ];
      if (c.description) parts.push(`  description: ${c.description.substring(0, 100)}`);
      if (c.url) parts.push(`  url: ${c.url}`);
      if (c.flow_name) parts.push(`  flow: ${c.flow_name}`);
      if (c.steps_preview) parts.push(`  steps: ${c.steps_preview}`);
      return `[${i + 1}]\n${parts.join('\n')}`;
    }).join('\n\n');

    return `TARGET TEST CASE (needs dependencies):\n${targetBlock}\n\nCANDIDATE TESTS (may or may not be dependencies):\n${candidateLines}\n\nWhich candidates must run before the target? Return JSON with suggestions array.`;
  }

  /**
   * Call LLM to classify dependency relationships.
   * Returns validated suggestions or empty array on failure.
   */
  private static async classifyWithLLM(
    targetCase: IntentCaseData,
    candidates: IntentCaseData[]
  ): Promise<LLMDependencySuggestion[]> {
    if (candidates.length === 0) return [];

    try {
      const userPrompt = this.buildLLMUserPrompt(targetCase, candidates);

      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: DEPENDENCY_CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        {
          model: LLM_MODEL,
          temperature: LLM_TEMPERATURE,
          max_tokens: LLM_MAX_TOKENS,
          response_format: { type: 'json_object' },
        }
      );

      // Parse JSON response
      const parsed: LLMClassificationResponse = JSON.parse(response.content);

      if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) {
        logger.warn('[DEPENDENCY_SUGGESTER] LLM returned invalid structure', {
          content: response.content.substring(0, 200),
        });
        return [];
      }

      // Validate each suggestion
      const validSuggestions: LLMDependencySuggestion[] = [];
      for (const s of parsed.suggestions) {
        if (
          typeof s.id === 'string' && s.id.length > 0 &&
          typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1 &&
          typeof s.reason === 'string'
        ) {
          validSuggestions.push({
            id: s.id,
            confidence: s.confidence,
            reason: s.reason.substring(0, 200),
          });
        }
      }

      logger.info('[DEPENDENCY_SUGGESTER] LLM classification complete', {
        candidatesAnalyzed: candidates.length,
        suggestionsReturned: validSuggestions.length,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      });

      return validSuggestions;
    } catch (error) {
      logger.error('[DEPENDENCY_SUGGESTER] LLM classification failed, returning empty', {
        error: error instanceof Error ? error.message : String(error),
        candidatesCount: candidates.length,
      });
      return [];
    }
  }

  // ==========================================================================
  // PRIVATE: Data Fetching
  // ==========================================================================

  private static async getIntentCase(
    caseId: string,
    userId: string
  ): Promise<IntentCaseData | null> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, url, start_url, flow_id, project_id, depends_on, steps_json')
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
      steps_preview: this.summarizeSteps(result.steps_json),
    } as IntentCaseData;
  }

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

  private static async getCandidatesInProject(
    projectId: string,
    userId: string,
    excludeCaseId?: string | null,
    existingDeps?: string[]
  ): Promise<IntentCaseData[]> {
    let query = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, url, start_url, flow_id, project_id, depends_on, steps_json, test_flows(name)')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (excludeCaseId) {
      query = query.neq('id', excludeCaseId);
    }

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
      steps_preview: this.summarizeSteps(row.steps_json),
    })) as IntentCaseData[];
  }

  // ==========================================================================
  // PRIVATE: Step summarization
  // ==========================================================================

  /**
   * Compress the first STEP_PREVIEW_LIMIT steps of a test case into a
   * single short string for the LLM prompt. Returns undefined when there
   * are no usable steps so the prompt builder can omit the line cleanly.
   *
   * Format: "type 'email field'='user@x.com'; click 'Sign in'; navigate /home"
   * — verb-first, value/element quoted, separators ;. The LLM doesn't need
   * the structured JSON; a flat line keeps tokens low and reads naturally.
   */
  private static summarizeSteps(steps: unknown): string | undefined {
    if (!Array.isArray(steps) || steps.length === 0) return undefined;
    const parts: string[] = [];
    for (const raw of steps.slice(0, STEP_PREVIEW_LIMIT)) {
      const step = raw as {
        type?: string;
        description?: string;
        value?: string;
        assertionText?: string;
      };
      // Collapse internal whitespace (newlines/tabs/runs of spaces) to a
      // single space so multi-line `value` fields don't break the "; " join
      // separator and so the prompt stays one tidy line per step.
      const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
      const verb = clean((step?.type || '').toString());
      const target = clean((step?.description || '').toString());
      const value = clean((step?.value || step?.assertionText || '').toString());
      if (!verb && !target && !value) continue;
      let line = verb;
      if (target) line = line ? `${line} '${target}'` : `'${target}'`;
      if (value) line = line ? `${line}=${value}` : value;
      if (line.length > STEP_DESCRIPTION_MAX_CHARS) {
        line = line.substring(0, STEP_DESCRIPTION_MAX_CHARS - 1) + '…';
      }
      parts.push(line);
    }
    if (parts.length === 0) return undefined;
    return parts.join('; ');
  }

  // ==========================================================================
  // PRIVATE: URL Continuity (Strategy 2 — language-independent)
  // ==========================================================================

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

    if (candidateUrl === targetUrl) {
      return {
        score: SCORE_URL_SAME_PAGE,
        reason: `Same URL: ${this.shortUrl(candidate.url)}`,
      };
    }

    const candidateDomain = this.extractDomain(candidate.url);
    const targetDomain = this.extractDomain(target.url);

    if (candidateDomain && targetDomain && candidateDomain === targetDomain) {
      const candidatePath = this.extractPath(candidate.url);

      if (candidatePath && AUTH_PATH_KEYWORDS.some(k => candidatePath.includes(k))) {
        return {
          score: SCORE_URL_AUTH_PATH,
          reason: `Auth flow: ${this.shortUrl(candidate.url)} → ${this.shortUrl(target.url)}`,
        };
      }

      return {
        score: SCORE_URL_SAME_DOMAIN,
        reason: `Same domain: ${candidateDomain}`,
      };
    }

    return { score: 0, reason: '' };
  }

  // ==========================================================================
  // PRIVATE: URL Utilities
  // ==========================================================================

  private static normalizeUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`.toLowerCase();
    } catch {
      return null;
    }
  }

  private static extractDomain(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private static extractPath(url: string): string | null {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return null;
    }
  }

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
