/**
 * Unit tests for LLM Disambiguation Service
 * Tests the LLM-based disambiguation for ambiguous element matching
 */

import {
  clearDisambiguationCache,
  disambiguateWithLLM,
  nodeToDisambiguationCandidate,
  type DisambiguationCandidate,
  type DisambiguationParams,
} from '../llm-disambiguation.service';
import type { InteractiveNode } from '../preview.types';

// Mock the OpenAI service
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));

// Mock logger
jest.mock('@/utils/core/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';

const mockGetChatCompletion = getChatCompletionWithMessages as jest.Mock;

describe('LLMDisambiguationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearDisambiguationCache();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // nodeToDisambiguationCandidate
  // ═══════════════════════════════════════════════════════════════════════════
  describe('nodeToDisambiguationCandidate', () => {
    it('should extract relevant fields from InteractiveNode', () => {
      const node: InteractiveNode = {
        ref: 'e123',
        tag: 'button',
        role: 'button',
        labelText: 'Log out',
        ariaLabel: 'Sign out',
        text: 'Log out',
        placeholder: undefined,
        name: 'logout-btn',
        containerTitles: ['Header', 'User Menu'],
        boundingBox: { x: 100, y: 50, width: 80, height: 32 },
        isVisible: true,
        isDisabled: false,
      };

      const candidate = nodeToDisambiguationCandidate(node);

      expect(candidate.ref).toBe('e123');
      expect(candidate.tag).toBe('button');
      expect(candidate.role).toBe('button');
      expect(candidate.labelText).toBe('Log out');
      expect(candidate.ariaLabel).toBe('Sign out');
      expect(candidate.text).toBe('Log out');
      expect(candidate.name).toBe('logout-btn');
      expect(candidate.containerTitles).toEqual(['Header', 'User Menu']);
      expect(candidate.boundingBox).toEqual({ x: 100, y: 50, width: 80, height: 32 });
    });

    it('should handle minimal node data', () => {
      const node: InteractiveNode = {
        tag: 'div',
      };

      const candidate = nodeToDisambiguationCandidate(node);

      expect(candidate.ref).toBe('');
      expect(candidate.tag).toBe('div');
      expect(candidate.labelText).toBeUndefined();
      expect(candidate.boundingBox).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // disambiguateWithLLM - Skip conditions
  // ═══════════════════════════════════════════════════════════════════════════
  describe('disambiguateWithLLM - Skip conditions', () => {
    const baseParams: DisambiguationParams = {
      userIntent: 'Click logout button',
      actionType: 'click',
      pageUrl: 'https://example.com/dashboard',
      candidates: [],
      totalAllowedCount: 0,
      pageSignature: 'test-signature',
    };

    it('should skip when too many candidates (> 50)', async () => {
      const params: DisambiguationParams = {
        ...baseParams,
        candidates: [{ ref: 'e1', tag: 'button' }],
        totalAllowedCount: 51,
      };

      const result = await disambiguateWithLLM(params);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('too_many_candidates');
      expect(result.selectedRef).toBeNull();
      expect(mockGetChatCompletion).not.toHaveBeenCalled();
    });

    it('should skip when no candidates provided', async () => {
      const params: DisambiguationParams = {
        ...baseParams,
        candidates: [],
        totalAllowedCount: 0,
      };

      const result = await disambiguateWithLLM(params);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('no_candidates');
      expect(result.selectedRef).toBeNull();
      expect(mockGetChatCompletion).not.toHaveBeenCalled();
    });

    it('should auto-select when only one candidate', async () => {
      const params: DisambiguationParams = {
        ...baseParams,
        candidates: [{ ref: 'e1', tag: 'button', labelText: 'Submit' }],
        totalAllowedCount: 1,
      };

      const result = await disambiguateWithLLM(params);

      expect(result.skipped).toBe(false);
      expect(result.selectedRef).toBe('e1');
      expect(result.confidence).toBe(0.9);
      expect(mockGetChatCompletion).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // disambiguateWithLLM - LLM resolution
  // ═══════════════════════════════════════════════════════════════════════════
  describe('disambiguateWithLLM - LLM resolution', () => {
    const candidates: DisambiguationCandidate[] = [
      { ref: 'e1', tag: 'button', labelText: 'Log out', boundingBox: { x: 100, y: 50, width: 80, height: 32 } },
      { ref: 'e2', tag: 'span', text: 'Log out', boundingBox: { x: 200, y: 150, width: 60, height: 20 } },
    ];

    const baseParams: DisambiguationParams = {
      userIntent: 'logout',
      actionType: 'click',
      pageUrl: 'https://example.com/dashboard',
      candidates,
      totalAllowedCount: 2,
      pageSignature: 'test-signature',
    };

    it('should return selected ref when LLM responds with high confidence', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e1',
          confidence: 0.95,
          reason: 'Button is the correct interactive element for logout action',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      const result = await disambiguateWithLLM(baseParams);

      expect(result.selectedRef).toBe('e1');
      expect(result.confidence).toBe(0.95);
      expect(result.reason).toContain('Button is the correct');
      expect(result.skipped).toBe(false);
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
    });

    it('should return null when LLM confidence is below threshold', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e1',
          confidence: 0.5, // Below 0.75 threshold
          reason: 'Both elements look similar',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      const result = await disambiguateWithLLM(baseParams);

      expect(result.selectedRef).toBeNull();
      expect(result.confidence).toBe(0.5);
      expect(result.skipped).toBe(false);
    });

    it('should reject hallucinated refs not in candidate list', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e999', // Not in candidates
          confidence: 0.95,
          reason: 'This element is best',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      const result = await disambiguateWithLLM(baseParams);

      expect(result.selectedRef).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('Failed to parse');
    });

    it('should handle LLM returning null ref', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: null,
          confidence: 0.3,
          reason: 'Cannot confidently determine the correct element',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      const result = await disambiguateWithLLM(baseParams);

      expect(result.selectedRef).toBeNull();
      expect(result.confidence).toBe(0.3);
      expect(result.skipped).toBe(false);
    });

    it('should handle malformed JSON response', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: 'This is not JSON',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      const result = await disambiguateWithLLM(baseParams);

      expect(result.selectedRef).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('Failed to parse');
    });

    it('should handle LLM timeout', async () => {
      // Mock a hanging request (no timers) that triggers our service timeout.
      // IMPORTANT: avoid using setTimeout here to prevent leaking open handles in Jest.
      mockGetChatCompletion.mockImplementation(() => new Promise(() => {}));

      const result = await disambiguateWithLLM(baseParams);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('timeout');
      expect(result.selectedRef).toBeNull();
    }, 10000); // Increase test timeout

    it('should handle LLM error', async () => {
      mockGetChatCompletion.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await disambiguateWithLLM(baseParams);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('error');
      expect(result.selectedRef).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // disambiguateWithLLM - Caching
  // ═══════════════════════════════════════════════════════════════════════════
  describe('disambiguateWithLLM - Caching', () => {
    const candidates: DisambiguationCandidate[] = [
      { ref: 'e1', tag: 'button', labelText: 'Submit' },
      { ref: 'e2', tag: 'button', labelText: 'Cancel' },
    ];

    const baseParams: DisambiguationParams = {
      userIntent: 'Submit the form',
      actionType: 'click',
      pageUrl: 'https://example.com/form',
      candidates,
      totalAllowedCount: 2,
      pageSignature: 'form-page-sig',
    };

    it('should cache result and return cache hit on second call', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e1',
          confidence: 0.9,
          reason: 'Submit button matches intent',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      // First call - should call LLM
      const result1 = await disambiguateWithLLM(baseParams);
      expect(result1.cacheHit).toBe(false);
      expect(result1.selectedRef).toBe('e1');
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);

      // Second call with same params - should hit cache
      const result2 = await disambiguateWithLLM(baseParams);
      expect(result2.cacheHit).toBe(true);
      expect(result2.selectedRef).toBe('e1');
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(1); // No additional call
    });

    it('should not use cache when intent changes', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e1',
          confidence: 0.9,
          reason: 'Submit button matches',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      // First call
      await disambiguateWithLLM(baseParams);
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);

      // Second call with different intent
      await disambiguateWithLLM({
        ...baseParams,
        userIntent: 'Cancel the form',
      });
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(2); // New LLM call
    });

    it('should not use cache when candidates change', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e1',
          confidence: 0.9,
          reason: 'First button matches',
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'gpt-4o-mini' },
      });

      // First call
      await disambiguateWithLLM(baseParams);
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);

      // Second call with different candidates
      await disambiguateWithLLM({
        ...baseParams,
        candidates: [
          { ref: 'e3', tag: 'button', labelText: 'Submit' },
          { ref: 'e4', tag: 'button', labelText: 'Cancel' },
        ],
      });
      expect(mockGetChatCompletion).toHaveBeenCalledTimes(2); // New LLM call
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // disambiguateWithLLM - Regression test for "logout" vs "Log out"
  // ═══════════════════════════════════════════════════════════════════════════
  describe('disambiguateWithLLM - Logout vs Log out regression', () => {
    it('should resolve "logout" to "Log out" button', async () => {
      const candidates: DisambiguationCandidate[] = [
        { ref: 'e1', tag: 'button', labelText: 'Log out', role: 'button', boundingBox: { x: 100, y: 50, width: 80, height: 32 } },
        { ref: 'e2', tag: 'span', text: 'Log out', boundingBox: { x: 200, y: 150, width: 60, height: 20 } },
      ];

      const params: DisambiguationParams = {
        userIntent: 'logout', // User wrote "logout" without space
        actionType: 'click',
        pageUrl: 'https://example.com/dashboard',
        candidates,
        totalAllowedCount: 2,
        pageSignature: 'dashboard-sig',
      };

      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({
          ref: 'e1',
          confidence: 0.92,
          reason: 'Button with "Log out" label is the correct clickable element for logout action',
        }),
        usage: { inputTokens: 150, outputTokens: 60, totalTokens: 210, model: 'gpt-4o-mini' },
      });

      const result = await disambiguateWithLLM(params);

      expect(result.selectedRef).toBe('e1');
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
      expect(result.skipped).toBe(false);
    });
  });
});
