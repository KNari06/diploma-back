/**
 * Generated-report import.
 *
 * Proves the parser now extracts test cases from a zipped GENERATED Allure
 * report (`allure generate` output: `data/test-cases/<uid>.json`), not only
 * the raw `allure-results/` directory. Before this, a report ZIP produced ZERO
 * tests and the import silently "completed" creating nothing.
 *
 * Only the classifier's OpenAI call is mocked; the parser + adapter run for
 * real.
 */

const mockGetChatCompletion = jest.fn(async () => ({
  content: JSON.stringify({ files: [] }), // ambiguous → skip
}));
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: () => mockGetChatCompletion(),
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/config/ai/ai-models.config', () => ({
  AI_MODELS: { classify: 'test-model' },
  AI_TASK_MODELS: { allureClassify: 'test-model' },
}));

import AdmZip from 'adm-zip';
import { parseAllureZip } from '../allure-parser';
import { adaptReportTestCases, isReportTestCasePath } from '../allure-report-adapter';

function buildZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [p, content] of Object.entries(files)) {
    zip.addFile(p, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
  }
  return zip.toBuffer();
}

/** A generated-report test case JSON (data/test-cases/<uid>.json schema). */
function reportTestCase(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    uid: 'abc',
    name: 'Test',
    status: 'PASSED',
    testStage: { steps: [] },
    beforeStages: [],
    afterStages: [],
    labels: [],
    parameters: [],
    links: [],
    ...overrides,
  });
}

describe('isReportTestCasePath', () => {
  it('matches generated-report per-test files', () => {
    expect(isReportTestCasePath('allure-report/data/test-cases/abc123.json')).toBe(true);
    expect(isReportTestCasePath('data/test-cases/xyz.json')).toBe(true);
  });
  it('does not match raw results or unrelated data files', () => {
    expect(isReportTestCasePath('allure-results/abc-result.json')).toBe(false);
    expect(isReportTestCasePath('data/suites.json')).toBe(false);
    expect(isReportTestCasePath('data/test-cases/nested/dir.json')).toBe(false);
  });
});

describe('adaptReportTestCases — schema translation', () => {
  it('maps uid, uppercase status, testStage.steps, and beforeStages→preconditions', () => {
    const json = JSON.parse(reportTestCase({
      uid: 'u1',
      name: 'Login works',
      fullName: 'com.acme.LoginTest.signsIn',
      historyId: 'hist-1',
      status: 'FAILED',
      statusMessage: 'expected dashboard, got login',
      description: 'desc',
      testStage: {
        steps: [
          { name: 'Open login page', status: 'PASSED' },
          { name: 'Submit form', status: 'FAILED', statusMessage: 'boom' },
        ],
      },
      beforeStages: [{ name: 'Seed user', steps: [] }],
      labels: [{ name: 'epic', value: 'Auth' }, { name: 'feature', value: 'Login' }],
    }));

    const { results, containers } = adaptReportTestCases([{ path: 'data/test-cases/u1.json', json }]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.uuid).toBe('u1');
    expect(r.testCaseId).toBe('hist-1');       // historyId → dedup key
    expect(r.name).toBe('Login works');
    expect(r.status).toBe('failed');            // UPPERCASE → lowercase
    expect(r.statusDetails?.message).toBe('expected dashboard, got login');
    expect(r.steps.map((s) => s.name)).toEqual(['Open login page', 'Submit form']);
    expect(r.steps[0].status).toBe('passed');
    expect(r.labels).toEqual([
      { name: 'epic', value: 'Auth' },
      { name: 'feature', value: 'Login' },
    ]);

    // beforeStages surface as a synthetic container linked by uuid
    expect(containers).toHaveLength(1);
    expect(containers[0].children).toEqual(['u1']);
    expect(containers[0].befores?.map((b) => b.name)).toEqual(['Seed user']);
  });

  it('resolves name from fullName when name is missing', () => {
    const json = JSON.parse(reportTestCase({ uid: 'u2', name: undefined, fullName: 'a.b.c.signsIn' }));
    const { results } = adaptReportTestCases([{ path: 'data/test-cases/u2.json', json }]);
    expect(results[0].name).toBe('signsIn');
  });

  it('skips a test case with no resolvable name', () => {
    const json = JSON.parse(reportTestCase({ uid: 'u3', name: '', fullName: undefined }));
    const { results } = adaptReportTestCases([{ path: 'data/test-cases/u3.json', json }]);
    expect(results).toHaveLength(0);
  });
});

describe('parseAllureZip — generated-report fallback', () => {
  it('extracts tests from a zipped allure-report/ site', async () => {
    const zip = buildZip({
      'allure-report/index.html': '<html>report</html>',
      'allure-report/app.js': 'console.log(1)',
      'allure-report/data/test-cases/abc123.json': reportTestCase({
        uid: 'abc123', name: 'Login works', status: 'PASSED',
        testStage: { steps: [{ name: 'Open login' }, { name: 'Submit' }] },
        labels: [{ name: 'epic', value: 'Auth' }],
      }),
      'allure-report/data/test-cases/def456.json': reportTestCase({
        uid: 'def456', name: 'Checkout fails', status: 'FAILED',
        testStage: { steps: [{ name: 'Add to cart' }] },
      }),
      'allure-report/data/suites.json': JSON.stringify({ children: [] }),
      'allure-report/widgets/summary.json': JSON.stringify({ statistic: {} }),
    });

    const out = await parseAllureZip(zip);

    expect(out.results.map((r) => r.name).sort()).toEqual(['Checkout fails', 'Login works']);
    expect(out.results.find((r) => r.name === 'Checkout fails')!.status).toBe('failed');
    const login = out.results.find((r) => r.name === 'Login works')!;
    expect(login.steps.map((s) => s.name)).toEqual(['Open login', 'Submit']);
    expect(login.labels).toEqual([{ name: 'epic', value: 'Auth' }]);
  });

  it('does NOT trigger the fallback when raw results exist (results ZIP unaffected)', async () => {
    const zip = buildZip({
      'allure-results/xyz-result.json': JSON.stringify({
        uuid: 'xyz', name: 'Real result', status: 'passed', steps: [{ name: 'do' }],
      }),
      // A stray report-shaped file must be ignored while raw results are present.
      'data/test-cases/ghost.json': reportTestCase({ uid: 'ghost', name: 'Should not import' }),
    });

    const out = await parseAllureZip(zip);

    expect(out.results.map((r) => r.name)).toEqual(['Real result']);
  });
});
