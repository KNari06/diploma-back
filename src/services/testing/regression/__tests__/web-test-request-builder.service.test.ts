// Unit tests for WebTestRequestBuilderService.buildTestRequest. We mock at the
// service boundary: the db/ sublayer, the parameter-substitution util, and the
// two dynamically-imported collaborators (intent-step normaliser + converter).
// ValidationError is the real class so `rejects.toThrow(ValidationError)` works.

jest.mock('../db/regression.db', () => ({ getTestBrowsersAndOptions: jest.fn() }));
jest.mock('@/utils/testing/parameter-substitution.utils', () => ({ applyParameters: jest.fn((cmds) => cmds) }));
jest.mock('../intent-step-dispatch.service', () => ({
  normaliseIntentStep: jest.fn((raw: any, i: number) => ({ ...raw, _normalised: i })),
}));
jest.mock('../../ui/preview/intent-step-converter.service', () => ({
  IntentStepConverterService: { convertToCommands: jest.fn() },
}));

import { WebTestRequestBuilderService } from '../web-test-request-builder.service';
import { ValidationError } from '@/types';
import * as regressionDb from '../db/regression.db';
import { applyParameters } from '@/utils/testing/parameter-substitution.utils';
import { IntentStepConverterService } from '../../ui/preview/intent-step-converter.service';

const getBrowsersMock = regressionDb.getTestBrowsersAndOptions as jest.Mock;
const applyParamsMock = applyParameters as jest.Mock;
const convertMock = IntentStepConverterService.convertToCommands as jest.Mock;

const build = WebTestRequestBuilderService.buildTestRequest;

/** A commands-strategy intent case with sensible defaults. */
const intentCase = (over: Record<string, any> = {}) => ({
  id: 'ic1',
  name: 'Login flow',
  url: 'https://app.test',
  project_id: 'proj1',
  replay_strategy: 'commands',
  commands: [{ action: 'click' }],
  ...over,
});

beforeEach(() => {
  getBrowsersMock.mockResolvedValue(null);
  applyParamsMock.mockImplementation((cmds) => cmds);
  convertMock.mockReturnValue([{ action: 'goto' }]);
});

describe('buildTestRequest — URL handling', () => {
  it('throws ValidationError when neither url nor start_url is set', async () => {
    await expect(build(intentCase({ url: undefined }), 'u1', {})).rejects.toThrow(ValidationError);
  });

  it('falls back to start_url when url is missing', async () => {
    const req = await build(intentCase({ url: undefined, start_url: 'https://fallback.test' }), 'u1', {});
    expect(req.url).toBe('https://fallback.test');
  });
});

describe('buildTestRequest — command extraction strategies', () => {
  it('uses pre-compiled commands for the "commands" strategy', async () => {
    const req = await build(intentCase({ commands: [{ action: 'click' }, { action: 'fill' }] }), 'u1', {});
    expect(req.commands).toHaveLength(2);
    expect(convertMock).not.toHaveBeenCalled();
  });

  it('uses graph_ref.steps for the "graph_extract" strategy', async () => {
    const c = intentCase({ replay_strategy: 'graph_extract', commands: undefined, graph_ref: { steps: [{ action: 'goto' }] } });
    const req = await build(c, 'u1', {});
    expect(req.commands).toEqual([{ action: 'goto' }]);
  });

  it('converts steps_json via the intent-step converter', async () => {
    convertMock.mockReturnValue([{ action: 'goto' }, { action: 'click' }]);
    const c = intentCase({ replay_strategy: 'step_editor', commands: undefined, steps_json: [{ type: 'click' }, { type: 'fill' }] });
    const req = await build(c, 'u1', {});
    expect(convertMock).toHaveBeenCalledWith(
      [
        { type: 'click', _normalised: 0 },
        { type: 'fill', _normalised: 1 },
      ],
      'https://app.test',
      'ic1',
    );
    expect(req.commands).toHaveLength(2);
  });

  it('throws ValidationError when there is no replayable data', async () => {
    const c = intentCase({ replay_strategy: 'mystery', commands: null, steps_json: null });
    await expect(build(c, 'u1', {})).rejects.toThrow(/no replayable data/);
  });

  it('throws ValidationError when conversion produces zero commands', async () => {
    convertMock.mockReturnValue([]);
    const c = intentCase({ replay_strategy: 'step_editor', commands: undefined, steps_json: [{ type: 'click' }] });
    await expect(build(c, 'u1', {})).rejects.toThrow(/no executable commands/);
  });
});

