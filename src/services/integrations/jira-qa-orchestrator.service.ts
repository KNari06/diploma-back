/**
 * Jira QA Orchestrator
 * When a task lands in the QA column: analyze (KB + test cases + past bugs + memory + capabilities),
 * then either run tests, send back to rework, or prepare test cases for manual QA.
 *
 * Context enrichment (v2): fetches 4 data sources in parallel for accurate AI decisions.
 */

import { randomUUID } from 'crypto';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { generateEmbedding } from '@/services/ai/core/embedding.service';
import { getJiraToken, ensureValidToken, getJiraIssue, addJiraComment, transitionJiraIssue } from '@/services/api/jira.service';
import { searchKB } from '@/services/kb/kb.service';
import { TestCaseResolverService } from '@/services/testing/resolver/test-case-resolver.service';
import { WorkspaceMemoryService } from '@/services/ai/memory/workspace-memory.service';
import { createTest } from '@/services/testing/ui/manual/test-creator';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { QueueManager } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { ResolverResult } from '@/services/testing/resolver/resolver.types';
import type { IntentActionType } from '@/services/testing/ui/preview/preview.types';

export type JiraQaOutcome = 'CAN_RUN_AUTO' | 'NEEDS_REWORK' | 'PREPARE_MANUAL';

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

const ANALYSIS_SYSTEM_PROMPT = `You are a senior QA engineer triaging Jira tickets for automated testing.
Your job is to decide if a Jira issue can be auto-tested, needs more information, or should be prepared for manual QA.

CAPABILITIES:
- Platform (UI) tests: Lite (exploratory AI) or Pro (intelligent multi-agent). Requires a start URL.
- API tests: Light / Medium / Hard. Requires API URL and optional method/body.
- Manual test case generation (no URL required).

OUTPUT FORMAT:
Respond with JSON only. Schema:
{
  "outcome": "CAN_RUN_AUTO" | "NEEDS_REWORK" | "PREPARE_MANUAL",
  "reason": "1-2 sentence explanation",
  "missingData": ["item1", "item2"],
  "suggestedAction": { "type": "platform_test"|"api_test", "mode"?: "lite"|"pro", "level"?: "light"|"medium"|"hard" } | null,
  "extractedUrl": "URL to test or null",
  "testCaseSummary": "step-by-step if PREPARE_MANUAL",
  "existingTestCaseId": "ID or null",
  "reworkQuestions": ["question1"]
}

DECISION RULES:
1. CAN_RUN_AUTO — we have a URL (from description, KB, or existing test case) AND clear test scope.
   - If EXACT MATCH test case exists → always CAN_RUN_AUTO with existingTestCaseId.
   - If related test cases have URLs → use as extractedUrl.
   - Default to "lite" mode unless task explicitly needs deep validation.
2. NEEDS_REWORK — missing critical data. MUST include specific reworkQuestions.
   - BAD question: "What is the URL?"
   - GOOD question: "The checkout flow needs a URL — is it /checkout or /cart/checkout based on your routing?"
   - Use HISTORICAL BUGS to ask targeted questions (e.g. "Similar bug X was found last time — does this affect the same component?").
   - Maximum 3 questions, each must be answerable in one sentence.
3. PREPARE_MANUAL — task is testable but not suitable for automation (visual review, one-off, complex multi-system flow).
   - testCaseSummary must be step-by-step (numbered), not a paragraph.
   - Reference related test cases when building steps.

EDGE CASES:
- If description says "test this page" with a URL → CAN_RUN_AUTO platform_test lite.
- If description is vague ("fix the bug") with no URL, no KB match, no test case → NEEDS_REWORK.
- If issue is about API/backend with endpoint mentioned → CAN_RUN_AUTO api_test.
- If issue is a design review or "check if it looks right" → PREPARE_MANUAL.
- Never guess URLs — only use URLs found in the task description, KB, or existing test cases.
- CONNECTED INTEGRATIONS tells you what notification channels are available. When suggesting outcomes, consider whether the user can receive notifications via Slack, Telegram, etc.

FEW-SHOT EXAMPLES:

Example 1 — CAN_RUN_AUTO with existing test case:
Input: Summary="Login page returns 500 after deploy", TestCase="Login Flow (exact match, ID=tc-123, URL=/login)"
Output: {"outcome":"CAN_RUN_AUTO","reason":"Exact match test case exists for login flow with URL","suggestedAction":{"type":"platform_test","mode":"lite"},"extractedUrl":"/login","existingTestCaseId":"tc-123","reworkQuestions":[]}

Example 2 — NEEDS_REWORK with historical context:
Input: Summary="Payment form validation broken", Description="users complain about checkout", HistoricalBug="[HIGH] Stripe iframe not loading on /checkout (similarity: 0.82)"
Output: {"outcome":"NEEDS_REWORK","reason":"No specific URL and unclear which validation — similar Stripe issue found before","missingData":["exact page URL","which validation rule is broken"],"suggestedAction":null,"extractedUrl":null,"reworkQuestions":["Is this the same Stripe iframe issue we found before on /checkout, or a different validation problem?","Which form field is affected — email, card number, or expiry?","Can you provide the exact URL where the form is broken?"]}

Example 3 — PREPARE_MANUAL:
Input: Summary="Verify new brand colors across all pages", Description="Design team updated the color palette, need visual review"
Output: {"outcome":"PREPARE_MANUAL","reason":"Visual design review requires human judgment across multiple pages","suggestedAction":null,"extractedUrl":null,"testCaseSummary":"1. Open homepage and verify header uses new brand blue (#1A73E8)\\n2. Navigate to /about and check section backgrounds\\n3. Open /pricing and verify CTA button colors\\n4. Check mobile responsive view for color consistency\\n5. Compare against Figma design spec"}`;

