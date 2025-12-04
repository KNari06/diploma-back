/**
 * AI Selector Engine
 * Intent-based adaptive selector resolution with self-healing
 */

import { logger } from '@/utils/logger';
import { IntentParserService } from './intent-parser.service';
import { SelectorCacheService } from './selector-cache.service';
import type {
  DOMNode,
  ParsedIntent,
  SelectorCandidate,
  SelectorResolveRequest,
  SelectorResolveResponse
} from './types';

// ═══════════════════════════════════════════════════════════════════════════
// AI SELECTOR ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export class AISelectorEngine {
  /**
   * Resolve selector from natural language intent
   * Primary method - uses cache, AI, and fallback strategies
   */
  static async resolve(request: SelectorResolveRequest): Promise<SelectorResolveResponse> {
    const startTime = Date.now();
    const { intent, metadata, mode = 'fast' } = request;

    logger.info('[AI_SELECTOR_ENGINE] Resolving selector', {
      intent: intent.substring(0, 100),
      mode,
      url: metadata.url,
      hasScreenshot: !!request.screenshot,
    });

    try {
      // Step 1: Check cache
      const cacheKey = await this.getCacheKey(request);
      const cached = await SelectorCacheService.get(cacheKey);
      if (cached) {
        logger.info('[AI_SELECTOR_ENGINE] Returning cached result', {
          intent,
          cacheKey,
          confidence: cached.selectedNode?.confidence,
        });
        return cached;
      }

      // Step 2: Parse intent
      const parsedIntent = await IntentParserService.parseIntent({
        intent,
        goal: undefined, // TODO: Pass goal from context if available
        pageContext: {
          url: metadata.url,
          nodes: request.nodes,
        },
      });

      // Step 3: Find candidate elements
      const candidates = await this.findCandidates(parsedIntent, request.nodes, request.dom);

      // Step 4: Score and rank candidates
      const scoredCandidates = await this.scoreCandidates(
        candidates,
        parsedIntent,
        request,
        mode
      );

      // Step 5: Generate selectors for top candidates
      const selectorsWithCandidates = await this.generateSelectors(scoredCandidates, request);

      // Step 6: Build response
      const response = this.buildResponse(
        selectorsWithCandidates,
        parsedIntent,
        startTime,
        false // cacheHit = false
      );

      // Step 7: Cache result
      await SelectorCacheService.set(cacheKey, response);

      return response;
    } catch (error) {
      logger.error('[AI_SELECTOR_ENGINE] Resolution failed', { error, intent });

      // Return failure response
      return {
        success: false,
        fallbackSelectors: [],
        explanation: `Failed to resolve selector: ${error instanceof Error ? error.message : String(error)}`,
        metrics: {
          totalDuration: Date.now() - startTime,
          cacheHit: false,
        },
      };
    }
  }

  /**
   * Generate cache key
   * ///improvement: Fixed cache key generation to include element-specific identifier
   * This prevents different buttons from getting the same cached selector
   */
  private static async getCacheKey(request: SelectorResolveRequest): Promise<string> {
    const { intent, metadata, nodes } = request;

    // Generate DOM hash
    const domHash = await this.generateDOMHashFromNodes(nodes);

    // ✅ FIX: Include element-specific identifier in intent to ensure unique cache keys
    // This prevents different buttons from getting the same cached selector
    // Extract element identifier from intent (e.g., button text, aria-label, etc.)
    const elementIdentifier = this.extractElementIdentifier(intent, nodes);
    const uniqueIntent = elementIdentifier
      ? `${IntentParserService.normalizeIntent(intent)}|${elementIdentifier}`
      : IntentParserService.normalizeIntent(intent);

    return SelectorCacheService.generateCacheKey({
      projectId: metadata.projectId || 'default',
      intent: uniqueIntent,
      domHash,
      viewport: `${metadata.viewport.width}x${metadata.viewport.height}`,
      modelVersion: 'gpt-4o-2024-11-20',
      engineVersion: '1.0.0',
    });
  }

  /**
   * Extract element-specific identifier from intent to ensure unique cache keys
   * ///improvement: Added extraction of element identifier (text + index) to ensure unique cache keys
   * This prevents duplicate selectors for different elements with same text
   * @param intent - Original intent string
   * @param nodes - Available DOM nodes
   * @returns Element identifier (text, aria-label, id, etc.) or null
   */
  private static extractElementIdentifier(intent: string, nodes: DOMNode[]): string | null {
    // Try to extract button text, aria-label, or other unique identifier from intent
    // Pattern: "Click "{text}" button (index: N)" or "Click {text} button" -> extract {text} and index
    const buttonMatch = intent.match(/Click\s+["']?(.+?)["']?\s+button(?:\s+\(index:\s*(\d+)\))?/i);
    if (buttonMatch && buttonMatch[1]) {
      // Remove quotes if present and normalize
      const text = buttonMatch[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      const index = buttonMatch[2] ? `:${buttonMatch[2]}` : '';
      return `${text}${index}`;
    }

    // Pattern: "Fill {label} input" -> extract {label}
    const inputMatch = intent.match(/Fill\s+.+?\s+input\s+["']?(.+?)["']?$/i);
    if (inputMatch && inputMatch[1]) {
      return inputMatch[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
    }

    // Pattern: "with aria-label "{label}"" -> extract aria-label
    const ariaLabelMatch = intent.match(/aria-label\s+["'](.+?)["']/i);
    if (ariaLabelMatch && ariaLabelMatch[1]) {
      return `aria:${ariaLabelMatch[1].trim().toLowerCase()}`;
    }

    // If no pattern matches, try to find unique identifier in nodes
    // This is a fallback - prefer explicit extraction from intent
    return null;
  }

  /**
   * Generate DOM hash from nodes
   */
  private static async generateDOMHashFromNodes(nodes: DOMNode[]): Promise<string> {
    // Create signature from interactive elements
    const signature = nodes
      .filter(n => n.isVisible)
      .map(n => `${n.tag}:${n.attributes.id || ''}:${n.role || ''}`)
      .join('|');

    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(signature).digest('hex').substring(0, 16);
  }

  /**
   * Find candidate elements matching parsed intent
   */
  private static async findCandidates(
    parsedIntent: ParsedIntent,
    nodes: DOMNode[],
    dom: string
  ): Promise<DOMNode[]> {
    const candidates: DOMNode[] = [];

    for (const node of nodes) {
      // Skip invisible elements
      if (!node.isVisible) continue;

      // Match by element type
      if (!this.matchesElementType(node, parsedIntent.target.type)) continue;

      // Match by text
      if (parsedIntent.target.text) {
        const textMatches = node.text.toLowerCase().includes(parsedIntent.target.text.toLowerCase());
        if (!textMatches) continue;
      }

      // Match by role
      if (parsedIntent.target.role) {
        if (node.role !== parsedIntent.target.role) continue;
      }

      // Match by attributes
      if (parsedIntent.target.attributes) {
        const attributesMatch = Object.entries(parsedIntent.target.attributes).every(
          ([key, value]) => node.attributes[key] === value
        );
        if (!attributesMatch) continue;
      }

      candidates.push(node);
    }

    logger.info('[AI_SELECTOR_ENGINE] Found candidates', {
      total: candidates.length,
      targetType: parsedIntent.target.type,
      targetDescription: parsedIntent.target.description,
    });

    return candidates;
  }

  /**
   * Check if node matches element type
   */
  private static matchesElementType(
    node: DOMNode,
    targetType: ParsedIntent['target']['type']
  ): boolean {
    const tag = node.tag.toLowerCase();
    const role = node.role?.toLowerCase();

    switch (targetType) {
      case 'button':
        return tag === 'button' || role === 'button' || (tag === 'a' && node.attributes.role === 'button');
      case 'link':
        return tag === 'a' && Boolean(node.attributes.href);
      case 'input':
        return tag === 'input' || tag === 'textarea' || role === 'textbox';
      case 'checkbox':
        return (tag === 'input' && node.attributes.type === 'checkbox') || role === 'checkbox';
      case 'select':
        return tag === 'select' || role === 'listbox';
      case 'element':
        return true; // Match any element
      default:
        return false;
    }
  }

  /**
   * Score candidates using heuristics
   * TODO: Implement Vision AI scoring for accurate mode when needed
   */
  private static async scoreCandidates(
    candidates: DOMNode[],
    parsedIntent: ParsedIntent,
    request: SelectorResolveRequest,
    mode: 'fast' | 'accurate'
  ): Promise<Array<{ node: DOMNode; score: number; reasoning: string }>> {
    if (candidates.length === 0) {
      return [];
    }

    // Always use heuristic scoring
    // Vision AI scoring not implemented yet (no significant benefit for current use case)
    return this.scoreWithHeuristics(candidates, parsedIntent);
  }

  /**
   * Score candidates using heuristics (fast)
   */
  private static scoreWithHeuristics(
    candidates: DOMNode[],
    parsedIntent: ParsedIntent
  ): Array<{ node: DOMNode; score: number; reasoning: string }> {
    return candidates.map(node => {
      let score = 0.5; // Base score
      let reasons: string[] = [];

      // Bonus: Has data-testid
      if (node.attributes['data-testid']) {
        score += 0.2;
        reasons.push('has data-testid');
      }

      // Bonus: Has ID
      if (node.attributes.id) {
        score += 0.15;
        reasons.push('has ID');
      }

      // Bonus: Has ARIA role
      if (node.role) {
        score += 0.1;
        reasons.push('has ARIA role');
      }

      // Bonus: Text matches intent description
      if (parsedIntent.target.description) {
        const descLower = parsedIntent.target.description.toLowerCase();
        const textLower = node.text.toLowerCase();
        if (textLower.includes(descLower) || descLower.includes(textLower)) {
          score += 0.3;
          reasons.push('text matches description');
        }
      }

      // Bonus: Larger bounding box (more prominent)
      const area = node.boundingBox.width * node.boundingBox.height;
      if (area > 5000) {
        score += 0.1;
        reasons.push('large element');
      }

      // Bonus: Higher position (closer to top)
      if (node.boundingBox.y < 300) {
        score += 0.05;
        reasons.push('near top');
      }

      // Cap score at 1.0
      score = Math.min(score, 1.0);

      return {
        node,
        score,
        reasoning: reasons.join(', '),
      };
    }).sort((a, b) => b.score - a.score); // Sort by score descending
  }


  /**
   * Generate selectors for candidates
   */
  private static async generateSelectors(
    scoredCandidates: Array<{ node: DOMNode; score: number; reasoning: string }>,
    request: SelectorResolveRequest
  ): Promise<Array<{ node: DOMNode; score: number; reasoning: string; selectors: SelectorCandidate[] }>> {
    return scoredCandidates.map(candidate => {
      const selectors = this.generateSelectorsForNode(candidate.node);
      return {
        ...candidate,
        selectors,
      };
    });
  }

  /**
   * Generate multiple selector strategies for a node
   * Priority: getByRole > getByLabel > getByText > data-testid > ID (via role=)
   * ✅ REMOVED: CSS class selectors, XPath (unstable)
   * Only Playwright selectors and data-testid are used now
   */
  private static generateSelectorsForNode(node: DOMNode): SelectorCandidate[] {
    const selectors: SelectorCandidate[] = [];

    // Strategy 1: getByRole (most stable)
    if (node.role) {
      const roleSelector = this.generateRoleSelector(node);
      if (roleSelector) selectors.push(roleSelector);
    }

    // Strategy 2: getByLabel (for inputs)
    if (node.tag === 'input' && (node.attributes['aria-label'] || node.attributes.placeholder)) {
      const labelSelector = this.generateLabelSelector(node);
      if (labelSelector) selectors.push(labelSelector);
    }

    // Strategy 3: getByText (for buttons/links)
    if ((node.tag === 'button' || node.tag === 'a') && node.text) {
      const textSelector = this.generateTextSelector(node);
      if (textSelector) selectors.push(textSelector);
    }

    // Strategy 4: data-testid (keep - stable test attribute)
    if (node.attributes['data-testid']) {
      selectors.push({
        type: 'data-testid',
        selector: `[data-testid="${node.attributes['data-testid']}"]`,
        confidence: 0.95,
        reasoning: 'Stable test ID attribute',
        stability: 0.95,
      });
    }

    // Strategy 5: ID as role= (convert ID to Playwright if element has implicit role)
    if (node.attributes.id && node.role) {
      // Use role= instead of #id for better stability
      const roleSelector = this.generateRoleSelector(node);
      if (roleSelector && !selectors.find(s => s.type === 'getByRole')) {
        selectors.push(roleSelector);
      }
    }

    // ✅ REMOVED: CSS selector generation (class-based, tag-based)
    // ✅ REMOVED: XPath selector (unstable fallback)
    // Only data-testid and ID (via role=) are kept as fallbacks

    return selectors;
  }

  /**
   * Generate Playwright getByRole selector
   * ✅ FIX: Convert to Playwright locator format (role=button or role=button[name='Login'])
   */
  private static generateRoleSelector(node: DOMNode): SelectorCandidate | null {
    if (!node.role) return null;

    // ✅ FIX: Use Playwright locator format
    let selector = `role=${node.role}`;

    // Add name filter if has text
    if (node.text && node.text.length > 0 && node.text.length < 50) {
      // Escape quotes in text
      const escapedText = node.text.replace(/'/g, "\\'").replace(/"/g, '\\"');
      selector += `[name="${escapedText}"]`;
    }

    return {
      type: 'getByRole',
      selector,
      confidence: 0.90,
      reasoning: 'Semantic ARIA role selector',
      stability: 0.90,
    };
  }

  /**
   * Generate Playwright getByLabel selector
   * ✅ FIX: Convert to Playwright locator format (label=Email)
   */
  private static generateLabelSelector(node: DOMNode): SelectorCandidate | null {
    const label = node.attributes['aria-label'] || node.attributes.placeholder;
    if (!label) return null;

    // ✅ FIX: Use Playwright locator format
    const escapedLabel = label.replace(/"/g, '\\"');
    const selector = `label="${escapedLabel}"`;

    return {
      type: 'getByLabel',
      selector,
      confidence: 0.85,
      reasoning: 'Accessibility label selector',
      stability: 0.85,
    };
  }

  /**
   * Generate Playwright getByText selector
   * ✅ FIX: Convert to Playwright locator format (text=Login)
   */
  private static generateTextSelector(node: DOMNode): SelectorCandidate | null {
    if (!node.text || node.text.length === 0 || node.text.length > 100) return null;

    // ✅ FIX: Use Playwright locator format (text=...)
    const escapedText = node.text.replace(/"/g, '\\"');
    const selector = `text="${escapedText}"`;

    return {
      type: 'getByText',
      selector,
      confidence: 0.75,
      reasoning: 'Text content selector',
      stability: 0.70, // Text can change
    };
  }

  // ✅ REMOVED: generateCSSSelector() - no longer generating class-based CSS selectors
  // ✅ REMOVED: generateXPathSelector() - no longer using XPath fallback
  // Only Playwright selectors (role=, label=, text=) and data-testid are used now

  /**
   * Build final response
   */
  private static buildResponse(
    selectorsWithCandidates: Array<{ node: DOMNode; score: number; reasoning: string; selectors: SelectorCandidate[] }>,
    parsedIntent: ParsedIntent,
    startTime: number,
    cacheHit: boolean
  ): SelectorResolveResponse {
    if (selectorsWithCandidates.length === 0) {
      return {
        success: false,
        fallbackSelectors: [],
        explanation: `No elements found matching intent: ${parsedIntent.target.description}`,
        warning: 'No matching elements found on page',
        metrics: {
          totalDuration: Date.now() - startTime,
          cacheHit,
        },
      };
    }

    // Top candidate
    const topCandidate = selectorsWithCandidates[0];
    const primarySelector = topCandidate.selectors[0]; // Highest priority selector

    // Alternative candidates
    const alternatives = selectorsWithCandidates.slice(1, 3).map(candidate => ({
      nodeId: candidate.node.nodeId,
      primarySelector: candidate.selectors[0]?.selector || '',
      selectorType: candidate.selectors[0]?.type || 'css',
      confidence: candidate.score,
      boundingBox: candidate.node.boundingBox,
      element: {
        tag: candidate.node.tag,
        text: candidate.node.text,
        attributes: candidate.node.attributes,
      },
    }));

    // Build response
    return {
      success: true,
      selectedNode: {
        nodeId: topCandidate.node.nodeId,
        primarySelector: primarySelector.selector,
        selectorType: primarySelector.type,
        confidence: topCandidate.score,
        boundingBox: topCandidate.node.boundingBox,
        element: {
          tag: topCandidate.node.tag,
          text: topCandidate.node.text,
          attributes: topCandidate.node.attributes,
        },
      },
      fallbackSelectors: topCandidate.selectors.slice(1, 3), // 2nd and 3rd best selectors
      explanation: `Selected ${topCandidate.node.tag} element: "${topCandidate.node.text.substring(0, 50)}${topCandidate.node.text.length > 50 ? '...' : ''}" (${topCandidate.reasoning})`,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      warning: topCandidate.score < 0.7 ? 'Low confidence - multiple similar elements found' : undefined,
      metrics: {
        totalDuration: Date.now() - startTime,
        aiDuration: 0, // TODO: Track AI time
        cacheHit,
      },
    };
  }
}
