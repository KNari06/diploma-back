// Mock the external collaborators so the formatter is tested in isolation:
// the execution-profile policy, the shared constants, and the dynamically
// imported fuzzing formatter. Logger is globally mocked in jest.setup.ts.
jest.mock('@/services/testing/api/agent/api-agent-policy', () => ({ inferExecutionProfile: jest.fn() }));
jest.mock('../../shared/constants', () => ({ CONSTANTS: { TEST_PLAN_EXPIRY_HOURS: 24 } }));
jest.mock('@/services/testing/api/fuzzing/api-fuzzing-formatter.service', () => ({
  ApiFuzzingFormatterService: { formatComprehensiveReport: jest.fn(() => 'FUZZ_REPORT_BODY') },
}));

import { formatApiResponse, getCircularReplacer, convertApiTestPlanToTestPlan } from '../formatting';
import { inferExecutionProfile } from '@/services/testing/api/agent/api-agent-policy';

const profileMock = inferExecutionProfile as jest.Mock;

beforeEach(() => {
  profileMock.mockReturnValue('non_prod');
});

describe('getCircularReplacer', () => {
  it('replaces a circular reference with "[Circular]"', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const out = JSON.stringify(obj, getCircularReplacer());
    expect(out).toContain('[Circular]');
    expect(JSON.parse(out)).toEqual({ a: 1, self: '[Circular]' });
  });

  it('leaves an acyclic object intact', () => {
    const obj = { a: 1, nested: { b: 2 } };
    expect(JSON.parse(JSON.stringify(obj, getCircularReplacer()))).toEqual(obj);
  });
});

describe('convertApiTestPlanToTestPlan', () => {
  const apiPlan = {
    id: 'plan1',
    url: 'https://api.test/users',
    summary: 'Test users endpoint',
    validation_steps: ['Check 200', 'Check shape'],
    estimated_duration: '5s',
    what_will_be_tested: ['happy path'],
    potential_issues: ['rate limit'],
    method: 'POST',
    headers: { Authorization: 'x' },
    body: { name: 'a' },
    expected_status: 201,
  };

  it('maps core fields and the api_test scope', () => {
    const plan = convertApiTestPlanToTestPlan(apiPlan);
    expect(plan).toMatchObject({
      id: 'plan1',
      status: 'pending_confirmation',
      url: 'https://api.test/users',
      scope: 'api_test',
      summary: 'Test users endpoint',
      estimatedDuration: '5s',
      whatWillBeTested: ['happy path'],
      whatWillNotBeTested: [],
      risks: ['rate limit'],
      commands: [],
    });
  });

  it('converts validation_steps into indexed validate steps', () => {
    const plan = convertApiTestPlanToTestPlan(apiPlan);
    expect(plan.steps).toEqual([
      { id: 'step_1', action: 'validate', description: 'Check 200' },
      { id: 'step_2', action: 'validate', description: 'Check shape' },
    ]);
  });

  it('packs API-specific data into metadata', () => {
    const plan = convertApiTestPlanToTestPlan(apiPlan);
    expect(plan.metadata).toEqual({
      type: 'api_test',
      method: 'POST',
      headers: { Authorization: 'x' },
      body: { name: 'a' },
      expectedStatus: 201,
    });
  });

  it('defaults risks to [] when potential_issues is missing', () => {
    const plan = convertApiTestPlanToTestPlan({ ...apiPlan, potential_issues: undefined });
    expect(plan.risks).toEqual([]);
  });

  it('sets expiresAt to TEST_PLAN_EXPIRY_HOURS after creation', () => {
    const plan = convertApiTestPlanToTestPlan(apiPlan);
    const deltaMs = new Date(plan.expiresAt).getTime() - new Date(plan.createdAt).getTime();
    expect(deltaMs).toBeGreaterThan(24 * 3600 * 1000 - 2000);
    expect(deltaMs).toBeLessThanOrEqual(24 * 3600 * 1000);
  });
});

