/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OVERLAY DISMISSER — Pre-survey & pre-flow page cleanup
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Detects and dismisses overlay UI elements (cookie consent, promo modals,
 * loading spinners, dropdowns, tooltips, toasts, drawers, onboarding tours)
 * BEFORE exploration snapshots or flow execution begins.
 *
 * Uses EXISTING infrastructure:
 *   - SnapshotCollector.collect() → obstacleFacts[], activeModalRef, transientState
 *   - IRON_CLAD_MODAL_SELECTORS → zero false-positive modal detection
 *   - CLOSE_BUTTON_SELECTOR → multi-language close button patterns
 *   - LAYER3_FALLBACK_PATTERNS → regex-based obstacle type classification
 *   - OBSTACLE_RECOVERY_MAP → type → recovery action mapping
 *
 * NO new AI calls — all classification is deterministic (ARIA + heuristics).
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { SnapshotCollector } from '../collectors/snapshot-collector';
import { VisualStability } from '../collectors/visual-stability';
import type { LiteSnapshot, ObstacleFact, ObstacleType } from '../lite-types';
import {
  IRON_CLAD_MODAL_SELECTORS,
  CLOSE_BUTTON_SELECTOR,
  LAYER3_FALLBACK_PATTERNS,
  OBSTACLE_RECOVERY_MAP,
} from '@/agent/utils/selectors/modal-detection';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Result of a single overlay dismissal attempt */
export interface DismissalAttempt {
  ref: string;
  obstacleType: ObstacleType;
  recovery: string;
  dismissed: boolean;
  skipped?: boolean;
  skipReason?: string;
  method?: 'escape' | 'button' | 'click_away' | 'wait';
}

/** Options for overlay cleanup */
export interface DismissOptions {
  /** Max number of dismiss passes (for stacked modals). Default: 3 */
  maxPasses?: number;
  /** Max total time for cleanup (ms). Default: 8000 */
  maxTimeMs?: number;
  /** survey = aggressive (dismiss all), flow = conservative (only blocking). Default: survey */
  mode?: 'survey' | 'flow';
}

