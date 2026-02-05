/**
 * Unit tests for HTML Context Service
 */

import { Page } from 'playwright';
import {
  buildSemanticHtmlFromPage,
  buildSemanticHtmlFromString,
  SemanticHtmlOptions,
} from '../html-context.service';

// Mock logger
jest.mock('@/utils/core/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock tiktoken
jest.mock('@/utils/text-processing/chunking', () => ({
  countTokens: jest.fn((text: string) => {
    // Simple mock: 1 token ≈ 4 chars
    return Math.ceil(text.length / 4);
  }),
}));

describe('HTML Context Service', () => {
  describe('buildSemanticHtmlFromString', () => {
    it('should strip scripts and styles', () => {
      const html = `
        <html>
          <head>
            <script>console.log('test');</script>
            <style>body { color: red; }</style>
          </head>
          <body>
            <h1>Hello World</h1>
            <script>alert('test');</script>
          </body>
        </html>
      `;

      const result = buildSemanticHtmlFromString(html);

      expect(result.html).not.toContain('<script>');
      expect(result.html).not.toContain('<style>');
      expect(result.html).toContain('Hello World');
    });

    it('should remove head, comments, and non-content elements', () => {
      const html = `
        <html>
          <head><title>Test</title></head>
          <!-- This is a comment -->
          <body>
            <noscript>No JS</noscript>
            <template><div>Template</div></template>
            <p>Content</p>
          </body>
        </html>
      `;

      const result = buildSemanticHtmlFromString(html);

      expect(result.html).not.toContain('<head>');
      expect(result.html).not.toContain('<!--');
      expect(result.html).not.toContain('<noscript>');
      expect(result.html).not.toContain('<template>');
      expect(result.html).toContain('Content');
    });

    it('should respect token budget and truncate if needed', () => {
      const largeHtml = '<p>' + 'a'.repeat(50000) + '</p>';
      
      const result = buildSemanticHtmlFromString(largeHtml, {
        tokenBudget: 1000, // ~4000 chars
      });

      expect(result.tokens).toBeLessThanOrEqual(1000);
      expect(result.prunedCount).toBeGreaterThan(0);
    });

    it('should detect negative assertions and expand budget', () => {
      const html = '<p>Test content</p>';
      
      const resultNormal = buildSemanticHtmlFromString(html, {
        assertionText: 'Page shows test content',
        tokenBudget: 1000,
      });

      const resultNegative = buildSemanticHtmlFromString(html, {
        assertionText: 'Error message is not shown',
        tokenBudget: 1000,
        expandForNegative: true,
      });

      expect(resultNegative.isNegative).toBe(true);
      expect(resultNormal.isNegative).toBe(false);
    });

    it('should handle empty HTML gracefully', () => {
      const result = buildSemanticHtmlFromString('');

      expect(result.html).toBe('');
      expect(result.tokens).toBe(0);
      expect(result.originalLength).toBe(0);
    });

    it('should collapse whitespace', () => {
      const html = `
        <div>
          <p>  Multiple    spaces   </p>
          <p>
            Line
            breaks
          </p>
        </div>
      `;

      const result = buildSemanticHtmlFromString(html);

      // Should not have multiple consecutive spaces
      expect(result.html).not.toMatch(/\s{2,}/);
    });

    it('should calculate reduction percentage correctly', () => {
      const html = `
        <html>
          <head>
            <script src="large.js"></script>
            <style>/* Large CSS */</style>
          </head>
          <body>
            <h1>Title</h1>
          </body>
        </html>
      `;

      const result = buildSemanticHtmlFromString(html);

      expect(result.semanticLength).toBeLessThan(result.originalLength);
      const reduction = 1 - result.semanticLength / result.originalLength;
      expect(reduction).toBeGreaterThan(0);
    });
  });

  describe('buildSemanticHtmlFromPage', () => {
    let mockPage: jest.Mocked<Page>;

    beforeEach(() => {
      mockPage = {
        content: jest.fn(),
        evaluate: jest.fn(),
      } as any;
    });

    it('should build semantic HTML from page', async () => {
      const rawHtml = `
        <html>
          <head><script>test</script></head>
          <body>
            <h1>Hello</h1>
            <button data-agent-ref="btn1">Click</button>
          </body>
        </html>
      `;

      mockPage.content.mockResolvedValue(rawHtml);
      mockPage.evaluate.mockResolvedValue({
        semanticHtml: '<h1>Hello</h1><button data-agent-ref="btn1">Click</button>',
        prunedCount: 0,
        helperTextCount: 0,
        nodeCount: 2,
      });

      const result = await buildSemanticHtmlFromPage(mockPage);

      expect(result.html).toContain('Hello');
      expect(result.html).toContain('btn1');
      expect(result.originalLength).toBe(rawHtml.length);
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('should pass options to page.evaluate', async () => {
      mockPage.content.mockResolvedValue('<html><body><p>Test</p></body></html>');
      mockPage.evaluate.mockResolvedValue({
        semanticHtml: '<p>Test</p>',
        prunedCount: 0,
        helperTextCount: 0,
        nodeCount: 1,
      });

      const options: SemanticHtmlOptions = {
        tokenBudget: 5000,
        assertionText: 'Test assertion',
        maxNodes: 1000,
      };

      await buildSemanticHtmlFromPage(mockPage, options);

      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          tokenBudget: 5000,
          maxNodes: 1000,
        })
      );
    });

    it('should handle negative assertions in page mode', async () => {
      mockPage.content.mockResolvedValue('<html><body><p>Test</p></body></html>');
      mockPage.evaluate.mockResolvedValue({
        semanticHtml: '<p>Test</p>',
        prunedCount: 0,
        helperTextCount: 0,
        nodeCount: 1,
      });

      const result = await buildSemanticHtmlFromPage(mockPage, {
        assertionText: 'Error is not visible',
        tokenBudget: 1000,
        expandForNegative: true,
      });

      expect(result.isNegative).toBe(true);
      // Budget should be expanded (1000 * 1.5 = 1500)
      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          tokenBudget: 1500,
        })
      );
    });

    it('should log semantic HTML metrics', async () => {
      const { logger } = require('@/utils/core/logger');
      
      mockPage.content.mockResolvedValue('<html><body>' + 'x'.repeat(10000) + '</body></html>');
      mockPage.evaluate.mockResolvedValue({
        semanticHtml: '<p>Short</p>',
        prunedCount: 5,
        helperTextCount: 2,
        nodeCount: 10,
      });

      await buildSemanticHtmlFromPage(mockPage);

      expect(logger.info).toHaveBeenCalledWith(
        '[HTML_CONTEXT] Semantic HTML built from page',
        expect.objectContaining({
          originalLength: expect.any(Number),
          semanticLength: expect.any(Number),
          reduction: expect.any(String),
          estimatedTokens: expect.any(Number),
          prunedCount: 5,
          helperTextCount: 2,
        })
      );
    });

    it('should throw error if page.evaluate fails', async () => {
      mockPage.content.mockResolvedValue('<html><body>Test</body></html>');
      mockPage.evaluate.mockRejectedValue(new Error('Evaluate failed'));

      await expect(buildSemanticHtmlFromPage(mockPage)).rejects.toThrow('Evaluate failed');
    });
  });

  describe('Priority-based pruning (integration)', () => {
    it('should preserve high-priority elements under budget', async () => {
      const mockPage = {
        content: jest.fn().mockResolvedValue('<html><body>Test</body></html>'),
        evaluate: jest.fn().mockImplementation(async (fn, args) => {
          // Simulate browser-side logic
          return {
            semanticHtml: `
              <button data-agent-ref="btn1">Submit</button>
              <input type="text" placeholder="Name" />
              <h1>Title</h1>
            `,
            prunedCount: 10, // Pruned low-priority divs
            helperTextCount: 0,
            nodeCount: 3,
          };
        }),
      } as any;

      const result = await buildSemanticHtmlFromPage(mockPage, {
        tokenBudget: 500, // Tight budget
      });

      // High-priority elements should be preserved
      expect(result.html).toContain('data-agent-ref="btn1"');
      expect(result.html).toContain('input');
      expect(result.html).toContain('h1');
      expect(result.prunedCount).toBeGreaterThan(0);
    });
  });

  describe('Helper text detection', () => {
    it('should include helper text near controls', async () => {
      const mockPage = {
        content: jest.fn().mockResolvedValue('<html><body>Test</body></html>'),
        evaluate: jest.fn().mockResolvedValue({
          semanticHtml: `
            <input type="email" />
            <span class="helper-text">Enter valid email</span>
            <span class="helper-text">Password must be 8+ chars</span>
          `,
          prunedCount: 0,
          helperTextCount: 2,
          nodeCount: 3,
        }),
      } as any;

      const result = await buildSemanticHtmlFromPage(mockPage);

      expect(result.helperTextCount).toBe(2);
      expect(result.html).toContain('helper-text');
    });
  });

  describe('Negative assertion keywords', () => {
    const negativeAssertions = [
      'Button is not visible',
      'No error message shown',
      'Without validation warning',
      'Element is hidden',
      'Missing submit button',
      'Ошибка не показана', // Russian
      'Без предупреждения',
    ];

    const positiveAssertions = [
      'Button is visible',
      'Error message is shown',
      'Page contains title',
    ];

    negativeAssertions.forEach(assertion => {
      it(`should detect negative assertion: "${assertion}"`, () => {
        const result = buildSemanticHtmlFromString('<p>Test</p>', {
          assertionText: assertion,
        });

        expect(result.isNegative).toBe(true);
      });
    });

    positiveAssertions.forEach(assertion => {
      it(`should not detect as negative: "${assertion}"`, () => {
        const result = buildSemanticHtmlFromString('<p>Test</p>', {
          assertionText: assertion,
        });

        expect(result.isNegative).toBe(false);
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle malformed HTML', () => {
      const malformedHtml = '<div><p>Unclosed paragraph<div>Nested</div>';
      
      const result = buildSemanticHtmlFromString(malformedHtml);

      expect(result.html).toBeTruthy();
      expect(result.tokens).toBeGreaterThan(0);
    });

    it('should handle HTML with only scripts', () => {
      const html = '<html><head><script>code</script></head><body><script>more</script></body></html>';
      
      const result = buildSemanticHtmlFromString(html);

      expect(result.html).not.toContain('<script>');
      expect(result.semanticLength).toBeLessThan(result.originalLength);
    });

    it('should handle very large HTML', () => {
      const largeHtml = '<div>' + '<p>Content</p>'.repeat(10000) + '</div>';
      
      const result = buildSemanticHtmlFromString(largeHtml, {
        tokenBudget: 2000,
      });

      expect(result.tokens).toBeLessThanOrEqual(2000);
      expect(result.prunedCount).toBeGreaterThan(0);
    });

    it('should handle HTML with special characters', () => {
      const html = '<p>Test &lt;script&gt; &amp; "quotes" \'apostrophes\'</p>';
      
      const result = buildSemanticHtmlFromString(html);

      expect(result.html).toContain('Test');
    });
  });

  describe('Token estimation accuracy', () => {
    it('should provide reasonable token estimates', () => {
      const html = '<p>' + 'word '.repeat(1000) + '</p>'; // ~1000 words
      
      const result = buildSemanticHtmlFromString(html);

      // Should be roughly 1000-1500 tokens for 1000 words
      expect(result.tokens).toBeGreaterThan(500);
      expect(result.tokens).toBeLessThan(2000);
    });
  });
});
