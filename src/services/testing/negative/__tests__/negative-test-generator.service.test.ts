/**
 * Unit tests for NegativeTestGeneratorService.
 * DB stubbed at the `db/` boundary; the AI call and fuzzing payloads stubbed.
 * No Supabase mocked directly.
 */

jest.mock('../db/negative.db', () => ({
  getSourceTestCase: jest.fn(),
  insertNegativeTestCase: jest.fn(),
  deleteNegativesBySource: jest.fn(),
  countFreshNegatives: jest.fn(),
  getNegativesForSource: jest.fn(),
}));

const mockGetChatCompletion = jest.fn();
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: any[]) => mockGetChatCompletion(...args),
}));

jest.mock('@/services/testing/api/fuzzing/fuzzing-config', () => ({
  CANONICAL_XSS_PAYLOAD: '<script>alert(1)</script>',
}));

import { NegativeTestGeneratorService } from '../negative-test-generator.service';
import * as negativeDb from '../db/negative.db';

const SOURCE = {
  id: 'src-1',
  name: 'Login flow',
  flow_id: 'flow-1',
  project_id: 'proj-1',
  url: 'https://app.test/login',
  start_url: 'https://app.test/login',
  steps_json: [
    { id: 's0', type: 'goto', description: 'Open login', value: 'https://app.test/login' },
    {
      id: 's1',
      type: 'fill',
      description: 'Enter email',
      value: 'user@example.com',
      recordedInputType: 'email',
      bindingHints: { type: 'email', label: 'Email', autocomplete: 'email' },
    },
    {
      id: 's2',
      type: 'fill',
      description: 'Enter password',
      value: 'hunter2',
      recordedInputType: 'password',
      bindingHints: { type: 'password', name: 'password' },
    },
    { id: 's3', type: 'click', description: 'Submit', value: '' },
  ],
};

function aiReturns(mutations: any[]) {
  mockGetChatCompletion.mockResolvedValue({ content: JSON.stringify({ mutations }) });
}

/** Capture every insert so we can assert on the built steps. */
function captureInserts() {
  const inserts: any[] = [];
  (negativeDb.insertNegativeTestCase as jest.Mock).mockImplementation(async (input: any) => {
    inserts.push(input);
    return `neg-${inserts.length}`;
  });
  return inserts;
}

beforeEach(() => {
  jest.clearAllMocks();
  (negativeDb.getSourceTestCase as jest.Mock).mockResolvedValue(SOURCE);
});

