/**
 * Smart Test Case Resolver Service
 *
 * Resolves user chat messages against existing intent_test_cases.
 * When a user writes "test checkout payment", this service checks if
 * a matching test case already exists and routes accordingly:
 *
 * - Exact match (≥0.85): redirect to run_regression (fast, no LiteEngine)
 * - Partial match (0.50–0.84): provide prefilled steps for LiteEngine fast replay
 * - No match (<0.50): passthrough to full LiteEngine
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import {
  combinedScore,
  computeNameSimilarity,
  computeUrlScore,
  cosineSimilarity,
  generateEmbedding,
  getCachedEmbedding,
  scoreReason,
} from './resolver-scoring';
// Phase B (May 2026) — shared_steps resolver deactivated. See regression-run
// service for full rationale; this file's `hasSharedSteps` branch (below)
// was always false in production because nothing emits `action: 'shared_steps'`.
// Import preserved in comment form to ease Phase C rollback if a stray row
// surfaces.
//   import { SharedStepResolverService } from '@/services/testing/shared-steps/shared-step-resolver.service';
import { logger } from '@/utils/core/logger';
import type { AICommand } from '@/agent/core/lite/lite-types';
import type {
  MatchType,
  ResolvedTestCase,
  ResolverResult,
  PrefilledStep,
  ResolverConfig,
} from './resolver.types';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: ResolverConfig = {
  exactMatchThreshold: 0.85,
  partialMatchThreshold: 0.50,
  maxCandidates: 50,
  maxPrefilledSources: 3,
  timeoutMs: 5000,
};

// Scoring weights, URL constants, name/URL similarity, and the embedding
// cache now live in ./resolver-scoring (shared with TestQueryResolverService).

// LLM refinement zone: scores in this range trigger LLM confirmation
const LLM_REFINE_MIN = 0.70;
const LLM_REFINE_MAX = 0.84;

// Command action mapping: PlaywrightCommand action → AICommand action
const ACTION_MAP: Record<string, AICommand['action'] | null> = {
  click: 'click',
  fill: 'fill',
  type: 'fill',
  goto: 'goto',
  navigate: 'goto',
  press: 'press',
  select: 'select',
  hover: 'hover',
  scroll: 'scroll',
  wait: 'wait',
  check: 'toggle',
  uncheck: 'toggle',
  toggle: 'toggle',
  setRange: 'setRange',
  clear: 'clear',
  selectDate: 'selectDate',
};

// ============================================================================
// SERVICE
// ============================================================================

export class TestCaseResolverService {
  /**
   * Main entry point: resolve a user message against existing test cases.
   */
  static async resolve(params: {
    message: string;
    userId: string;
    workspaceId: string;
    currentUrl?: string;
    config?: Partial<ResolverConfig>;
    /**
     * When true, restrict candidates to projects OWNED by `userId` (not the
     * whole workspace). The chat run flow needs this because the runner
     * (`getSavedTestCase`) is owner-scoped — surfacing a workspace-mate's test
     * we can't actually run would dead-end on confirm. Default false preserves
     * the workspace-wide behavior other callers (Jira) rely on.
     */
    ownerOnly?: boolean;
  }): Promise<ResolverResult> {
    const config = { ...DEFAULT_CONFIG, ...params.config };
    const startTime = Date.now();
    let strategy: ResolverResult['resolverMeta']['strategy'] = 'hybrid';

    try {
      // 1. Fetch published test cases from workspace projects
      const candidates = await this.fetchCandidates(params.userId, params.workspaceId, config, params.ownerOnly);

      if (candidates.length === 0) {
        return {
          matchType: 'none',
          resolverMeta: {
            candidatesScanned: 0,
            totalTimeMs: Date.now() - startTime,
            strategy,
          },
        };
      }

      // 2. Score and rank candidates
      const ranked = await Promise.race([
        this.scoreAndRank(params.message, candidates, params.currentUrl),
        new Promise<ResolvedTestCase[]>((_, reject) =>
          setTimeout(() => reject(new Error('Resolver timeout')), config.timeoutMs)
        ),
      ]).catch((err) => {
        // Embedding timeout → fallback to name-only matching
        logger.warn('[RESOLVER] Scoring timeout, falling back to name-only', {
          error: err.message,
        });
        strategy = 'name_only';
        return this.scoreByNameOnly(params.message, candidates);
      });

      if (ranked.length === 0) {
        return {
          matchType: 'none',
          resolverMeta: {
            candidatesScanned: candidates.length,
            totalTimeMs: Date.now() - startTime,
            strategy,
          },
        };
      }

      // 3. Classify match
      const matchType = await this.classifyMatch(params.message, ranked, config);

      // 4. Build result based on match type
      const result: ResolverResult = {
        matchType,
        resolverMeta: {
          candidatesScanned: candidates.length,
          totalTimeMs: Date.now() - startTime,
          strategy,
        },
      };

      if (matchType === 'exact') {
        result.bestMatch = ranked[0];
        result.bestMatch.matchType = 'exact';
      } else if (matchType === 'partial') {
        const topCases = ranked.slice(0, config.maxPrefilledSources);
        result.relatedCases = topCases.map(c => ({ ...c, matchType: 'partial' as MatchType }));
        result.prefilledSteps = await this.buildPrefilledSteps(topCases);
      }

      logger.info('[RESOLVER] Resolution complete', {
        matchType,
        candidatesScanned: candidates.length,
        topScore: ranked[0]?.score ?? 0,
        totalTimeMs: result.resolverMeta.totalTimeMs,
        strategy,
      });

      return result;
    } catch (err) {
      logger.error('[RESOLVER] Unexpected error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        matchType: 'none',
        resolverMeta: {
          candidatesScanned: 0,
          totalTimeMs: Date.now() - startTime,
          strategy,
        },
      };
    }
  }

  /**
   * Similarity search for AUTHORING: "does a test case like this already exist?"
   * Reuses the same hybrid scoring as `resolve()` (embedding + name + URL) but
   * skips the chat-routing concerns — no match-type classification, no
   * prefilled steps, no thresholds. Returns the top-N ranked candidates so the
   * caller (e.g. the mobile agent, before authoring a new draft) can warn about
   * duplicates.
   *
   * `platformPrefix` filters candidates in the DB query BEFORE the candidate
   * cap, so a mobile search on a web-heavy workspace still sees mobile rows.
   * Never throws — returns [] on any failure (embedding timeout falls back to
   * name-only scoring, same as `resolve`).
   */
  static async findSimilar(params: {
    query: string;
    userId: string;
    workspaceId: string;
    platformPrefix?: string;
    limit?: number;
    config?: Partial<ResolverConfig>;
  }): Promise<ResolvedTestCase[]> {
    const config = { ...DEFAULT_CONFIG, ...params.config };
    const limit = params.limit ?? 3;
    try {
      const candidates = await this.fetchCandidates(
        params.userId,
        params.workspaceId,
        config,
        true, // owner-scoped — matches the owner-scoped save path
        params.platformPrefix,
      );
      if (candidates.length === 0) return [];

      const ranked = await Promise.race([
        this.scoreAndRank(params.query, candidates),
        new Promise<ResolvedTestCase[]>((_, reject) =>
          setTimeout(() => reject(new Error('Resolver timeout')), config.timeoutMs),
        ),
      ]).catch((err) => {
        logger.warn('[RESOLVER] findSimilar scoring timeout, name-only fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
        return this.scoreByNameOnly(params.query, candidates);
      });

      return ranked.slice(0, limit);
    } catch (err) {
      logger.warn('[RESOLVER] findSimilar failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Does this user have ANY runnable saved tests or regression plans (in
   * projects they OWN within the workspace)? Used by the chat flow to decide
   * between "confirm an existing test" and "suggest exploration". Owner-scoped
   * to match the owner-scoped runner + the resolver's ownerOnly run path — so
   * "you don't have any tests yet" is accurate for THIS user. Counts published
   * intent_test_cases AND regression plans. Never throws — returns false on any
   * failure so the caller degrades to the exploration suggestion.
   */
  static async userHasAnyTests(userId: string, workspaceId: string): Promise<boolean> {
    try {
      const { data: projects } = await supabaseAdmin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId);

      const projectIds = (projects || []).map((p) => p.id);
      if (projectIds.length === 0) return false;

      const [testCases, plans] = await Promise.all([
        supabaseAdmin
          .from('intent_test_cases')
          .select('id', { count: 'exact', head: true })
          .in('project_id', projectIds)
          .eq('status', 'published'),
        supabaseAdmin
          .from('regression_plans')
          .select('id', { count: 'exact', head: true })
          .in('project_id', projectIds),
      ]);

      return (testCases.count || 0) + (plans.count || 0) > 0;
    } catch (err) {
      logger.warn('[RESOLVER] userHasAnyTests failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ==========================================================================
  // PRIVATE: Fetch Candidates
  // ==========================================================================

  private static async fetchCandidates(
    userId: string,
    workspaceId: string,
    config: ResolverConfig,
    ownerOnly?: boolean,
    platformPrefix?: string,
  ): Promise<RawCandidate[]> {
    // Get the projects to scan. ownerOnly restricts to projects the user owns
    // (so every candidate is runnable by the owner-scoped runner); otherwise
    // the whole workspace is in scope.
    let projectQuery = supabaseAdmin
      .from('projects')
      .select('id')
      .eq('workspace_id', workspaceId);
    if (ownerOnly) {
      projectQuery = projectQuery.eq('user_id', userId);
    }
    const { data: projects, error: projError } = await projectQuery;

    if (projError || !projects?.length) {
      logger.debug('[RESOLVER] No projects in scope', { workspaceId, ownerOnly });
      return [];
    }

    const projectIds = projects.map(p => p.id);

    let candidateQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, url, start_url, commands, steps_json, project_id, flow_id, tags, platform, updated_at')
      .in('project_id', projectIds)
      .eq('status', 'published');
    // Platform filter BEFORE the cap — otherwise a workspace with many web
    // tests could evict all mobile rows past `maxCandidates` before scoring.
    if (platformPrefix) {
      candidateQuery = candidateQuery.like('platform', `${platformPrefix}%`);
    }
    const { data, error } = await candidateQuery
      .order('updated_at', { ascending: false })
      .limit(config.maxCandidates);

    if (error) {
      logger.error('[RESOLVER] Failed to fetch candidates', { error: error.message });
      return [];
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      url: row.url || row.start_url || '',
      commands: Array.isArray(row.commands) ? row.commands : [],
      stepsJson: Array.isArray(row.steps_json) ? row.steps_json : [],
      projectId: row.project_id,
      flowId: row.flow_id,
      tags: Array.isArray(row.tags) ? row.tags : [],
      platform: row.platform || 'web',
      updatedAt: row.updated_at,
    }));
  }

  // ==========================================================================
  // PRIVATE: Score & Rank (Hybrid: Embedding + Name + URL)
  // ==========================================================================

  private static async scoreAndRank(
    message: string,
    candidates: RawCandidate[],
    currentUrl?: string
  ): Promise<ResolvedTestCase[]> {
    // Generate message embedding
    const messageEmbedding = await generateEmbedding(message);

    // Generate/retrieve candidate embeddings (shared cache, keyed by id:updatedAt)
    const candidateEmbeddings = await Promise.all(
      candidates.map((c) =>
        getCachedEmbedding(
          `${c.id}:${c.updatedAt}`,
          [c.name, c.description].filter(Boolean).join(' — '),
        ),
      ),
    );

    // Score each candidate (shared scoring — see resolver-scoring.ts)
    const scored: ResolvedTestCase[] = candidates.map((candidate, idx) => {
      const embeddingSim = candidateEmbeddings[idx]
        ? cosineSimilarity(messageEmbedding, candidateEmbeddings[idx]!)
        : 0;
      const nameSim = computeNameSimilarity(message, candidate.name);
      const urlScore = currentUrl ? computeUrlScore(currentUrl, candidate.url) : 0;

      return {
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        url: candidate.url,
        commands: candidate.commands,
        stepsJson: candidate.stepsJson,
        projectId: candidate.projectId,
        flowId: candidate.flowId,
        tags: candidate.tags,
        platform: candidate.platform,
        score: combinedScore(embeddingSim, nameSim, urlScore),
        matchType: 'none' as MatchType,
        matchReason: scoreReason(embeddingSim, nameSim, urlScore),
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  // ==========================================================================
  // PRIVATE: Name-only fallback scoring (when embeddings timeout)
  // ==========================================================================

  private static scoreByNameOnly(
    message: string,
    candidates: RawCandidate[]
  ): ResolvedTestCase[] {
    const scored = candidates.map(candidate => {
      const nameSim = computeNameSimilarity(message, candidate.name);
      const descSim = candidate.description
        ? computeNameSimilarity(message, candidate.description) * 0.5
        : 0;
      const score = Math.max(nameSim, descSim);

      return {
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        url: candidate.url,
        commands: candidate.commands,
        stepsJson: candidate.stepsJson,
        projectId: candidate.projectId,
        flowId: candidate.flowId,
        tags: candidate.tags,
        platform: candidate.platform,
        score,
        matchType: 'none' as MatchType,
        matchReason: `name_only=${score.toFixed(2)}`,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // ==========================================================================
  // PRIVATE: Classify Match
  // ==========================================================================

  private static async classifyMatch(
    message: string,
    ranked: ResolvedTestCase[],
    config: ResolverConfig
  ): Promise<MatchType> {
    const topScore = ranked[0].score;

    if (topScore >= config.exactMatchThreshold) {
      return 'exact';
    }

    // Uncertain zone: call LLM to confirm
    if (topScore >= LLM_REFINE_MIN && topScore < LLM_REFINE_MAX) {
      try {
        const isExact = await this.refineWithLLM(message, ranked.slice(0, 3));
        if (isExact) return 'exact';
      } catch (err) {
        // Conservative fallback: treat as partial (not exact)
        logger.warn('[RESOLVER] LLM refinement failed, defaulting to partial', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (topScore >= config.partialMatchThreshold) {
      return 'partial';
    }

    return 'none';
  }

  // ==========================================================================
  // PRIVATE: LLM Refinement (uncertain zone 0.70-0.84)
  // ==========================================================================

  private static async refineWithLLM(
    message: string,
    topCandidates: ResolvedTestCase[]
  ): Promise<boolean> {
    const candidatesText = topCandidates
      .map((c, i) => `${i + 1}. "${c.name}"${c.description ? ` — ${c.description}` : ''}${c.url ? ` (${c.url})` : ''}`)
      .join('\n');

    const response = await getChatCompletionWithMessages(
      [
        {
          role: 'system',
          content: `You are a QA test case matcher. Determine if the user wants to run one of the existing test cases below, or if they want something different.

Existing test cases:
${candidatesText}

Rules:
- If the user's message clearly refers to one of these test cases (same functionality, same page), answer isExactMatch=true
- If the user wants something different, even if related, answer isExactMatch=false
- Work with any language (English, Russian, etc.)

Return JSON: {"isExactMatch": boolean, "confidence": number, "matchedIndex": number | null}`,
        },
        { role: 'user', content: message },
      ],
      {
        model: AI_TASK_MODELS.testCaseResolution,
        temperature: 0.1,
        max_tokens: 100,
        response_format: { type: 'json_object' },
      }
    );

    const parsed = JSON.parse(response.content || '{}');
    return parsed.isExactMatch === true && (parsed.confidence ?? 0) >= 0.8;
  }

  // ==========================================================================
  // PRIVATE: Build Prefilled Steps
  // ==========================================================================

  private static async buildPrefilledSteps(
    relatedCases: ResolvedTestCase[]
  ): Promise<PrefilledStep[]> {
    const steps: PrefilledStep[] = [];

    for (const testCase of relatedCases) {
      const commands = testCase.commands;

      // Phase B (May 2026) — shared_steps resolution removed. `hasSharedSteps`
      // was always false in production (no producer of action='shared_steps'
      // commands exists anywhere in the codebase). Block preserved here as
      // a comment for Phase C rollback context.
      //
      //   const hasSharedSteps = commands.some((c: any) => c.action === 'shared_steps');
      //   if (hasSharedSteps) {
      //     try {
      //       const resolved = await SharedStepResolverService.resolveCommands(
      //         commands,
      //         testCase.projectId
      //       );
      //       commands = resolved.commands;
      //     } catch (err) {
      //       logger.warn('[RESOLVER] Failed to resolve shared steps, using raw commands', {
      //         testCaseId: testCase.id,
      //         error: err instanceof Error ? err.message : String(err),
      //       });
      //     }
      //   }

      // Convert PlaywrightCommand → AICommand
      for (let i = 0; i < commands.length; i++) {
        const aiCommand = this.convertToAICommand(commands[i]);
        if (aiCommand) {
          steps.push({
            command: aiCommand,
            sourceTestCaseId: testCase.id,
            sourceTestCaseName: testCase.name,
            stepIndex: i,
            softReplay: true, // Default: continue on failure, let AI take over
          });
        }
      }
    }

    return steps;
  }

  // ==========================================================================
  // PRIVATE: Command Conversion (PlaywrightCommand → AICommand)
  // ==========================================================================

  private static convertToAICommand(cmd: any): AICommand | null {
    if (!cmd || !cmd.action) return null;

    const mappedAction = ACTION_MAP[cmd.action];
    if (!mappedAction) return null;

    const aiCommand: AICommand = { action: mappedAction };

    switch (mappedAction) {
      case 'click':
      case 'hover':
        aiCommand.ref = cmd.selector || cmd.ref;
        break;
      case 'fill':
        aiCommand.ref = cmd.selector || cmd.ref;
        aiCommand.value = cmd.value || cmd.text || '';
        break;
      case 'goto':
        aiCommand.url = cmd.url || cmd.value;
        break;
      case 'press':
        aiCommand.ref = cmd.selector || cmd.ref;
        aiCommand.key = cmd.key || cmd.value;
        break;
      case 'select':
        aiCommand.ref = cmd.selector || cmd.ref;
        aiCommand.value = cmd.value;
        break;
      case 'scroll':
        aiCommand.direction = cmd.direction || 'down';
        aiCommand.amount = cmd.amount;
        break;
      case 'wait':
        break;
      case 'toggle':
        aiCommand.ref = cmd.selector || cmd.ref;
        break;
      case 'setRange':
        aiCommand.ref = cmd.selector || cmd.ref;
        aiCommand.value = cmd.value;
        break;
      case 'clear':
        aiCommand.ref = cmd.selector || cmd.ref;
        break;
      case 'selectDate':
        aiCommand.ref = cmd.selector || cmd.ref;
        aiCommand.value = cmd.value;
        break;
    }

    return aiCommand;
  }

}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface RawCandidate {
  id: string;
  name: string;
  description: string;
  url: string;
  commands: any[];
  stepsJson: any[];
  projectId: string;
  flowId?: string;
  tags: string[];
  platform: string;
  updatedAt: string;
}
