/**
 * LLM-driven scenario re-segmentation (the "no hardcode" fallback).
 *
 * When the deterministic CSV split is degenerate — its step/expected labels are
 * in a language our registry doesn't cover, so everything collapses into one
 * step — `convertImportedStepsWithAI` re-segments the RAW scenario semantically
 * via the LLM (no word-list). These tests assert:
 *   - the fallback fires only when `rawScenario` is provided (degenerate case),
 *   - the LLM's re-segmentation drives the final steps,
 *   - a normal (confident) split does NOT pay the extra LLM pass.
 */

const mockGetChatCompletion = jest.fn();
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: unknown[]) => mockGetChatCompletion(...args),
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/config/ai/ai-models.config', () => ({
  AI_MODELS: { classify: 'test-model' },
  AI_TASK_MODELS: { allureStepConvert: 'test-model' },
}));
// Avoid pulling DB-bound services through the mapper's other imports.
jest.mock('@/services/testing/modules/module.service', () => ({ ModuleService: {} }));
jest.mock('@/services/testing/flows/flow.service', () => ({ FlowService: {} }));
jest.mock('@/services/testing/platforms/platform.service', () => ({ PlatformService: {} }));

import { convertImportedStepsWithAI } from '../allure-mapper';

beforeEach(() => mockGetChatCompletion.mockReset());

describe('convertImportedStepsWithAI — raw-scenario re-segmentation fallback', () => {
  it('re-segments the raw scenario via LLM when a degenerate split is passed', async () => {
    // 1st LLM call = re-segmentation; 2nd = the normal step-type conversion.
    mockGetChatCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({
          steps: [
            { description: 'افتح صفحة الدخول' },                 // Arabic: open login page
            { description: 'أدخل البيانات', expected: ['تظهر لوحة التحكم'] },
          ],
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          steps: [
            { type: 'navigate', description: 'افتح صفحة الدخول' },
            { type: 'type', description: 'أدخل البيانات' },
            { type: 'assert', description: 'تظهر لوحة التحكم' },
          ],
        }),
      });

    // Degenerate deterministic input: one giant step (labels weren't recognised).
    const degenerate = [{ type: 'click', description: 'افتح صفحة الدخول أدخل البيانات تظهر لوحة التحكم' }];
    const rawScenario = 'افتح صفحة الدخول\nأدخل البيانات\nالنتيجة المتوقعة\nتظهر لوحة التحكم';

    const { steps } = await convertImportedStepsWithAI('اختبار', degenerate, 'web', rawScenario);

    // Two LLM calls: re-segment + convert.
    expect(mockGetChatCompletion).toHaveBeenCalledTimes(2);
    // Final steps came from the re-segmented structure (3 = 2 actions + 1 assert).
    expect(steps.length).toBe(3);
    expect(steps.map((s) => s.type)).toEqual(['navigate', 'type', 'assert']);
  });

  it('does NOT re-segment when no rawScenario is provided (confident split)', async () => {
    mockGetChatCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
        steps: [
          { type: 'navigate', description: 'Open login' },
          { type: 'click', description: 'Submit' },
        ],
      }),
    });

    const { steps } = await convertImportedStepsWithAI(
      'Login',
      [
        { type: 'click', description: 'Open login' },
        { type: 'click', description: 'Submit' },
      ],
      'web',
      // no rawScenario
    );

    // Only ONE LLM call — the conversion. No wasted re-segmentation pass.
    expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
    expect(steps.length).toBe(2);
  });

  it('falls back to the deterministic split when re-segmentation returns nothing', async () => {
    // Re-segmentation yields empty → converter uses the passed-in steps.
    mockGetChatCompletion
      .mockResolvedValueOnce({ content: JSON.stringify({ steps: [] }) })
      .mockResolvedValueOnce({
        content: JSON.stringify({ steps: [{ type: 'click', description: 'Do the thing' }] }),
      });

    const { steps } = await convertImportedStepsWithAI(
      'T',
      [{ type: 'click', description: 'Do the thing' }],
      'web',
      'line1\nline2\nline3',
    );

    expect(steps.length).toBe(1);
    expect(steps[0].description).toBe('Do the thing');
  });
});
