/**
 * Self-Healing Service
 * Automatically repairs broken selectors using AI Selector Engine
 *
 * Resolution pipeline:
 *   1. Fast mode: DOM-only embeddings + LLM disambiguation
 *   2. Accurate mode (escalation): DOM + screenshot → Gemini Vision
 *
 * Escalation triggers when fast mode fails:
 *   healSelector(fast) → fails → healSelector(accurate) → resolveWithVision()
 */

import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import { DOMNodeExtractor } from './dom-node-extractor';
import { AISelectorEngine } from './index';
import type { DOMNode, SelectorType, SelfHealingResult } from './types';
import { generateTextWithGeminiVision } from '@/services/ai/core/gemini.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';

// ═══════════════════════════════════════════════════════════════════════════
// SELF-HEALING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class SelfHealingService {
  /**
   * Attempt to heal a broken selector
   * Called when element is not found during test execution
   */
  static async healSelector(params: {
    oldSelector: string; // Selector that failed
    intent: string; // What we're trying to do (from action.description)
    page: Page; // Current page
    errorMessage: string; // Error from Playwright
    metadata: {
      url: string;
      projectId?: string;
      userId?: string;
    };
    mode?: 'fast' | 'accurate'; // Fast: DOM only, Accurate: + screenshot
  }): Promise<SelfHealingResult> {
    const { oldSelector, intent, page, metadata, mode = 'fast' } = params;

    logger.info('[SELF_HEALING] Attempting to heal selector', {
      oldSelector,
      intent: intent.substring(0, 100),
      mode,
      url: metadata.url,
    });

    const startTime = Date.now();

    try {
      // Step 1: Extract current DOM nodes
      const nodes = await DOMNodeExtractor.extractNodes(page, {
        visibleOnly: true,
        interactiveOnly: true, // Only interactive elements
      });

      if (nodes.length === 0) {
        logger.warn('[SELF_HEALING] No interactive elements found on page');
        return {
          success: false,
          oldSelector,
          diff: {
            what_changed: 'Page has no interactive elements',
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: 'css',
            confidence: 0,
          },
          suggestion: 'Page may not be loaded or has no interactive elements',
          autoApplied: false,
        };
      }

      // Step 2: Get page DOM and optionally screenshot
      const [dom, screenshot] = await Promise.all([
        page.content(),
        mode === 'accurate' ? page.screenshot({ type: 'png' }).then(b => b.toString('base64')) : Promise.resolve(undefined),
      ]);

      // Step 3: Get viewport
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };

      // Step 4: Resolve new selector using AI
      const resolveResult = await AISelectorEngine.resolve({
        intent,
        dom,
        nodes,
        screenshot,
        metadata: {
          url: metadata.url,
          viewport,
          projectId: metadata.projectId,
          userId: metadata.userId,
        },
        mode,
      });

      // Step 5: Check if resolution successful
      if (!resolveResult.success || !resolveResult.selectedNode) {
        // ── Phase 1: Vision fallback in accurate mode ───────────────────
        // If we have a screenshot (accurate mode), try Gemini Vision as last resort
        if (mode === 'accurate' && screenshot) {
          logger.info('[SELF_HEALING] Embeddings failed in accurate mode, trying vision resolution', {
            oldSelector,
            intent: intent.substring(0, 100),
          });

          const visionResult = await this.resolveWithVision({
            screenshot,
            nodes,
            intent,
            actionType: this.inferActionType(intent),
            pageUrl: metadata.url,
            viewport,
          });

          if (visionResult.ref && visionResult.confidence >= 0.7) {
            // Vision found a matching node — build selector from it
            const matchedNode = nodes.find(n => n.nodeId === visionResult.ref);
            if (matchedNode) {
              // Build selector from the matched node via AI engine
              const visionResolve = await AISelectorEngine.resolve({
                intent,
                dom,
                nodes: [matchedNode], // Single node — forces selection
                screenshot,
                metadata: { url: metadata.url, viewport, projectId: metadata.projectId, userId: metadata.userId },
                mode: 'accurate',
              });

              if (visionResolve.success && visionResolve.selectedNode) {
                const visionSelector = visionResolve.selectedNode.primarySelector;
                const visionTest = await this.testSelectorWithDryRun(page, visionSelector);
                if (visionTest.works) {
                  const duration = Date.now() - startTime;
                  const result = this.buildSuccessResult(
                    oldSelector,
                    visionSelector,
                    visionResolve.selectedNode.selectorType,
                    visionResult.confidence,
                    duration,
                  );
                  result.visionUsed = true;
                  result.escalated = mode === 'accurate';
                  return result;
                }
              }
            }
          }

          // Vision returned bounding box coordinates (element not in interactive nodes list)
          if (!visionResult.ref && visionResult.boundingBox && visionResult.confidence >= 0.7) {
            const bb = visionResult.boundingBox;
            const duration = Date.now() - startTime;
            logger.info('[SELF_HEALING] Vision found element by coordinates (not in node list)', {
              boundingBox: bb,
              confidence: visionResult.confidence,
            });
            return {
              success: true,
              oldSelector,
              coordinates: {
                x: Math.round(bb.x + bb.width / 2),
                y: Math.round(bb.y + bb.height / 2),
              },
              diff: {
                what_changed: 'Element found by visual analysis (coordinate-based)',
                old_strategy: this.detectSelectorType(oldSelector),
                new_strategy: 'css',
                confidence: visionResult.confidence,
              },
              suggestion: `Vision identified element at (${bb.x}, ${bb.y}) — ${visionResult.reason}`,
              autoApplied: visionResult.confidence >= 0.8,
              visionUsed: true,
              escalated: true,
            };
          }
        }

        // ── Phase 3: Iframe-aware healing ────────────────────────────────
        // Element might be inside a same-origin iframe. Try collecting iframe nodes.
        try {
          const { collectInteractiveNodes } = await import('@/agent/execution/background-dom-collector');
          const allNodes = await collectInteractiveNodes(page);
          // Filter to iframe-only nodes (refs starting with "iframe-")
          const iframeNodes = allNodes.filter(n => n.ref?.startsWith('iframe-'));

          if (iframeNodes.length > 0) {
            logger.info('[SELF_HEALING] Trying iframe nodes for healing', {
              iframeNodeCount: iframeNodes.length,
              intent: intent.substring(0, 80),
            });

            // Build DOM from iframe content (approximate — use main frame content)
            const iframeDom = await page.content();
            const iframeResolve = await AISelectorEngine.resolve({
              intent,
              dom: iframeDom,
              nodes: iframeNodes as any[], // InteractiveNode → DOMNode compatible
              screenshot,
              metadata: {
                url: metadata.url,
                viewport: page.viewportSize() || { width: 1920, height: 1080 },
                projectId: metadata.projectId,
                userId: metadata.userId,
              },
              mode: 'fast',
            });

            if (iframeResolve.success && iframeResolve.selectedNode) {
              const iframeSelector = iframeResolve.selectedNode.primarySelector;
              // Extract iframe context from the ref
              const refMatch = iframeResolve.selectedNode.nodeId.match(/^iframe-(.+?)-bg-/);
              const frameId = refMatch?.[1];

              // Find the frame to test the selector
              const frame = page.frames().find(f =>
                (f.name() && f.name() === frameId) ||
                (f.url() && f.url().endsWith(frameId || ''))
              );

              if (frame) {
                try {
                  const frameLocator = frame.locator(iframeSelector);
                  const count = await frameLocator.count();
                  const isVisible = count > 0 && await frameLocator.first().isVisible({ timeout: 2000 }).catch(() => false);

                  if (count === 1 && isVisible) {
                    const duration = Date.now() - startTime;
                    const result = this.buildSuccessResult(
                      oldSelector,
                      iframeSelector,
                      iframeResolve.selectedNode.selectorType,
                      iframeResolve.selectedNode.confidence,
                      duration,
                    );
                    result.iframeContext = {
                      frameName: frame.name() || undefined,
                      frameUrl: frame.url(),
                    };
                    logger.info('[SELF_HEALING] Found element in iframe!', {
                      frameName: frame.name(),
                      frameUrl: frame.url().slice(0, 80),
                      selector: iframeSelector,
                    });
                    return result;
                  }
                } catch {
                  // Frame locator failed — continue to next fallback
                }
              }
            }
          }
        } catch (iframeError) {
          logger.debug('[SELF_HEALING] Iframe healing attempt failed (non-fatal)', {
            error: iframeError instanceof Error ? iframeError.message : String(iframeError),
          });
        }

        // ── Phase 5: Scroll-and-retry for virtualized lists ──────────────
        // If resolution found 0 candidates, element might be below the fold
        logger.info('[SELF_HEALING] Resolution failed, trying scroll-and-retry', {
          oldSelector,
          intent: intent.substring(0, 80),
        });

        const scrollResult = await this.scrollAndRetryResolution({
          page,
          intent,
          oldSelector,
          metadata,
        });

        if (scrollResult) {
          return scrollResult;
        }

        logger.warn('[SELF_HEALING] Failed to find replacement selector (including scroll-and-retry)', {
          oldSelector,
          intent,
          mode,
        });

        return {
          success: false,
          oldSelector,
          diff: {
            what_changed: 'No suitable replacement found',
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: 'css',
            confidence: 0,
          },
          suggestion: resolveResult.explanation,
          autoApplied: false,
        };
      }

      // Step 6: Test new selector with dry-run validation
      const newSelector = resolveResult.selectedNode.primarySelector;
      const testResult = await this.testSelectorWithDryRun(page, newSelector);

      if (!testResult.works) {
        logger.warn('[SELF_HEALING] New selector does not work', {
          oldSelector,
          newSelector,
          count: testResult.count,
          isVisible: testResult.isVisible,
          error: testResult.error,
        });

        // ✅ NEW: Try fallback selectors if primary fails
        if (resolveResult.fallbackSelectors && resolveResult.fallbackSelectors.length > 0) {
          logger.info('[SELF_HEALING] Trying fallback selectors', {
            count: resolveResult.fallbackSelectors.length,
          });

          for (const fallback of resolveResult.fallbackSelectors) {
            const fallbackTest = await this.testSelectorWithDryRun(page, fallback.selector);
            if (fallbackTest.works) {
              logger.info('[SELF_HEALING] Fallback selector works!', {
                selector: fallback.selector,
                type: fallback.type,
              });

              // Use fallback selector instead
              const fallbackDuration = Date.now() - startTime;
              return this.buildSuccessResult(
                oldSelector,
                fallback.selector,
                fallback.type,
                fallback.confidence,
                fallbackDuration
              );
            }
          }
        }

        return {
          success: false,
          oldSelector,
          newSelector,
          diff: {
            what_changed: `Found selector but validation failed: ${testResult.error || 'not visible or not unique'}`,
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: resolveResult.selectedNode.selectorType,
            confidence: resolveResult.selectedNode.confidence,
          },
          suggestion: `Tried ${newSelector} but it failed validation (count: ${testResult.count}, visible: ${testResult.isVisible})`,
          autoApplied: false,
        };
      }

      // Step 7: Build success result
      const duration = Date.now() - startTime;
      return this.buildSuccessResult(
        oldSelector,
        newSelector,
        resolveResult.selectedNode.selectorType,
        resolveResult.selectedNode.confidence,
        duration
      );
    } catch (error) {
      logger.error('[SELF_HEALING] Healing failed', {
        error,
        oldSelector,
        intent,
      });

      return {
        success: false,
        oldSelector,
        diff: {
          what_changed: 'Healing process failed',
          old_strategy: this.detectSelectorType(oldSelector),
          new_strategy: 'css',
          confidence: 0,
        },
        suggestion: `Healing failed: ${error instanceof Error ? error.message : String(error)}`,
        autoApplied: false,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VISION-BASED ELEMENT RESOLUTION (Phase 1)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve element using Gemini Vision (screenshot + DOM nodes + intent).
   * Called when embeddings-based resolution fails in accurate mode.
   *
   * Sends a page screenshot alongside the interactive node list and intent
   * to Gemini 2.0 Flash for visual element identification.
   *
   * @returns Matched node ref + confidence, or null if no match
   */
  private static async resolveWithVision(params: {
    screenshot: string; // base64 PNG
    nodes: DOMNode[];
    intent: string;
    actionType: string;
    pageUrl: string;
    viewport: { width: number; height: number };
  }): Promise<{
    ref: string | null;
    confidence: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
    reason: string;
  }> {
    const { screenshot, nodes, intent, actionType, pageUrl, viewport } = params;

    // Build numbered node list for the prompt (max 30 to keep prompt small)
    const visibleNodes = nodes
      .filter(n => n.isVisible && n.boundingBox && n.boundingBox.width > 0)
      .slice(0, 30);

    const nodeList = visibleNodes.map((n, i) => {
      const attrs: string[] = [];
      if (n.attributes['aria-label']) attrs.push(`aria-label="${n.attributes['aria-label']}"`);
      if (n.attributes['placeholder']) attrs.push(`placeholder="${n.attributes['placeholder']}"`);
      if (n.text && n.text.length <= 60) attrs.push(`text="${n.text}"`);
      if (n.attributes['name']) attrs.push(`name="${n.attributes['name']}"`);
      if (n.role) attrs.push(`role="${n.role}"`);
      if (n.attributes['type']) attrs.push(`type="${n.attributes['type']}"`);
      const pos = n.boundingBox
        ? `pos=(${Math.round(n.boundingBox.x)},${Math.round(n.boundingBox.y)},${Math.round(n.boundingBox.width)}x${Math.round(n.boundingBox.height)})`
        : '';
      return `${i + 1}. ref="${n.nodeId}" <${n.tag}> ${attrs.join(' ')} ${pos}`;
    }).join('\n');

    const prompt = `You are an AI element selector for a browser testing tool.

TASK: The user wants to perform a "${actionType}" action described as: "${intent}"
PAGE: ${pageUrl} (viewport: ${viewport.width}x${viewport.height})

Look at the screenshot and identify the target element. Match it to one of the numbered elements below if possible.

ELEMENTS ON PAGE:
${nodeList}

RULES:
1. Use the screenshot to visually identify the correct element
2. Match by visual appearance AND semantic meaning of the intent
3. If you can match to a numbered element, return its ref
4. If the element is visible in the screenshot but NOT in the list, return ref as null and provide bounding box coordinates (x, y, width, height in pixels)
5. Only return refs from the list above — never invent refs
6. If no element matches, return ref as null with confidence 0

Respond ONLY with valid JSON:
{"ref":"node-XX","confidence":0.0-1.0,"reason":"brief explanation"}
Or if element not in list:
{"ref":null,"confidence":0.0-1.0,"boundingBox":{"x":0,"y":0,"width":0,"height":0},"reason":"brief explanation"}`;

    try {
      const response = await generateTextWithGeminiVision({
        prompt,
        imageBase64: screenshot,
        mimeType: 'image/png',
        model: AI_TASK_MODELS.visionElementResolution as any,
        temperature: 0,
        maxTokens: 200,
        timeout: 8000,
      });

      // Parse JSON response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[SELF_HEALING] Vision: no JSON in response', {
          responsePreview: response.content.slice(0, 200),
        });
        return { ref: null, confidence: 0, reason: 'Failed to parse vision response' };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate ref against actual node list
      if (parsed.ref !== null && typeof parsed.ref === 'string') {
        const validRefs = new Set(visibleNodes.map(n => n.nodeId));
        if (!validRefs.has(parsed.ref)) {
          logger.warn('[SELF_HEALING] Vision: hallucinated ref rejected', { ref: parsed.ref });
          return { ref: null, confidence: 0, reason: 'Vision returned invalid ref' };
        }
      }

      const confidence = typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0;

      // Only accept if confidence >= 0.7
      if (confidence < 0.7) {
        return { ref: null, confidence, reason: parsed.reason || 'Low confidence' };
      }

      logger.info('[SELF_HEALING] Vision resolved element', {
        ref: parsed.ref,
        confidence,
        hasBoundingBox: !!parsed.boundingBox,
        reason: (parsed.reason || '').slice(0, 100),
      });

      return {
        ref: parsed.ref ?? null,
        confidence,
        boundingBox: parsed.boundingBox || undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : 'Vision match',
      };
    } catch (error) {
      logger.warn('[SELF_HEALING] Vision resolution failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ref: null, confidence: 0, reason: 'Vision resolution error' };
    }
  }

  /**
   * ✅ DEPRECATED: Use testSelectorWithDryRun() instead
   * Kept for backwards compatibility
   */
  private static async testSelector(page: Page, selector: string): Promise<boolean> {
    const result = await this.testSelectorWithDryRun(page, selector);
    return result.works;
  }

  /**
   * ✅ NEW: Test selector with dry-run validation
   * Returns detailed information about why selector works or doesn't work
   * Uses getLocator() helper to support all Playwright formats (text=, role=, label=)
   */
  private static async testSelectorWithDryRun(page: Page, selector: string): Promise<{
    works: boolean;
    count: number;
    isVisible: boolean;
    error?: string;
  }> {
    try {
      // ✅ CRITICAL FIX: Use getLocator() helper instead of page.locator()
      // This ensures we support text=, role=, label= formats
      const locator = this.getLocatorForPage(page, selector);
      const count = await locator.count();

      if (count === 0) {
        return {
          works: false,
          count: 0,
          isVisible: false,
          error: 'No elements found',
        };
      }

      // Check if element is visible (with short timeout)
      const isVisible = await locator.first().isVisible({ timeout: 2000 }).catch(() => false);

      // ✅ STRICT: Only works if exactly 1 element and visible
      // Multiple elements = ambiguous selector
      return {
        works: count === 1 && isVisible,
        count,
        isVisible,
        error: count > 1 ? `Multiple elements found (${count})` : !isVisible ? 'Element not visible' : undefined,
      };
    } catch (error) {
      logger.debug('[SELF_HEALING] Selector test failed', { selector, error });
      return {
        works: false,
        count: 0,
        isVisible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * ✅ NEW: Get Playwright locator for a page (duplicated from CommandExecutor)
   * This is needed because SelfHealingService doesn't have access to CommandExecutor instance
   * TODO: Extract to shared utility if this grows
   * @returns Locator - all Playwright methods return Locator type
   */
  private static getLocatorForPage(page: Page, selector: string): import('playwright').Locator {
    if (!selector) {
      throw new Error('Selector is required');
    }

    const s = selector.trim();

    // 1. Handle text= format
    const textMatch = s.match(/^text\s*=\s*(.+)$/i);
    if (textMatch) {
      let payload = textMatch[1].trim();
      const regexMatch = payload.match(/^\/(.+?)\/([gimsuy]*)$/);
      if (regexMatch) {
        return page.getByText(new RegExp(regexMatch[1], regexMatch[2]));
      }
      payload = payload.replace(/^["']|["']$/g, '');
      const isExact = textMatch[1].includes('"') || textMatch[1].includes("'");
      return page.getByText(payload, { exact: isExact });
    }

    // 2. Handle label= format
    const labelMatch = s.match(/^label\s*=\s*(.+)$/i);
    if (labelMatch) {
      const label = labelMatch[1].trim().replace(/^["']|["']$/g, '');
      return page.getByLabel(label);
    }

    // 3. Handle role= format
    const roleMatch = s.match(/^role\s*=\s*([^[\s]+)(?:\s*\[name\s*=\s*(.+?)\])?$/i);
    if (roleMatch) {
      const role = roleMatch[1].trim() as any;
      let name = roleMatch[2]?.trim();
      if (name) {
        const nameRegexMatch = name.match(/^\/(.+?)\/([gimsuy]*)$/);
        if (nameRegexMatch) {
          return page.getByRole(role, { name: new RegExp(nameRegexMatch[1], nameRegexMatch[2]) });
        }
        name = name.replace(/^["']|["']$/g, '');
        return page.getByRole(role, { name });
      }
      return page.getByRole(role);
    }

    // 4. Handle contextual locators (has-text, >>, :has, :scope)
    // These are Playwright-specific CSS extensions
    if (s.includes('>>') || s.includes(':has-text(') || s.includes(':has(') || s.includes(':scope')) {
      // ✅ FIX: Handle chained selectors with role=/text=/label= after >>
      // Example: ".relative >> role=textbox" → use proper Playwright chaining
      if (s.includes('>>')) {
        const parts = s.split('>>').map(p => p.trim());

        // Start with first part (usually CSS selector)
        let locator = page.locator(parts[0]);

        // Chain remaining parts using proper Playwright methods
        for (let i = 1; i < parts.length; i++) {
          const part = parts[i];

          // Handle role=value
          const roleMatch = part.match(/^role\s*=\s*(.+?)(?:\[name\s*=\s*["']?(.+?)["']?\])?$/);
          if (roleMatch) {
            const role = roleMatch[1].trim() as any;
            const name = roleMatch[2]?.trim();

            if (name) {
              // Remove quotes if present
              const cleanName = name.replace(/^["']|["']$/g, '');
              locator = locator.getByRole(role, { name: cleanName });
            } else {
              locator = locator.getByRole(role);
            }
            continue;
          }

          // Handle text="value"
          const textMatch = part.match(/^text\s*=\s*["']?(.+?)["']?$/);
          if (textMatch) {
            const text = textMatch[1];
            // Check if it's a regex
            const regexMatch = text.match(/^\/(.+?)\/([gimsuy]*)$/);
            if (regexMatch) {
              try {
                const regex = new RegExp(regexMatch[1], regexMatch[2]);
                locator = locator.getByText(regex);
              } catch {
                locator = locator.getByText(text);
              }
            } else {
              locator = locator.getByText(text);
            }
            continue;
          }

          // Handle label="value"
          const labelMatch = part.match(/^label\s*=\s*["']?(.+?)["']?$/);
          if (labelMatch) {
            const label = labelMatch[1];
            locator = locator.getByLabel(label);
            continue;
          }

          // Fallback: treat as CSS selector
          locator = locator.locator(part);
        }

        return locator;
      }

      return page.locator(s);
    }

    // 5. Handle XPath
    if (s.match(/^(xpath\s*=\s*)?\/{1,2}/i)) {
      const xpath = s.startsWith('xpath=') ? s.slice(6).trim() : s;
      return page.locator(`xpath=${xpath}`);
    }

    // 6. CSS selector (default)
    return page.locator(s);
  }

  /**
   * ✅ NEW: Build success result (extracted for reuse with fallback selectors)
   */
  private static buildSuccessResult(
    oldSelector: string,
    newSelector: string,
    newStrategy: SelectorType,
    confidence: number,
    duration: number
  ): SelfHealingResult {
    const oldStrategy = this.detectSelectorType(oldSelector);
    const whatChanged = this.describeWhatChanged(oldSelector, newSelector, oldStrategy, newStrategy);
    const autoApplied = confidence >= 0.8;

    logger.info('[SELF_HEALING] Successfully healed selector', {
      oldSelector,
      newSelector,
      whatChanged,
      confidence,
      autoApplied,
      duration: `${duration}ms`,
    });

    return {
      success: true,
      oldSelector,
      newSelector,
      diff: {
        what_changed: whatChanged,
        old_strategy: oldStrategy,
        new_strategy: newStrategy,
        confidence,
      },
      suggestion: autoApplied
        ? `Auto-applied: ${newSelector}`
        : `Suggestion: Use ${newSelector} (confidence: ${(confidence * 100).toFixed(0)}%)`,
      autoApplied,
    };
  }

  /**
   * Infer action type from intent description for vision prompt context
   */
  private static inferActionType(intent: string): string {
    const lower = intent.toLowerCase();
    if (lower.includes('click') || lower.includes('press') || lower.includes('tap')) return 'click';
    if (lower.includes('type') || lower.includes('fill') || lower.includes('enter') || lower.includes('input')) return 'type';
    if (lower.includes('select') || lower.includes('choose') || lower.includes('pick')) return 'select';
    if (lower.includes('check') || lower.includes('toggle')) return 'check';
    if (lower.includes('hover')) return 'hover';
    if (lower.includes('scroll')) return 'scroll';
    return 'click'; // Default
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCROLL-AND-RETRY FOR VIRTUALIZED LISTS (Phase 5)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Scroll-and-retry resolution for virtualized lists.
   *
   * When 0 candidates are found, the target element may be below the fold
   * in a virtual scroll container. This method:
   * 1. Finds scrollable containers (overflow-y: auto/scroll)
   * 2. Scrolls incrementally (80% of client height)
   * 3. Re-extracts DOM after each scroll
   * 4. Retries resolution on combined (old + new) nodes
   * 5. Stops when element found or max attempts reached
   *
   * @returns SelfHealingResult if found, null if not
   */
  static async scrollAndRetryResolution(params: {
    page: Page;
    intent: string;
    oldSelector: string;
    metadata: { url: string; projectId?: string; userId?: string };
    maxScrollAttempts?: number;
  }): Promise<SelfHealingResult | null> {
    const { page, intent, oldSelector, metadata, maxScrollAttempts = 5 } = params;

    try {
      // 1. Find scrollable containers (runs in browser context)
      const scrollableContainers: Array<{
        selector: string;
        scrollHeight: number;
        clientHeight: number;
        area: number;
      }> = await page.evaluate(`
        (function() {
          var containers = [];
          var allElements = document.querySelectorAll('*');
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            var style = window.getComputedStyle(el);
            var overflowY = style.overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
              var sel = el.tagName.toLowerCase();
              if (el.id) sel += '#' + el.id;
              else if (el.className && typeof el.className === 'string') {
                sel += '.' + el.className.split(/\\s+/).slice(0, 2).join('.');
              }
              containers.push({
                selector: sel,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                area: el.clientWidth * el.clientHeight,
              });
            }
          }
          containers.sort(function(a, b) { return b.area - a.area; });
          return containers.slice(0, 3);
        })()
      `);

      if (scrollableContainers.length === 0) {
        logger.debug('[SELF_HEALING] No scrollable containers found for scroll-and-retry');
        return null;
      }

      logger.info('[SELF_HEALING] Found scrollable containers for scroll-and-retry', {
        count: scrollableContainers.length,
        containers: scrollableContainers.map(c => ({ sel: c.selector, scrollH: c.scrollHeight, clientH: c.clientHeight })),
      });

      let totalAttempts = 0;
      const allSeenRefs = new Set<string>();

      for (const container of scrollableContainers) {
        if (totalAttempts >= maxScrollAttempts) break;

        for (let attempt = 0; attempt < maxScrollAttempts && totalAttempts < maxScrollAttempts; attempt++) {
          totalAttempts++;

          // Scroll the container (browser context)
          const scrollArgs = {
            sel: container.selector,
            scrollAmount: Math.round(container.clientHeight * 0.8),
          };
          const scrolled = await page.evaluate(`
            (function() {
              var el = document.querySelector('${scrollArgs.sel.replace(/'/g, "\\'")}');
              if (!el) return false;
              var before = el.scrollTop;
              el.scrollBy(0, ${scrollArgs.scrollAmount});
              return el.scrollTop !== before;
            })()
          `);

          if (!scrolled) {
            logger.debug('[SELF_HEALING] Scroll exhausted for container', { selector: container.selector, attempt });
            break; // Container fully scrolled
          }

          // Wait for DOM stability after scroll
          await page.waitForTimeout(500);

          // Re-extract nodes
          const nodes = await DOMNodeExtractor.extractNodes(page, {
            visibleOnly: true,
            interactiveOnly: true,
          });

          // Check for new nodes
          const newNodes = nodes.filter(n => n.nodeId && !allSeenRefs.has(n.nodeId));
          nodes.forEach(n => { if (n.nodeId) allSeenRefs.add(n.nodeId); });

          if (newNodes.length === 0) {
            logger.debug('[SELF_HEALING] No new nodes after scroll', { attempt, totalAttempts });
            break; // No new content loaded
          }

          logger.debug('[SELF_HEALING] New nodes after scroll', { newCount: newNodes.length, totalAttempts });

          // Try resolution on ALL current nodes
          const resolveResult = await AISelectorEngine.resolve({
            intent,
            dom: await page.content(),
            nodes,
            metadata: {
              url: metadata.url,
              viewport: page.viewportSize() || { width: 1920, height: 1080 },
              projectId: metadata.projectId,
              userId: metadata.userId,
            },
            mode: 'fast',
          });

          if (resolveResult.success && resolveResult.selectedNode) {
            const newSelector = resolveResult.selectedNode.primarySelector;
            const testResult = await this.testSelectorWithDryRun(page, newSelector);

            if (testResult.works) {
              logger.info('[SELF_HEALING] Scroll-and-retry found element!', {
                attempts: totalAttempts,
                container: container.selector,
                newSelector,
              });

              return this.buildSuccessResult(
                oldSelector,
                newSelector,
                resolveResult.selectedNode.selectorType,
                resolveResult.selectedNode.confidence,
                0 // Duration tracked by caller
              );
            }
          }
        }
      }

      logger.info('[SELF_HEALING] Scroll-and-retry exhausted without finding element', {
        totalAttempts,
        containersChecked: scrollableContainers.length,
      });
      return null;
    } catch (error) {
      logger.warn('[SELF_HEALING] Scroll-and-retry error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Detect selector type from selector string
   */
  private static detectSelectorType(selector: string): SelectorType {
    if (selector.startsWith('getByRole(')) return 'getByRole';
    if (selector.startsWith('getByLabel(')) return 'getByLabel';
    if (selector.startsWith('getByText(')) return 'getByText';
    if (selector.includes('[data-testid=')) return 'data-testid';
    if (selector.startsWith('//')) return 'xpath';
    return 'css';
  }

  /**
   * Describe what changed between old and new selector
   */
  private static describeWhatChanged(
    oldSelector: string,
    newSelector: string,
    oldStrategy: SelectorType,
    newStrategy: SelectorType
  ): string {
    // Strategy changed
    if (oldStrategy !== newStrategy) {
      return `Strategy changed from ${oldStrategy} to ${newStrategy}`;
    }

    // Same strategy, different selector
    if (oldStrategy === 'css') {
      // Check if class changed
      if (oldSelector.includes('.') && newSelector.includes('.')) {
        return 'CSS classes changed';
      }
      // Check if ID changed
      if (oldSelector.includes('#') && newSelector.includes('#')) {
        return 'Element ID changed';
      }
      return 'CSS selector structure changed';
    }

    if (oldStrategy === 'getByRole') {
      return 'ARIA role or name changed';
    }

    if (oldStrategy === 'getByText') {
      return 'Element text content changed';
    }

    if (oldStrategy === 'data-testid') {
      return 'data-testid attribute changed';
    }

    return 'Selector changed';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POST-SELECTION VERIFICATION AGENT (Phase 8)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Determine whether a healed selector needs visual verification.
   *
   * Verification runs only in the "grey zone" where we're not sure:
   * - Confidence 0.70–0.90 (high enough to try, low enough to doubt)
   * - Escalation was used (fast → accurate)
   * - Multiple close candidates (similarity delta < 0.05)
   *
   * Skipped when:
   * - Confidence >= 0.95 (very high — trust the result)
   * - Confidence < 0.70 (too low — wouldn't have auto-applied anyway)
   * - Coordinate-based click (no selector to verify)
   */
  static shouldVerify(params: {
    confidence: number;
    escalated?: boolean;
    visionUsed?: boolean;
    hasCoordinates?: boolean;
  }): boolean {
    const { confidence, escalated, hasCoordinates } = params;

    // Never verify coordinate-based results (no element to highlight)
    if (hasCoordinates) return false;

    // Very high confidence — trust it
    if (confidence >= 0.95) return false;

    // Grey zone: always verify
    if (confidence >= 0.70 && confidence < 0.90) return true;

    // Escalation was used — verify even at higher confidence
    if (escalated && confidence < 0.95) return true;

    return false;
  }

  /**
   * Visually verify that a healed selector points to the correct element.
   *
   * Steps:
   * 1. Highlight the found element with a red border
   * 2. Take a screenshot of the element + surrounding area
   * 3. Send to Gemini 2.0 Flash: "Is the highlighted element correct?"
   * 4. Parse verification result
   * 5. Clean up highlight overlay
   *
   * @returns Verification result (verified, confidence, reason)
   */
  static async verifySelectedElement(params: {
    page: Page;
    selector: string;
    intent: string;
    actionType: string;
    confidence: number;
  }): Promise<{ verified: boolean; confidence: number; reason: string }> {
    const { page, selector, intent, actionType, confidence } = params;

    const VERIFICATION_TIMEOUT = 5000;
    const MAX_TOKENS = 150;

    try {
      // 1. Get locator and bounding box
      const locator = this.getLocatorForPage(page, selector);
      const boundingBox = await locator.boundingBox();
      if (!boundingBox) {
        logger.warn('[VERIFICATION] Element has no bounding box, skipping verification');
        return { verified: true, confidence: confidence, reason: 'No bounding box — assuming correct' };
      }

      // 2. Add red border highlight to the element using the locator (avoids DOM type issues)
      const highlightHandle = await locator.evaluate((el: any) => {
        // Store original styles
        const originalOutline = el.style.outline || '';
        const originalOutlineOffset = el.style.outlineOffset || '';

        // Apply red border highlight
        el.style.outline = '3px solid red';
        el.style.outlineOffset = '2px';

        return { originalOutline, originalOutlineOffset };
      }).catch(() => null);

      // 3. Take screenshot of the element area + 60px padding
      const padding = 60;
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };
      const clip = {
        x: Math.max(0, boundingBox.x - padding),
        y: Math.max(0, boundingBox.y - padding),
        width: Math.min(boundingBox.width + 2 * padding, viewport.width - Math.max(0, boundingBox.x - padding)),
        height: Math.min(boundingBox.height + 2 * padding, viewport.height - Math.max(0, boundingBox.y - padding)),
      };

      const screenshot = await page.screenshot({
        type: 'png',
        clip,
      });
      const screenshotBase64 = screenshot.toString('base64');

      // 4. Remove highlight immediately (don't leave it for action execution)
      if (highlightHandle) {
        await locator.evaluate((el: any, original: any) => {
          el.style.outline = original.originalOutline;
          el.style.outlineOffset = original.originalOutlineOffset;
        }, highlightHandle).catch(() => {
          // Best effort cleanup
        });
      }

      // 5. Send to Gemini Vision for verification
      const prompt = `You are a verification agent for a browser testing tool.

TASK: A self-healing system chose an element to perform a "${actionType}" action.
USER INTENT: "${intent}"
HEALING CONFIDENCE: ${(confidence * 100).toFixed(0)}%

The element with the RED BORDER in the screenshot is the selected target.

QUESTION: Is this the correct element for the user's intent?

Consider:
- Does the element visually match what "${intent}" describes?
- Is it the right type of element for a "${actionType}" action?
- Could there be a better element nearby that matches the intent more closely?

Respond ONLY with valid JSON:
{"verified":true/false,"confidence":0.0-1.0,"reason":"brief explanation (max 30 words)"}`;

      const response = await generateTextWithGeminiVision({
        prompt,
        imageBase64: screenshotBase64,
        mimeType: 'image/png',
        model: AI_TASK_MODELS.healingVerification as any,
        temperature: 0,
        maxTokens: MAX_TOKENS,
        timeout: VERIFICATION_TIMEOUT,
      });

      // 6. Parse verification response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[VERIFICATION] No JSON in response — defaulting to verified', {
          responsePreview: response.content.slice(0, 200),
        });
        // Fail-open: if verification response is malformed, proceed with original result
        return { verified: true, confidence: confidence, reason: 'Verification response malformed — fail-open' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const verifiedConfidence = typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0;

      const result = {
        verified: parsed.verified === true && verifiedConfidence >= 0.8,
        confidence: verifiedConfidence,
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : 'Unknown',
      };

      logger.info('[VERIFICATION] Element verification result', {
        verified: result.verified,
        confidence: result.confidence,
        reason: result.reason,
        healingConfidence: confidence,
        intent: intent.slice(0, 80),
        selector: selector.slice(0, 80),
      });

      return result;
    } catch (error) {
      // Fail-open: verification errors should NOT block execution
      logger.warn('[VERIFICATION] Verification failed — proceeding with original result (fail-open)', {
        error: error instanceof Error ? error.message : String(error),
        selector: selector.slice(0, 80),
      });
      return {
        verified: true,
        confidence: confidence,
        reason: `Verification error: ${error instanceof Error ? error.message : 'unknown'} — fail-open`,
      };
    }
  }
}
