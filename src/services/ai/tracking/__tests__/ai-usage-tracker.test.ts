/**
 * Tests for AIUsageTracker's cost-calculation helpers.
 *
 * calculateGeminiCost used to hardcode its own stale Gemini 1.5 pricing
 * instead of reusing AI_PRICING, silently undercounting real spend by 4-8x
 * for every gemini-2.5-flash/flash-lite/pro call. These tests pin both cost
 * functions against AI_PRICING so the pricing table and the cost math can't
 * drift apart again.
 */

import { calculateGeminiCost, calculateOpenAICost } from '../ai-usage-tracker';
import { AI_PRICING } from '../../cost/ai-cost-manager.service';
import { logger } from '@/utils/core/logger';

describe('calculateGeminiCost', () => {
  it('prices gemini-2.5-flash-lite at its AI_PRICING rate', () => {
    const cost = calculateGeminiCost('gemini-2.5-flash-lite', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(
      AI_PRICING['gemini-2.5-flash-lite'].input * 1_000_000 +
        AI_PRICING['gemini-2.5-flash-lite'].output * 1_000_000
    );
    expect(cost).toBeCloseTo(0.1 + 0.4);
  });

  it('prices gemini-2.5-flash at its own rate, not the flash-lite rate', () => {
    const cost = calculateGeminiCost('gemini-2.5-flash', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.3 + 2.5);
  });

  it('prices gemini-2.5-pro at its own rate', () => {
    const cost = calculateGeminiCost('gemini-2.5-pro', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.25 + 10.0);
  });

  it('falls back to the cheapest Gemini tier for an unrecognized model string', () => {
    const cost = calculateGeminiCost('gemini-some-future-variant', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.1 + 0.4);
  });

  it('warns when falling back, so a config/env drift from AI_PRICING is observable', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(undefined as never);
    calculateGeminiCost('gemini-2.5-pro-002', 1_000_000, 1_000_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unrecognized Gemini model'),
      expect.objectContaining({ model: 'gemini-2.5-pro-002' })
    );
    warnSpy.mockRestore();
  });

  it('does not warn for a recognized model', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(undefined as never);
    calculateGeminiCost('gemini-2.5-flash', 1_000_000, 1_000_000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('calculateOpenAICost', () => {
  it('prices gpt-4.1-mini at its AI_PRICING rate', () => {
    const cost = calculateOpenAICost('gpt-4.1-mini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.2 + 0.8);
  });

  it('falls back to gpt-4.1-mini for an unrecognized model string', () => {
    const cost = calculateOpenAICost('some-unreleased-model', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.2 + 0.8);
  });
});
