/**
 * Batch-upload pipeline integration test.
 *
 * Simulates a user uploading a realistic Allure ZIP (and a CSV) and runs it
 * through the REAL parser/classifier/dedup/container-linking code. Only the
 * OpenAI client is mocked (deterministic, offline) — everything else is the
 * production code path.
 *
 * Goal: prove the parse → classify → dedup → container-link stages hold up on a
 * messy real-world batch: multiple results, parameterized duplicates, fixtures,
 * docs, video, generated report UI noise, and malformed files mixed together.
 */

// ── Mock the OpenAI client used by the classifier (ambiguous files only) ──────
// Classify everything ambiguous as 'noise' so the deterministic skip behaviour
// is exercised without a network call. (Most files are classified
// deterministically and never reach this mock.)
const mockGetChatCompletion = jest.fn(async () => ({
  content: JSON.stringify({ files: [] }), // empty → caller treats as skip
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
import { parseAllureCsv } from '../allure-csv-parser';
import type { AllureTestResult, AllureContainer } from '../allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function result(overrides: Partial<AllureTestResult> & { uuid: string; name: string }): string {
  const base: AllureTestResult = {
    status: 'passed',
    labels: [],
    links: [],
    parameters: [],
    steps: [],
    attachments: [],
    ...overrides,
  } as AllureTestResult;
  return JSON.stringify(base);
}

function container(overrides: Partial<AllureContainer> & { uuid: string }): string {
  return JSON.stringify({ children: [], befores: [], afters: [], ...overrides });
}

/** Build an in-memory Allure ZIP buffer from a {path: content} map. */
function buildZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [p, content] of Object.entries(files)) {
    zip.addFile(p, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
  }
  return zip.toBuffer();
}

beforeEach(() => mockGetChatCompletion.mockClear());

// ─────────────────────────────────────────────────────────────────────────────
// ZIP pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAllureZip — realistic batch upload', () => {
  it('extracts real tests, links fixtures, and skips report-UI noise', async () => {
    const zip = buildZip({
      // 3 genuine test results
      'allure-results/a1-result.json': result({ uuid: 'a1', name: 'Login works', status: 'passed' }),
      'allure-results/a2-result.json': result({ uuid: 'a2', name: 'Checkout fails', status: 'failed' }),
      'allure-results/a3-result.json': result({ uuid: 'a3', name: 'Search', status: 'broken' }),
      // a fixture container linking a1
      'allure-results/c1-container.json': container({
        uuid: 'c1',
        children: ['a1'],
        befores: [{ name: 'Seed test user' } as any],
      }),
      // metadata + generated report UI + media — all must be skipped/categorised
      'allure-results/environment.properties': 'BASE_URL=https://x.io\nBROWSER=chrome',
      'allure-results/executor.json': JSON.stringify({ name: 'CI', buildName: '#42' }),
      'index.html': '<html><body>report</body></html>',
      'plugins/screen-diff/index.js': 'console.log(1)',
      'widgets/summary.json': JSON.stringify({ statistic: {} }),
      'data/test-cases/a1.json': '{"generated":true}',
      'allure-results/shot-attachment.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'allure-results/clip-attachment.webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    });

    const out = await parseAllureZip(zip);

    // 3 real tests extracted, names preserved
    expect(out.results.map((r) => r.name).sort()).toEqual(['Checkout fails', 'Login works', 'Search']);
    // statuses preserved
    expect(out.results.find((r) => r.name === 'Checkout fails')!.status).toBe('failed');
    // container linked to a1 by child uuid
    expect(out.containerByResultUuid.get('a1')?.uuid).toBe('c1');
    // metadata parsed
    expect(out.metadata.environment?.BASE_URL).toBe('https://x.io');
    expect(out.metadata.executor?.buildName).toBe('#42');
    // video counted, UI/data/image skipped (not surfaced as tests)
    expect(out.classified.videosSkipped).toBeGreaterThanOrEqual(1);
    expect(out.classified.filesSkipped).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates parameterized runs by testCaseId, keeping the richest', async () => {
    const zip = buildZip({
      // same testCaseId, 3 param runs — should collapse to ONE
      'p1-result.json': result({
        uuid: 'p1', name: 'Param test [a]', testCaseId: 'tc-shared',
        parameters: [{ name: 'x', value: 'a' }],
        steps: [{ name: 's1' }],
      }),
      'p2-result.json': result({
        uuid: 'p2', name: 'Param test [b]', testCaseId: 'tc-shared',
        parameters: [{ name: 'x', value: 'b' }],
        steps: [{ name: 's1' }, { name: 's2' }, { name: 's3' }], // richest → kept
      }),
      'p3-result.json': result({
        uuid: 'p3', name: 'Param test [c]', testCaseId: 'tc-shared',
        parameters: [{ name: 'x', value: 'c' }],
        steps: [{ name: 's1' }],
      }),
      // a distinct test with no testCaseId — kept as-is
      'u1-result.json': result({ uuid: 'u1', name: 'Standalone' }),
    });

    const out = await parseAllureZip(zip);

    const names = out.results.map((r) => r.name).sort();
    expect(names).toEqual(['Param test [b]', 'Standalone']); // richest param run + standalone
    const kept = out.results.find((r) => r.testCaseId === 'tc-shared')!;
    expect(kept.steps).toHaveLength(3); // kept the 3-step run
    // parameters from all 3 runs merged
    expect(kept.parameters.map((p) => p.value).sort()).toEqual(['a', 'b', 'c']);
  });

  it('survives malformed result files without aborting the whole batch', async () => {
    const zip = buildZip({
      'good-result.json': result({ uuid: 'g1', name: 'Good' }),
      'bad1-result.json': '{ not valid json',
      'bad2-result.json': JSON.stringify({ name: 'no uuid here' }), // missing uuid → skipped
    });

    const out = await parseAllureZip(zip);

    expect(out.results.map((r) => r.name)).toEqual(['Good']);
    expect(out.classified.filesSkipped).toBeGreaterThanOrEqual(2);
  });

  it('resolves name from fullName when name is absent', async () => {
    const zip = buildZip({
      'f1-result.json': JSON.stringify({ uuid: 'f1', fullName: 'com.acme.LoginTest.signsIn', status: 'passed' }),
    });

    const out = await parseAllureZip(zip);

    expect(out.results).toHaveLength(1);
    expect(out.results[0].name).toBe('signsIn'); // last segment of fullName
  });

  it('throws on a non-ZIP buffer (caller marks import failed)', async () => {
    await expect(parseAllureZip(Buffer.from('not a zip at all'))).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV pipeline (TestOps export)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAllureCsv — TestOps batch export', () => {
  it('parses a multi-row semicolon export with hierarchy + steps', async () => {
    const csv = [
      'Epic;Feature;name;Severity;scenario;precondition;tag',
      'Billing;Invoices;Create invoice;blocker;"[step 1] Open billing\n[step 2] Click create";"Logged in";smoke',
      'Billing;Invoices;Delete invoice;normal;"[step 1] Open invoice\n[step 2] Delete";"Invoice exists";regression',
      'Auth;Login;Sign in;critical;"[step 1] Enter creds";"";smoke',
    ].join('\n');

    const { testCases, errors } = await parseAllureCsv(csv);

    expect(errors).toEqual([]);
    expect(testCases).toHaveLength(3);

    const invoice = testCases.find((t) => t.name === 'Create invoice')!;
    expect(invoice.moduleName).toBe('Billing');   // Epic → module
    expect(invoice.flowName).toBe('Invoices');     // Feature → flow
    expect(invoice.priority).toBe('critical');     // blocker → critical
    expect(invoice.steps).toHaveLength(2);
    expect(invoice.preconditions).toEqual(['Logged in']);
    expect(invoice.tags).toContain('smoke');
  });

  it('handles a 200-row batch without dropping rows', async () => {
    const header = 'name;Severity;scenario';
    const rows = Array.from({ length: 200 }, (_, i) =>
      `Test ${i};normal;"[step 1] Do thing ${i}"`
    );
    const csv = [header, ...rows].join('\n');

    const { testCases, errors } = await parseAllureCsv(csv);

    expect(errors).toEqual([]);
    expect(testCases).toHaveLength(200);
    expect(testCases[199].name).toBe('Test 199');
  });

  it('errors cleanly when the required name column is missing', async () => {
    const csv = 'Epic;Severity\nBilling;blocker';
    const { testCases, errors } = await parseAllureCsv(csv);
    expect(testCases).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/name/i);
  });
});
