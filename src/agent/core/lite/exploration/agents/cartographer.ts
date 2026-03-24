/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CARTOGRAPHER AGENT — Page Understanding & Entry Point Discovery
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Replaces: classifyPage() in survey-agent.ts
 * Called: once per page during Phase 1 BFS survey
 *
 * Responsibilities:
 *   - Classify page type (AI decides, no fixed enum)
 *   - Discover ALL testable entry points (no caps)
 *   - Detect auth walls and login forms
 *   - Produce deep page insight for other agents
 *
 * Reuses from LiteEngine:
 *   - ObserverCache (LRU cache for repeated pages)
 *   - getChatCompletionWithMessages (AI call wrapper)
 *   - FormAnalysis type
 */

import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';

import type { LiteSnapshot } from '../../lite-types';
import { RateLimiter } from '../rate-limiter';
import type { ExplorationTraceService } from '../exploration-trace.service';
import type { CartographerInput, CartographerOutput } from './agent-types';
import {
  CARTOGRAPHER_SYSTEM_PROMPT,
  buildCartographerPrompt,
  parseCartographerResponse,
} from './cartographer-prompts';

/** Timeout for Cartographer AI call */
const CARTOGRAPHER_TIMEOUT_MS = 25_000;

export class Cartographer {
  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly trace?: ExplorationTraceService,
  ) {}

  /**
   * Analyze a page and discover entry points, navigation links, and auth info.
   *
   * @param input - Full page data with exploration context
   * @param formattedSnapshot - Pre-formatted snapshot string (from SurveyAgent)
   * @returns CartographerOutput with entry points, nav links, auth detection, and page insight
   */
  async analyze(
    input: CartographerInput,
    formattedSnapshot: string,
  ): Promise<CartographerOutput> {
    const { url } = input;
    const pageId = `page-${Date.now()}`;

    // If AI is degraded, return empty result (SurveyAgent will use fallback)
    if (this.rateLimiter.isDegraded('openai')) {
      logger.info('[CARTOGRAPHER] AI degraded, returning empty result for fallback', { url });
      return this.emptyOutput(pageId);
    }

    // Build prompt with pre-formatted snapshot (avoids double formatting)
    const prompt = buildCartographerPrompt(input, formattedSnapshot);

    try {
      // Build messages with optional vision (screenshot)
      const userContent: any[] = [{ type: 'text', text: prompt }];

      if (input.screenshot) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${input.screenshot}`,
            detail: 'low',
          },
        });
      }

      await this.rateLimiter.acquireSlot('ai');

      this.trace?.writePageClassificationPrompt({
        url,
        model: AI_MODELS.vision,
        systemPrompt: CARTOGRAPHER_SYSTEM_PROMPT,
        userPrompt: input.screenshot ? '[multimodal content with screenshot]' : prompt,
        hasScreenshot: !!input.screenshot,
      });

      const aiStartTime = Date.now();

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: CARTOGRAPHER_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          {
            model: AI_MODELS.vision,
            temperature: 0.1,
            max_tokens: 3000,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Cartographer AI timeout')), CARTOGRAPHER_TIMEOUT_MS),
        ),
      ]);

      this.rateLimiter.recordSuccess('openai');

      const result = parseCartographerResponse(response.content, pageId);

      this.trace?.writePageClassificationResponse({
        url,
        model: AI_MODELS.vision,
        rawResponse: response.content,
        parsed: {
          pageType: result.pageType,
          entryPointCount: result.entryPoints.length,
          navLinkCount: result.navigationLinks.length,
        },
        latencyMs: Date.now() - aiStartTime,
        tokensUsed: response.usage?.totalTokens,
      });

      logger.info('[CARTOGRAPHER] Page analyzed', {
        url,
        pageType: result.pageType,
        entryPoints: result.entryPoints.length,
        navLinks: result.navigationLinks.length,
        isLoginPage: result.authDetection.isLoginPage,
        isAuthGated: result.authDetection.isAuthGated,
        recommendDeeper: result.recommendDeeper,
        latencyMs: Date.now() - aiStartTime,
      });

      return result;
    } catch (error) {
      // Handle rate limits with retry
      if (RateLimiter.isRateLimitError(error as Error)) {
        const rlResult = await this.rateLimiter.recordFailure('openai', error as Error);
        if (rlResult.shouldRetry) {
          logger.info('[CARTOGRAPHER] Retrying after rate limit backoff', { url });
          return this.analyze(input, formattedSnapshot);
        }
      }

      logger.warn('[CARTOGRAPHER] AI classification failed, returning empty for fallback', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      return this.emptyOutput(pageId);
    }
  }

  private emptyOutput(pageId: string): CartographerOutput {
    return {
      pageType: 'unknown',
      entryPoints: [],
      navigationLinks: [],
      authDetection: { isLoginPage: false, isAuthGated: false },
      pageInsight: {
        pageId,
        pageType: 'unknown',
        forms: [],
        interactiveAreas: [],
        dataEntities: [],
        stateIndicators: [],
        complexity: 'unknown',
        relatedPages: [],
      },
      recommendDeeper: false,
    };
  }
}
