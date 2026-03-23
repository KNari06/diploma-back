/**
 * Step Blocker Diagnosis Service
 *
 * When deterministic readiness checks + retry both fail, this service
 * uses a fast LLM call to diagnose WHY a step cannot execute.
 *
 * Input: ~200 tokens of page context (target element HTML, surrounding DOM, page state)
 * Output: structured JSON — blocker reason + optional CSS selector to wait for
 *
 * Called ONCE per step failure, AFTER the first retry has already failed.
 * Cost: ~$0.001 per call (fast model, ~300 tokens total).
 *
 * Flow in execution loop:
 *   Step fails → deterministic retry (1.5s settle + fresh resolution) → still fails →
 *   → diagnoseStepBlocker() → wait for suggested selector → final retry → done
 */

import { logger } from '@/utils/core/logger';
import { generateText } from '@/services/ai/core/ai-provider.service';
import type { Page } from 'playwright';
import type { IntentStep, IntentActionType } from './preview.types';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface BlockerDiagnosis {
  /** What is blocking the step */
  blocker: string;
  /** CSS selector to wait for (disappearance or appearance) */
  waitForSelector?: string;
  /** Wait for this selector to disappear (true) or appear (false) */
  waitForDisappear?: boolean;
  /** Suggested max wait time in ms */
  suggestedWaitMs?: number;
  /** Whether it's worth retrying after waiting */
  shouldRetry: boolean;
  /** Confidence in the diagnosis (0-1) */
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT COLLECTION — lightweight page snapshot for LLM
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collect minimal page context for LLM diagnosis.
 * ~200-400 tokens total. Fast: single page.evaluate() call.
 */
async function collectBlockerContext(
  page: Page,
  step: IntentStep,
  error: string,
): Promise<string> {
  try {
    const pageState = await page.evaluate(
      ({ stepDesc, stepType }: { stepDesc: string; stepType: string }) => {
        // @ts-expect-error - browser context
        const doc = document;
        // @ts-expect-error - browser context
        const win = window;

        // 1. Page basics
        const url = win.location.href;
        const title = doc.title || '';

        // 2. Blockers scan
        const blockers: string[] = [];

        // Loading indicators
        const loadingSels = [
          '[role="progressbar"]', '[aria-busy="true"]',
          '.spinner', '.loader', '.loading', '.skeleton',
          '[data-loading="true"]', '.ant-spin-spinning',
        ];
        for (const sel of loadingSels) {
          const el = doc.querySelector(sel);
          if (el) {
            const s = win.getComputedStyle(el);
            if (s.display !== 'none' && s.visibility !== 'hidden') {
              blockers.push(`LOADING: <${el.tagName.toLowerCase()}> matches "${sel}"`);
            }
          }
        }

        // Overlays (fixed/absolute positioned elements covering viewport)
        const fixedEls = doc.querySelectorAll('[style*="position: fixed"], [style*="position:fixed"]');
        for (const el of fixedEls) {
          const rect = el.getBoundingClientRect();
          if (rect.width > win.innerWidth * 0.5 && rect.height > win.innerHeight * 0.5) {
            const tag = el.tagName.toLowerCase();
            const cls = el.className?.toString().slice(0, 60) || '';
            const role = el.getAttribute('role') || '';
            blockers.push(`OVERLAY: <${tag} class="${cls}" role="${role}"> covers ${Math.round(rect.width)}x${Math.round(rect.height)}`);
          }
        }
        // Also check computed position: fixed
        const allEls = doc.querySelectorAll('*');
        for (const el of allEls) {
          const s = win.getComputedStyle(el);
          if (s.position !== 'fixed') continue;
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > win.innerWidth * 0.3 && rect.height > win.innerHeight * 0.3) {
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const cls = (el.className?.toString() || '').slice(0, 50);
            if (!blockers.some(b => b.includes(cls.slice(0, 20)))) {
              blockers.push(`FIXED_OVERLAY: <${tag} class="${cls}" role="${role}"> ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            }
          }
        }

        // Disabled buttons with loading text
        const disabledBtns = doc.querySelectorAll('button[disabled], [role="button"][aria-disabled="true"]');
        for (const btn of disabledBtns) {
          const text = (btn.textContent || '').trim().slice(0, 40);
          if (text) {
            blockers.push(`DISABLED_BUTTON: "${text}"`);
          }
        }

        // Inert elements
        const inertEls = doc.querySelectorAll('[inert]');
        if (inertEls.length > 0) {
          blockers.push(`INERT: ${inertEls.length} element(s) with inert attribute`);
        }

        // aria-hidden sections
        const ariaHiddenRoots = doc.querySelectorAll('[aria-hidden="true"]');
        const hiddenContainers = Array.from(ariaHiddenRoots).filter((el: any) => {
          return el.children.length > 3; // Only significant containers
        });
        if (hiddenContainers.length > 0) {
          blockers.push(`ARIA_HIDDEN: ${hiddenContainers.length} container(s) marked aria-hidden`);
        }

        // 3. Visible interactive elements near target description
        // This helps LLM understand what IS available vs what step expects
        const interactive = doc.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"]:not([aria-disabled="true"])'
        );
        const visibleInteractive: string[] = [];
        for (const el of interactive) {
          if (visibleInteractive.length >= 8) break;
          const s = win.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 30);
          const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
          const id = el.id ? `#${el.id}` : '';
          visibleInteractive.push(`<${tag}${id}> "${text || label}"`);
        }

        return {
          url: url.slice(0, 120),
          title: title.slice(0, 60),
          blockers,
          visibleElements: visibleInteractive,
        };
      },
      { stepDesc: step.description || '', stepType: step.type }
    );

    // Build context string
    const lines: string[] = [
      `PAGE: ${pageState.url}`,
      `TITLE: "${pageState.title}"`,
      `STEP: ${step.type} — "${step.description || ''}"`,
      `ERROR: ${error.slice(0, 150)}`,
    ];

    if (pageState.blockers.length > 0) {
      lines.push(`DETECTED BLOCKERS:`);
      for (const b of pageState.blockers.slice(0, 6)) {
        lines.push(`  - ${b}`);
      }
    } else {
      lines.push(`DETECTED BLOCKERS: none`);
    }

    if (pageState.visibleElements.length > 0) {
      lines.push(`VISIBLE INTERACTIVE ELEMENTS:`);
      for (const e of pageState.visibleElements) {
        lines.push(`  - ${e}`);
      }
    }

    // Add step's binding hints for element identification
    if (step.bindingHints) {
      const h = step.bindingHints;
      const hints: string[] = [];
      if (h.role) hints.push(`role="${h.role}"`);
      if (h.label) hints.push(`label="${h.label}"`);
      if (h.placeholder) hints.push(`placeholder="${h.placeholder}"`);
      if (h.nearText) hints.push(`nearText="${h.nearText}"`);
      if (h.type) hints.push(`type="${h.type}"`);
      if (hints.length > 0) {
        lines.push(`ELEMENT HINTS: ${hints.join(', ')}`);
      }
    }

    return lines.join('\n');
  } catch (e) {
    return `PAGE: ${page.url()}\nSTEP: ${step.type} — "${step.description}"\nERROR: ${error}\n(context collection failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM DIAGNOSIS
// ═══════════════════════════════════════════════════════════════════════════

const DIAGNOSIS_PROMPT = `You are a web test automation expert diagnosing why a test step failed.

Given the page state and error, determine the MOST LIKELY blocker and suggest a fix.

Common blockers:
1. OVERLAY/MODAL — a cookie banner, dialog, or overlay is covering the target element
2. LOADING — page is still loading data (spinner, skeleton, pending API)
3. NAVIGATION — page navigated but SPA didn't finish rendering
4. ELEMENT_NOT_EXIST — the element doesn't exist on this page (wrong page state)
5. ELEMENT_DISABLED — element exists but is disabled/inert
6. ANIMATION — element is animating (fade-in, slide-in) and not yet interactable
7. WRONG_STATE — page is in unexpected state (logged out, error page, etc.)
8. TIMING — element appeared briefly but was replaced (React re-render, virtual scroll)

Respond ONLY with valid JSON:
{
  "blocker": "SHORT_DESCRIPTION",
  "waitForSelector": "CSS selector to wait for (disappear or appear)",
  "waitForDisappear": true/false,
  "suggestedWaitMs": 3000,
  "shouldRetry": true/false,
  "confidence": 0.0-1.0
}

Rules:
- waitForSelector must be a VALID CSS selector
- If blocker is an overlay, waitForSelector = the overlay selector, waitForDisappear = true
- If element doesn't exist at all, shouldRetry = false
- If page is on wrong URL or logged out, shouldRetry = false
- Keep suggestedWaitMs between 1000-8000
- Be concise in blocker description`;

/**
 * Diagnose why a step failed using LLM.
 *
 * Called AFTER first deterministic retry has already failed.
 * Collects lightweight page context and asks fast LLM for diagnosis.
 *
 * @returns BlockerDiagnosis or null if diagnosis failed/timed out
 */
export async function diagnoseStepBlocker(
  page: Page,
  step: IntentStep,
  error: string,
): Promise<BlockerDiagnosis | null> {
  try {
    const context = await collectBlockerContext(page, step, error);

    logger.debug('[BLOCKER_DIAGNOSIS] Requesting LLM diagnosis', {
      stepId: step.id,
      stepType: step.type,
      contextLength: context.length,
    });

    const response = await generateText({
      prompt: `${DIAGNOSIS_PROMPT}\n\n--- PAGE STATE ---\n${context}`,
      task: 'fast',
      temperature: 0,
      maxTokens: 200,
      timeout: 4000, // Hard cap: 4s
    });

    // Parse JSON response
    const content = response.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[BLOCKER_DIAGNOSIS] LLM response is not JSON', { content: content.slice(0, 200) });
      return null;
    }

    const diagnosis = JSON.parse(jsonMatch[0]) as BlockerDiagnosis;

    // Validate required fields
    if (!diagnosis.blocker || typeof diagnosis.shouldRetry !== 'boolean') {
      logger.warn('[BLOCKER_DIAGNOSIS] Invalid diagnosis structure', { diagnosis });
      return null;
    }

    // Clamp values
    diagnosis.confidence = Math.max(0, Math.min(1, diagnosis.confidence ?? 0.5));
    diagnosis.suggestedWaitMs = Math.max(1000, Math.min(8000, diagnosis.suggestedWaitMs ?? 3000));

    logger.info('[BLOCKER_DIAGNOSIS] Diagnosis complete', {
      stepId: step.id,
      blocker: diagnosis.blocker,
      waitForSelector: diagnosis.waitForSelector,
      waitForDisappear: diagnosis.waitForDisappear,
      shouldRetry: diagnosis.shouldRetry,
      confidence: diagnosis.confidence,
    });

    return diagnosis;
  } catch (e) {
    logger.warn('[BLOCKER_DIAGNOSIS] Diagnosis failed', {
      stepId: step.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Act on a blocker diagnosis — wait for the suggested selector.
 * Returns true if the wait succeeded (something changed), false otherwise.
 */
export async function actOnDiagnosis(
  page: Page,
  diagnosis: BlockerDiagnosis,
): Promise<boolean> {
  if (!diagnosis.waitForSelector) return false;

  const waitMs = diagnosis.suggestedWaitMs ?? 3000;

  try {
    if (diagnosis.waitForDisappear) {
      // Wait for blocker element to disappear
      logger.debug('[BLOCKER_DIAGNOSIS] Waiting for blocker to disappear', {
        selector: diagnosis.waitForSelector,
        waitMs,
      });
      await page.waitForSelector(diagnosis.waitForSelector, {
        state: 'hidden',
        timeout: waitMs,
      });
      return true;
    } else {
      // Wait for target element to appear
      logger.debug('[BLOCKER_DIAGNOSIS] Waiting for element to appear', {
        selector: diagnosis.waitForSelector,
        waitMs,
      });
      await page.waitForSelector(diagnosis.waitForSelector, {
        state: 'visible',
        timeout: waitMs,
      });
      return true;
    }
  } catch {
    logger.debug('[BLOCKER_DIAGNOSIS] Wait timed out, proceeding anyway', {
      selector: diagnosis.waitForSelector,
      disappear: diagnosis.waitForDisappear,
      waitMs,
    });
    return false;
  }
}