describe('buildTestRequest — source test configuration', () => {
  it('applies default browsers and empty options when there is no source_test_id', async () => {
    const req = await build(intentCase(), 'u1', {});
    expect(req.browsers).toEqual(['chrome']);
    expect(req.options).toEqual({});
    expect(getBrowsersMock).not.toHaveBeenCalled();
  });

  it('pulls browsers and options from the source test when present', async () => {
    getBrowsersMock.mockResolvedValue({ browsers: ['firefox', 'webkit'], options: { headless: true } });
    const req = await build(intentCase({ source_test_id: 'src1' }), 'u1', {});
    expect(getBrowsersMock).toHaveBeenCalledWith('src1');
    expect(req.browsers).toEqual(['firefox', 'webkit']);
    expect(req.options).toMatchObject({ headless: true });
  });

  it('lets a browserOverride win over source/default browsers', async () => {
    getBrowsersMock.mockResolvedValue({ browsers: ['firefox'], options: {} });
    const req = await build(intentCase({ source_test_id: 'src1' }), 'u1', {}, 'edge');
    expect(req.browsers).toEqual(['edge']);
  });
});

describe('buildTestRequest — request shape', () => {
  it('merges the trigger into options', async () => {
    const req = await build(intentCase(), 'u1', {}, undefined, 'scheduled');
    expect(req.options.trigger).toBe('scheduled');
  });

  it('omits the trigger key when no trigger is given', async () => {
    const req = await build(intentCase(), 'u1', {});
    expect(req.options).not.toHaveProperty('trigger');
  });

  it('passes through resource_bindings, or defaults to []', async () => {
    const withBindings = await build(intentCase({ resource_bindings: [{ kind: 'auth' }] }), 'u1', {});
    expect(withBindings.resourceBindings).toEqual([{ kind: 'auth' }]);
    const withoutBindings = await build(intentCase({ resource_bindings: 'oops' }), 'u1', {});
    expect(withoutBindings.resourceBindings).toEqual([]);
  });

  it('prefers description over name for testGoal and sets metadata + flags', async () => {
    const req = await build(intentCase({ description: 'Sign in as admin' }), 'u1', {});
    expect(req.testGoal).toBe('Sign in as admin');
    expect(req.intelligentMode).toBe(false);
    expect(req.userId).toBe('u1');
    expect(req.projectId).toBe('proj1');
    expect(req.metadata).toEqual({
      intentTestCaseId: 'ic1',
      intentTestCaseName: 'Login flow',
      source: 'intent_test_case',
    });
  });

  it('falls back to name for testGoal when description is absent', async () => {
    const req = await build(intentCase(), 'u1', {});
    expect(req.testGoal).toBe('Login flow');
  });

  it('runs commands through applyParameters and uses the result', async () => {
    const substituted = [{ action: 'click', resolved: true }];
    applyParamsMock.mockReturnValue(substituted);
    const params = { user: 'admin' };
    const req = await build(intentCase(), 'u1', params);
    expect(applyParamsMock).toHaveBeenCalledWith([{ action: 'click' }], params);
    expect(req.commands).toBe(substituted);
  });
});

describe('stitchCommandsForTestCase', () => {
  it('is a pass-through that returns the main commands unchanged', async () => {
    const cmds = [{ action: 'click' }];
    await expect(WebTestRequestBuilderService.stitchCommandsForTestCase(cmds, {}, 'https://x')).resolves.toBe(cmds);
  });
});
