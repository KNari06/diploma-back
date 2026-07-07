/**
 * Eager project-context wiring in the authoring tools:
 *
 *   - mobile_create_test_case resolves the project from (1) a validated
 *     explicit projectId arg, (2) the blackboard's eager project context,
 *     (3) the legacy chat-session lookup — and on a total miss points the
 *     LLM at the list_project_options recovery tool instead of dead-ending.
 *   - list_project_options enumerates workspace projects for the user to
 *     pick from.
 *   - the eager context's detectedFramework short-circuits the save-time
 *     framework fetch.
 *
 * Boundaries mocked: draft cache, save service, app storage, the
 * project-context service, runner client, supabase. Blackboard is real.
 */

jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: jest.fn(),
}));
jest.mock('@/services/mobile/session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_CHAT_PII_REDACTION: true,
    MOBILE_RUNNER_URL: 'http://localhost:4100',
    MOBILE_RUNNER_API_KEY: '',
    RUNNER_USER_TOKEN_SECRET: '',
    MOBILE_RUNNER_ALLOWED_HOSTS: '',
    SUPABASE_URL: 'http://supabase.invalid',
    SUPABASE_ANON_KEY: 'anon-key-test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key-test',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL_FAST: 'gpt-4.1-mini',
  },
}));

// Supabase mocked to a no-op surface. The legacy resolveProjectId fallback
// dynamic-imports this module — `from` is a jest.fn so tests can assert the
// fallback was NOT consulted when the eager context supplies the project.
jest.mock('@/db/supabase', () => ({
  supabase: {},
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/services/testing/mobile/mobile-draft-steps-cache', () => ({
  MobileDraftStepsCache: {
    set: jest.fn(),
    get: jest.fn(),
    consume: jest.fn(),
  },
}));

jest.mock('@/services/testing/regression/regression-save.service', () => ({
  RegressionSaveService: { saveTestCase: jest.fn() },
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: { getDetectedFramework: jest.fn() },
}));