describe('NegativeTestGeneratorService.generateForTestCase', () => {
  it('appends an ai_check step that carries assertionText (required by executors)', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'empty_field', stepIndex: 1, originalValue: 'user@example.com', mutatedValue: '', expectedBehavior: 'Должна быть ошибка валидации email' },
    ]);

    const ids = await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');

    expect(ids).toEqual(['neg-1']);
    const steps = inserts[0].stepsJson;
    const check = steps[steps.length - 1];
    expect(check.type).toBe('ai_check');
    expect(check.assertionText).toBe('Должна быть ошибка валидации email');
    expect(check.options.aiContextMode).toBe('html+a11y');
    // The ai_check carries the negative intent — it verifies an error state,
    // it is NOT a positive happy-path assertion.
    expect(check.expectedOutcome).toBe('error');
  });

  it('clears the value for empty_field and marks the step expectedOutcome=error', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'empty_field', stepIndex: 1, originalValue: 'user@example.com', mutatedValue: '', expectedBehavior: 'required' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(inserts[0].stepsJson[1].value).toBe('');
    // Without this, a correct app 4xx flips the run to failed (inverted pass/fail).
    expect(inserts[0].stepsJson[1].expectedOutcome).toBe('error');
  });

  it('injects the server-owned canonical XSS payload, not the LLM value', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'xss', stepIndex: 1, originalValue: 'user@example.com', mutatedValue: 'LLM_INVENTED', expectedBehavior: 'no reflection' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(inserts[0].stepsJson[1].value).toBe('<script>alert(1)</script>');
    // meta must agree with what was actually injected
    expect(inserts[0].negativeMeta.mutatedValue).toBe('<script>alert(1)</script>');
  });

  it('injects a long canonical overflow payload', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'overflow', stepIndex: 2, originalValue: 'hunter2', mutatedValue: 'x', expectedBehavior: 'rejected' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(inserts[0].stepsJson[2].value.length).toBeGreaterThanOrEqual(1000);
  });

  it('removes the targeted step for skip_step (and still appends ai_check)', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'skip_step', stepIndex: 1, originalValue: 'user@example.com', mutatedValue: '', expectedBehavior: 'cannot submit' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    const steps = inserts[0].stepsJson;
    // original had 4 steps; -1 skipped +1 ai_check = 4
    expect(steps).toHaveLength(4);
    expect(steps.find((s: any) => s.id === 's1')).toBeUndefined();
    expect(steps[steps.length - 1].type).toBe('ai_check');
  });

  it('duplicates the targeted step for double_submit', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'double_submit', stepIndex: 3, originalValue: '', mutatedValue: '', expectedBehavior: 'no double charge' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    const steps = inserts[0].stepsJson;
    // 4 original + 1 duplicate + 1 ai_check = 6
    expect(steps).toHaveLength(6);
    expect(steps[3].description).toBe(steps[4].description);
    // The duplicate (second submit) is the one expected to be rejected.
    expect(steps[4].expectedOutcome).toBe('error');
  });

  it('drops malformed mutations (bad type / out-of-range index / missing expectedBehavior)', async () => {
    captureInserts();
    aiReturns([
      { mutationType: 'not_a_type', stepIndex: 1, expectedBehavior: 'x' },
      { mutationType: 'empty_field', stepIndex: 99, expectedBehavior: 'x' },
      { mutationType: 'empty_field', stepIndex: 1 }, // missing expectedBehavior
      { mutationType: 'empty_field', stepIndex: 1, originalValue: 'a', mutatedValue: '', expectedBehavior: 'valid' },
    ]);

    const ids = await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(ids).toHaveLength(1); // only the valid one
  });

  it('tolerates a bare-array AI response (defensive fallback)', async () => {
    const inserts = captureInserts();
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify([
        { mutationType: 'empty_field', stepIndex: 1, originalValue: 'a', mutatedValue: '', expectedBehavior: 'valid' },
      ]),
    });

    const ids = await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(ids).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });

  it('returns [] when the source has no steps', async () => {
    (negativeDb.getSourceTestCase as jest.Mock).mockResolvedValue({ ...SOURCE, steps_json: [] });
    const ids = await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(ids).toEqual([]);
    expect(negativeDb.insertNegativeTestCase).not.toHaveBeenCalled();
  });

  it('throws when the source test case is missing', async () => {
    (negativeDb.getSourceTestCase as jest.Mock).mockResolvedValue(null);
    await expect(
      NegativeTestGeneratorService.generateForTestCase('missing', 'user-1'),
    ).rejects.toThrow(/not found/i);
  });

  it('returns [] (no throw) when the AI call fails', async () => {
    captureInserts();
    mockGetChatCompletion.mockRejectedValue(new Error('llm down'));
    const ids = await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(ids).toEqual([]);
  });

  it('copies the source identity fields onto the negative (web source)', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'empty_field', stepIndex: 1, originalValue: 'a', mutatedValue: '', expectedBehavior: 'required' },
    ]);

    (negativeDb.getSourceTestCase as jest.Mock).mockResolvedValue({
      ...SOURCE,
      platform: 'web',
      replay_strategy: 'commands',
      parameters_schema: { param_password: { type: 'string', sensitive: true } },
      resource_bindings: [{ kind: 'auth', resource_id: 'r1', required: true }],
      mobile_variant_label: null,
      triggers: [],
    });

    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    const ins = inserts[0];
    expect(ins.platform).toBe('web');
    // Inherits the source replay_strategy — NOT the old hardcoded 'steps_json'
    // (which is not a valid replay_strategy CHECK value).
    expect(ins.replayStrategy).toBe('commands');
    expect(ins.parametersSchema).toEqual({ param_password: { type: 'string', sensitive: true } });
    expect(ins.resourceBindings).toEqual([{ kind: 'auth', resource_id: 'r1', required: true }]);
  });

  it('persists per-mutation reasoning into negative_meta when provided', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'empty_field', stepIndex: 1, originalValue: 'a', mutatedValue: '', expectedBehavior: 'required', reasoning: 'email is required' },
    ]);
    await NegativeTestGeneratorService.generateForTestCase('src-1', 'user-1');
    expect(inserts[0].negativeMeta.reasoning).toBe('email is required');
  });
});

