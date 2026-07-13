/**
 * Unit tests for mobile-project-context.service — the eager project /
 * app / open-test-case resolution the mobile-agent handler runs before
 * the first LLM call.
 *
 * The db/ sublayer is stubbed (unit-test mock boundary per testing.md);
 * WorkspaceAccessService is stubbed for the membership checks.
 */

jest.mock('../db/mobile-project-context.db', () => ({
  getChatSessionProjectId: jest.fn(),
  getProjectRow: jest.fn(),
  getTestCaseAuthoringRow: jest.fn(),
  listWorkspaceProjects: jest.fn(),
}));

jest.mock('@/services/core/workspace-access.service', () => ({
  WorkspaceAccessService: { isMember: jest.fn() },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  resolveMobileProjectContext,
  listMobileProjectOptions,
  getAccessibleProject,
  formatMobileProjectContextForChat,
  summariseSteps,
} from '../mobile-project-context.service';
import {
  getChatSessionProjectId,
  getProjectRow,
  getTestCaseAuthoringRow,
  listWorkspaceProjects,
} from '../db/mobile-project-context.db';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';

const mockedSessionProject = getChatSessionProjectId as jest.Mock;
const mockedProjectRow = getProjectRow as jest.Mock;
const mockedTestCaseRow = getTestCaseAuthoringRow as jest.Mock;
const mockedListProjects = listWorkspaceProjects as jest.Mock;
const mockedIsMember = WorkspaceAccessService.isMember as jest.Mock;

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 'proj-1',
  name: 'Kolesa App',
  workspaceId: 'ws-1',
  userId: 'owner-1',
  settings: {
    mobileApp: { packageName: 'kz.kolesa', detectedFramework: 'flutter' },
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveMobileProjectContext — priority order', () => {
  it('uses the open test case project first and builds a steps summary', async () => {
    mockedTestCaseRow.mockResolvedValue({
      id: 'tc-1',
      name: 'Login flow',
      projectId: 'proj-1',
      platform: 'mobile_android',
      goal: JSON.stringify({ appPackage: 'kz.kolesa.tc', startActivity: null }),
      stepsJson: [
        { type: 'open_app', description: 'Open the app' },
        { type: 'type', description: 'Type email' },
      ],
    });
    mockedProjectRow.mockResolvedValue(project());

    const ctx = await resolveMobileProjectContext({
      userId: 'u1',
      chatSessionId: 'chat-1',
      testCaseId: 'tc-1',
      contextProjectId: 'proj-other',
    });

    expect(ctx).not.toBeNull();
    expect(ctx!.projectId).toBe('proj-1');
    expect(ctx!.source).toBe('test_case');
    // Test-case-level appPackage (from goal JSON) beats project settings.
    expect(ctx!.appPackage).toBe('kz.kolesa.tc');
    expect(ctx!.testCase).toEqual(
      expect.objectContaining({
        id: 'tc-1',
        name: 'Login flow',
        platform: 'mobile_android',
        stepCount: 2,
      }),
    );
    expect(ctx!.testCase!.stepsSummary).toContain('1. [open_app] Open the app');
    expect(ctx!.testCase!.stepsSummary).toContain('2. [type] Type email');
    // Test-case project is authoritative — the (untrusted) context
    // projectId and the chat-session lookup must not be consulted.
    expect(mockedSessionProject).not.toHaveBeenCalled();
  });

  it('uses a validated context projectId when no test case is open', async () => {
    mockedProjectRow.mockResolvedValue(project({ userId: 'someone-else' }));
    mockedIsMember.mockResolvedValue(true);

    const ctx = await resolveMobileProjectContext({
      userId: 'u1',
      chatSessionId: 'chat-1',
      contextProjectId: 'proj-1',
    });

    expect(ctx!.projectId).toBe('proj-1');
    expect(ctx!.source).toBe('context');
    expect(ctx!.detectedFramework).toBe('flutter');
    expect(mockedIsMember).toHaveBeenCalledWith('u1', 'ws-1');
    expect(mockedSessionProject).not.toHaveBeenCalled();
  });

  it('REJECTS a context projectId the user has no access to and falls back to the chat session', async () => {
    // First getProjectRow call = context-projectId validation (foreign
    // project, not a member); second = the chat-session project load.
    mockedProjectRow
      .mockResolvedValueOnce(project({ id: 'proj-foreign', userId: 'someone-else' }))
      .mockResolvedValueOnce(project());
    mockedIsMember.mockResolvedValue(false);
    mockedSessionProject.mockResolvedValue('proj-1');

    const ctx = await resolveMobileProjectContext({
      userId: 'u1',
      chatSessionId: 'chat-1',
      contextProjectId: 'proj-foreign',
    });

    expect(ctx!.projectId).toBe('proj-1');
    expect(ctx!.source).toBe('chat_session');
  });

  it('falls back to the chat session project binding', async () => {
    mockedSessionProject.mockResolvedValue('proj-1');
    mockedProjectRow.mockResolvedValue(project());

    const ctx = await resolveMobileProjectContext({
      userId: 'u1',
      chatSessionId: 'chat-1',
    });

    expect(ctx!.projectId).toBe('proj-1');
    expect(ctx!.source).toBe('chat_session');
    expect(ctx!.appPackage).toBe('kz.kolesa');
  });

  it('returns null when nothing resolves', async () => {
    mockedSessionProject.mockResolvedValue(null);
    const ctx = await resolveMobileProjectContext({
      userId: 'u1',
      chatSessionId: 'chat-1',
    });
    expect(ctx).toBeNull();
  });

  it('never throws — a DB error resolves to null (fallback to lazy lookup)', async () => {
    mockedTestCaseRow.mockRejectedValue(new Error('db down'));
    const ctx = await resolveMobileProjectContext({
      userId: 'u1',
      chatSessionId: 'chat-1',
      testCaseId: 'tc-1',
    });
    expect(ctx).toBeNull();
  });
});

describe('getAccessibleProject', () => {
  it('allows the project owner without a workspace lookup', async () => {
    mockedProjectRow.mockResolvedValue(project({ userId: 'u1' }));
    const p = await getAccessibleProject('u1', 'proj-1');
    expect(p!.id).toBe('proj-1');
    expect(mockedIsMember).not.toHaveBeenCalled();
  });

  it('returns null for a non-owner non-member', async () => {
    mockedProjectRow.mockResolvedValue(project({ userId: 'someone-else' }));
    mockedIsMember.mockResolvedValue(false);
    expect(await getAccessibleProject('u1', 'proj-1')).toBeNull();
  });

  it('returns null when the project does not exist', async () => {
    mockedProjectRow.mockResolvedValue(null);
    expect(await getAccessibleProject('u1', 'nope')).toBeNull();
  });
});

describe('listMobileProjectOptions', () => {
  it('returns [] without a workspaceId', async () => {
    expect(await listMobileProjectOptions(undefined)).toEqual([]);
    expect(mockedListProjects).not.toHaveBeenCalled();
  });

  it('sorts projects with an uploaded mobile app first', async () => {
    mockedListProjects.mockResolvedValue([
      project({ id: 'p-web', name: 'Web only', settings: {} }),
      project({ id: 'p-mob', name: 'Mobile' }),
    ]);
    const options = await listMobileProjectOptions('ws-1');
    expect(options.map((o) => o.id)).toEqual(['p-mob', 'p-web']);
    expect(options[0]).toEqual(
      expect.objectContaining({ hasMobileApp: true, appPackage: 'kz.kolesa' }),
    );
    expect(options[1].hasMobileApp).toBe(false);
  });

  it('never throws — a DB error resolves to []', async () => {
    mockedListProjects.mockRejectedValue(new Error('db down'));
    expect(await listMobileProjectOptions('ws-1')).toEqual([]);
  });
});

describe('summariseSteps', () => {
  it('caps long flows with an ellipsis line', () => {
    const steps = Array.from({ length: 35 }, (_, i) => ({
      type: 'tap',
      description: `Step ${i + 1}`,
    }));
    const summary = summariseSteps(steps);
    expect(summary).toContain('30. [tap] Step 30');
    expect(summary).not.toContain('31. [tap]');
    expect(summary).toContain('… and 5 more step(s)');
  });

  it('truncates overly long step descriptions', () => {
    const summary = summariseSteps([
      { type: 'tap', description: 'x'.repeat(500) },
    ]);
    const [line] = summary.split('\n');
    expect(line.length).toBeLessThanOrEqual(141); // cap + ellipsis char
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('formatMobileProjectContextForChat', () => {
  it('renders project + app + open test case blocks', () => {
    const block = formatMobileProjectContextForChat({
      projectId: 'proj-1',
      projectName: 'Kolesa App',
      workspaceId: 'ws-1',
      appPackage: 'kz.kolesa',
      detectedFramework: 'flutter',
      source: 'test_case',
      testCase: {
        id: 'tc-1',
        name: 'Login flow',
        platform: 'mobile_android',
        stepCount: 2,
        stepsSummary: '1. [open_app] Open the app\n2. [type] Type email',
      },
    });

    expect(block).toContain('--- PROJECT CONTEXT ---');
    expect(block).toContain('Kolesa App');
    expect(block).toContain('kz.kolesa');
    expect(block).toContain('framework: flutter');
    expect(block).toContain('--- OPEN TEST CASE ---');
    expect(block).toContain('"Login flow"');
    expect(block).toContain('1. [open_app] Open the app');
    expect(block).toContain('CONTINUE the flow');
  });

  it('omits the test-case block when no test case is open', () => {
    const block = formatMobileProjectContextForChat({
      projectId: 'proj-1',
      projectName: 'Kolesa App',
      source: 'chat_session',
    });
    expect(block).toContain('--- PROJECT CONTEXT ---');
    expect(block).not.toContain('OPEN TEST CASE');
  });
});
