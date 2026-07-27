/**
 * Jira QA Orchestrator
 * When a task lands in the QA column: analyze (KB + test cases + past bugs + memory + capabilities),
 * then either run tests, send back to rework, or prepare test cases for manual QA.
 *
 * Context enrichment: fetches data sources in parallel (KB, similar test cases, past bugs,
 * workspace memory, connected integrations, scoped project coverage + the ticket's related
 * tickets/subtasks/comments) so one LLM call can both triage AND assess task readiness /
 * forgotten test cases (see TaskReadinessService + jira-readiness-prompts).
 */

import { randomUUID } from 'crypto';
import { env } from '@/config/environment/env';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { RetrievalPlannerService } from '@/services/integrations/retrieval-planner.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { generateEmbedding } from '@/services/ai/core/embedding.service';
import { getJiraToken, ensureValidToken, getJiraIssueWithContext, addJiraComment, transitionJiraIssue, type JiraRelatedContext } from '@/services/api/jira.service';
import { searchKB } from '@/services/kb/kb.service';
import { TestCaseResolverService } from '@/services/testing/resolver/test-case-resolver.service';
import { WorkspaceMemoryService } from '@/services/ai/memory/workspace-memory.service';
import { CoverageAnalysisService } from '@/services/testing/analysis/coverage-analysis.service';
import { TaskReadinessService } from '@/services/testing/analysis/task-readiness.service';
import { buildJiraAnalysisMessages } from '@/ai/prompts/jira-readiness-prompts';
import { createTest } from '@/services/testing/ui/manual/test-creator';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { QueueManager } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { extractFirstUrl } from '@/utils/parsing/url-scope';
import type { ResolverResult } from '@/services/testing/resolver/resolver.types';
import type { IntentActionType } from '@/services/testing/ui/preview/preview.types';
import type { CoverageGap, JiraQaOutcome, TaskReadinessAssessment } from '@/types/testing.types';
import type { JiraIssueListItem } from '@/types';

// Re-exported for existing importers; the canonical definition lives in testing.types.
export type { JiraQaOutcome } from '@/types/testing.types';

export interface JiraQaAnalysisResult {
  outcome: JiraQaOutcome;
  reason?: string;
  missingData?: string[];
  suggestedAction?: {
    type: 'api_test' | 'platform_test';
    level?: string; // light | medium | hard for API
    mode?: string; // lite | pro for platform
  };
  extractedUrl?: string;
  testCaseSummary?: string;
  existingTestCaseId?: string | null;
  reworkQuestions?: string[];
  readiness?: TaskReadinessAssessment;
}

export interface JiraQaOrchestratorParams {
  issueKey: string;
  projectId: string;
  userId: string;
  cloudId?: string;
  reworkStatusName?: string; // e.g. "To Do" or "Rework"
  workspaceId?: string;
}

export interface JiraQaOrchestratorResult {
  success: boolean;
  outcome: JiraQaOutcome;
  message: string;
  testId?: string;
  testCaseId?: string;
  existingTestCaseId?: string;
  error?: string;
}

interface FindingSearchResult {
  title: string;
  description: string;
  severity: string;
  similarity: number;
}

// Map AICommand.action → IntentActionType for building draft test case steps
const AI_ACTION_TO_INTENT: Record<string, string> = {
  click: 'click',
  fill: 'type',
  goto: 'navigate',
  press: 'press',
  select: 'select',
  hover: 'hover',
  scroll: 'scroll',
  wait: 'wait',
  toggle: 'toggle',
  clear: 'click', // closest intent type
  setRange: 'click',
  selectDate: 'click',
};

