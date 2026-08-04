/**
 * Ambiguity gate — a vague authoring request must yield a CLARIFYING QUESTION,
 * not fabricated steps.
 *
 * The prompt tells the agent to clarify ambiguous goals, but a prompt is
 * advisory. This test pins the STRUCTURAL enforcement: when the planner LLM
 * decides the goal is underspecified it returns
 * { needsClarification: true, clarifyingQuestion }, and `plan_flow`
 * (via executeTool) surfaces that question WITHOUT installing a plan — so the
 * executor cannot walk into authoring.
 *
 * The planner + runPlanFlow + blackboard run for real; only the LLM boundary
 * (`getChatCompletionWithMessages`) is stubbed so we control the raw JSON the
 * planner parses.
 */

// ── Mocks (declare before importing the module under test) ──

const mockGetChatCompletion = jest.fn();
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: unknown[]) => mockGetChatCompletion(...args),
}));

jest.mock('@/config/ai/ai-models.config', () => ({
  AI_MODELS: { fast: 'gpt-4.1-mini', smart: 'gpt-5.4-mini' },
}));

// The planner reads env for PII redaction; the progress emitter fires WS
// events we don't care about here. Keep both inert.
jest.mock('@/config/environment/env', () => ({
  env: { MOBILE_CHAT_PII_REDACTION: true },
}));

jest.mock('../progress', () => ({
  emitMobilePlanningStep: jest.fn(),
  emitMobileToolStep: jest.fn(),
  mobileToolProgress: jest.fn().mockReturnValue(65),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// tools.ts pulls in mobile-app-storage.service (existing) AND
// mobile-project-context.service (new eager-context work) — both reach
// @/db/supabase transitively. Mock at the tools.ts entry points this
// suite actually exercises so module init doesn't require real env vars.
jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: { getDetectedFramework: jest.fn() },
}));
jest.mock('@/services/chat/mobile-project-context.service', () => ({
  getAccessibleProject: jest.fn(),
  listMobileProjectOptions: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/services/testing/regression/regression-save.service', () => ({
  RegressionSaveService: { saveTestCase: jest.fn() },
}));
jest.mock('@/services/testing/mobile/mobile-draft-steps-cache', () => ({
  MobileDraftStepsCache: { set: jest.fn(), get: jest.fn(), consume: jest.fn() },
}));
jest.mock('@/services/testing/resolver/test-case-resolver.service', () => ({
  TestCaseResolverService: { findSimilar: jest.fn().mockResolvedValue([]) },
}));

import { executeTool } from '../tools';
import { MobileBlackboard } from '../blackboard';

function makeBlackboard(goal: string): MobileBlackboard {
  return new MobileBlackboard({
    goal,
    mobileSessionId: 'sess-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
  });
}

function llmReturns(json: unknown): void {
  mockGetChatCompletion.mockResolvedValueOnce({
    content: JSON.stringify(json),
    tool_calls: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('plan_flow ambiguity gate', () => {
  it('surfaces a clarifying question and installs NO plan for a vague goal', async () => {
    const bb = makeBlackboard('just create some test steps');
    llmReturns({
      goal: 'create some test steps',
      needsClarification: true,
      clarifyingQuestion:
        'Which flow should I test — login, sign-up, or something else? And what counts as success?',
    });

    const result = await executeTool(
      'plan_flow',
      JSON.stringify({ userGoal: 'just create some test steps' }),
      bb,
    );

    // The tool reports ok (it did its job) but explicitly did NOT author.
    expect(result.ok).toBe(true);
    expect(result.content).toContain('clarifying question');
    expect(result.content).toContain('Which flow should I test');
    expect(result.content).toMatch(/do not author|do not run|stop/i);

    // The critical invariant: nothing got installed, so the executor has no
    // plan to walk — it must ask the user, not fabricate steps.
    expect(bb.hasPlan()).toBe(false);
    expect(bb.getPlan()).toBeNull();
  });

  it('installs a concrete plan when the goal is specific', async () => {
    const bb = makeBlackboard('create a login test');
    llmReturns({
      goal: 'create a login test',
      steps: [
        { id: 1, intent: 'Open the login screen', verify: 'Email field visible' },
        { id: 2, intent: 'Fill the email field', verify: 'Email field shows the value' },
        { id: 3, intent: 'Tap submit', verify: 'Home screen shown' },
      ],
    });

    const result = await executeTool(
      'plan_flow',
      JSON.stringify({ userGoal: 'create a login test' }),
      bb,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('Plan installed');
    expect(bb.hasPlan()).toBe(true);
    expect(bb.getPlan()?.steps).toHaveLength(3);
  });

  it('rejects a malformed clarification (needsClarification without a question)', async () => {
    const bb = makeBlackboard('make a test');
    // Schema refine must fail this: needsClarification=true but no question
    // AND no steps → not a usable plan. Planner returns ok:false, tool tells
    // the executor to proceed step-by-step rather than crashing.
    llmReturns({ goal: 'make a test', needsClarification: true });

    const result = await executeTool(
      'plan_flow',
      JSON.stringify({ userGoal: 'make a test' }),
      bb,
    );

    expect(result.ok).toBe(false);
    expect(bb.hasPlan()).toBe(false);
  });
});