jest.mock('@/services/chat/mobile-project-context.service', () => ({
  getAccessibleProject: jest.fn(),
  listMobileProjectOptions: jest.fn(),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { executeTool, MOBILE_AGENT_TOOLS } from '../tools';
import { MobileBlackboard } from '../blackboard';
import { MobileDraftStepsCache } from '@/services/testing/mobile/mobile-draft-steps-cache';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import {
  getAccessibleProject,
  listMobileProjectOptions,
} from '@/services/chat/mobile-project-context.service';
import { supabaseAdmin } from '@/db/supabase';

const mockedConsume = MobileDraftStepsCache.consume as jest.Mock;
const mockedCacheSet = MobileDraftStepsCache.set as jest.Mock;
const mockedSave = RegressionSaveService.saveTestCase as jest.Mock;
const mockedFramework = MobileAppStorageService.getDetectedFramework as jest.Mock;
const mockedAccessibleProject = getAccessibleProject as jest.Mock;
const mockedListOptions = listMobileProjectOptions as jest.Mock;
const mockedSupabaseFrom = supabaseAdmin.from as jest.Mock;

function makeBlackboard(overrides: Partial<ConstructorParameters<typeof MobileBlackboard>[0]> = {}): MobileBlackboard {
  return new MobileBlackboard({
    goal: 'save the test',
    mobileSessionId: 'sess-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    workspaceId: 'ws-1',
    ...overrides,
  });
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    steps: [{ id: 's1', type: 'tap', description: 'Tap login' }],
    mobileSessionId: 'sess-1',
    platform: 'android',
    appPackage: 'kz.kolesa',
    userId: 'user-1',
    suggestedName: 'Login flow',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSave.mockResolvedValue({ savedTestCaseId: 'tc-new', projectId: 'proj-1' });
  mockedFramework.mockResolvedValue(undefined);
});

describe('mobile_create_test_case — project resolution', () => {
  it('uses the eager blackboard project context without touching the chat-session fallback', async () => {
    mockedConsume.mockReturnValue(draft());
    const bb = makeBlackboard();
    bb.setProjectContext({ projectId: 'proj-eager', source: 'chat_session' });

    const result = await executeTool('mobile_create_test_case', { confirm: true }, bb);

    expect(result.ok).toBe(true);
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-eager', userId: 'user-1' }),
    );
    // Legacy lazy lookup (chat_sessions read) must not have fired.
    expect(mockedSupabaseFrom).not.toHaveBeenCalled();
  });

  it('uses a validated explicit projectId arg over the eager context', async () => {
    mockedConsume.mockReturnValue(draft());
    mockedAccessibleProject.mockResolvedValue({ id: 'proj-picked', name: 'Picked' });
    const bb = makeBlackboard();
    bb.setProjectContext({ projectId: 'proj-eager', source: 'chat_session' });

    const result = await executeTool(
      'mobile_create_test_case',
      { confirm: true, projectId: 'proj-picked' },
      bb,
    );

    expect(result.ok).toBe(true);
    expect(mockedAccessibleProject).toHaveBeenCalledWith('user-1', 'proj-picked');
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-picked' }),
    );
  });

  it('rejects an inaccessible projectId arg, keeps the draft, and points at list_project_options', async () => {
    mockedConsume.mockReturnValue(draft());
    mockedAccessibleProject.mockResolvedValue(null);
    const bb = makeBlackboard();

    const result = await executeTool(
      'mobile_create_test_case',
      { confirm: true, projectId: 'proj-foreign' },
      bb,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('no access');
    expect(result.content).toContain('list_project_options');
    expect(mockedSave).not.toHaveBeenCalled();
    // Draft re-cached so the retry doesn't lose the work.
    expect(mockedCacheSet).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      suggestedName: 'Login flow',
    }));
  });

  it('surfaces the list_project_options recovery path when NO project resolves (no dead-end)', async () => {
    mockedConsume.mockReturnValue(draft());
    // No eager context; legacy fallback also misses (supabase mock throws
    // inside resolveProjectId → caught → null).
    mockedSupabaseFrom.mockImplementation(() => {
      throw new Error('no db in test');
    });
    const bb = makeBlackboard();

    const result = await executeTool('mobile_create_test_case', { confirm: true }, bb);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('list_project_options');
    expect(result.content).toContain('projectId');
    expect(mockedCacheSet).toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('derives the save platform from the eager context framework WITHOUT a DB fetch', async () => {
    mockedConsume.mockReturnValue(draft());
    const bb = makeBlackboard();
    bb.setProjectContext({
      projectId: 'proj-eager',
      detectedFramework: 'flutter',
      source: 'chat_session',
    });

    await executeTool('mobile_create_test_case', { confirm: true }, bb);

    expect(mockedFramework).not.toHaveBeenCalled();
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'mobile_flutter' }),
    );
  });

  it('still fetches the framework when the save targets a DIFFERENT project than the eager context', async () => {
    mockedConsume.mockReturnValue(draft());
    mockedAccessibleProject.mockResolvedValue({ id: 'proj-picked', name: 'Picked' });
    mockedFramework.mockResolvedValue('flutter');
    const bb = makeBlackboard();
    bb.setProjectContext({
      projectId: 'proj-eager',
      detectedFramework: 'android',
      source: 'chat_session',
    });

    await executeTool(
      'mobile_create_test_case',
      { confirm: true, projectId: 'proj-picked' },
      bb,
    );

    expect(mockedFramework).toHaveBeenCalledWith('proj-picked');
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'mobile_flutter' }),
    );
  });
});

describe('list_project_options tool', () => {
  it('is registered in MOBILE_AGENT_TOOLS', () => {
    const names = MOBILE_AGENT_TOOLS.map((t) => t.function.name);
    expect(names).toContain('list_project_options');
  });

  it('lists workspace projects with mobile-app markers', async () => {
    mockedListOptions.mockResolvedValue([
      { id: 'p-mob', name: 'Mobile', hasMobileApp: true, appPackage: 'kz.kolesa' },
      { id: 'p-web', name: 'Web only', hasMobileApp: false },
    ]);
    const bb = makeBlackboard();

    const result = await executeTool('list_project_options', {}, bb);

    expect(mockedListOptions).toHaveBeenCalledWith('ws-1');
    expect(result.ok).toBe(true);
    expect(result.content).toContain('"Mobile" (id: p-mob) — mobile app: kz.kolesa');
    expect(result.content).toContain('"Web only" (id: p-web) — no mobile app uploaded');
    expect(result.content).toContain('mobile_create_test_case');
  });

  it('returns an actionable failure when the workspace has no projects', async () => {
    mockedListOptions.mockResolvedValue([]);
    const result = await executeTool('list_project_options', {}, makeBlackboard());
    expect(result.ok).toBe(false);
    expect(result.content).toContain('No projects found');
  });
});
