import { WebTestRequestBuilderService } from '../web-test-request-builder.service';
import { ValidationError } from '@/types';
import * as regressionDb from '../db/regression.db';

jest.mock('../db/regression.db', () => ({
  getTestBrowsersAndOptions: jest.fn(),
}));

const mockGetBrowsers = regressionDb.getTestBrowsersAndOptions as jest.MockedFunction<
  typeof regressionDb.getTestBrowsersAndOptions
>;

// Mock dynamic imports used inside buildTestRequest
jest.mock('../intent-step-dispatch.service', () => ({
  normaliseIntentStep: jest.fn((raw: any, i: number) => ({ id: `step_${i + 1}`, ...raw })),
}));

jest.mock('../../ui/preview/intent-step-converter.service', () => ({
  IntentStepConverterService: {
    convertToCommands: jest.fn((steps: any[]) =>
      steps.map((s, i) => ({ action: s.type ?? 'click', _idx: i })),
    ),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBrowsers.mockResolvedValue(null);
});

function baseCase(overrides: Record<string, any> = {}) {
  return {
    id: 'tc-1',
    name: 'Login test',
    url: 'https://app.example.com',
    project_id: 'proj-1',
    description: 'Log in as admin',
    resource_bindings: [],
    ...overrides,
  };
}

// ── URL validation ────────────────────────────────────────────────────────────

describe('URL validation', () => {
  it('throws ValidationError when neither url nor start_url is set', async () => {
    const tc = baseCase({ url: undefined, start_url: undefined });
    await expect(
      WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {}),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts start_url as fallback when url is absent', async () => {
    const tc = baseCase({
      url: undefined,
      start_url: 'https://start.example.com',
      commands: [{ action: 'navigate' }],
      replay_strategy: 'commands',
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {});
    expect(req.url).toBe('https://start.example.com');
  });
});

// ── Strategy: pre-compiled commands ─────────────────────────────────────────

describe("strategy='commands'", () => {
  it('uses the commands array directly', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'click', selector: '#btn' }],
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {});
    expect(req.commands).toEqual([{ action: 'click', selector: '#btn' }]);
  });

  it('falls through to steps_json path when commands array is empty', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [],
      steps_json: [{ type: 'click', description: 'tap' }],
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {});
    // steps_json path produces commands via IntentStepConverterService
    expect(req.commands.length).toBeGreaterThan(0);
  });
});

// ── Strategy: graph_extract ──────────────────────────────────────────────────

describe("strategy='graph_extract'", () => {
  it('uses graph_ref.steps array', async () => {
    const steps = [{ action: 'click', selector: '#a' }, { action: 'navigate' }];
    const tc = baseCase({
      replay_strategy: 'graph_extract',
      graph_ref: { steps },
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {});
    expect(req.commands).toEqual(steps);
  });

  it('falls through when graph_ref.steps is empty', async () => {
    const tc = baseCase({
      replay_strategy: 'graph_extract',
      graph_ref: { steps: [] },
      steps_json: [{ type: 'click', description: 'tap' }],
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {});
    expect(req.commands.length).toBeGreaterThan(0);
  });
});

// ── Strategy: steps_json conversion ─────────────────────────────────────────

describe('steps_json conversion path', () => {
  it('calls normaliseIntentStep and IntentStepConverterService.convertToCommands', async () => {
    const { normaliseIntentStep } = await import('../intent-step-dispatch.service');
    const { IntentStepConverterService } = await import('../../ui/preview/intent-step-converter.service');

    const tc = baseCase({
      steps_json: [{ type: 'click', description: 'tap' }],
    });
    await WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {});

    expect(normaliseIntentStep).toHaveBeenCalledTimes(1);
    expect(IntentStepConverterService.convertToCommands).toHaveBeenCalledTimes(1);
  });

  it('throws ValidationError when steps_json is empty', async () => {
    const tc = baseCase({ steps_json: [] });
    await expect(
      WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {}),
    ).rejects.toThrow(ValidationError);
  });
});

// ── No replayable data ───────────────────────────────────────────────────────

describe('no replayable data', () => {
  it('throws ValidationError when no commands, no graph, no steps_json', async () => {
    const tc = baseCase({ commands: null, graph_ref: null, steps_json: null });
    await expect(
      WebTestRequestBuilderService.buildTestRequest(tc, 'user-1', {}),
    ).rejects.toThrow(ValidationError);
  });
});

// ── Parameter application ────────────────────────────────────────────────────

describe('parameter application', () => {
  it('applies parameters to commands', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'fill', value: '{{username}}' }],
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {
      username: 'admin',
    });
    // applyParameters resolves {{username}} → 'admin'
    const cmd = req.commands[0];
    expect(cmd.value).toBe('admin');
  });
});

// ── Browser resolution ───────────────────────────────────────────────────────

describe('browser resolution', () => {
  it('uses browserOverride when provided', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'click' }],
      source_test_id: 'src-1',
    });
    mockGetBrowsers.mockResolvedValue({ browsers: ['firefox'], options: {} });

    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {}, 'webkit');
    expect(req.browsers).toEqual(['webkit']);
  });

  it('falls back to source test browsers when no override', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'click' }],
      source_test_id: 'src-1',
    });
    mockGetBrowsers.mockResolvedValue({ browsers: ['firefox'], options: {} });

    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.browsers).toEqual(['firefox']);
  });

  it('defaults to ["chrome"] when no source test and no override', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'click' }],
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.browsers).toEqual(['chrome']);
  });

  it('does not query DB when source_test_id is absent', async () => {
    const tc = baseCase({ replay_strategy: 'commands', commands: [{ action: 'click' }] });
    await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(mockGetBrowsers).not.toHaveBeenCalled();
  });
});

// ── Trigger injection ────────────────────────────────────────────────────────

describe('trigger injection', () => {
  it('injects trigger into options when provided', async () => {
    const tc = baseCase({ replay_strategy: 'commands', commands: [{ action: 'click' }] });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {}, undefined, 'scheduled');
    expect(req.options.trigger).toBe('scheduled');
  });

  it('omits trigger key when not provided', async () => {
    const tc = baseCase({ replay_strategy: 'commands', commands: [{ action: 'click' }] });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.options).not.toHaveProperty('trigger');
  });
});

// ── Resource bindings ────────────────────────────────────────────────────────

describe('resource bindings', () => {
  it('passes resource_bindings from intentCase through to the request', async () => {
    const bindings = [{ kind: 'login', resource_id: 'res-1' }];
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'click' }],
      resource_bindings: bindings,
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.resourceBindings).toEqual(bindings);
  });

  it('defaults to empty array when resource_bindings is not an array', async () => {
    const tc = baseCase({
      replay_strategy: 'commands',
      commands: [{ action: 'click' }],
      resource_bindings: null,
    });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.resourceBindings).toEqual([]);
  });
});

// ── Request shape ────────────────────────────────────────────────────────────

describe('request shape', () => {
  it('sets intelligentMode=false', async () => {
    const tc = baseCase({ replay_strategy: 'commands', commands: [{ action: 'click' }] });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.intelligentMode).toBe(false);
  });

  it('sets metadata.intentTestCaseId and intentTestCaseName', async () => {
    const tc = baseCase({ replay_strategy: 'commands', commands: [{ action: 'click' }] });
    const req = await WebTestRequestBuilderService.buildTestRequest(tc, 'u-1', {});
    expect(req.metadata.intentTestCaseId).toBe('tc-1');
    expect(req.metadata.intentTestCaseName).toBe('Login test');
  });
});