/** Full result from overlay cleanup */
export interface OverlayCleanupResult {
  /** Number of overlays detected */
  overlaysDetected: number;
  /** Attempts made to dismiss */
  attempts: DismissalAttempt[];
  /** Whether page was in loading state and we waited */
  waitedForLoading: boolean;
  /** Total time spent on cleanup (ms) */
  durationMs: number;
  /** Overlay summary string for AI prompt enhancement */
  overlaySummary: string | null;
  /** Last snapshot after cleanup (caller can reuse to avoid double collection) */
  cleanSnapshot?: LiteSnapshot;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Max iterations for loading wait loop */
const MAX_LOADING_WAIT_ITERATIONS = 5;

// Loading delay replaced by network idle + VisualStability smart wait

/**
 * Smart DOM settle after dismiss actions.
 * Uses VisualStability (element count polling) instead of fixed delays.
 * Fast config: 100ms interval × 3 attempts = 300ms typical, exits early when stable.
 */
async function waitForDomSettle(page: Page): Promise<void> {
  await VisualStability.waitForStable(page, { checkInterval: 100, maxAttempts: 3 });
}

/**
 * Destructive action patterns — NEVER click buttons whose text matches these.
 * Prevents accidental data deletion, logout, or account changes during exploration.
 */
const DESTRUCTIVE_PATTERNS = /\b(delete|remove|cancel\s+subscription|unsubscribe|deactivate|disable|log\s*out|sign\s*out|clear\s+all|erase|reset|terminate|revoke|destroy)\b/i;

/**
 * Extended heuristic patterns for obstacle classification.
 * Used when SnapshotCollector's hintType and LAYER3_FALLBACK_PATTERNS don't match.
 */
const HEURISTIC_PATTERNS: Record<string, { classRegex: RegExp; coverageMax?: number; requiresCloseButton?: boolean }> = {
  drawer: {
    classRegex: /drawer|sidebar|slide[-_]?over|off[-_]?canvas|side[-_]?panel/i,
  },
  dropdown: {
    classRegex: /dropdown|select[-_]?menu|combobox|autocomplete|listbox|menu[-_]?popup/i,
    coverageMax: 0.15,
  },
  tooltip: {
    classRegex: /tooltip|popover|tippy|popper/i,
    coverageMax: 0.10,
  },
  onboarding: {
    classRegex: /onboarding|tour|walkthrough|joyride|introjs|shepherd|welcome[-_]?guide/i,
  },
  chat_widget: {
    classRegex: /intercom|drift|crisp|zendesk|tawk|livechat|hubspot[-_]?chat/i,
    coverageMax: 0.10,
  },
};

/**
 * Promo modal text patterns — detect newsletter/subscription popups.
 */
const PROMO_MODAL_PATTERNS = /\b(subscribe|newsletter|sign\s+up\s+for|get\s+\d+%\s+off|exclusive\s+offer|join\s+our|special\s+deal|discount\s+code|early\s+access)\b/i;

/**
 * Extended close button text patterns for dismiss_button recovery.
 * Reuses CLOSE_BUTTON_SELECTOR for DOM queries, these are for text matching.
 */
const DISMISS_BUTTON_TEXT_PATTERNS = [
  'close', 'dismiss', 'закрыть', 'отклонить',
  'accept', 'accept all', 'agree', 'allow', 'allow all',
  'got it', 'i understand', 'ok', 'okay', 'понятно',
  'consent', 'continue', 'no thanks', 'not now', 'maybe later',
  'skip', 'deny', 'reject', 'decline', 'reject all',
  '×', 'x', '✕', '✖',
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class OverlayDismisser {
  /**
   * Detect and dismiss overlay elements on the page.
   *
   * Phase 0: Wait for loading state to clear (max 5s)
   * Phase 1: Classify obstacles deterministically (no AI)
   * Phase 2: Dismiss in z-index DESC order (topmost first)
   * Phase 3: Build summary for AI prompt
   *
   * @param page — Playwright Page instance
   * @param options — cleanup configuration
   * @returns cleanup result with summary and last clean snapshot
   */
  static async dismissOverlays(
    page: Page,
    options?: DismissOptions,
  ): Promise<OverlayCleanupResult> {
    const startTime = Date.now();
    const maxPasses = options?.maxPasses ?? 3;
    const maxTimeMs = options?.maxTimeMs ?? 8000;
    const mode = options?.mode ?? 'survey';

    const attempts: DismissalAttempt[] = [];
    let waitedForLoading = false;
    let lastSnapshot: LiteSnapshot | undefined;
    let totalDetected = 0;

    try {
      // ── Phase 0: Wait for loading state ─────────────────────────────────
      lastSnapshot = await SnapshotCollector.collect(page, { skipStabilityWait: false });

      if (lastSnapshot.transientState?.isTransient) {
        waitedForLoading = true;

        // Wait for API requests to finish (loading UI often persists until API responds)
        // Use waitForStable only (NOT waitForPageReady — Phase 0 already handles loading polling below)
        try {
          await VisualStability.waitForStable(page, { checkInterval: 150, maxAttempts: 5 });
        } catch {
          // Non-fatal — proceed to polling
        }

        for (let i = 0; i < MAX_LOADING_WAIT_ITERATIONS; i++) {
          if (Date.now() - startTime > maxTimeMs) break;

          await VisualStability.waitForStable(page, { checkInterval: 150, maxAttempts: 4 });
          lastSnapshot = await SnapshotCollector.collect(page, { skipStabilityWait: true });

          if (!lastSnapshot.transientState?.isTransient) break;
        }

        if (lastSnapshot.transientState?.isTransient) {
          logger.debug('[OVERLAY_DISMISSER] Page still loading after wait, proceeding anyway');
        }
      }

      // ── Phase 1 + 2: Classify & dismiss in passes ──────────────────────
      for (let pass = 0; pass < maxPasses; pass++) {
        if (Date.now() - startTime > maxTimeMs) break;

        const obstacles = lastSnapshot.obstacleFacts ?? [];
        if (obstacles.length === 0) break;

        // Classify each obstacle
        const classified = this.classifyObstacles(obstacles);
        totalDetected += classified.length;

        // Filter to dismissible obstacles
        const dismissible = this.filterDismissible(classified, mode);
        if (dismissible.length === 0) break;

        // Sort by z-index DESC (topmost first)
        dismissible.sort((a, b) => b.fact.zIndex - a.fact.zIndex);

        let anyDismissed = false;

        for (const { fact, type } of dismissible) {
          if (Date.now() - startTime > maxTimeMs) break;

          // Destructive guard: if overlay contains destructive text,
          // try safe dismissal (Escape/Cancel) instead of skipping entirely.
          // This handles confirmation dialogs like "Delete item? [Cancel] [Delete]"
          if (isDestructiveOverlay(fact.textPreview)) {
            // Try Escape first — safest way to dismiss confirmation dialogs
            const escResult = await this.executeRecovery(page, fact, type, 'dismiss_escape');
            if (escResult.dismissed) {
              attempts.push(escResult);
              anyDismissed = true;
              continue;
            }
            // Escape didn't work — skip (don't risk clicking destructive button)
            attempts.push({
              ref: fact.ref,
              obstacleType: type,
              recovery: 'skipped',
              dismissed: false,
              skipped: true,
              skipReason: 'destructive content — Escape failed, skipping to avoid data loss',
            });
            continue;
          }

          const recovery = OBSTACLE_RECOVERY_MAP[type] ?? 'dismiss_escape';
          const result = await this.executeRecovery(page, fact, type, recovery);
          attempts.push(result);

          if (result.dismissed) {
            anyDismissed = true;
          }
        }

        // If nothing was dismissed, no point re-checking
        if (!anyDismissed) break;

        // Re-collect snapshot for next pass (catches stacked modals)
        if (pass < maxPasses - 1) {
          await waitForDomSettle(page);
          lastSnapshot = await SnapshotCollector.collect(page, { skipStabilityWait: true });
        }
      }

      // ── Phase 3: Build summary ──────────────────────────────────────────
      // Re-collect final snapshot if any dismissals happened
      const anyDismissed = attempts.some((a) => a.dismissed);
      if (anyDismissed) {
        await waitForDomSettle(page);
        lastSnapshot = await SnapshotCollector.collect(page, { skipStabilityWait: true });
      }

      const overlaySummary = this.buildOverlaySummary(attempts);

      return {
        overlaysDetected: totalDetected,
        attempts,
        waitedForLoading,
        durationMs: Date.now() - startTime,
        overlaySummary,
        cleanSnapshot: lastSnapshot,
      };
    } catch (error) {
      logger.warn('[OVERLAY_DISMISSER] Cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        attemptsCount: attempts.length,
      });

      return {
        overlaysDetected: totalDetected,
        attempts,
        waitedForLoading,
        durationMs: Date.now() - startTime,
        overlaySummary: null,
        cleanSnapshot: lastSnapshot,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLASSIFICATION (deterministic, no AI)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify obstacle facts using a priority cascade:
   * 1. SnapshotCollector's hintType (ARIA/geometry-based)
   * 2. LAYER3_FALLBACK_PATTERNS regex (cookie_consent, toast, loading_overlay)
   * 3. Extended heuristic patterns (drawer, dropdown, tooltip, onboarding, chat_widget)
   * 4. Promo modal detection (text-based)
   * 5. Default: unknown
   */
  private static classifyObstacles(
    facts: ObstacleFact[],
  ): Array<{ fact: ObstacleFact; type: ObstacleType }> {
    return facts.map((fact) => ({
      fact,
      type: this.classifySingle(fact),
    }));
  }

  private static classifySingle(fact: ObstacleFact): ObstacleType {
    // Priority 1: SnapshotCollector's deterministic hint (ARIA, geometry)
    if (fact.hintType && fact.hintType !== 'unknown') {
      return fact.hintType;
    }

    // Priority 2: LAYER3_FALLBACK_PATTERNS (regex on className + id)
    const searchText = `${fact.className} ${fact.id ?? ''} ${fact.textPreview}`;
    for (const [type, pattern] of Object.entries(LAYER3_FALLBACK_PATTERNS)) {
      if (pattern.test(searchText)) {
        return type as ObstacleType;
      }
    }

    // Priority 3: Extended heuristic patterns
    const classAndId = `${fact.className} ${fact.id ?? ''}`;
    for (const [type, config] of Object.entries(HEURISTIC_PATTERNS)) {
      if (config.classRegex.test(classAndId)) {
        // Check coverage constraint if defined
        if (config.coverageMax !== undefined && fact.coverage > config.coverageMax) continue;
        return type as ObstacleType;
      }
    }

    // Priority 4: Promo modal detection (ARIA modal + promo text)
    if (
      (fact.role === 'dialog' || fact.ariaModal || fact.coverage > 0.3) &&
      fact.hasCloseButton &&
      PROMO_MODAL_PATTERNS.test(fact.textPreview)
    ) {
      return 'modal';
    }

    // Priority 5: Default
    return 'unknown';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FILTERING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Filter obstacles to only those worth dismissing.
   * - survey mode: dismiss everything except permanent elements (sticky_header/footer)
   * - flow mode: only dismiss blocking overlays (modal, cookie_consent, loading, onboarding)
   */
  private static filterDismissible(
    classified: Array<{ fact: ObstacleFact; type: ObstacleType }>,
    mode: 'survey' | 'flow',
  ): Array<{ fact: ObstacleFact; type: ObstacleType }> {
    /** Permanent elements that should never be dismissed */
    const PERMANENT_TYPES: ObstacleType[] = ['sticky_header', 'sticky_footer'];

    /** In flow mode, only dismiss these blocking types (pipeline handles the rest) */
    const FLOW_BLOCKING_TYPES: ObstacleType[] = [
      'modal', 'cookie_consent', 'loading_overlay', 'onboarding', 'paywall',
    ];

    return classified.filter(({ type }) => {
      // Never dismiss permanent elements
      if (PERMANENT_TYPES.includes(type)) return false;

      // In flow mode, only dismiss blocking overlays
      if (mode === 'flow' && !FLOW_BLOCKING_TYPES.includes(type)) return false;

      return true;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECOVERY EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute a type-specific recovery action.
   * Adapted from ActionExecutor's tryDismissWithEscape/tryDismissWithSafeButton patterns.
   */
  private static async executeRecovery(
    page: Page,
    fact: ObstacleFact,
    type: ObstacleType,
    recovery: string,
  ): Promise<DismissalAttempt> {
    const base: DismissalAttempt = {
      ref: fact.ref,
      obstacleType: type,
      recovery,
      dismissed: false,
    };

    try {
      switch (recovery) {
        case 'dismiss_escape': {
          const dismissed = await this.tryEscape(page);
          return { ...base, dismissed, method: 'escape' };
        }

        case 'dismiss_button': {
          // Try close/accept button first, then fallback to Escape
          const buttonDismissed = await this.tryCloseButton(page, fact.ref);
          if (buttonDismissed) {
            return { ...base, dismissed: true, method: 'button' };
          }
          const escapeDismissed = await this.tryEscape(page);
          return { ...base, dismissed: escapeDismissed, method: escapeDismissed ? 'escape' : undefined };
        }

        case 'click_away': {
          const dismissed = await this.tryClickAway(page);
          return { ...base, dismissed, method: 'click_away' };
        }

        case 'wait': {
          // Transient overlays (toast, loading) — already handled in Phase 0
          // Just wait a bit more if still present
          await waitForDomSettle(page);
          const stillPresent = await this.isModalPresent(page);
          return { ...base, dismissed: !stillPresent, method: 'wait' };
        }

        case 'scroll_around':
        case 'navigate_back':
          // No-op for exploration — these are permanent/blocking elements
          return { ...base, dismissed: false, skipped: true, skipReason: `${recovery} not applicable in exploration` };

        default:
          return { ...base, dismissed: false };
      }
    } catch (error) {
      logger.debug('[OVERLAY_DISMISSER] Recovery failed', {
        ref: fact.ref,
        type,
        recovery,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...base, dismissed: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DISMISS HELPERS (adapted from ActionExecutor patterns)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Try to dismiss active overlay with Escape key.
   * Adapted from ActionExecutor.tryDismissWithEscape().
   */
  private static async tryEscape(page: Page): Promise<boolean> {
    await page.keyboard.press('Escape');
    await waitForDomSettle(page);
    return !(await this.isModalPresent(page));
  }

  /**
   * Try to find and click a close/accept button inside or near the overlay.
   * Adapted from ActionExecutor.tryDismissWithSafeButton().
   *
   * Strategy:
   *   1. Look inside overlay element (by ref) for CLOSE_BUTTON_SELECTOR
   *   2. Look for buttons matching dismiss text patterns globally (high z-index)
   *   3. Score candidates and click the best one
   */
  private static async tryCloseButton(page: Page, overlayRef: string): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clicked = await page.evaluate(
        (args: { ref: string; selectorStr: string; textPatterns: string[] }) => {
          const doc = (globalThis as any).document;
          const win = (globalThis as any).window;

          // Helper: check if element is visible
          const isVisible = (el: any): boolean => {
            const style = win.getComputedStyle(el);
            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              parseFloat(style.opacity) >= 0.3
            );
          };

          // Collect candidates: first from overlay element, then global
          const candidates: any[] = [];

          // 1. Inside overlay container
          const overlay = doc.querySelector(`[data-agent-ref="${args.ref}"]`);
          if (overlay) {
            const insideButtons = overlay.querySelectorAll(args.selectorStr);
            for (const btn of insideButtons) {
              if (isVisible(btn)) candidates.push(btn);
            }
          }

          // 2. Global high z-index buttons (for overlays without data-agent-ref)
          if (candidates.length === 0) {
            const allButtons = doc.querySelectorAll(
              'button, a, [role="button"], [aria-label*="close" i], [aria-label*="dismiss" i], [aria-label*="accept" i]',
            );
            for (const btn of allButtons) {
              if (!isVisible(btn)) continue;
              const style = win.getComputedStyle(btn);
              const zIndex = parseInt(style.zIndex || '0', 10);
              if (zIndex >= 1 || style.position === 'fixed' || style.position === 'absolute') {
                candidates.push(btn);
              }
            }
          }

          if (candidates.length === 0) return false;

          // Score candidates
          let bestCandidate: any = null;
          let bestScore = -1;

          for (const candidate of candidates) {
            let score = 0;
            const text = (candidate.textContent?.trim() || '').toLowerCase();
            const ariaLabel = (candidate.getAttribute('aria-label') || '').toLowerCase();
            const title = (candidate.getAttribute('title') || '').toLowerCase();
            const allText = `${text} ${ariaLabel} ${title}`;

            // Check against text patterns
            for (const pattern of args.textPatterns) {
              if (allText.includes(pattern.toLowerCase())) {
                score += 3;
                break;
              }
            }

            // Prefer aria-label with "close"
            if (ariaLabel.includes('close') || ariaLabel.includes('закрыть')) score += 2;

            // Prefer short text (icon buttons like X)
            if (text.length <= 3 && text.length > 0) score += 2;

            // Prefer "accept all" (cookie consent specific)
            if (allText.includes('accept all') || allText.includes('allow all')) score += 4;

            // Avoid destructive buttons
            if (/\b(delete|remove|cancel|logout|sign.out)\b/i.test(allText)) score -= 10;

            if (score > bestScore) {
              bestScore = score;
              bestCandidate = candidate;
            }
          }

          if (bestCandidate && bestScore > 0) {
            bestCandidate.click();
            return true;
          }

          return false;
        },
        {
          ref: overlayRef,
          selectorStr: CLOSE_BUTTON_SELECTOR,
          textPatterns: DISMISS_BUTTON_TEXT_PATTERNS,
        },
      );

      if (clicked) {
        await waitForDomSettle(page);
        return !(await this.isModalPresent(page));
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Try to dismiss by clicking an empty area outside the overlay.
   * Used for dropdowns, tooltips, and autocomplete popups.
   */
  private static async tryClickAway(page: Page): Promise<boolean> {
    try {
      const viewportHeight = await page.evaluate(() => (globalThis as any).window.innerHeight);
      // Click at the left edge, vertically centered — usually safe empty space
      await page.mouse.click(10, viewportHeight / 2);
      await waitForDomSettle(page);
      return !(await this.isModalPresent(page));
    } catch {
      return false;
    }
  }

  /**
   * Check if any modal/overlay is still present using IRON_CLAD selectors.
   * This is a lightweight check (no full snapshot collection).
   */
  private static async isModalPresent(page: Page): Promise<boolean> {
    try {
      return await page.evaluate((selectors) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const elements = doc.querySelectorAll(selectors);
        for (const el of elements) {
          const style = win.getComputedStyle(el);
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) >= 0.1
          ) {
            return true;
          }
        }
        return false;
      }, IRON_CLAD_MODAL_SELECTORS);
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY BUILDER
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build human-readable overlay summary for AI prompt injection.
   * Returns null if no overlays were found.
   */
  private static buildOverlaySummary(attempts: DismissalAttempt[]): string | null {
    if (attempts.length === 0) return null;

    const dismissed = attempts.filter((a) => a.dismissed);
    const skipped = attempts.filter((a) => a.skipped);
    const failed = attempts.filter((a) => !a.dismissed && !a.skipped);

    const lines: string[] = [];

    if (dismissed.length > 0) {
      lines.push('DISMISSED OVERLAYS (removed before snapshot):');
      for (const a of dismissed) {
        lines.push(`  - ${a.obstacleType} (ref: ${a.ref}, method: ${a.method})`);
      }
    }

    if (skipped.length > 0) {
      lines.push('SKIPPED OVERLAYS (not dismissed):');
      for (const a of skipped) {
        lines.push(`  - ${a.obstacleType} (ref: ${a.ref}, reason: ${a.skipReason})`);
      }
    }

    if (failed.length > 0) {
      lines.push('REMAINING OVERLAYS (dismiss failed):');
      for (const a of failed) {
        lines.push(`  - ${a.obstacleType} (ref: ${a.ref})`);
      }
    }

    return lines.join('\n');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if overlay text contains destructive action keywords.
 * Prevents accidentally clicking "Delete Account" confirm dialogs.
 */
function isDestructiveOverlay(textPreview: string): boolean {
  return DESTRUCTIVE_PATTERNS.test(textPreview);
}
