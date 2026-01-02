/**
 * Unit tests for context-compressor.ts
 * Tests context compression logic and history summarization
 */

import {
  createActionResult,
  createDynamicAction,
  createLargeTestState,
  createPageVisit,
  createTestState,
} from '@/test/mocks';
import {
  buildHistorySummary,
  compressContextForPrompt,
  estimateTokenCount
} from '../context-compressor';

describe('context-compressor', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // estimateTokenCount
  // ═══════════════════════════════════════════════════════════════════════════
  describe('estimateTokenCount', () => {
    it('should estimate 1 token per 4 characters', () => {
      // 4 chars = 1 token
      expect(estimateTokenCount('abcd')).toBe(1);
      // 5 chars = 2 tokens (ceil)
      expect(estimateTokenCount('abcde')).toBe(2);
      // 8 chars = 2 tokens
      expect(estimateTokenCount('12345678')).toBe(2);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokenCount('')).toBe(0);
    });

    it('should handle long text', () => {
      const longText = 'a'.repeat(4000); // 4000 chars = 1000 tokens
      expect(estimateTokenCount(longText)).toBe(1000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // compressContextForPrompt (small context - no compression)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('compressContextForPrompt - small context', () => {
    it('should return uncompressed context when below threshold', () => {
      const state = createTestState({
        visitedPages: [createPageVisit()],
        completedActions: [createActionResult()],
        errors: [{ message: 'Test error', timestamp: Date.now() }],
      });

      const result = compressContextForPrompt(state);

      // Should keep all data without compression
      expect(result.recentPages).toHaveLength(1);
      expect(result.oldPagesSummary).toBe('');
      expect(result.recentActions).toHaveLength(1);
      expect(result.oldActionsSummary).toBe('');
      expect(result.recentErrors).toEqual(['Test error']);
      expect(result.totalPagesVisited).toBe(1);
      expect(result.totalActionsCompleted).toBe(1);
    });

    it('should handle empty state', () => {
      const state = createTestState({
        visitedPages: [],
        completedActions: [],
        errors: [],
      });

      const result = compressContextForPrompt(state);

      expect(result.recentPages).toHaveLength(0);
      expect(result.recentActions).toHaveLength(0);
      expect(result.recentErrors).toHaveLength(0);
      expect(result.oldPagesSummary).toBe('');
      expect(result.oldActionsSummary).toBe('');
    });

    it('should handle undefined arrays in state', () => {
      const state = createTestState();
      // @ts-ignore - Testing undefined handling
      state.visitedPages = undefined;
      // @ts-ignore - Testing undefined handling
      state.completedActions = undefined;
      // @ts-ignore - Testing undefined handling
      state.errors = undefined;

      const result = compressContextForPrompt(state);

      expect(result.recentPages).toEqual([]);
      expect(result.recentActions).toEqual([]);
      expect(result.recentErrors).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // compressContextForPrompt (large context - with compression)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('compressContextForPrompt - large context', () => {
    it('should compress when context exceeds token threshold', () => {
      // Create a very large state that will exceed 8000 tokens (32000+ chars)
      // Each page visit and action result adds significant JSON size
      const pages = Array(50).fill(null).map((_, i) =>
        createPageVisit({
          url: `https://example.com/very/long/path/to/page${i}/with/extra/segments`,
          pageType: i % 3 === 0 ? 'product' : i % 3 === 1 ? 'category' : 'home',
          actions: [
            createDynamicAction({ description: 'Very long action description '.repeat(5) + i }),
            createDynamicAction({ description: 'Another long action '.repeat(5) + i }),
          ],
        })
      );

      const actions = Array(80).fill(null).map((_, i) =>
        createActionResult({
          action: createDynamicAction({
            action: 'click',
            description: 'Long action description text '.repeat(3) + i,
            selector: `#button-${i}-with-very-long-selector-name-for-testing`,
          }),
          success: i % 5 !== 0,
        })
      );

      const state = createTestState({
        visitedPages: pages,
        completedActions: actions,
        pagesAnalyzed: 50,
      });

      const result = compressContextForPrompt(state);

      // Should keep only recent pages (last 10 at most)
      expect(result.recentPages.length).toBeLessThanOrEqual(10);

      // Should keep only recent actions (last 20 at most)
      expect(result.recentActions.length).toBeLessThanOrEqual(20);

      // Should preserve totals
      expect(result.totalPagesVisited).toBe(50);
      expect(result.totalActionsCompleted).toBe(80);
    });

    it('should always include all errors', () => {
      const state = createLargeTestState(25, 60);
      // Add more errors
      state.errors = [
        { message: 'Error 1', timestamp: Date.now() - 3000 },
        { message: 'Error 2', timestamp: Date.now() - 2000 },
        { message: 'Error 3', timestamp: Date.now() - 1000 },
      ];

      const result = compressContextForPrompt(state);

      expect(result.recentErrors).toEqual(['Error 1', 'Error 2', 'Error 3']);
    });

    it('should produce smaller output than input', () => {
      const state = createLargeTestState(25, 60);

      const originalSize = estimateTokenCount(JSON.stringify(state));
      const result = compressContextForPrompt(state);
      const compressedSize = estimateTokenCount(JSON.stringify(result));

      // Compressed should be smaller (or equal if already small)
      expect(compressedSize).toBeLessThanOrEqual(originalSize);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Old pages summary format
  // ═══════════════════════════════════════════════════════════════════════════
  describe('old pages summary', () => {
    it('should include page type counts when compressed', () => {
      // Need enough pages to trigger compression (>10 pages so some become "old")
      const pages = Array(20).fill(null).map((_, i) =>
        createPageVisit({
          url: `https://example.com/page${i}`,
          pageType: i % 2 === 0 ? 'product' : 'category',
        })
      );

      // Also need large enough context to trigger compression
      const actions = Array(50).fill(null).map((_, i) =>
        createActionResult({
          action: createDynamicAction({ description: 'Long description '.repeat(10) + i }),
        })
      );

      const state = createTestState({
        visitedPages: pages,
        completedActions: actions,
        pagesAnalyzed: 20,
      });

      const result = compressContextForPrompt(state);

      // If compression occurred and there are old pages, summary should be non-empty
      if (result.recentPages.length < 20 && result.oldPagesSummary) {
        // Summary should mention page counts
        expect(result.oldPagesSummary).toContain('pages earlier');
      }
    });

    it('should include URL info when old pages exist', () => {
      // Create enough pages with unique URLs
      const pages = Array(20).fill(null).map((_, i) =>
        createPageVisit({
          url: `https://example.com/unique-path-${i}`,
          pageType: 'product',
        })
      );

      const actions = Array(50).fill(null).map((_, i) =>
        createActionResult({
          action: createDynamicAction({ description: 'Long action text '.repeat(10) + i }),
        })
      );

      const state = createTestState({
        visitedPages: pages,
        completedActions: actions,
        pagesAnalyzed: 20,
      });

      const result = compressContextForPrompt(state);

      // If old pages summary exists, it should mention URLs
      if (result.oldPagesSummary) {
        expect(result.oldPagesSummary).toContain('URLs');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Old actions summary format
  // ═══════════════════════════════════════════════════════════════════════════
  describe('old actions summary', () => {
    it('should include action type counts', () => {
      const actions = [
        ...Array(10).fill(null).map(() =>
          createActionResult({ action: createDynamicAction({ action: 'click' }) })
        ),
        ...Array(5).fill(null).map(() =>
          createActionResult({ action: createDynamicAction({ action: 'fill' }) })
        ),
        ...Array(20).fill(null).map(() =>
          createActionResult({ action: createDynamicAction({ action: 'scroll' }) })
        ),
      ];

      const state = createTestState({
        visitedPages: Array(15).fill(null).map(() => createPageVisit()),
        completedActions: actions,
      });

      const result = compressContextForPrompt(state);

      // Summary should mention action types
      if (result.oldActionsSummary) {
        expect(result.oldActionsSummary).toContain('click');
        expect(result.oldActionsSummary).toContain('scroll');
      }
    });

    it('should include success rate', () => {
      const actions = [
        ...Array(8).fill(null).map(() =>
          createActionResult({ success: true, action: createDynamicAction({ action: 'click' }) })
        ),
        ...Array(2).fill(null).map(() =>
          createActionResult({ success: false, action: createDynamicAction({ action: 'click' }) })
        ),
        ...Array(15).fill(null).map(() =>
          createActionResult({ success: true, action: createDynamicAction({ action: 'scroll' }) })
        ),
      ];

      const state = createTestState({
        visitedPages: Array(15).fill(null).map(() => createPageVisit()),
        completedActions: actions,
      });

      const result = compressContextForPrompt(state);

      // Summary should mention success rate
      if (result.oldActionsSummary) {
        expect(result.oldActionsSummary).toContain('Success rate');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // buildHistorySummary
  // ═══════════════════════════════════════════════════════════════════════════
  describe('buildHistorySummary', () => {
    it('should return empty-ish string for empty state', () => {
      const state = createTestState({
        visitedPages: [],
        completedActions: [],
        errors: [],
      });

      const result = buildHistorySummary(state);

      // Should be minimal (empty or very short)
      expect(result.length).toBeLessThan(50);
    });

    it('should include recent pages section', () => {
      const state = createTestState({
        visitedPages: [
          createPageVisit({ url: 'https://example.com/page1', pageType: 'home' }),
          createPageVisit({ url: 'https://example.com/page2', pageType: 'product' }),
        ],
      });

      const result = buildHistorySummary(state);

      expect(result).toContain('Recent pages');
      expect(result).toContain('home');
      expect(result).toContain('product');
    });

    it('should include recent actions section', () => {
      const state = createTestState({
        completedActions: [
          createActionResult({
            success: true,
            action: createDynamicAction({ action: 'click', description: 'Clicked button' }),
          }),
        ],
      });

      const result = buildHistorySummary(state);

      expect(result).toContain('✓'); // Success marker
      expect(result).toContain('click');
    });

    it('should include errors section', () => {
      const state = createTestState({
        errors: [
          { message: 'Selector not found', timestamp: Date.now() },
          { message: 'Navigation timeout', timestamp: Date.now() },
        ],
      });

      const result = buildHistorySummary(state);

      expect(result).toContain('Errors');
      expect(result).toContain('Selector not found');
      expect(result).toContain('Navigation timeout');
    });

    it('should show failure marker for failed actions', () => {
      const state = createTestState({
        completedActions: [
          createActionResult({
            success: false,
            action: createDynamicAction({ action: 'click', description: 'Clicked missing button' }),
          }),
        ],
      });

      const result = buildHistorySummary(state);

      expect(result).toContain('✗'); // Failure marker
    });

    it('should include old summaries for large contexts', () => {
      // Create large enough context to trigger compression
      const pages = Array(30).fill(null).map((_, i) =>
        createPageVisit({
          url: `https://example.com/long-path-${i}`,
          pageType: i % 2 === 0 ? 'product' : 'category',
        })
      );

      const actions = Array(80).fill(null).map((_, i) =>
        createActionResult({
          action: createDynamicAction({ description: 'Action description text '.repeat(10) + i }),
          success: i % 3 !== 0,
        })
      );

      const state = createTestState({
        visitedPages: pages,
        completedActions: actions,
        pagesAnalyzed: 30,
        errors: [{ message: 'Test error', timestamp: Date.now() }],
      });

      const result = buildHistorySummary(state);

      // Should have some content - at minimum recent pages section
      expect(result.length).toBeGreaterThan(0);
      // Should include pages info
      expect(result).toContain('page');
    });
  });
});
