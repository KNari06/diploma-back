/**
 * PDF parity for expected results (Root A follow-up).
 *
 * The PDF path is LLM-driven. The prompt now asks for a per-step `expected[]`
 * field, and the sanitizer in parseChunkWithLLM normalizes it to a clean
 * string[] (the model may return a string, mixed types, or omit it). This keeps
 * the PDF path in parity with CSV/ZIP so expected results aren't dropped.
 *
 * pdf-parse and the OpenAI client are mocked so we drive the parser
 * deterministically from text + a controlled LLM response.
 */

const mockGetChatCompletion = jest.fn();
const mockGetText = jest.fn();

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: unknown[]) => mockGetChatCompletion(...args),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/config/ai/ai-models.config', () => ({
  // AI_MODELS must be present even though this test never uses it: replacing
  // the whole module means anything in the import graph that reads it AT LOAD
  // TIME gets undefined. `intelligent-test-limits.ts` does exactly that
  // (`coreBrainModel: AI_MODELS.smart`), and it is reachable from the parser
  // via allure-mapper → module.service → … → snapshot-collector.
  AI_MODELS: { smart: 'test-model', fast: 'test-model' },
  AI_TASK_MODELS: { allureCsvPdfParse: 'test-model' },
}));

// Mock pdf-parse: PDFParse(...).getText() → controlled text.
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({ getText: () => mockGetText() })),
}));

import { parseAllurePdf } from '../allure-pdf-parser';

beforeEach(() => {
  mockGetChatCompletion.mockReset();
  mockGetText.mockReset();
  mockGetText.mockResolvedValue({ text: '#1001 Some Test [Active]\nSteps:\n1. Do thing\n   Expected result: it works' });
});

function llmReturns(testCases: unknown[]): void {
  mockGetChatCompletion.mockResolvedValue({ content: JSON.stringify({ testCases }) });
}

describe('parseAllurePdf — per-step expected results', () => {
  it('preserves expected[] returned by the model', async () => {
    llmReturns([
      {
        name: 'Some Test',
        steps: [
          { type: 'click', description: 'Do thing', expected: ['it works', 'no error shown'] },
        ],
      },
    ]);

    const { testCases } = await parseAllurePdf(Buffer.from('pdf'));

    expect(testCases).toHaveLength(1);
    expect(testCases[0].steps[0].expected).toEqual(['it works', 'no error shown']);
  });

  it('coerces a single-string expected into a one-element array', async () => {
    llmReturns([
      { name: 'T', steps: [{ type: 'click', description: 'Step', expected: 'only one' }] },
    ]);

    const { testCases } = await parseAllurePdf(Buffer.from('pdf'));

    expect(testCases[0].steps[0].expected).toEqual(['only one']);
  });

  it('drops empty/blank expected so downstream sees undefined', async () => {
    llmReturns([
      { name: 'T', steps: [{ type: 'click', description: 'Step', expected: ['', '   '] }] },
    ]);

    const { testCases } = await parseAllurePdf(Buffer.from('pdf'));

    expect(testCases[0].steps[0].expected).toBeUndefined();
  });

  it('handles steps with no expected field at all', async () => {
    llmReturns([
      { name: 'T', steps: [{ type: 'click', description: 'Step' }] },
    ]);

    const { testCases } = await parseAllurePdf(Buffer.from('pdf'));

    expect(testCases[0].steps[0].expected).toBeUndefined();
  });

  it('returns a scanned-PDF error when no text is extracted', async () => {
    mockGetText.mockResolvedValue({ text: '' });

    const { testCases, errors } = await parseAllurePdf(Buffer.from('pdf'));

    expect(testCases).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/scanned|no text/i);
  });

  it('does NOT strip a real step line shaped like "N of M" as page noise', async () => {
    // Regression: the page-footer cleaner must keep action lines such as
    // "Repeat step 3 of 5" / "Do 5 of 8" (they read like a counter but are
    // real steps). We capture the text actually sent to the LLM and assert
    // those lines survive the pre-clean, while a true footer is removed.
    mockGetText.mockResolvedValue({
      text: [
        '#1002 Retry flow [Active]',
        'Steps:',
        'Repeat step 3 of 5',
        'Do 5 of 8',
        'Test Cases\t12 of 250',   // genuine footer → stripped
        '12 of 250',                 // bare counter → stripped
      ].join('\n'),
    });
    llmReturns([{ name: 'Retry flow', steps: [{ type: 'click', description: 'Repeat step 3 of 5' }] }]);

    await parseAllurePdf(Buffer.from('pdf'));

    const sentToLlm: string = mockGetChatCompletion.mock.calls[0][0]
      .map((m: { content: string }) => m.content).join('\n');
    expect(sentToLlm).toContain('Repeat step 3 of 5');   // real step kept
    expect(sentToLlm).toContain('Do 5 of 8');            // real step kept
    expect(sentToLlm).not.toContain('12 of 250');        // footer stripped
  });
});