function buildAnalysisMessages(
  issueSummary: string,
  issueDescription: string | null,
  kbContext: string,
  testCaseContext: string,
  pastBugsContext: string,
  memoryContext: string,
  integrationContext: string,
): { system: string; user: string } {
  const userSections: string[] = [];

  userSections.push(`JIRA ISSUE:
Summary: ${issueSummary}
Description: ${issueDescription || '(none provided)'}`);

  userSections.push(`KNOWLEDGE BASE:
${kbContext || '(no relevant documentation found)'}`);

  if (testCaseContext) {
    userSections.push(`EXISTING TEST CASES:\n${testCaseContext}`);
  }

  if (pastBugsContext) {
    userSections.push(`HISTORICAL BUGS:\n${pastBugsContext}`);
  }

  if (memoryContext) {
    userSections.push(`WORKSPACE CONTEXT:\n${memoryContext}`);
  }

  if (integrationContext) {
    userSections.push(`CONNECTED INTEGRATIONS:\n${integrationContext}`);
  }

  userSections.push('Analyze and respond with JSON.');

  return { system: ANALYSIS_SYSTEM_PROMPT, user: userSections.join('\n\n') };
}

export class JiraQaOrchestratorService {
  /**
   * Analyze Jira task and execute the chosen outcome (run test, rework, or prepare manual).
   * Enriches AI decision with 4 parallel data sources: KB, test cases, past bugs, workspace memory.
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

      const issue = await getJiraIssue(accessToken, cloudIdToUse, issueKey);

      // Resolve workspaceId (from params or from project)
      const workspaceId = params.workspaceId || await this.resolveWorkspaceId(projectId);

      const query = [issue.summary, issue.description].filter(Boolean).join(' ');

      // Fetch all 4 data sources in parallel (each is non-fatal)
      const [kbResult, resolverResult, findingsResult, memoryContext, integrationContext] = await Promise.all([
        // 1. Knowledge Base (existing)
        searchKB(query, projectId, { matchCount: 5, matchThreshold: 0.5 })
          .catch((err) => {
            logger.warn('[JIRA_QA] KB search failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
            return { chunks: [] } as { chunks: Array<{ content?: string }> };
          }),

        // 2. Test Case Resolver (NEW) — find similar existing test cases
        workspaceId
          ? TestCaseResolverService.resolve({ message: query, userId, workspaceId })
              .catch((err) => {
                logger.warn('[JIRA_QA] Resolver failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
                return null as ResolverResult | null;
              })
          : Promise.resolve(null as ResolverResult | null),

        // 3. Past Bug Findings vector search (NEW) — similar bugs in this project
        this.searchProjectFindings(query, projectId)
          .catch((err) => {
            logger.warn('[JIRA_QA] Findings search failed (non-fatal)', { issueKey, error: err instanceof Error ? err.message : String(err) });
            return [] as FindingSearchResult[];
          }),

        // 4. Workspace Memory (NEW) — user-saved patterns and facts
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
      ]);

      // Build context strings
      const kbContext = ((kbResult as { chunks: Array<{ content?: string }> }).chunks || [])
        .map((c) => c.content)
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 3000);

      const testCaseContext = this.buildTestCaseContext(resolverResult);
      const pastBugsContext = this.buildPastBugsContext(findingsResult);

      logger.info('[JIRA_QA] Context enrichment complete', {
        issueKey,
        kbChunks: ((kbResult as { chunks: any[] }).chunks || []).length,
        resolverMatch: resolverResult?.matchType || 'none',
        findingsCount: findingsResult.length,
        hasMemory: !!memoryContext,
      });

      const { system, user } = buildAnalysisMessages(
        issue.summary,
        issue.description,
        kbContext,
        testCaseContext,
        pastBugsContext,
        memoryContext,
        integrationContext,
      );

      const completion = await getChatCompletionWithMessages(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { temperature: 0.2, max_tokens: 1000, response_format: { type: 'json_object' } }
      );
      let analysis: JiraQaAnalysisResult;
      try {
        const raw = JSON.parse(completion.content) as Record<string, unknown>;
        analysis = {
          outcome: (raw.outcome as JiraQaOutcome) || 'PREPARE_MANUAL',
          reason: raw.reason as string | undefined,
          missingData: Array.isArray(raw.missingData) ? (raw.missingData as string[]) : undefined,
          suggestedAction: raw.suggestedAction as JiraQaAnalysisResult['suggestedAction'],
          extractedUrl: raw.extractedUrl as string | undefined,
          testCaseSummary: raw.testCaseSummary as string | undefined,
          existingTestCaseId: (raw.existingTestCaseId as string | null) || null,
          reworkQuestions: Array.isArray(raw.reworkQuestions) ? (raw.reworkQuestions as string[]) : undefined,
        };
      } catch {
        analysis = { outcome: 'PREPARE_MANUAL', reason: 'Could not parse AI response' };
      }

      logger.info('[JIRA_QA] Analysis result', { issueKey, outcome: analysis.outcome, reason: analysis.reason });

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
        let testGoal = issue.summary + (issue.description ? '\n' + issue.description.slice(0, 500) : '');
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
   * Get project Jira QA settings (qaColumn, reworkStatus from project.settings.integrations.jira).
   */
  static async getProjectJiraQaSettings(projectId: string, userId: string): Promise<{ reworkStatusName?: string }> {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle();
    const jira = (project?.settings as any)?.integrations?.jira || {};
    return { reworkStatusName: jira.reworkStatusName || undefined };
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
