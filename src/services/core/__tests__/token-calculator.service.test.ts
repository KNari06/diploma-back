/**
 * Unit tests for TokenCalculatorService
 * Tests token/credit conversions, cost calculations, and edge cases
 */

import {
  TokenCalculatorService,
  TOKENS_PER_CREDIT,
  MODEL_PRICING,
  TEST_CREDITS,
} from '../token-calculator.service';

describe('TokenCalculatorService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // tokensToCredits
  // ═══════════════════════════════════════════════════════════════════════════
  describe('tokensToCredits', () => {
    it('should return 0 for 0 tokens', () => {
      expect(TokenCalculatorService.tokensToCredits(0)).toBe(0);
    });

    it('should return 0 for negative tokens', () => {
      expect(TokenCalculatorService.tokensToCredits(-100)).toBe(0);
      expect(TokenCalculatorService.tokensToCredits(-1)).toBe(0);
    });

    it('should return 0 for NaN', () => {
      expect(TokenCalculatorService.tokensToCredits(NaN)).toBe(0);
    });

    it('should return 0 for Infinity', () => {
      expect(TokenCalculatorService.tokensToCredits(Infinity)).toBe(0);
      expect(TokenCalculatorService.tokensToCredits(-Infinity)).toBe(0);
    });

    it('should round up to nearest credit', () => {
      // 1 token should be 1 credit (ceil)
      expect(TokenCalculatorService.tokensToCredits(1)).toBe(1);
      // 562.5 tokens = 1 credit exactly
      expect(TokenCalculatorService.tokensToCredits(TOKENS_PER_CREDIT)).toBe(1);
      // 563 tokens should be 2 credits (ceil)
      expect(TokenCalculatorService.tokensToCredits(TOKENS_PER_CREDIT + 1)).toBe(2);
    });

    it('should handle large token counts', () => {
      const largeTokens = 1000000; // 1M tokens
      const expectedCredits = Math.ceil(largeTokens / TOKENS_PER_CREDIT);
      expect(TokenCalculatorService.tokensToCredits(largeTokens)).toBe(expectedCredits);
    });

    it('should convert typical AI call tokens correctly', () => {
      // Typical GPT-4o call: 500 input + 200 output = 700 tokens
      const tokens = 700;
      const credits = TokenCalculatorService.tokensToCredits(tokens);
      expect(credits).toBe(Math.ceil(700 / TOKENS_PER_CREDIT)); // Should be 2
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // creditsToTokens
  // ═══════════════════════════════════════════════════════════════════════════
  describe('creditsToTokens', () => {
    it('should return 0 for 0 credits', () => {
      expect(TokenCalculatorService.creditsToTokens(0)).toBe(0);
    });

    it('should return 0 for negative credits', () => {
      expect(TokenCalculatorService.creditsToTokens(-5)).toBe(0);
    });

    it('should return 0 for NaN', () => {
      expect(TokenCalculatorService.creditsToTokens(NaN)).toBe(0);
    });

    it('should return 0 for Infinity', () => {
      expect(TokenCalculatorService.creditsToTokens(Infinity)).toBe(0);
    });

    it('should convert credits to tokens correctly', () => {
      expect(TokenCalculatorService.creditsToTokens(1)).toBe(TOKENS_PER_CREDIT);
      expect(TokenCalculatorService.creditsToTokens(10)).toBe(10 * TOKENS_PER_CREDIT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // calculateCostFromTokens
  // ═══════════════════════════════════════════════════════════════════════════
  describe('calculateCostFromTokens', () => {
    it('should return 0 for 0 tokens', () => {
      expect(TokenCalculatorService.calculateCostFromTokens(0, 0, 'gpt-5.4-mini')).toBe(0);
    });

    it('should handle negative input tokens by treating as 0', () => {
      const cost = TokenCalculatorService.calculateCostFromTokens(-100, 100, 'gpt-5.4-mini');
      // Only output tokens should be counted
      expect(cost).toBe((100 / 1000) * MODEL_PRICING['gpt-5.4-mini'].output);
    });

    it('should handle negative output tokens by treating as 0', () => {
      const cost = TokenCalculatorService.calculateCostFromTokens(100, -100, 'gpt-5.4-mini');
      // Only input tokens should be counted
      expect(cost).toBe((100 / 1000) * MODEL_PRICING['gpt-5.4-mini'].input);
    });

    it('should handle NaN tokens', () => {
      expect(TokenCalculatorService.calculateCostFromTokens(NaN, 100, 'gpt-5.4-mini')).toBe(
        (100 / 1000) * MODEL_PRICING['gpt-5.4-mini'].output
      );
    });

    it('should fallback to gpt-4.1-mini for unknown model', () => {
      const cost = TokenCalculatorService.calculateCostFromTokens(1000, 500, 'unknown-model' as any);
      const expectedCost =
        (1000 / 1000) * MODEL_PRICING['gpt-4.1-mini'].input +
        (500 / 1000) * MODEL_PRICING['gpt-4.1-mini'].output;
      expect(cost).toBe(expectedCost);
    });

    it('should calculate gpt-5.4-mini cost correctly', () => {
      const inputTokens = 1000;
      const outputTokens = 500;
      const expectedCost =
        (inputTokens / 1000) * MODEL_PRICING['gpt-5.4-mini'].input +
        (outputTokens / 1000) * MODEL_PRICING['gpt-5.4-mini'].output;
      expect(TokenCalculatorService.calculateCostFromTokens(inputTokens, outputTokens, 'gpt-5.4-mini')).toBe(
        expectedCost
      );
    });

    it('should calculate gpt-4.1-mini cost correctly', () => {
      const inputTokens = 1000;
      const outputTokens = 500;
      const expectedCost =
        (inputTokens / 1000) * MODEL_PRICING['gpt-4.1-mini'].input +
        (outputTokens / 1000) * MODEL_PRICING['gpt-4.1-mini'].output;
      expect(
        TokenCalculatorService.calculateCostFromTokens(inputTokens, outputTokens, 'gpt-4.1-mini')
      ).toBe(expectedCost);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // calculateCreditsFromCost
  // ═══════════════════════════════════════════════════════════════════════════
  describe('calculateCreditsFromCost', () => {
    it('should return 0 for 0 cost', () => {
      expect(TokenCalculatorService.calculateCreditsFromCost(0)).toBe(0);
    });

    it('should return 0 for negative cost', () => {
      expect(TokenCalculatorService.calculateCreditsFromCost(-1)).toBe(0);
    });

    it('should return 0 for NaN', () => {
      expect(TokenCalculatorService.calculateCreditsFromCost(NaN)).toBe(0);
    });

    it('should convert cost to credits', () => {
      const costUSD = 0.01; // 1 cent
      const credits = TokenCalculatorService.calculateCreditsFromCost(costUSD);
      expect(credits).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getTestCreditCost
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getTestCreditCost', () => {
    it('should return correct cost for intelligent test', () => {
      expect(TokenCalculatorService.getTestCreditCost('intelligent')).toBe(TEST_CREDITS.INTELLIGENT);
    });

    it('should return correct cost for standard test', () => {
      expect(TokenCalculatorService.getTestCreditCost('standard')).toBe(TEST_CREDITS.STANDARD);
    });

    it('should return correct cost for api test', () => {
      expect(TokenCalculatorService.getTestCreditCost('api')).toBe(TEST_CREDITS.API);
    });

    it('should return correct cost for chat', () => {
      expect(TokenCalculatorService.getTestCreditCost('chat')).toBe(TEST_CREDITS.CHAT);
    });

    it('should return 0 for unknown test type', () => {
      // @ts-expect-error - Testing invalid test type
      expect(TokenCalculatorService.getTestCreditCost('unknown')).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // estimateIntelligentTestCredits
  // ═══════════════════════════════════════════════════════════════════════════
  describe('estimateIntelligentTestCredits', () => {
    it('should use default 5 pages if not provided', () => {
      const credits = TokenCalculatorService.estimateIntelligentTestCredits();
      expect(credits).toBeGreaterThanOrEqual(TEST_CREDITS.INTELLIGENT);
    });

    it('should clamp to default for 0 pages', () => {
      const credits = TokenCalculatorService.estimateIntelligentTestCredits(0);
      expect(credits).toBeGreaterThanOrEqual(TEST_CREDITS.INTELLIGENT);
    });

    it('should clamp to default for negative pages', () => {
      const credits = TokenCalculatorService.estimateIntelligentTestCredits(-5);
      expect(credits).toBeGreaterThanOrEqual(TEST_CREDITS.INTELLIGENT);
    });

    it('should clamp to default for NaN', () => {
      const credits = TokenCalculatorService.estimateIntelligentTestCredits(NaN);
      expect(credits).toBeGreaterThanOrEqual(TEST_CREDITS.INTELLIGENT);
    });

    it('should return at least INTELLIGENT credits', () => {
      // Even for 1 page, should return at least the fixed cost
      const credits = TokenCalculatorService.estimateIntelligentTestCredits(1);
      expect(credits).toBeGreaterThanOrEqual(TEST_CREDITS.INTELLIGENT);
    });

    it('should scale with more pages', () => {
      const credits10 = TokenCalculatorService.estimateIntelligentTestCredits(10);
      const credits20 = TokenCalculatorService.estimateIntelligentTestCredits(20);
      expect(credits20).toBeGreaterThan(credits10);
    });

    it('should floor fractional pages', () => {
      const creditsFloat = TokenCalculatorService.estimateIntelligentTestCredits(5.7);
      const creditsInt = TokenCalculatorService.estimateIntelligentTestCredits(5);
      expect(creditsFloat).toBe(creditsInt);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // formatCredits
  // ═══════════════════════════════════════════════════════════════════════════
  describe('formatCredits', () => {
    it('should return "0" for NaN', () => {
      expect(TokenCalculatorService.formatCredits(NaN)).toBe('0');
    });

    it('should return "0" for Infinity', () => {
      expect(TokenCalculatorService.formatCredits(Infinity)).toBe('0');
    });

    it('should format small numbers without commas', () => {
      expect(TokenCalculatorService.formatCredits(100)).toBe('100');
    });

    it('should format large numbers with commas', () => {
      expect(TokenCalculatorService.formatCredits(1000)).toBe('1,000');
      expect(TokenCalculatorService.formatCredits(1000000)).toBe('1,000,000');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // calculateTestCapacity
  // ═══════════════════════════════════════════════════════════════════════════
  describe('calculateTestCapacity', () => {
    it('should return 0 for all types with 0 credits', () => {
      const capacity = TokenCalculatorService.calculateTestCapacity(0);
      expect(capacity.intelligent).toBe(0);
      expect(capacity.standard).toBe(0);
      expect(capacity.api).toBe(0);
    });

    it('should return 0 for all types with negative credits', () => {
      const capacity = TokenCalculatorService.calculateTestCapacity(-100);
      expect(capacity.intelligent).toBe(0);
      expect(capacity.standard).toBe(0);
      expect(capacity.api).toBe(0);
    });

    it('should return 0 for all types with NaN', () => {
      const capacity = TokenCalculatorService.calculateTestCapacity(NaN);
      expect(capacity.intelligent).toBe(0);
      expect(capacity.standard).toBe(0);
      expect(capacity.api).toBe(0);
    });

    it('should calculate correct capacity', () => {
      const credits = 100;
      const capacity = TokenCalculatorService.calculateTestCapacity(credits);
      expect(capacity.intelligent).toBe(Math.floor(credits / TEST_CREDITS.INTELLIGENT));
      expect(capacity.standard).toBe(Math.floor(credits / TEST_CREDITS.STANDARD));
      expect(capacity.api).toBe(Math.floor(credits / TEST_CREDITS.API));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // hasEnoughCredits
  // ═══════════════════════════════════════════════════════════════════════════
  describe('hasEnoughCredits', () => {
    it('should return false for 0 credits', () => {
      expect(TokenCalculatorService.hasEnoughCredits(0, 'intelligent')).toBe(false);
    });

    it('should return false for negative credits', () => {
      expect(TokenCalculatorService.hasEnoughCredits(-10, 'intelligent')).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(TokenCalculatorService.hasEnoughCredits(NaN, 'intelligent')).toBe(false);
    });

    it('should return true when exactly enough credits', () => {
      expect(TokenCalculatorService.hasEnoughCredits(TEST_CREDITS.INTELLIGENT, 'intelligent')).toBe(
        true
      );
      expect(TokenCalculatorService.hasEnoughCredits(TEST_CREDITS.STANDARD, 'standard')).toBe(true);
      expect(TokenCalculatorService.hasEnoughCredits(TEST_CREDITS.API, 'api')).toBe(true);
      expect(TokenCalculatorService.hasEnoughCredits(TEST_CREDITS.CHAT, 'chat')).toBe(true);
    });

    it('should return true when more than enough credits', () => {
      expect(TokenCalculatorService.hasEnoughCredits(1000, 'intelligent')).toBe(true);
    });

    it('should return false when not enough credits', () => {
      expect(TokenCalculatorService.hasEnoughCredits(TEST_CREDITS.INTELLIGENT - 1, 'intelligent')).toBe(
        false
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // logTokenUsage (just verify it doesn't throw)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('logTokenUsage', () => {
    it('should not throw when called', () => {
      expect(() => {
        TokenCalculatorService.logTokenUsage(
          'Test context',
          { input: 100, output: 50, model: 'gpt-4o' },
          5
        );
      }).not.toThrow();
    });
  });
});