export class JiraQaOrchestratorService {
  /**
   * Analyze Jira task and execute the chosen outcome (run test, rework, or prepare manual).
   * Enriches the AI decision with parallel data sources (KB, similar test cases, past bugs,
   * workspace memory, integrations, scoped coverage, related tickets) and also produces a
   * task-readiness assessment (readiness score + forgotten-case gaps) on the result.
   */
  static async analyzeAndExecute(params: JiraQaOrchestratorParams): Promise<JiraQaOrchestratorResult> {
    const { issueKey, projectId, userId, cloudId, reworkStatusName } = params;

    try {
      const tokenData = await getJiraToken(userId, cloudId);
      if (!tokenData?.cloud_id) {
        return { success: false, outcome: 'NEEDS_REWORK', message: 'Jira not connected', error: 'Jira not connected' };
      }
      const accessToken = await ensureValidToken(tokenData);
      const cloudIdToUse = cloudId || tokenData.cloud_id;

      const { analysis, issue, resolverResult } = await this.analyzeTask({
        issueKey, projectId, userId,
        accessToken, cloudId: cloudIdToUse,
        workspaceId: params.workspaceId,
      });

      // ── NEEDS_REWORK ──────────────────────────────────────────────────
      if (analysis.outcome === 'NEEDS_REWORK') {
        const questions = analysis.reworkQuestions?.length
          ? '\n\nPlease clarify:\n' + analysis.reworkQuestions.map(q => `• ${q}`).join('\n')
          : '';
        const comment = `[QAI] Cannot run automated test yet.\nReason: ${analysis.reason || 'Insufficient data'}`
          + (analysis.missingData?.length ? `\nMissing: ${analysis.missingData.join(', ')}` : '')
          + questions;
        await addJiraComment(accessToken, cloudIdToUse, issueKey, comment);
        if (reworkStatusName) {
          try {
            await transitionJiraIssue(accessToken, cloudIdToUse, issueKey, reworkStatusName);
          } catch (e) {
            logger.warn('[JIRA_QA] Transition to rework failed', { issueKey, error: e });
          }
        }
        return {
          success: true,
          outcome: 'NEEDS_REWORK',
          message: analysis.reason || 'Task sent back to rework',
        };
      }

      // ── CAN_RUN_AUTO: platform test ───────────────────────────────────
      if (analysis.outcome === 'CAN_RUN_AUTO' && analysis.suggestedAction?.type === 'platform_test' && analysis.extractedUrl) {
        // Pro Mode is retired — the IntelligentTestOrchestrator path is no longer
        // used; everything runs on the Lite engine. Force 'lite' regardless of
        // what the analysis LLM suggested, so this stays the last reachable
        // entry point that could have set 'pro'.
        const mode = 'lite' as const;
        const creditsRequired = 15;
        const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
        if (!creditCheck.hasEnough || (creditCheck.available ?? 0) < creditsRequired) {
          await addJiraComment(accessToken, cloudIdToUse, issueKey, `[QAI] Cannot run test: insufficient credits. Required: ${creditsRequired}, available: ${creditCheck.available ?? 0}.`);
          return {
            success: true,
            outcome: 'PREPARE_MANUAL',
            message: 'Insufficient credits; test case prepared for manual QA instead',
          };
        }

        // Build test goal; include prefilled steps hint if resolver found a match
        const testGoal = issue.summary + (issue.description ? '\n' + issue.description.slice(0, 500) : '');
        const prefilledSteps = resolverResult?.prefilledSteps;

        const test = await createTest({
          url: analysis.extractedUrl,
          projectId,
          userId,
          browsers: ['chrome'],
          intelligentMode: true,
          testGoal,
          mode,
          metadata: {
            source: 'jira_qa_orchestrator' as const,
            sourceJiraIssueKey: issueKey,
            sourceJiraCloudId: cloudIdToUse,
          },
        });
        await QueueManager.addTestRunJob({
          testId: test.id,
          url: analysis.extractedUrl,
          browser: 'chrome',
          projectId,
          userId,
          intelligentMode: true,
          testGoal: issue.summary,
          mode,
          ...(prefilledSteps?.length ? { prefilledSteps } : {}),
        });
        await CreditCostTrackerService.deductCreditsForTest({
          userId,
          testType: 'intelligent',
          credits: creditsRequired,
          costUSD: 0.06,
          testId: test.id,
          description: `Jira QA auto-test: ${issue.key} (${mode})`,
        });
        const prefilledNote = prefilledSteps?.length ? ` Enriched with ${prefilledSteps.length} prefilled steps from similar test cases.` : '';
        await addJiraComment(accessToken, cloudIdToUse, issueKey, `[QAI] Automated platform test started (${mode}). Test ID: ${test.id}${prefilledNote}`);
        return {
          success: true,
          outcome: 'CAN_RUN_AUTO',
          message: 'Platform test started',
          testId: test.id,
          existingTestCaseId: analysis.existingTestCaseId || undefined,
        };
      }

      // ── CAN_RUN_AUTO: API test ────────────────────────────────────────
      if (analysis.outcome === 'CAN_RUN_AUTO' && analysis.suggestedAction?.type === 'api_test' && analysis.extractedUrl) {
        await addJiraComment(accessToken, cloudIdToUse, issueKey, `[QAI] API test not yet automated from board. Please run from chat. URL: ${analysis.extractedUrl}`);
        return {
          success: true,
          outcome: 'PREPARE_MANUAL',
          message: 'API test suggested; run from chat with URL',
        };
      }

      // ── PREPARE_MANUAL (or CAN_RUN_AUTO without URL) ──────────────────
      const name = `Jira: ${issue.key} - ${issue.summary.slice(0, 80)}`;

      // Use prefilled steps from resolver if available, otherwise single assert
      const steps = (resolverResult?.prefilledSteps?.length)
        ? resolverResult.prefilledSteps.map(ps => {
            const intentType = (AI_ACTION_TO_INTENT[ps.command.action] || 'click') as IntentActionType;
            return {
              id: randomUUID(),
              type: intentType,
              description: `${ps.command.action}: ${ps.command.ref || ps.command.url || ps.command.value || ''}`.trim(),
            };
          })
        : [
            {
              id: randomUUID(),
              type: 'assert' as const,
              description: analysis.testCaseSummary || issue.summary,
            },
          ];

      const testCase = await IntentTestCaseService.create({
        projectId,
        userId,
        name,
        description: issue.description || undefined,
        startUrl: analysis.extractedUrl || undefined,
        steps,
        status: 'draft',
        kind: 'standalone',
      });
      const comment = `[QAI] Test case prepared for manual QA.\n${analysis.testCaseSummary || issue.summary}\nTest case ID: ${testCase.id}${steps.length > 1 ? `\nPre-populated with ${steps.length} steps from similar test cases.` : ''}`;
      await addJiraComment(accessToken, cloudIdToUse, issueKey, comment);
      return {
        success: true,
        outcome: 'PREPARE_MANUAL',
        message: 'Test case created for manual QA',
        testCaseId: testCase.id,
      };
    } catch (error) {
      logger.error('[JIRA_QA] Orchestrator error', { issueKey, error });
      return {
        success: false,
        outcome: 'PREPARE_MANUAL',
        message: 'Analysis failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Assess a Jira task WITHOUT executing anything: fetch it + related context,
   * enrich, and run the merged triage + readiness LLM call. Returns the parsed
   * analysis (incl. `readiness`). Used by the live `runFromJiraViaChat` path to
   * gate the auto-run. Throws only if Jira is not connected / the issue can't be
   * fetched (caller decides how to degrade).
   */
  static async assessReadiness(
    params: JiraQaOrchestratorParams,
  ): Promise<{ analysis: JiraQaAnalysisResult; issue: JiraIssueListItem; related: JiraRelatedContext }> {
    const { issueKey, projectId, userId, cloudId } = params;
    const tokenData = await getJiraToken(userId, cloudId);
    if (!tokenData?.cloud_id) {
      throw new Error('Jira not connected');
    }
    const accessToken = await ensureValidToken(tokenData);
    const cloudIdToUse = cloudId || tokenData.cloud_id;
    const { analysis, issue, related } = await this.analyzeTask({
      issueKey, projectId, userId,
      accessToken, cloudId: cloudIdToUse,
      workspaceId: params.workspaceId,
    });
    return { analysis, issue, related };
  }

  /**
   * Shared analysis half of the orchestrator: fetch the issue + related context,
   * enrich from all data sources in parallel, and run ONE merged triage +
   * readiness LLM call. Returns the parsed analysis plus the artifacts the
   * execution branches need (`issue`, `resolverResult`). No side effects.
   */
  private static async analyzeTask(args: {
    issueKey: string;
    projectId: string;
    userId: string;
    accessToken: string;
    cloudId: string;
    workspaceId?: string;
  }): Promise<{ analysis: JiraQaAnalysisResult; issue: JiraIssueListItem; related: JiraRelatedContext; resolverResult: ResolverResult | null }> {
    const { issueKey, projectId, userId, accessToken, cloudId } = args;

    const { issue, related } = await getJiraIssueWithContext(accessToken, cloudId, issueKey);

    // Resolve workspaceId (from args or from project)
    const workspaceId = args.workspaceId || await this.resolveWorkspaceId(projectId);

    const rawQuery = [issue.summary, issue.description].filter(Boolean).join(' ');

    // Query-driven retrieval (flagged): expand the ticket into search terms so
    // context retrieval finds related work by meaning, not just literal words.
    // Off / on failure → the raw ticket text is used (no regression).
    let query = rawQuery;
    if (env.JIRA_QUERY_PLANNER_ENABLED) {
      const plan = await RetrievalPlannerService.plan({ summary: issue.summary, description: issue.description });
      query = RetrievalPlannerService.enrichQuery(rawQuery, plan);
      if (plan.searchTerms.length || plan.entities.length) {
        logger.info('[JIRA_QA] Query planner expanded retrieval', {
          issueKey, terms: plan.searchTerms, entities: plan.entities,
        });
      }
    }

    // Fetch all data sources in parallel (each is non-fatal)
    const [kbResult, resolverResult, findingsResult, memoryContext, integrationContext, coverageGaps] = await Promise.all([
      // 1. Knowledge Base
      searchKB(query, projectId, { matchCount: 5, matchThreshold: 0.5 })
        .catch((err) => {
          logger.warn('[JIRA_QA] KB search failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
          return { chunks: [] } as { chunks: Array<{ content?: string }> };
        }),

      // 2. Test Case Resolver — find similar existing test cases
      workspaceId
        ? TestCaseResolverService.resolve({ message: query, userId, workspaceId })
            .catch((err) => {
              logger.warn('[JIRA_QA] Resolver failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
              return null as ResolverResult | null;
            })
        : Promise.resolve(null as ResolverResult | null),

      // 3. Past Bug Findings vector search — similar bugs in this project
      this.searchProjectFindings(query, projectId)
        .catch((err) => {
          logger.warn('[JIRA_QA] Findings search failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
          return [] as FindingSearchResult[];
        }),

      // 4. Workspace Memory — user-saved patterns and facts
      workspaceId
        ? WorkspaceMemoryService.getMemoryForContext(workspaceId, 1500)
            .catch((err) => {
              logger.warn('[JIRA_QA] Memory context failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
              return '';
            })
        : Promise.resolve(''),

      // 5. Integration status — which providers are connected
      import('@/services/api/integration-token.service')
        .then(m => m.IntegrationTokenService.getIntegrationSummary(userId, workspaceId ?? undefined))
        .catch(() => ''),

      // 6. Project coverage — a URL/execution-level SIGNAL (scoped to the ticket below)
      workspaceId
        ? CoverageAnalysisService.analyze(projectId, userId, workspaceId)
            .then((r) => r.gaps)
            .catch((err) => {
              logger.warn('[JIRA_QA] Coverage analysis failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
              return [] as CoverageGap[];
            })
        : Promise.resolve([] as CoverageGap[]),
    ]);

    // Build context strings
    const kbContext = ((kbResult as { chunks: Array<{ content?: string }> }).chunks || [])
      .map((c) => c.content)
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 3000);

    const testCaseContext = this.buildTestCaseContext(resolverResult);
    const pastBugsContext = this.buildPastBugsContext(findingsResult);
    const relatedTicketsContext = TaskReadinessService.buildRelatedTicketsContext(related);

    // Scope project-wide coverage gaps to this ticket's feature (by ticket URL +
    // matched test-case URLs), then render to a short signal string.
    const ticketUrl = extractFirstUrl(query);
    const scopedCoverage = TaskReadinessService.scopeCoverageGaps(
      coverageGaps,
      ticketUrl,
      resolverResult?.relatedCases ?? (resolverResult?.bestMatch ? [resolverResult.bestMatch] : []),
    );
    const coverageContext = TaskReadinessService.buildCoverageContext(scopedCoverage);

    logger.info('[JIRA_QA] Context enrichment complete', {
      issueKey,
      kbChunks: ((kbResult as { chunks: any[] }).chunks || []).length,
      resolverMatch: resolverResult?.matchType || 'none',
      findingsCount: findingsResult.length,
      hasMemory: !!memoryContext,
      relatedLinks: related.links.length,
      relatedSubtasks: related.subtasks.length,
      scopedCoverageGaps: scopedCoverage.length,
    });

    const { system, user } = buildJiraAnalysisMessages({
      issueSummary: issue.summary,
      issueDescription: issue.description,
      kbContext,
      testCaseContext,
      pastBugsContext,
      memoryContext,
      integrationContext,
      relatedTicketsContext,
      coverageContext,
    });

    const completion = await getChatCompletionWithMessages(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.2, max_tokens: 1400, response_format: { type: 'json_object' } }
    );
    let analysis: JiraQaAnalysisResult;
    try {
      const raw = JSON.parse(completion.content) as Record<string, unknown>;
      const outcome = (raw.outcome as JiraQaOutcome) || 'PREPARE_MANUAL';
      analysis = {
        outcome,
        reason: raw.reason as string | undefined,
        missingData: Array.isArray(raw.missingData) ? (raw.missingData as string[]) : undefined,
        suggestedAction: raw.suggestedAction as JiraQaAnalysisResult['suggestedAction'],
        extractedUrl: raw.extractedUrl as string | undefined,
        testCaseSummary: raw.testCaseSummary as string | undefined,
        existingTestCaseId: (raw.existingTestCaseId as string | null) || null,
        reworkQuestions: Array.isArray(raw.reworkQuestions) ? (raw.reworkQuestions as string[]) : undefined,
        readiness: TaskReadinessService.sanitizeReadiness(raw.readiness, outcome),
      };
    } catch {
      analysis = { outcome: 'PREPARE_MANUAL', reason: 'Could not parse AI response' };
    }

    logger.info('[JIRA_QA] Analysis result', { issueKey, outcome: analysis.outcome, reason: analysis.reason });

    return { analysis, issue, related, resolverResult };
  }

  /**
   * Get project Jira QA settings (reworkStatus + hybrid-autonomy flag from
   * project.settings.integrations.jira).
   */
  static async getProjectJiraQaSettings(
    projectId: string,
    userId: string,
  ): Promise<{ reworkStatusName?: string; requireApprovalBeforeRun: boolean }> {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle();
    const jira = (project?.settings as any)?.integrations?.jira || {};
    return {
      reworkStatusName: jira.reworkStatusName || undefined,
      requireApprovalBeforeRun: jira.requireApprovalBeforeRun === true,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Resolve workspaceId from projectId (lightweight single-column query).
   */
  private static async resolveWorkspaceId(projectId: string): Promise<string | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('workspace_id')
        .eq('id', projectId)
        .maybeSingle();
      if (error || !data?.workspace_id) {
        logger.warn('[JIRA_QA] Could not resolve workspaceId from projectId', { projectId });
        return null;
      }
      return data.workspace_id;
    } catch {
      return null;
    }
  }

  /**
   * Semantic search for past bug findings in the project via vector similarity RPC.
   */
  private static async searchProjectFindings(
    query: string,
    projectId: string,
  ): Promise<FindingSearchResult[]> {
    const queryEmbedding = await generateEmbedding(query);
    const { data, error } = await supabaseAdmin.rpc('search_project_findings', {
      p_project_id: projectId,
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_match_count: 5,
      p_match_threshold: 0.5,
    });
    if (error) {
      logger.warn('[JIRA_QA] search_project_findings RPC error', { projectId, error: error.message });
      return [];
    }
    return (data || []) as FindingSearchResult[];
  }

  /**
   * Build context string from TestCaseResolver result.
   */
  private static buildTestCaseContext(resolverResult: ResolverResult | null): string {
    if (!resolverResult) return '';

    if (resolverResult.matchType === 'exact' && resolverResult.bestMatch) {
      const m = resolverResult.bestMatch;
      return `EXACT MATCH found: "${m.name}" (ID: ${m.id}, score: ${m.score.toFixed(2)}, ${m.commands?.length || 0} steps)`
        + (m.url ? `\nURL: ${m.url}` : '');
    }

    if (resolverResult.matchType === 'partial' && resolverResult.relatedCases?.length) {
      return resolverResult.relatedCases.slice(0, 3).map(c =>
        `- "${c.name}" (score: ${c.score.toFixed(2)}, ${c.commands?.length || 0} steps${c.url ? ', URL: ' + c.url : ''})`
      ).join('\n');
    }

    return '';
  }

  /**
   * Build context string from findings vector search results.
   */
  private static buildPastBugsContext(findings: FindingSearchResult[]): string {
    if (!findings || findings.length === 0) return '';

    return findings.map(f =>
      `- [${f.severity}] ${f.title}: ${(f.description || '').slice(0, 150)} (similarity: ${typeof f.similarity === 'number' ? f.similarity.toFixed(2) : 'N/A'})`
    ).join('\n');
  }
}
