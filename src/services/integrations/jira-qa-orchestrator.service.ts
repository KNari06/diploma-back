/**
 * Jira QA Orchestrator
 * When a task lands in the QA column: analyze (KB + context + capabilities), then either
 * run tests, send back to rework, or prepare test cases for manual QA.
 */

import { randomUUID } from 'crypto';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { getJiraToken, ensureValidToken, getJiraIssue, addJiraComment, transitionJiraIssue } from '@/services/api/jira.service';
import { searchKB } from '@/services/kb/kb.service';
import { createTest } from '@/services/testing/ui/manual/test-creator';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { QueueManager } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

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
}

export interface JiraQaOrchestratorParams {
  issueKey: string;
  projectId: string;
  userId: string;
  cloudId?: string;
  reworkStatusName?: string; // e.g. "To Do" or "Rework"
}

export interface JiraQaOrchestratorResult {
  success: boolean;
  outcome: JiraQaOutcome;
  message: string;
  testId?: string;
  testCaseId?: string;
  error?: string;
}

const CAPABILITIES_TEXT = `We can:
- Run platform (UI) tests: Lite (exploratory) or Pro (intelligent) mode. Requires a start URL.
- Run API tests: Light / Medium / Hard level. Requires API URL and optional method/body.
- Generate test cases and steps for manual QA (no URL required).`;

function buildAnalysisPrompt(issueSummary: string, issueDescription: string | null, kbContext: string): string {
  return `You are a QA analyst. Given a Jira task and our capabilities, decide what we can do.

TASK:
Summary: ${issueSummary}
Description: ${issueDescription || '(none)'}

KNOWLEDGE BASE (project context):
${kbContext || '(no relevant docs)'}

${CAPABILITIES_TEXT}

Respond with JSON only, no markdown:
{
  "outcome": "CAN_RUN_AUTO" | "NEEDS_REWORK" | "PREPARE_MANUAL",
  "reason": "short explanation",
  "missingData": ["list of missing items if NEEDS_REWORK"],
  "suggestedAction": { "type": "api_test"|"platform_test", "level"?: "light"|"medium"|"hard", "mode"?: "lite"|"pro" } | null,
  "extractedUrl": "url from description or KB if we can run a test",
  "testCaseSummary": "brief test case summary if PREPARE_MANUAL"
}

Rules:
- CAN_RUN_AUTO: we have enough data to run (URL for platform or API; clear scope). Set suggestedAction and extractedUrl if applicable.
- NEEDS_REWORK: missing critical data (e.g. no URL, unclear scope). Set missingData.
- PREPARE_MANUAL: task is testable but better as manual (e.g. one-off, no env). Set testCaseSummary.`;
}

export class JiraQaOrchestratorService {
  /**
   * Analyze Jira task and execute the chosen outcome (run test, rework, or prepare manual).
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
      const query = [issue.summary, issue.description].filter(Boolean).join(' ');
      const kbResult = await searchKB(query, projectId, { matchCount: 5, matchThreshold: 0.5 });
      const kbContext = (kbResult.chunks || [])
        .map((c) => (c as { content?: string }).content)
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 3000);

      const prompt = buildAnalysisPrompt(issue.summary, issue.description, kbContext);
      const completion = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        { temperature: 0.2, max_tokens: 600, response_format: { type: 'json_object' } }
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
        };
      } catch {
        analysis = { outcome: 'PREPARE_MANUAL', reason: 'Could not parse AI response' };
      }

      logger.info('[JIRA_QA] Analysis result', { issueKey, outcome: analysis.outcome, reason: analysis.reason });

      if (analysis.outcome === 'NEEDS_REWORK') {
        const comment = `[QAI] Cannot run automated test yet.\nReason: ${analysis.reason || 'Insufficient data'}\n${(analysis.missingData?.length ? `Missing: ${analysis.missingData.join(', ')}` : '')}`;
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

      if (analysis.outcome === 'CAN_RUN_AUTO' && analysis.suggestedAction?.type === 'platform_test' && analysis.extractedUrl) {
        const mode = (analysis.suggestedAction.mode === 'pro' ? 'pro' : 'lite') as 'lite' | 'pro';
        const creditsRequired = mode === 'pro' ? TokenCalculatorService.getTestCreditCost('intelligent') : 15; // lite=15, pro=20
        const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
        if (!creditCheck.hasEnough || (creditCheck.available ?? 0) < creditsRequired) {
          await addJiraComment(accessToken, cloudIdToUse, issueKey, `[QAI] Cannot run test: insufficient credits. Required: ${creditsRequired}, available: ${creditCheck.available ?? 0}.`);
          return {
            success: true,
            outcome: 'PREPARE_MANUAL',
            message: 'Insufficient credits; test case prepared for manual QA instead',
          };
        }
        const test = await createTest({
          url: analysis.extractedUrl,
          projectId,
          userId,
          browsers: ['chrome'],
          intelligentMode: true,
          testGoal: issue.summary + (issue.description ? '\n' + issue.description.slice(0, 500) : ''),
          mode,
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
        });
        await CreditCostTrackerService.deductCreditsForTest({
          userId,
          testType: 'intelligent',
          credits: creditsRequired,
          costUSD: mode === 'pro' ? 0.08 : 0.06,
          testId: test.id,
          description: `Jira QA auto-test: ${issue.key} (${mode})`,
        });
        await addJiraComment(accessToken, cloudIdToUse, issueKey, `[QAI] Automated platform test started (${mode}). Test ID: ${test.id}`);
        return {
          success: true,
          outcome: 'CAN_RUN_AUTO',
          message: 'Platform test started',
          testId: test.id,
        };
      }

      if (analysis.outcome === 'CAN_RUN_AUTO' && analysis.suggestedAction?.type === 'api_test' && analysis.extractedUrl) {
        // API test: could enqueue or call ApiAgentOrchestratorService.run. For now we only support platform run; API can be added similarly.
        await addJiraComment(accessToken, cloudIdToUse, issueKey, `[QAI] API test not yet automated from board. Please run from chat. URL: ${analysis.extractedUrl}`);
        return {
          success: true,
          outcome: 'PREPARE_MANUAL',
          message: 'API test suggested; run from chat with URL',
        };
      }

      // PREPARE_MANUAL or CAN_RUN_AUTO without URL: create a draft test case and comment
      const name = `Jira: ${issue.key} - ${issue.summary.slice(0, 80)}`;
      const steps = [
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
      const comment = `[QAI] Test case prepared for manual QA.\n${analysis.testCaseSummary || issue.summary}\nTest case ID: ${testCase.id}`;
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
}
