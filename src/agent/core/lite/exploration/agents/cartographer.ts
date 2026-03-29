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
import type { CartographerInput, CartographerOutput, CartographerEntryPoint } from './agent-types';
import {
  CARTOGRAPHER_SYSTEM_PROMPT,
  buildCartographerPrompt,
  parseCartographerResponse,
} from './cartographer-prompts';

/** Timeout for Cartographer AI call */
const CARTOGRAPHER_TIMEOUT_MS = 25_000;

/** Min interactive elements to justify a retry when AI returns empty */
const RETRY_MIN_INTERACTIVE_ELEMENTS = 5;

export class Cartographer {
  /** Track URLs already retried to prevent infinite retry loops */
  private retriedUrls = new Set<string>();

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

    // If AI is degraded, collect basic entry points from DOM heuristics
    if (this.rateLimiter.isDegraded('openai')) {
      logger.info('[CARTOGRAPHER] AI degraded, using DOM heuristic fallback', { url });
      return this.domFallbackOutput(pageId, input);
    }

    // Build prompt with pre-formatted snapshot (avoids double formatting)
    const prompt = buildCartographerPrompt(input, formattedSnapshot);
    const aiStartTime = Date.now();

    try {
      // Build messages with optional vision (screenshot)
      const userContent: any[] = [{ type: 'text', text: prompt }];

      if (input.screenshot) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${input.screenshot}`,
            detail: 'high',
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

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: CARTOGRAPHER_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          {
            model: AI_MODELS.vision,
            temperature: 0.1,
            max_tokens: 4000,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Cartographer AI timeout')), CARTOGRAPHER_TIMEOUT_MS),
        ),
      ]);

      this.rateLimiter.recordSuccess('openai');

      const result = parseCartographerResponse(response.content, pageId);

      const latencyMs = Date.now() - aiStartTime;

      this.trace?.writePageClassificationResponse({
        url,
        model: AI_MODELS.vision,
        rawResponse: response.content,
        parsed: {
          pageType: result.pageType,
          entryPointCount: result.entryPoints.length,
          navLinkCount: result.navigationLinks.length,
        },
        latencyMs,
        tokensUsed: response.usage?.totalTokens,
      });

      // Retry once without screenshot if AI returned empty on a page with interactive elements.
      // Vision models sometimes hallucinate or get confused by complex screenshots — text-only can work better.
      if (
        result.entryPoints.length === 0 &&
        input.screenshot &&
        !this.retriedUrls.has(url)
      ) {
        const interactiveCount = (input.snapshot?.elements ?? []).filter(
          (e) => e.role === 'button' || e.role === 'link' || e.role === 'textbox' || e.tag === 'input' || e.tag === 'select',
        ).length;

        if (interactiveCount >= RETRY_MIN_INTERACTIVE_ELEMENTS) {
          logger.info('[CARTOGRAPHER] Empty result on interactive page — retrying without screenshot', {
            url,
            interactiveCount,
          });
          this.retriedUrls.add(url);
          return this.analyze({ ...input, screenshot: undefined }, formattedSnapshot);
        }
      }

      logger.info('[CARTOGRAPHER] Page analyzed', {
        url,
        pageType: result.pageType,
        entryPoints: result.entryPoints.length,
        navLinks: result.navigationLinks.length,
        isLoginPage: result.authDetection.isLoginPage,
        isAuthGated: result.authDetection.isAuthGated,
        recommendDeeper: result.recommendDeeper,
        latencyMs,
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

      const errorMsg = error instanceof Error ? error.message : String(error);
      const httpStatus = (error as any)?.status;
      logger.warn('[CARTOGRAPHER] AI classification failed, returning empty for fallback', {
        url,
        error: errorMsg,
        httpStatus,
      });

      // Log the failure in trace so it's visible alongside successful responses
      this.trace?.writePageClassificationResponse({
        url,
        model: AI_MODELS.vision,
        rawResponse: `[ERROR: ${errorMsg}]`,
        parsed: { pageType: 'error', entryPointCount: 0, navLinkCount: 0 },
        latencyMs: Date.now() - aiStartTime,
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

  /**
   * DOM heuristic fallback when AI is degraded.
   * Collects entry points from buttons, forms, and links in the snapshot.
   */
  private domFallbackOutput(pageId: string, input: CartographerInput): CartographerOutput {
    const elements = input.snapshot?.elements ?? [];
    const entryPoints: CartographerEntryPoint[] = [];

    // Detect forms (look for password fields → login form)
    const hasPasswordField = elements.some(el => el.type === 'password');
    if (hasPasswordField) {
      const emailField = elements.find(el => el.type === 'email' || /email/i.test(el.name || el.placeholder || ''));
      const usernameField = elements.find(el => /username|login|user/i.test(el.name || el.placeholder || ''));
      const fieldDesc = emailField
        ? `email field "${emailField.name || emailField.placeholder || 'email'}"`
        : usernameField
          ? `username field "${usernameField.name || usernameField.placeholder || 'username'}"`
          : 'credentials fields';
      entryPoints.push({
        name: 'User Login',
        goal: `Fill in the ${fieldDesc} and password field, then click the login/submit button to authenticate`,
        category: 'authentication',
        priority: 'critical',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: elements
          .filter(el => el.type === 'password' || el.type === 'email' || /email|username|login/i.test(el.name || el.placeholder || ''))
          .slice(0, 5).map(el => ({ ref: el.ref, role: el.role, name: el.name, tag: el.tag })),
      });
    }

    // Detect search inputs
    const searchInputs = elements.filter(el =>
      el.type === 'search' || /search/i.test(el.name || el.placeholder || el.role || ''),
    );
    if (searchInputs.length > 0) {
      const searchEl = searchInputs[0];
      entryPoints.push({
        name: 'Search Functionality',
        goal: `Click the search input "${searchEl.name || searchEl.placeholder || 'search box'}", type a relevant search query, and verify results appear`,
        category: 'search',
        priority: 'high',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: searchInputs.slice(0, 3).map(el => ({
          ref: el.ref, role: el.role, name: el.name, tag: el.tag,
        })),
      });
    }

    // Detect form submissions (non-auth forms with multiple inputs)
    const textInputs = elements.filter(el =>
      (el.tag === 'input' || el.tag === 'textarea') &&
      el.type !== 'password' && el.type !== 'hidden' && el.type !== 'search' &&
      !el.disabled,
    );
    const submitButtons = elements.filter(el =>
      (el.tag === 'button' || el.role === 'button') &&
      /submit|send|save|create|add|register|sign\s*up/i.test(el.name || ''),
    );
    if (textInputs.length >= 2 && submitButtons.length > 0 && !hasPasswordField) {
      const submitBtn = submitButtons[0];
      const fieldNames = textInputs.slice(0, 3).map(el => el.name || el.placeholder || el.type).filter(Boolean);
      // Derive a meaningful name from the submit button text or page context
      const btnLabel = (submitBtn.name || '').trim();
      const formName = /submit/i.test(btnLabel) || !btnLabel
        ? `${fieldNames[0] || 'Form'} Submission`
        : btnLabel;
      entryPoints.push({
        name: formName,
        goal: `Fill in the form fields (${fieldNames.join(', ') || 'required fields'}) with valid test data and click "${submitBtn.name || 'submit'}" to submit`,
        category: 'form_submission',
        priority: 'high',
        requiresAuth: false,
        estimatedComplexity: 'medium',
        relatedElements: [...textInputs.slice(0, 4), ...submitButtons.slice(0, 1)].map(el => ({
          ref: el.ref, role: el.role, name: el.name, tag: el.tag,
        })),
      });
    }

    // Detect prominent CTA buttons
    const ctaButtons = elements.filter(el =>
      (el.tag === 'button' || el.role === 'button' || (el.tag === 'a' && el.role === 'link')) &&
      el.visible && !el.disabled &&
      /get\s*started|try|demo|sign\s*up|register|contact|learn/i.test(el.name || ''),
    );
    for (const btn of ctaButtons.slice(0, 3)) {
      entryPoints.push({
        name: `${btn.name || 'CTA'} Flow`,
        goal: `Click the "${btn.name || 'CTA button'}" button and complete any resulting form or redirect flow`,
        category: 'navigation',
        priority: 'medium',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: [{ ref: btn.ref, role: btn.role, name: btn.name, tag: btn.tag }],
      });
    }

    // Detect navigation links from snapshot
    const navLinks = elements.filter(el =>
      el.tag === 'a' && el.href && el.visible && !el.disabled &&
      el.name && el.name.length > 1 && el.name.length < 50,
    );
    const navigationLinks = navLinks.slice(0, 10).map(el => ({
      ref: el.ref,
      label: el.name || '',
      estimatedPageType: 'other' as string,
    }));

    const isLoginPage = hasPasswordField || /login|signin|sign-in/i.test(input.url);

    return {
      pageType: isLoginPage ? 'login' : 'unknown',
      entryPoints,
      navigationLinks,
      authDetection: { isLoginPage, isAuthGated: false },
      pageInsight: {
        pageId,
        pageType: isLoginPage ? 'login' : 'unknown',
        forms: [],
        interactiveAreas: [],
        dataEntities: [],
        stateIndicators: [],
        complexity: 'unknown',
        relatedPages: [],
      },
      recommendDeeper: true,
    };
  }
}
