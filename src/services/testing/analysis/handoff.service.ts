/**
 * HandoffService — builds, persists, and surfaces the QA hand-off artifact.
 *
 * The hand-off is the structured object the next pipeline stage reads instead of
 * parsing chat. Produced at assess-time (before any run) and patched post-run.
 * Business logic only — all `qa_handoffs` queries go through ./db/handoff.db.
 * Every write is best-effort (log + swallow) so it NEVER blocks the run path.
 */

import { randomUUID } from 'crypto';
import { webSocketService } from '@/websocket/core/websocket.service';
import { logger } from '@/utils/core/logger';
import {
  deriveHonestStatusFromReadiness,
  deriveHonestStatusFromRun,
  type HonestStatusResult,
} from './honest-status.util';
import { getHandoff, patchHandoffPostRun, upsertHandoff } from './db/handoff.db';
import type { JiraRelatedContext } from '@/services/api/jira.service';
import type { JiraIssueListItem } from '@/types';
import type { JiraQaAnalysisResult } from '@/services/integrations/jira-qa-orchestrator.service';
import type { QaHandoff, QaHandoffBranch, QaHandoffStatus } from '@/types/testing.types';

export class HandoffService {
  /**
   * Build a QaHandoff from an assessment + issue context, persist it, and emit
   * it to chat as a structured message. Returns the persisted handoff (or a
   * built-but-unpersisted one if the DB write failed — never throws).
   */
  static async buildAndPersist(params: {
    projectId: string;
    issueKey: string;
    cloudId?: string;
    url?: string;
    analysis: JiraQaAnalysisResult;
    issue: Pick<JiraIssueListItem, 'summary' | 'description'>;
    related?: JiraRelatedContext | null;
    chatSessionId?: string;
  }): Promise<QaHandoff> {
    const { projectId, issueKey, cloudId, url, analysis, issue, related, chatSessionId } = params;

    const statusResult = deriveHonestStatusFromReadiness(analysis.readiness, analysis.outcome);
    const handoff: QaHandoff = {
      taskRef: { issueKey, cloudId, url: url || analysis.extractedUrl },
      groundTruth: {
        summary: issue.summary,
        description: issue.description,
        relatedTickets: this.relatedTicketLabels(related, analysis),
      },
      readiness: analysis.readiness ?? this.emptyReadiness(),
      status: statusResult.status,
      suggestedBranches: this.inferBranches(analysis, statusResult.status),
    };

    let persisted = handoff;
    try {
      const row = await upsertHandoff({ projectId, issueKey, cloudId, status: handoff.status, handoff });
      if (row) persisted = row;
    } catch (err) {
      logger.warn('[HANDOFF] Persist failed (non-fatal)', {
        issueKey, error: err instanceof Error ? err.message : String(err),
      });
    }

    this.emitToChat(chatSessionId, persisted, statusResult);
    return persisted;
  }