describe('formatApiResponse', () => {
  const plan = { url: 'https://api.test/users' };
  const apiDetails = { method: 'POST' };
  const okResult = { status: 200, success: true, durationMs: 42 };

  describe('input validation', () => {
    it('throws on a missing apiTestResult', async () => {
      await expect(formatApiResponse(null, null, plan, apiDetails)).rejects.toThrow('Invalid apiTestResult');
    });
    it('throws on a plan without a url', async () => {
      await expect(formatApiResponse(okResult, null, {}, apiDetails)).rejects.toThrow('Invalid plan or missing plan.url');
    });
    it('throws on missing apiDetails', async () => {
      await expect(formatApiResponse(okResult, null, plan, null)).rejects.toThrow('Invalid apiDetails');
    });
  });

  describe('mode label', () => {
    it('labels a prod-readonly profile as "Hard (Prod-safe)"', async () => {
      profileMock.mockReturnValue('prod_readonly');
      const { finalMessage } = await formatApiResponse(okResult, null, plan, apiDetails);
      expect(finalMessage).toContain('Hard (Prod-safe)');
    });
    it('labels any other profile as "Hard (Non-prod)"', async () => {
      const { finalMessage } = await formatApiResponse(okResult, null, plan, apiDetails);
      expect(finalMessage).toContain('Hard (Non-prod)');
    });
  });

  describe('happy-path message (no fuzzing report)', () => {
    it('includes url, method, status, success and duration', async () => {
      const { finalMessage } = await formatApiResponse(okResult, null, plan, apiDetails);
      expect(finalMessage).toContain('API test executed successfully');
      expect(finalMessage).toContain('https://api.test/users');
      expect(finalMessage).toContain('**Method:** POST');
      expect(finalMessage).toContain('**Status Code:** 200');
      expect(finalMessage).toContain('**Success:** Yes');
      expect(finalMessage).toContain('**Duration:** 42ms');
    });

    it('applies defaults for missing method/status/duration and success=No', async () => {
      const { finalMessage } = await formatApiResponse({ success: false }, null, plan, {});
      expect(finalMessage).toContain('**Method:** GET');
      expect(finalMessage).toContain('**Status Code:** N/A');
      expect(finalMessage).toContain('**Success:** No');
      expect(finalMessage).toContain('**Duration:** 0ms');
    });
  });

  describe('fuzzing report branch', () => {
    it('renders the comprehensive fuzzing report and happy-path header', async () => {
      const { finalMessage } = await formatApiResponse(okResult, { findings: [] }, plan, apiDetails);
      expect(finalMessage).toContain('Happy Path Test:** PASSED');
      expect(finalMessage).toContain('FUZZ_REPORT_BODY');
    });

    it('applies method/status/duration defaults in the fuzzing branch', async () => {
      const { finalMessage } = await formatApiResponse({}, { findings: [] }, plan, {});
      expect(finalMessage).toContain('Method: GET');
      expect(finalMessage).toContain('Status: N/A');
      expect(finalMessage).toContain('Duration: 0ms');
    });
  });

  describe('response body rendering', () => {
    it('pretty-prints an object response body as a json block', async () => {
      const { responseBodyDisplay } = await formatApiResponse({ ...okResult, responseBody: { id: 1 } }, null, plan, apiDetails);
      expect(responseBodyDisplay).toContain('**Response Body:**');
      expect(responseBodyDisplay).toContain('```json');
      expect(responseBodyDisplay).toContain('"id": 1');
    });

    it('parses and re-formats a JSON string response body', async () => {
      const { responseBodyDisplay } = await formatApiResponse({ ...okResult, responseBody: '{"a":2}' }, null, plan, apiDetails);
      expect(responseBodyDisplay).toContain('```json');
      expect(responseBodyDisplay).toContain('"a": 2');
    });

    it('shows a non-JSON string body in a plain code block', async () => {
      const { responseBodyDisplay } = await formatApiResponse({ ...okResult, responseBody: 'plain text body' }, null, plan, apiDetails);
      expect(responseBodyDisplay).toContain('```\nplain text body\n```');
    });

    it('truncates a long non-JSON string body to 500 chars + ellipsis', async () => {
      const big = 'x'.repeat(600);
      const { responseBodyDisplay } = await formatApiResponse({ ...okResult, responseBody: big }, null, plan, apiDetails);
      expect(responseBodyDisplay).toContain('x'.repeat(500) + '...');
      expect(responseBodyDisplay).not.toContain('x'.repeat(501));
    });

    it('falls back to a placeholder when the body cannot be stringified', async () => {
      // A BigInt value makes JSON.stringify throw (TypeError) → catch branch.
      const { responseBodyDisplay } = await formatApiResponse({ ...okResult, responseBody: { big: 10n } }, null, plan, apiDetails);
      expect(responseBodyDisplay).toContain('[Object - too complex to display]');
    });

    it('leaves the body display empty when there is no response body', async () => {
      const { responseBodyDisplay } = await formatApiResponse(okResult, null, plan, apiDetails);
      expect(responseBodyDisplay).toBe('');
    });
  });
});