/** Mobile source: no recordedInputType; a11y signals + mobile-only step types. */
const MOBILE_SOURCE = {
  id: 'm-src-1',
  name: 'Mobile login',
  flow_id: 'flow-m',
  project_id: 'proj-1',
  url: 'mobile://android',
  start_url: null,
  platform: 'mobile_android',
  replay_strategy: 'mobile_steps',
  parameters_schema: { param_password: { type: 'string', sensitive: true } },
  resource_bindings: [{ kind: 'auth', resource_id: 'login-1', required: true }],
  mobile_variant_label: 'beta',
  triggers: [{ on: 'permission_dialog', do: 'allow' }],
  steps_json: [
    { id: 'm0', type: 'open_app', description: 'Open app', value: 'com.shop.app' },
    { id: 'm1', type: 'type', description: 'Enter email', value: 'user@example.com', bindingHints: { role: 'textbox', label: 'Email' } },
    { id: 'm2', type: 'type', description: 'Enter password', value: 'hunter2', bindingHints: { role: 'textbox', label: 'Пароль', type: 'password' } },
    { id: 'm3', type: 'click', description: 'Login', bindingHints: { role: 'button', label: 'Войти' } },
  ],
};

describe('NegativeTestGeneratorService — mobile sources', () => {
  beforeEach(() => {
    (negativeDb.getSourceTestCase as jest.Mock).mockResolvedValue(MOBILE_SOURCE);
  });

  it('inherits mobile platform + replay_strategy + setup fields onto the negative', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'empty_field', stepIndex: 2, originalValue: 'hunter2', mutatedValue: '', expectedBehavior: 'показать ошибку, не войти' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('m-src-1', 'user-1');
    const ins = inserts[0];
    expect(ins.platform).toBe('mobile_android');
    expect(ins.replayStrategy).toBe('mobile_steps');
    expect(ins.resourceBindings).toEqual([{ kind: 'auth', resource_id: 'login-1', required: true }]);
    expect(ins.mobileVariantLabel).toBe('beta');
    expect(ins.triggers).toEqual([{ on: 'permission_dialog', do: 'allow' }]);
  });

  it('uses aiCheckSource:tree (not aiContextMode) on the trailing ai_check', async () => {
    const inserts = captureInserts();
    aiReturns([
      { mutationType: 'empty_field', stepIndex: 2, originalValue: 'hunter2', mutatedValue: '', expectedBehavior: 'ошибка валидации' },
    ]);

    await NegativeTestGeneratorService.generateForTestCase('m-src-1', 'user-1');
    const steps = inserts[0].stepsJson;
    const check = steps[steps.length - 1];
    expect(check.type).toBe('ai_check');
    expect(check.options.aiCheckSource).toBe('tree');
    expect(check.options.aiContextMode).toBeUndefined();
    expect(check.expectedOutcome).toBe('error');
  });

  it('drops a value mutation that targets a non-input mobile step (open_app)', async () => {
    captureInserts();
    aiReturns([
      // LLM mistakenly targets the open_app step (index 0) — no input value.
      { mutationType: 'invalid_format', stepIndex: 0, originalValue: 'com.shop.app', mutatedValue: 'x', expectedBehavior: 'n/a' },
      // ...and a valid one on the password field (index 2).
      { mutationType: 'empty_field', stepIndex: 2, originalValue: 'hunter2', mutatedValue: '', expectedBehavior: 'ошибка' },
    ]);

    const ids = await NegativeTestGeneratorService.generateForTestCase('m-src-1', 'user-1');
    // Only the valid mutation survives; the open_app mutation is dropped.
    expect(ids).toHaveLength(1);
  });
});
