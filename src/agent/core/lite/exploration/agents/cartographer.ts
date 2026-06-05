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

import type { LiteSnapshot } from '../../lite-types';
import { RateLimiter } from '../rate-limiter';
import type { ExplorationTraceService } from '../exploration-trace.service';
import type { CartographerInput, CartographerOutput, CartographerEntryPoint } from './agent-types';
import { EXPLORATION_AGENT_LLM } from './agent-llm-config';
import {
  isPasswordInput,
  isCredentialInput,
  isSearchInput,
  isEditableField,
  isSubmitButton,
  bestLabel,
} from '../../analysis/interactive-element-signals';
import {
  CARTOGRAPHER_SYSTEM_PROMPT,
  buildCartographerPrompt,
  parseCartographerResponse,
} from './cartographer-prompts';

/** Centralized LLM tuning for this agent (model / temp / tokens / timeout). */
const LLM = EXPLORATION_AGENT_LLM.cartographer;

/** Min interactive elements to justify a retry when AI returns empty */
const RETRY_MIN_INTERACTIVE_ELEMENTS = 5;

/**
 * Max recursive retries on rate-limit errors before giving up. Mirrors Scout's
 * cap — the limiter normally bounds this, but recordSuccess() resets its
 * consecutive-failure counter, so intermittent 429s could otherwise recurse
 * without a hard ceiling.
 */
const MAX_RATE_LIMIT_RETRIES = 2;

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
    attempt = 0,
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
        model: LLM.model,
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
            model: LLM.model,
            temperature: LLM.temperature,
            max_tokens: LLM.maxTokens,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Cartographer AI timeout')), LLM.timeoutMs),
        ),
      ]);

      this.rateLimiter.recordSuccess('openai');

      const result = parseCartographerResponse(response.content, pageId);

      const latencyMs = Date.now() - aiStartTime;

      this.trace?.writePageClassificationResponse({
        url,
        model: LLM.model,
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
          return this.analyze({ ...input, screenshot: undefined }, formattedSnapshot, attempt);
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
      // Handle rate limits with bounded retry (prevents unbounded recursion if
      // intermittent 429s keep resetting the limiter's failure counter).
      if (RateLimiter.isRateLimitError(error as Error)) {
        const rlResult = await this.rateLimiter.recordFailure('openai', error as Error);
        if (rlResult.shouldRetry && attempt < MAX_RATE_LIMIT_RETRIES) {
          logger.info('[CARTOGRAPHER] Retrying after rate limit backoff', { url, attempt: attempt + 1 });
          return this.analyze(input, formattedSnapshot, attempt + 1);
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
        model: LLM.model,
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

    // Detect forms (look for password fields → login form). Password detection
    // and identity-field classification are language-neutral (type/autocomplete
    // + shared multilingual classifier), so this works on RU/KK/… sites too.
    const hasPasswordField = elements.some(isPasswordInput);
    if (hasPasswordField) {
      const identityEls = elements.filter(el => !isPasswordInput(el) && isCredentialInput(el));
      const passwordEls = elements.filter(isPasswordInput);
      entryPoints.push({
        name: 'User Login',
        goal: 'Fill in the identity and password fields, then submit the login form to authenticate',
        category: 'authentication',
        priority: 'critical',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: [...identityEls, ...passwordEls]
          .slice(0, 5).map(el => ({ ref: el.ref, role: el.role, name: el.name, tag: el.tag })),
      });
    }

    // Detect search inputs (type=search / role=searchbox / inputmode=search)
    const searchInputs = elements.filter(isSearchInput);
    if (searchInputs.length > 0) {
      entryPoints.push({
        name: 'Search Functionality',
        goal: 'Type a relevant query into the search input and verify results appear',
        category: 'search',
        priority: 'high',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: searchInputs.slice(0, 3).map(el => ({
          ref: el.ref, role: el.role, name: el.name, tag: el.tag,
        })),
      });
    }

    // Detect form submissions (non-auth forms with multiple editable fields).
    // Submit control is identified structurally (type=submit / button), not by text.
    const textInputs = elements.filter(el => isEditableField(el) && !isPasswordInput(el) && !isSearchInput(el) && !el.disabled);
    const submitButtons = elements.filter(isSubmitButton);
    if (textInputs.length >= 2 && submitButtons.length > 0 && !hasPasswordField) {
      const fieldNames = textInputs.slice(0, 3).map(bestLabel).filter(Boolean);
      const formName = bestLabel(submitButtons[0]) || `${fieldNames[0] || 'Form'} Submission`;
      entryPoints.push({
        name: formName,
        goal: `Fill in the form fields (${fieldNames.join(', ') || 'required fields'}) with valid test data and submit the form`,
        category: 'form_submission',
        priority: 'high',
        requiresAuth: false,
        estimatedComplexity: 'medium',
        relatedElements: [...textInputs.slice(0, 4), ...submitButtons.slice(0, 1)].map(el => ({
          ref: el.ref, role: el.role, name: el.name, tag: el.tag,
        })),
      });
    }

    // Detect navigation links from snapshot (language-neutral: tag/href/role)
    const navLinks = elements.filter(el =>
      el.tag === 'a' && el.href && el.visible && !el.disabled &&
      bestLabel(el).length > 1 && bestLabel(el).length < 50,
    );
    const navigationLinks = navLinks.slice(0, 10).map(el => ({
      ref: el.ref,
      label: bestLabel(el),
      estimatedPageType: 'other' as string,
    }));

    // Login-page heuristic: presence of a password field. URL keyword matching
    // removed — it only ever recognised English paths (/login, /signin).
    const isLoginPage = hasPasswordField;

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