  /** Patch the handoff after a run completes with the real outcome + fix-prompt ref. */
  static async updatePostRun(params: {
    projectId: string;
    issueKey: string;
    run: { totalExecutions: number; passed: number; failed: number; skipped: number; setupFailure?: boolean; emptyTestSet?: boolean };
    testId?: string;
    fixPromptRef?: string;
  }): Promise<void> {
    const { projectId, issueKey, run, testId, fixPromptRef } = params;
    const status = deriveHonestStatusFromRun(run).status;
    try {
      await patchHandoffPostRun({ projectId, issueKey, status, testId, fixPromptRef });
    } catch (err) {
      logger.warn('[HANDOFF] Post-run patch failed (non-fatal)', {
        issueKey, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Read the handoff for a (project, issue). Never throws — returns null on error. */
  static async read(projectId: string, issueKey: string): Promise<QaHandoff | null> {
    try {
      return await getHandoff(projectId, issueKey);
    } catch (err) {
      logger.warn('[HANDOFF] Read failed (non-fatal)', {
        issueKey, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Emit branch-choice options to chat (hybrid autonomy: a ready ticket that
   * requires human approval before running). Renders as clickable buttons via
   * the existing quick-action framework (`metadata.actions`, `chat` kind) — a
   * click sends the branch prompt back through the normal chat flow. Also
   * carries the raw handoff under `metadata.qaBranchChoice` for any richer UI.
   */
  static emitBranchChoice(chatSessionId: string | undefined, handoff: QaHandoff): void {
    if (!chatSessionId) return;
    const branches = handoff.suggestedBranches.filter((b) => b !== 'stop');
    const key = handoff.taskRef.issueKey;
    const content = `This task is ready to test (${handoff.readiness.readinessScore}/100). How should I proceed?`;

    // Quick-action descriptors the frontend already knows how to render (chat kind).
    const actions = [
      ...branches.map((b) => ({
        id: `qa-branch-${b}-${key}`,
        kind: 'chat' as const,
        label: this.branchLabel(b),
        prompt: this.branchPrompt(b, handoff),
      })),
      {
        id: `qa-branch-stop-${key}`,
        kind: 'chat' as const,
        label: 'Stop here (analysis only)',
        prompt: `Stop — just keep the analysis for ${key}, don't run any test.`,
      },
    ];

    this.safeEmit(chatSessionId, content, { kind: 'qa_branch_choice', actions, qaBranchChoice: handoff });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private static emitToChat(
    chatSessionId: string | undefined,
    handoff: QaHandoff,
    statusResult: HonestStatusResult,
  ): void {
    if (!chatSessionId) return;
    const content = `Task readiness: ${handoff.status.toUpperCase()} (${handoff.readiness.readinessScore}/100). ${statusResult.reason}`;
    this.safeEmit(chatSessionId, content, { kind: 'qa_handoff', handoff });
  }

  private static safeEmit(chatSessionId: string, content: string, metadata: Record<string, unknown>): void {
    try {
      webSocketService.emitChatMessage(chatSessionId, {
        sessionId: chatSessionId,
        messageId: randomUUID(),
        role: 'assistant',
        content,
        metadata,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('[HANDOFF] Chat emit failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Infer execution branches from the triage suggestion + status. */
  private static inferBranches(analysis: JiraQaAnalysisResult, status: QaHandoffStatus): QaHandoffBranch[] {
    if (status === 'blocked' || status === 'empty') return ['stop'];
    const t = analysis.suggestedAction?.type;
    if (t === 'api_test') return ['api', 'stop'];
    if (t === 'platform_test') return ['ui', 'stop'];
    // Ready but no concrete action → offer manual + stop.
    return ['manual', 'stop'];
  }

  private static relatedTicketLabels(
    related: JiraRelatedContext | null | undefined,
    analysis: JiraQaAnalysisResult,
  ): string[] {
    const labels = new Set<string>();
    for (const l of related?.links || []) labels.add(`${l.key}: ${l.summary}`.trim());
    for (const s of related?.subtasks || []) labels.add(`${s.key}: ${s.summary}`.trim());
    if (related?.parent?.key) labels.add(`${related.parent.key}: ${related.parent.summary}`.trim());
    // Also fold in gap-referenced tickets (may not be in `related` if inferred).
    for (const g of analysis.readiness?.coverageGaps || []) {
      if (g.relatedTicket) labels.add(g.relatedTicket);
    }
    return Array.from(labels).slice(0, 12);
  }

  private static branchLabel(b: QaHandoffBranch): string {
    switch (b) {
      case 'ui': return 'Run UI test';
      case 'api': return 'Run API test';
      case 'manual': return 'Prepare a manual test case';
      case 'stop': return 'Stop here (analysis only)';
    }
  }

  /** The chat prompt a branch button sends when clicked (re-enters the normal flow). */
  private static branchPrompt(b: QaHandoffBranch, handoff: QaHandoff): string {
    const ref = handoff.taskRef.url || handoff.taskRef.issueKey;
    switch (b) {
      case 'ui': return `Run a UI test for ${ref}`;
      case 'api': return `Run an API test for ${ref}`;
      case 'manual': return `Prepare a manual test case for ${ref}`;
      case 'stop': return `Stop — analysis only for ${handoff.taskRef.issueKey}.`;
    }
  }

  private static emptyReadiness() {
    return { readinessScore: 0, readyToTest: false, blockingQuestions: [], coverageGaps: [], summary: '' };
  }
}
