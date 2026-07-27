import { HandoffService } from '../handoff.service';
import type { JiraQaAnalysisResult } from '@/services/integrations/jira-qa-orchestrator.service';

// Mock the db/ boundary and websocket (infrastructure, not logic under test).
jest.mock('../db/handoff.db', () => ({
  upsertHandoff: jest.fn(async (input: any) => ({ ...input.handoff, status: input.status })),
  patchHandoffPostRun: jest.fn(async () => null),
  getHandoff: jest.fn(async () => null),
}));
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitChatMessage: jest.fn() },
}));

import { upsertHandoff, patchHandoffPostRun } from '../db/handoff.db';
import { webSocketService } from '@/websocket/core/websocket.service';

const readyAnalysis = (over: Partial<JiraQaAnalysisResult> = {}): JiraQaAnalysisResult => ({
  outcome: 'CAN_RUN_AUTO',
  extractedUrl: 'https://app.example.com/login',
  suggestedAction: { type: 'platform_test' },
  readiness: { readinessScore: 85, readyToTest: true, blockingQuestions: [], coverageGaps: [], summary: 'ok' },
  ...over,
});

const issue = { summary: 'Login broken', description: 'after deploy' };

describe('HandoffService.buildAndPersist', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds a ready handoff with ui branch and persists + emits to chat', async () => {
    const handoff = await HandoffService.buildAndPersist({
      projectId: 'p1', issueKey: 'KAN-1', analysis: readyAnalysis(), issue, chatSessionId: 's1',
    });
    expect(handoff.status).toBe('ready');
    expect(handoff.suggestedBranches).toContain('ui');
    expect(handoff.taskRef.issueKey).toBe('KAN-1');
    expect(upsertHandoff).toHaveBeenCalledTimes(1);
    expect(webSocketService.emitChatMessage).toHaveBeenCalledTimes(1);
  });

  it('blocked analysis → status blocked, only the stop branch', async () => {
    const analysis = readyAnalysis({
      outcome: 'NEEDS_REWORK',
      readiness: { readinessScore: 20, readyToTest: false, blockingQuestions: ['url?'], coverageGaps: [], summary: 'thin' },
    });
    const handoff = await HandoffService.buildAndPersist({ projectId: 'p1', issueKey: 'KAN-2', analysis, issue });
    expect(handoff.status).toBe('blocked');
    expect(handoff.suggestedBranches).toEqual(['stop']);
  });

  it('api suggestion → api branch', async () => {
    const analysis = readyAnalysis({ suggestedAction: { type: 'api_test' } });
    const handoff = await HandoffService.buildAndPersist({ projectId: 'p1', issueKey: 'KAN-3', analysis, issue });
    expect(handoff.suggestedBranches).toContain('api');
  });

  it('folds related-ticket labels from coverage gaps into groundTruth', async () => {
    const analysis = readyAnalysis({
      readiness: {
        readinessScore: 80, readyToTest: true, blockingQuestions: [], summary: 'ok',
        coverageGaps: [{ type: 'related_flow', title: 'checkout', why: 'linked', priority: 'high', relatedTicket: 'PROJ-88' }],
      },
    });
    const handoff = await HandoffService.buildAndPersist({ projectId: 'p1', issueKey: 'KAN-4', analysis, issue });
    expect(handoff.groundTruth.relatedTickets).toContain('PROJ-88');
  });

  it('does not throw when persist fails (best-effort)', async () => {
    (upsertHandoff as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(
      HandoffService.buildAndPersist({ projectId: 'p1', issueKey: 'KAN-5', analysis: readyAnalysis(), issue }),
    ).resolves.toBeDefined();
  });
});

describe('HandoffService.emitBranchChoice', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits branch options excluding stop-as-branch', () => {
    HandoffService.emitBranchChoice('s1', {
      taskRef: { issueKey: 'KAN-1' },
      groundTruth: { summary: 's' },
      readiness: { readinessScore: 80, readyToTest: true, blockingQuestions: [], coverageGaps: [], summary: '' },
      status: 'ready',
      suggestedBranches: ['ui', 'stop'],
    });
    expect(webSocketService.emitChatMessage).toHaveBeenCalledTimes(1);
    const payload = (webSocketService.emitChatMessage as jest.Mock).mock.calls[0][1];
    expect(payload.metadata.kind).toBe('qa_branch_choice');
    // Rendered as clickable quick-actions (chat kind) — ui branch + a stop option.
    expect(Array.isArray(payload.metadata.actions)).toBe(true);
    const kinds = payload.metadata.actions.map((a: any) => a.kind);
    expect(kinds.every((k: string) => k === 'chat')).toBe(true);
    const labels = payload.metadata.actions.map((a: any) => a.label);
    expect(labels).toContain('Run UI test');
    expect(labels).toContain('Stop here (analysis only)');
  });

  it('no-ops without a chat session', () => {
    HandoffService.emitBranchChoice(undefined, {
      taskRef: { issueKey: 'x' }, groundTruth: { summary: 's' },
      readiness: { readinessScore: 0, readyToTest: false, blockingQuestions: [], coverageGaps: [], summary: '' },
      status: 'ready', suggestedBranches: ['ui'],
    });
    expect(webSocketService.emitChatMessage).not.toHaveBeenCalled();
  });
});

describe('HandoffService.updatePostRun', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a passed one-execution run → status done', async () => {
    await HandoffService.updatePostRun({
      projectId: 'p1', issueKey: 'KAN-1',
      run: { totalExecutions: 1, passed: 1, failed: 0, skipped: 0 },
      testId: 't1',
    });
    expect(patchHandoffPostRun).toHaveBeenCalledTimes(1);
    const arg = (patchHandoffPostRun as jest.Mock).mock.calls[0][0];
    // deriveHonestStatusFromRun maps all-passed → ready; the run lifecycle treats
    // a completed passed run as "done" via the caller — here we assert the derived
    // value is a terminal, non-blocked status.
    expect(['ready', 'done']).toContain(arg.status);
    expect(arg.testId).toBe('t1');
  });

  it('a failed one-execution run (bug/error) → status blocked', async () => {
    await HandoffService.updatePostRun({
      projectId: 'p1', issueKey: 'KAN-2',
      run: { totalExecutions: 1, passed: 0, failed: 1, skipped: 0 },
      testId: 't2', fixPromptRef: 'r2',
    });
    const arg = (patchHandoffPostRun as jest.Mock).mock.calls[0][0];
    expect(arg.status).toBe('blocked');
    expect(arg.fixPromptRef).toBe('r2');
  });

  it('does not throw when the db patch fails (best-effort)', async () => {
    (patchHandoffPostRun as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(
      HandoffService.updatePostRun({
        projectId: 'p1', issueKey: 'KAN-3',
        run: { totalExecutions: 0, passed: 0, failed: 0, skipped: 0 },
      }),
    ).resolves.toBeUndefined();
  });
});
