/**
 * Element Resolver Service V8
 * Language-agnostic element resolution using LLM-first selection
 *
 * Architecture:
 * 1. Build HardAllowed/SoftAllowed sets via deterministic DOM-structural rules (sync, fast)
 *    - Only hard exclude: isVisible=false
 *    - Everything else: soft penalty → LLM decides
 * 2. Count-based decision:
 *    - 0 allowed → Gemini Flash rescue (AI with optional vision)
 *    - 1+ allowed → LLM selection (gemini-2.5-flash-lite)
 * 3. Vision second opinion for visual elements (img/svg/canvas) when LLM can't match by text
 *
 * Philosophy: Zero hardcoded text matching. All semantic decisions delegated to LLM.
 * DOM-structural rules only filter by visibility, tag/role compatibility, state.
 * Visual properties (color, shape, icon classes, size) passed to LLM for matching.
 */

import { generateText } from '@/services/ai/core/ai-provider.service';
import { generateTextWithGeminiVision } from '@/services/ai/core/gemini.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { cacheMetrics } from '@/utils/core/cache-metrics';
import type {
    BindingHints,
    IntentActionType,
    IntentStep,
    InteractiveNode,
    LintCandidate,
    LintResult,
    LintStatus,
    TargetFingerprint,
} from './preview.types';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

import { ELEMENT_RESOLVER_CONFIG, PREVIEW_SESSION_CONFIG } from '@/config/testing/playwright-tuning';

const MAX_CANDIDATE_TEXT_LENGTH = ELEMENT_RESOLVER_CONFIG.maxCandidateTextLength;
const MAX_INTENT_TEXT_LENGTH = ELEMENT_RESOLVER_CONFIG.maxIntentTextLength;
const MAX_CANDIDATES_FOR_LLM = ELEMENT_RESOLVER_CONFIG.maxCandidatesForLlm;
const PREVIEW_VIEWPORT = PREVIEW_SESSION_CONFIG.viewport;

/**
 * Action type to expected element tags mapping (HardAllowed filter)
 * Elements not in this list are excluded for the action
 * P1 FIX: Expanded click to include modern UI patterns (list items, table cells, images, etc.)
 */
const ACTION_TO_TAGS: Record<string, string[]> = {
  type: ['input', 'textarea'],
  click: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg', 'canvas', 'summary', 'nav', 'header', 'footer', 'section', 'article'],
  select: ['select'],
  check: ['input'],
  uncheck: ['input'],
  toggle: ['input', 'button', 'div', 'span'],
  open: ['button', 'div', 'select', 'summary', 'details'],
  close: ['button', 'div', 'summary', 'details'],
  hover: ['button', 'a', 'div', 'span', 'img', 'li', 'td', 'th', 'svg', 'label', 'nav', 'header', 'footer', 'section', 'summary'],
  scroll: ['div', 'section', 'main', 'body', 'html'],
  press: ['input', 'textarea', 'button', 'div', 'span'], // FIX #4: contenteditable + role=textbox divs
  upload: ['input', 'button', 'label', 'div', 'span'], // File inputs are often hidden; trigger is a button/label/div
  // V15: Missing action types — same tag sets as their base actions
  dblclick: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg', 'canvas', 'summary'],
  contextmenu: ['button', 'a', 'div', 'span', 'li', 'td', 'th', 'img', 'svg', 'section', 'article'],
  drag_and_drop: ['div', 'span', 'li', 'img', 'button', 'a', 'td', 'th', 'section', 'article'],
  // Mobile actions
  swipe: ['div', 'section', 'main', 'body', 'html', 'ul', 'li', 'span', 'img'],
  long_press: ['button', 'a', 'div', 'span', 'li', 'td', 'th', 'img', 'svg'],
  double_tap: ['button', 'a', 'div', 'span', 'li', 'td', 'th', 'img', 'svg'],
};

/**
 * Role-based allowlist for click actions
 * P1 FIX: Elements with these ARIA roles are allowed for click regardless of tag
 */
const CLICK_ALLOWED_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'option',
  'treeitem',
  'row',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'switch',
]);

/**
 * Role-based allowlist for select actions
 * Custom dropdowns with these ARIA roles are allowed for select regardless of tag
 */
const SELECT_ALLOWED_ROLES = new Set([
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
]);

/**
 * Tags that can serve as custom dropdown triggers (soft-allowed for select action).
 * Many modern frameworks render dropdowns as <button>, <div>, <span>, or <input>
 * without any ARIA roles. These are allowed as soft candidates so the LLM
 * can decide via semantic matching.
 */
const SELECT_SOFT_TAGS = new Set([
  'button',
  'div',
  'span',
  'input',
  'a',
  'li',
]);

/** Actions that require writable state (not readonly) */
const WRITABLE_ACTIONS = new Set(['fill', 'type', 'clear']);

/** Actions that require specific element state */
const STATE_AWARE_ACTIONS: Record<string, { requiredState: string; field: keyof InteractiveNode }> = {
  check: { requiredState: 'unchecked', field: 'checked' },
  uncheck: { requiredState: 'checked', field: 'checked' },
  open: { requiredState: 'closed', field: 'ariaExpanded' },
  close: { requiredState: 'open', field: 'ariaExpanded' },
};

// ═══════════════════════════════════════════════════════════════════════════
// V3: RULE TRACE TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rule trace entry for debugging and logging
 * Records which rules were applied and their effects
 */
export interface RuleTraceEntry {
  ruleId: string;
  version: string;
  action: 'exclude' | 'boost' | 'penalize';
  evidence: string;
  affectedRefs: string[];
}

/**
 * Allowed set classification result
 */
export interface AllowedSetResult {
  /** Elements that pass all hard rules */
  hardAllowed: InteractiveNode[];
  /** Elements that pass hard rules but have soft penalties */
  softAllowed: InteractiveNode[];
  /** Rule trace for debugging */
  ruleTrace: RuleTraceEntry[];
}

/**
 * Fill action should only target editable text-like inputs.
 * Excludes input types that are not textual (checkbox, radio, submit, etc.).
 */
function isFillCompatibleTextField(node: InteractiveNode): boolean {
  if (node.tag === 'textarea') return true;

  if (node.tag === 'input') {
    const t = (node.type || node.inputType || 'text').toLowerCase();
    const disallowed = new Set([
      'button',
      'submit',
      'reset',
      'image',
      'checkbox',
      'radio',
      'file',
      'range',
      'color',
      'date',
      'datetime-local',
      'month',
      'week',
      'time',
      'hidden',
    ]);
    return !disallowed.has(t);
  }

  // Non-standard textbox components (best-effort support).
  if (node.tag === 'div' && node.role === 'textbox') return true;

  // FIX #8: contenteditable elements are type-compatible regardless of tag
  if (node.isContentEditable) return true;

  return false;
}

/**
 * Build HardAllowed and SoftAllowed sets based on deterministic DOM-structural rules.
 * Synchronous — no AI calls. All semantic matching delegated to LLM.
 *
 * Rules:
 * 1. Visibility (isVisible=false → hard exclude — only hard exclude)
 * 2. Disabled → soft penalty (LLM decides)
 * 3. Readonly for writable actions → soft penalty
 * 3b. Tag/type compatibility → soft penalty
 * 4. State-aware checks (check/uncheck/open/close) → soft penalty
 * 5. Tag/role compatibility → soft penalty
 * Soft: covered by overlay, dynamic ID
 */
export function buildAllowedSets(
  nodes: InteractiveNode[],
  actionType: IntentActionType,
): AllowedSetResult {
  const hardAllowed: InteractiveNode[] = [];
  const softAllowed: InteractiveNode[] = [];
  const ruleTrace: RuleTraceEntry[] = [];

  // P1+P2 CRITICAL: Position-aware modal/dialog/popup layer detection
  // If a modal is present, visible, AND covers a significant portion of the viewport,
  // elements behind it should be HARD excluded.
  // Cookie banners (small, bottom/top-positioned) should NOT trigger full modal exclusion.
  const modalNode = nodes.find(
    (n) =>
      n.isVisible &&
      (n.role === 'dialog' ||
        n.role === 'alertdialog' ||
        n.tag === 'dialog' ||
        (n.isTopMostAtCenter === true &&
         (n.role === 'region' || n.role === 'presentation') &&
         (n.ariaLabel?.toLowerCase().includes('modal') ||
          n.ariaLabel?.toLowerCase().includes('dialog'))))
  );

  // ✅ FIX: Also detect modal presence via isInsideActiveModal flag from snapshot collector.
  // Snapshot collector has a broader modal detection (covers custom popups, drawers, overlays)
  // than the role-based check above. If ANY node has isInsideActiveModal=true,
  // the snapshot collector detected an active modal/popup layer.
  const hasModalFlaggedElements = nodes.some(n => n.isInsideActiveModal === true);

  // Position-aware: only treat as blocking modal if it covers significant viewport area
  // Cookie banners are typically small (< 30% viewport area) and positioned at edges
  let hasVisibleModal = false;
  if (modalNode) {
    const bb = modalNode.boundingBox;
    if (bb && bb.width > 0 && bb.height > 0) {
      // Estimate viewport as max bounding box across all visible nodes
      let maxRight = 0;
      let maxBottom = 0;
      for (const n of nodes) {
        if (n.boundingBox && n.isVisible) {
          maxRight = Math.max(maxRight, n.boundingBox.x + n.boundingBox.width);
          maxBottom = Math.max(maxBottom, n.boundingBox.y + n.boundingBox.height);
        }
      }
      const viewportArea = maxRight * maxBottom;
      const modalArea = bb.width * bb.height;
      // Modal must cover at least 30% of visible area to be considered blocking
      // This filters out cookie banners, notification bars, etc.
      const coverageRatio = viewportArea > 0 ? modalArea / viewportArea : 0;
      hasVisibleModal = coverageRatio >= 0.3;

      if (!hasVisibleModal) {
        ruleTrace.push({
          ruleId: 'modal.small_overlay_skipped',
          version: 'v2',
          action: 'penalize',
          evidence: `Dialog/modal found but only covers ${(coverageRatio * 100).toFixed(0)}% of viewport (< 30% threshold)`,
          affectedRefs: modalNode.ref ? [modalNode.ref] : [],
        });
      }
    } else {
      // No bounding box info — fall back to treating it as blocking
      hasVisibleModal = true;
    }
  } else if (hasModalFlaggedElements) {
    // ✅ FIX: Snapshot collector detected an active modal/popup (broader detection)
    // even though no node matched the role-based check above.
    // Trust the snapshot collector's judgment — it uses z-index, positioning, coverage,
    // and class-name heuristics to detect custom popups/overlays/drawers.
    hasVisibleModal = true;
    ruleTrace.push({
      ruleId: 'modal.detected_via_snapshot',
      version: 'v2',
      action: 'exclude',
      evidence: 'Modal/popup detected by snapshot collector (isInsideActiveModal flag present on nodes)',
      affectedRefs: [],
    });
  }

  if (hasVisibleModal) {
    ruleTrace.push({
      ruleId: 'modal.detected',
      version: 'v2',
      action: 'exclude',
      evidence: 'Blocking modal/dialog layer detected - background elements will be hard-excluded',
      affectedRefs: modalNode?.ref ? [modalNode.ref] : [],
    });
  }
  
  for (const node of nodes) {
    // Skip nodes without valid ref
    if (!node.ref || node.ref.trim().length === 0) {
      continue;
    }
    
    let excluded = false;
    let isSoft = false;
    const nodeRules: RuleTraceEntry[] = [];
    const isNonStandardTextbox = actionType === 'type' && node.tag === 'div' && node.role === 'textbox';
    
    // ═══════════════════════════════════════════════════════════════════════
    // HARD RULES: Exclude elements that are fundamentally incompatible
    // ═══════════════════════════════════════════════════════════════════════
    
    // Rule 1: Visibility check
    if (node.isVisible === false) {
      excluded = true;
      nodeRules.push({
        ruleId: 'visibility.hidden',
        version: 'v1',
        action: 'exclude',
        evidence: 'isVisible=false',
        affectedRefs: [node.ref],
      });
    }
    
    // Rule 2: Disabled check → soft penalty (LLM decides)
    if (!excluded && node.isDisabled) {
      isSoft = true;
      nodeRules.push({
        ruleId: 'state.disabled',
        version: 'v3',
        action: 'penalize',
        evidence: 'isDisabled=true — soft penalty, LLM decides',
        affectedRefs: [node.ref],
      });
    }

    // Rule 3: Readonly for writable actions → soft penalty (LLM decides)
    if (!excluded && WRITABLE_ACTIONS.has(actionType) && node.readOnly) {
      isSoft = true;
      nodeRules.push({
        ruleId: 'state.readonly',
        version: 'v3',
        action: 'penalize',
        evidence: `readOnly=true for action=${actionType} — soft penalty, LLM decides`,
        affectedRefs: [node.ref],
      });
    }

    // Rule 3b: Type must target text-like editable fields only → soft penalty (LLM decides)
    if (!excluded && actionType === 'type' && !isFillCompatibleTextField(node)) {
      isSoft = true;
      nodeRules.push({
        ruleId: 'type.incompatible_field_type',
        version: 'v3',
        action: 'penalize',
        evidence: `tag=${node.tag}, type=${node.type || node.inputType || 'unknown'} — soft penalty, LLM decides`,
        affectedRefs: [node.ref],
      });
    }

    // Rule 4: State-aware action checks → soft penalty (LLM decides)
    if (!excluded) {
      const stateCheck = STATE_AWARE_ACTIONS[actionType];
      if (stateCheck) {
        const currentState = node[stateCheck.field];
        if (currentState !== undefined) {
          const isCorrectState =
            (stateCheck.requiredState === 'unchecked' && currentState === false) ||
            (stateCheck.requiredState === 'checked' && currentState === true) ||
            (stateCheck.requiredState === 'closed' && currentState === false) ||
            (stateCheck.requiredState === 'open' && currentState === true);

          if (!isCorrectState) {
            isSoft = true;
            nodeRules.push({
              ruleId: 'state.mismatch',
              version: 'v3',
              action: 'penalize',
              evidence: `${stateCheck.field}=${currentState}, required=${stateCheck.requiredState} — soft penalty, LLM decides`,
              affectedRefs: [node.ref],
            });
          }
        }
      }
    }
    
    // Rule 5: Tag compatibility for action
    if (!excluded) {
      const allowedTags = ACTION_TO_TAGS[actionType];
      if (allowedTags && allowedTags.length > 0) {
        const tagMatches = allowedTags.includes(node.tag.toLowerCase());

        // P1 FIX: Role-based allowlist for click actions
        // Elements with interactive ARIA roles should be allowed regardless of tag
        // For select: also allow elements with aria-expanded (dropdown triggers without explicit ARIA role)
        // FIX #5: Also check aria-haspopup for dropdown triggers without aria-expanded
        const isDropdownLike = actionType === 'select' && (
          node.ariaExpanded !== undefined || node.hasAriaHaspopup
        );
        const roleMatches =
          (actionType === 'click' && node.role && CLICK_ALLOWED_ROLES.has(node.role)) ||
          // FIX #3: hover uses same interactive roles as click
          (actionType === 'hover' && node.role && CLICK_ALLOWED_ROLES.has(node.role)) ||
          (actionType === 'select' && (
            (node.role && SELECT_ALLOWED_ROLES.has(node.role)) || isDropdownLike
          ));

        // For select action: soft-allow common interactive tags as potential custom dropdown triggers.
        // Many modern frameworks render dropdowns as <button>/<div>/<span> without ARIA roles.
        const isSelectSoftTag = actionType === 'select' && !tagMatches && !roleMatches
          && SELECT_SOFT_TAGS.has(node.tag.toLowerCase());

        // Phase 4: Soft-allow framework-clickable elements for click action.
        // React/Vue/Angular elements with synthetic events look non-interactive by tag alone.
        // Also soft-allow any element with onclick, tabindex >= 0, or aria-expanded/aria-haspopup.
        const hasClickSignal =
          actionType === 'click' &&
          !tagMatches &&
          !roleMatches &&
          (
            !!node.frameworkClickable ||
            !!node.hasOnclick ||
            (node.tabIndex !== undefined && node.tabIndex >= 0) ||
            node.ariaExpanded !== undefined ||
            node.hasAriaHaspopup
          );

        // Phase 4: Soft-allow framework-bound/interactive elements for hover action.
        // Hover can target anything that is interactive — same signals as click.
        const hasHoverSignal =
          actionType === 'hover' &&
          !tagMatches &&
          !roleMatches &&
          (
            !!node.frameworkClickable ||
            !!node.hasOnclick ||
            (node.tabIndex !== undefined && node.tabIndex >= 0) ||
            node.ariaExpanded !== undefined ||
            node.hasAriaHaspopup
          );

        // Phase 4: Soft-allow contenteditable elements for type action.
        const isContentEditable =
          actionType === 'type' &&
          !tagMatches &&
          !isNonStandardTextbox &&
          !roleMatches &&
          !!node.isContentEditable;

        // Exception: allow non-standard textbox components for type as SoftAllowed.
        if (!tagMatches && !isNonStandardTextbox && !roleMatches && !isSelectSoftTag && !hasClickSignal && !hasHoverSignal && !isContentEditable) {
          isSoft = true;
          nodeRules.push({
            ruleId: 'tag.incompatible',
            version: 'v3',
            action: 'penalize',
            evidence: `tag=${node.tag}, role=${node.role || 'none'} not in allowed [${allowedTags.join(',')}] for action=${actionType} — soft penalty, LLM decides`,
            affectedRefs: [node.ref],
          });
        } else if (isNonStandardTextbox) {
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.nonstandard_textbox',
            version: 'v1',
            action: 'penalize',
            evidence: 'div with role=textbox allowed as soft candidate',
            affectedRefs: [node.ref],
          });
        } else if (roleMatches && !tagMatches && actionType === 'click') {
          // Role-based match for click: allow but log for visibility
          nodeRules.push({
            ruleId: 'role.click_allowed',
            version: 'v1',
            action: 'boost',
            evidence: `tag=${node.tag} allowed via role=${node.role} for click`,
            affectedRefs: [node.ref],
          });
        } else if ((roleMatches || isDropdownLike) && !tagMatches && actionType === 'select') {
          // Custom dropdown via ARIA role or aria-expanded: soft-allow (prefer native <select>)
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.custom_dropdown',
            version: 'v1',
            action: 'penalize',
            evidence: `tag=${node.tag}, role=${node.role || 'none'}, ariaExpanded=${node.ariaExpanded} allowed as soft candidate for select`,
            affectedRefs: [node.ref],
          });
        } else if (isSelectSoftTag) {
          // Custom dropdown trigger without ARIA: soft-allow with heavier penalty
          // LLM will decide via semantic matching
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.custom_dropdown_trigger',
            version: 'v1',
            action: 'penalize',
            evidence: `tag=${node.tag} soft-allowed as potential custom dropdown trigger for select (no ARIA role)`,
            affectedRefs: [node.ref],
          });
        } else if (hasClickSignal) {
          // Phase 4: Framework-bound or explicitly interactive custom element.
          // No standard ARIA role or interactive tag, but has a JS click signal.
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.framework_clickable',
            version: 'v4',
            action: 'penalize',
            evidence: `tag=${node.tag} soft-allowed for click: frameworkClickable=${node.frameworkClickable || false}, onclick=${!!node.hasOnclick}, tabIndex=${node.tabIndex}, ariaExpanded=${node.ariaExpanded}, ariaHaspopup=${!!node.hasAriaHaspopup}`,
            affectedRefs: [node.ref],
          });
        } else if (hasHoverSignal) {
          // V8: Framework-bound or explicitly interactive element for hover action.
          // Same rationale as click — custom elements with JS handlers can be hover targets.
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.framework_hoverable',
            version: 'v8',
            action: 'penalize',
            evidence: `tag=${node.tag} soft-allowed for hover: frameworkClickable=${node.frameworkClickable || false}, onclick=${!!node.hasOnclick}, tabIndex=${node.tabIndex}`,
            affectedRefs: [node.ref],
          });
        } else if (isContentEditable) {
          // Phase 4: contenteditable region (rich text editor, inline text field).
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.contenteditable',
            version: 'v4',
            action: 'penalize',
            evidence: `tag=${node.tag} with contenteditable soft-allowed for type/fill action`,
            affectedRefs: [node.ref],
          });
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // SOFT RULES: Penalize but don't exclude
    // ═══════════════════════════════════════════════════════════════════════

    if (!excluded) {
      // ✅ FIX: Layer-aware coverage logic.
      // Elements INSIDE the active modal/popup are NEVER excluded for isTopMostAtCenter,
      // because the user interacts with the popup layer, not the background.
      // Elements OUTSIDE the modal with isTopMostAtCenter=false are background → exclude.
      if (node.isTopMostAtCenter === false) {
        if (node.isInsideActiveModal) {
          // Element is inside the popup/modal — keep it regardless of hit test.
          // Popup backdrops can cause false negatives in elementFromPoint.
          // No penalty: this is the active layer the user sees.
        } else if (hasVisibleModal) {
          // Soft penalty: likely behind modal layer — LLM decides
          isSoft = true;
          nodeRules.push({
            ruleId: 'modal.likely_background',
            version: 'v3',
            action: 'penalize',
            evidence: 'isTopMostAtCenter=false, not inside modal, modal present — soft penalty, LLM decides',
            affectedRefs: [node.ref],
          });
        } else {
          // SOFT penalty: element is covered but no modal detected
          isSoft = true;
          nodeRules.push({
            ruleId: 'visibility.covered',
            version: 'v1',
            action: 'penalize',
            evidence: 'isTopMostAtCenter=false (no modal)',
            affectedRefs: [node.ref],
          });
        }
      }
      
      // Soft Rule 2: Dynamic ID (less reliable)
      if (node.isDynamicId) {
        isSoft = true;
        nodeRules.push({
          ruleId: 'stability.dynamic_id',
          version: 'v1',
          action: 'penalize',
          evidence: 'isDynamicId=true',
          affectedRefs: [node.ref],
        });
      }
      
      // Soft Rule 3: Non-standard role (e.g., div with role=textbox)
      // Handled earlier (Rule 5 exception) to avoid being excluded by tag checks.
    }
    
    // Add to appropriate set
    if (!excluded) {
      if (isSoft) {
        softAllowed.push(node);
      } else {
        hardAllowed.push(node);
      }
    }

    // Add all rules for this node to trace
    ruleTrace.push(...nodeRules);
  }
  
  // Log rule trace summary
  const modalElementCount = hasVisibleModal
    ? [...hardAllowed, ...softAllowed].filter(n => n.isInsideActiveModal).length
    : 0;
  logger.debug('[ELEMENT_RESOLVER] Built allowed sets', {
    hardAllowedCount: hardAllowed.length,
    softAllowedCount: softAllowed.length,
    rulesApplied: ruleTrace.length,
    hasVisibleModal,
    modalElementCount,
  });

  return { hardAllowed, softAllowed, ruleTrace };
}

/**
 * Compute simple hash for text (for cache keys)
 */
function computeTextHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Compute page signature for cache key.
 * V8: Added content hash (first 10 node texts) to detect DOM mutations
 * that preserve refs but change element content.
 */
function computePageSignature(url: string, nodes: InteractiveNode[]): string {
  const refs = nodes.map(n => n.ref || '').join(',');
  // V8: Include content hash — detect text changes within same ref structure
  const contentSample = nodes.slice(0, 10)
    .map(n => (n.text || n.labelText || n.ariaLabel || '').slice(0, 20))
    .join('|');
  const data = `${url}|${nodes.length}|${refs}|${contentSample}`;
  return computeTextHash(data);
}

// ═══════════════════════════════════════════════════════════════════════════
// CANDIDATE TEXT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build semantic text representation for a candidate node
 * Priority-ordered template with length cap
 * @param node - Interactive node from DOM analysis
 * @returns Semantic text for LLM matching (max 200 chars)
 */
export function buildCandidateText(node: InteractiveNode): string {
  const parts: string[] = [];

  // Container context FIRST (hierarchy awareness)
  // Phase 7: Include landmark role for richer context
  if (node.nearestLandmark || (node.containerTitles && node.containerTitles.length > 0)) {
    const segments: string[] = [];
    if (node.nearestLandmark) segments.push(node.nearestLandmark);
    if (node.containerTitles && node.containerTitles.length > 0) {
      segments.push(...node.containerTitles.slice(0, 2));
    }
    parts.push(`[${segments.join(' > ')}]`);
  }

  // Primary labels (most semantic) - mutually exclusive
  if (node.labelText) {
    parts.push(node.labelText);
  } else if (node.ariaLabel) {
    parts.push(node.ariaLabel);
  }

  // Title attribute (tooltip — especially useful for icon-only buttons)
  if (node.title && node.title !== node.labelText && node.title !== node.ariaLabel && node.title !== node.text) {
    parts.push(`title: ${node.title}`);
  }

  // Icon-only button hint (helps LLM bridge visual ↔ semantic gap)
  if (node.isIconButton) {
    parts.push('icon-button');
  }

  // Secondary hints
  if (node.placeholder) {
    parts.push(`placeholder: ${node.placeholder}`);
  }

  // Text content (if different from all previously emitted labels and short enough)
  if (node.text && node.text !== node.labelText && node.text !== node.ariaLabel && node.text !== node.title && node.text.length <= 50) {
    parts.push(node.text);
  }

  // Near text: row/sibling context for disambiguation of duplicate elements
  // e.g. "Delete" button near "Anna Lee" → "near: Anna Lee, anna@mail.com"
  if (node.nearText) {
    parts.push(`near: ${node.nearText}`);
  }

  // Structural hints (lower priority)
  if (node.autocomplete) {
    parts.push(`autocomplete: ${node.autocomplete}`);
  }

  // Name attribute (if not dynamic)
  if (node.name && !node.isDynamicId && node.name !== node.id) {
    parts.push(`name: ${node.name}`);
  }

  // Test ID (useful for disambiguation)
  if (node.testIdAttr) {
    parts.push(`testid: ${node.testIdAttr}`);
  }

  // V22: Stable id (after isDynamicId filter — framework-generated ids are
  // already stripped at snapshot collection). Critical for icon-only elements
  // (svg/img/i) where description-style matching fails — without `id` in the
  // candidate text, LLM can't bridge a recorded `'layout-header-setting'`
  // intent to the live svg that bears that exact id.
  if (node.id && !node.isDynamicId) {
    parts.push(`id: ${node.id}`);
  }

  // V22: href for <a> tags. Differentiates duplicate link text by destination
  // (5 "Read more" links → distinct hrefs disambiguate).
  if (node.tag === 'a' && (node as any).href) {
    const hrefShort = String((node as any).href).slice(0, 80);
    parts.push(`href: ${hrefShort}`);
  }

  // V22 Pkg1: child icon testid. For descriptor-poor IconButton-shaped
  // targets the lifted child testid (`VisibilityOffOutlinedIcon`) is what
  // makes the candidate identifiable to the resolver.
  if ((node as any).childTestId) {
    parts.push(`icon: ${(node as any).childTestId}`);
  } else if ((node as any).iconLabel) {
    // V22 Pkg4: semantic icon label from svg <title> / data-lucide /
    // sprite href / FA class. Fallback for `<div role="button"><svg/></div>`
    // patterns where childTestId is unavailable. Same `icon:` key so the
    // LLM-prompt rules apply uniformly.
    parts.push(`icon: ${(node as any).iconLabel}`);
  }

  // V22 Pkg1: data-value for Select option / MenuItem / chip semantic key.
  // Same logical option matches across i18n re-localization.
  if ((node as any).dataValue) {
    parts.push(`value: ${(node as any).dataValue}`);
  }

  // V22 Pkg1: aria-valuenow / aria-valuetext for slider / spinbutton /
  // progressbar. Lets LLM pick the right control by its semantic value
  // even when multiple identical-shape sliders coexist on a page.
  const liveValueText = (node as any).ariaValueText;
  const liveValueNow = (node as any).ariaValueNow;
  if (liveValueText) {
    parts.push(`value: ${liveValueText}`);
  } else if (typeof liveValueNow === 'number') {
    parts.push(`value: ${liveValueNow}`);
  }

  // V22 Pkg2: Bootstrap / aria-haspopup / activedescendant / row-key.
  // These are present on a small subset of elements so the candidateText
  // stays compact when absent. Each surfaces a different disambiguator:
  //   - bsToggle="modal" / bsTarget="#editForm" → real Bootstrap trigger
  //   - aria-haspopup="menu" → genuine popup-button vs styled lookalike
  //   - data-row-key → table row identity even after re-paginate
  //   - aria-activedescendant → which Combobox option is currently focused
  if ((node as any).bsToggle) {
    parts.push(`bsToggle: ${(node as any).bsToggle}`);
  }
  if ((node as any).bsTarget) {
    parts.push(`bsTarget: ${String((node as any).bsTarget).slice(0, 60)}`);
  }
  if ((node as any).ariaHasPopup) {
    parts.push(`hasPopup: ${(node as any).ariaHasPopup}`);
  }
  if ((node as any).dataRowKey) {
    parts.push(`rowKey: ${(node as any).dataRowKey}`);
  }
  if ((node as any).ariaActiveDescendant) {
    parts.push(`activeDescendant: ${(node as any).ariaActiveDescendant}`);
  }
  if ((node as any).rowClickable) {
    // Soft hint that this <tr> is interactive — helps LLM treat it as a
    // candidate for "click row" intents that lack an explicit role/onclick.
    parts.push('clickable-row');
  }

  // V22 Pkg5: row text + sibling index + disabled + arrow direction.
  // nearestRowText is THE big disambiguator for descriptor-poor row
  // checkboxes — surfaces the row's payload (name/id/etc) directly to
  // the LLM. Truncated to 100 chars to keep candidateText compact.
  if ((node as any).nearestRowText) {
    const rt = String((node as any).nearestRowText).slice(0, 100);
    parts.push(`row: ${rt}`);
  }
  // siblingIndex helps LLM pick "the second of two pagination buttons"
  // when both look identical at the DOM level. 0-indexed in fingerprint
  // but emitted 1-indexed in candidateText (more natural for prompting).
  if (typeof (node as any).siblingIndex === 'number') {
    parts.push(`pos: ${((node as any).siblingIndex as number) + 1}`);
  }
  // disabled state — distinguishes prev (disabled) from next (enabled).
  if ((node as any).disabled === true) {
    parts.push('disabled');
  } else if ((node as any).disabled === false) {
    parts.push('enabled');
  }
  // arrowDir — last-resort hint when a button has no name and only an svg.
  if ((node as any).arrowDir) {
    parts.push(`arrow: ${(node as any).arrowDir}`);
  }

  // ARIA state hints (helps LLM match "selected tab", "expanded menu", "pressed toggle")
  const stateHints: string[] = [];
  if (node.isDisabled) stateHints.push('disabled');
  if (node.readOnly) stateHints.push('readonly');
  if (node.ariaSelected === true) stateHints.push('selected');
  if (node.ariaPressed === true) stateHints.push('pressed');
  if (node.ariaExpanded === true) stateHints.push('expanded');
  else if (node.ariaExpanded === false) stateHints.push('collapsed');
  if (node.ariaChecked === true || node.checked === true) stateHints.push('checked');
  else if (node.ariaChecked === 'mixed') stateHints.push('indeterminate');
  // V22: invalid state — recorded "click on invalid email field with red border"
  // must match a live invalid input, not a freshly-cleared valid one.
  if ((node as any).invalid === true) stateHints.push('invalid');
  // V22 Pkg1: aria-current — "click current page" disambiguator for
  // Pagination / Stepper / Breadcrumbs.
  const liveAriaCurrent = (node as any).ariaCurrent;
  if (liveAriaCurrent) stateHints.push(`current=${liveAriaCurrent}`);
  if (stateHints.length > 0) {
    parts.push(`[${stateHints.join(', ')}]`);
  }

  // Active layer hint (element is inside the foreground modal/popup/dropdown overlay)
  if (node.isInsideActiveModal) {
    parts.push('[active-layer]');
  }

  // V8: Visual properties — enables "grey button", "rounded icon", "red cancel"
  const visualHints: string[] = [];
  if (node.backgroundColor && node.backgroundColor !== 'white' && node.backgroundColor !== 'transparent') {
    visualHints.push(node.backgroundColor);
  }
  if (node.shapeHint) {
    visualHints.push(node.shapeHint);
  }
  if (node.iconClasses) {
    visualHints.push(`icon: ${node.iconClasses}`);
  }
  if (node.sizeHint) {
    visualHints.push(node.sizeHint);
  }
  if (visualHints.length > 0) {
    parts.push(`[${visualHints.join(', ')}]`);
  }

  // Position hint — lets LLM understand spatial layout (overlays, drawers, dropdowns)
  if (node.boundingBox) {
    const bb = node.boundingBox;
    parts.push(`@(${Math.round(bb.x)},${Math.round(bb.y)},${Math.round(bb.width)}x${Math.round(bb.height)})`);
  }

  // Phase 4: Custom component signals (rich text editor, framework buttons)
  if (node.isContentEditable) {
    parts.push('editable');
  }
  if (node.frameworkClickable) {
    parts.push('interactive');
  }

  // V9: iframe context — helps LLM distinguish main page vs embedded content
  if (node.iframeSource) {
    parts.push(`[iframe: ${node.iframeSource}]`);
  }

  // Tag/role/type (last, for disambiguation)
  let tagPart = `<${node.tag}`;
  if (node.role && node.role !== node.tag) {
    tagPart += ` role=${node.role}`;
  }
  if (node.type) {
    tagPart += ` type=${node.type}`;
  }
  tagPart += '>';
  parts.push(tagPart);

  // Join and cap length
  const result = parts.join(' | ');
  return result.slice(0, MAX_CANDIDATE_TEXT_LENGTH);
}

/**
 * Build a brief page scene summary from candidate nodes.
 * Gives the LLM a top-down understanding of the page state
 * (which dropdowns are open, which tabs are selected, whether a modal is active).
 */
function buildSceneSummary(
  candidates: Array<{ node: InteractiveNode; candidateText: string }>
): string {
  const scenes: string[] = [];

  // Detect expanded containers (open dropdowns, accordions, menus)
  const expanded = candidates.filter(c => c.node.ariaExpanded === true);
  for (const c of expanded) {
    const label = c.node.labelText || c.node.ariaLabel || c.node.text || c.node.tag;
    scenes.push(`"${label}" is expanded/open`);
  }

  // Detect selected tabs
  const selected = candidates.filter(c => c.node.ariaSelected === true);
  for (const c of selected) {
    const label = c.node.labelText || c.node.ariaLabel || c.node.text || c.node.tag;
    scenes.push(`"${label}" tab is selected`);
  }

  // Detect active modal/popup layer (from snapshot collector heuristics)
  const modalElements = candidates.filter(c => c.node.isInsideActiveModal === true);
  if (modalElements.length > 0) {
    scenes.push(`A modal/popup is open with ${modalElements.length} interactive elements`);
  }

  if (scenes.length === 0) return '';
  return scenes.slice(0, 5).join('; ');
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-SCORE: Rank elements by text overlap with intent
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tokenize text into lowercase words (3+ chars). No stop-word lists — no hardcode.
 * Short tokens (<3 chars) are noise in any language and excluded.
 */
function tokenizeForPrescore(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s|,;:.()\[\]{}'"!?/\\<>@#$%^&*+=~`\-_]+/)
    .filter(w => w.length >= 3);
}

/**
 * Build searchable text blob for an InteractiveNode.
 * Combines all text fields that a user might reference when describing an element.
 */
function buildNodeSearchText(node: InteractiveNode): string {
  const parts: string[] = [];
  if (node.labelText) parts.push(node.labelText);
  if (node.text) parts.push(node.text);
  if (node.ariaLabel) parts.push(node.ariaLabel);
  if (node.placeholder) parts.push(node.placeholder);
  if (node.title) parts.push(node.title);
  if (node.nearText) parts.push(node.nearText);
  if (node.testIdAttr) parts.push(node.testIdAttr);
  if (node.name && !node.isDynamicId) parts.push(node.name);
  if (node.containerTitles?.length) parts.push(node.containerTitles.join(' '));
  if (node.autocomplete) parts.push(node.autocomplete);
  if (node.nearestLandmark) parts.push(node.nearestLandmark);
  // V15: Icon semantic signals — critical for icon-only buttons where no text/aria-label exists.
  // Splits "lucide-folder" / "icon-folder" / "mdi:folder" into scannable tokens so
  // intent "folder icon" matches the right element instead of falling back to DOM order.
  if (node.iconClasses) parts.push(node.iconClasses.replace(/[-_:]/g, ' '));
  return parts.join(' ').toLowerCase();
}

/** Proportion of LLM slots reserved for scored elements (rest go to DOM-order) */
const SCORED_SLOT_RATIO = 0.6; // 60% scored, 40% DOM-order

/**
 * Pre-score elements and build a merged batch that GUARANTEES both:
 * 1. Elements with text overlap are prioritized (covers 65% of intents)
 * 2. DOM-order elements always get slots (covers cross-language, visual, synonym intents)
 *
 * CRITICAL: No element is ever filtered out by score. Score only determines
 * which RESERVED SLOTS an element fills. Zero-score elements fill DOM slots.
 *
 * Layout for limit=70:
 *   [up to 42 scored elements (desc)] + [up to 28 DOM-order elements not already included]
 *   = always 70 (or fewer if total < 70)
 *
 * If scored < 42, remaining slots go to DOM-order (total still 70).
 * If scored >= 42, overflow scored elements go to DOM-order slots if space permits.
 *
 * This means: even if pre-score has 42 false positives, 28 DOM-order elements
 * still get through — covering cross-language, synonym, and visual description cases.
 */
function preScoreAndSort(nodes: InteractiveNode[], intentText: string, limit: number): InteractiveNode[] {
  if (nodes.length <= limit) return nodes; // Everything fits — no ranking needed

  const intentWords = tokenizeForPrescore(intentText);

  // If no usable tokens (very short intent, all <3 chars), keep DOM order
  if (intentWords.length === 0) return nodes;

  // Score each node
  const scored: Array<{ node: InteractiveNode; score: number; domIndex: number }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const searchText = buildNodeSearchText(node);

    let wordScore = 0;
    for (const word of intentWords) {
      if (searchText.includes(word)) wordScore++;
    }

    scored.push({ node, score: wordScore, domIndex: i });
  }

  // Find the median score to separate "specifically relevant" from "generically matching".
  // Elements scoring above median are genuinely relevant; elements at or below may just
  // share a common word (e.g. "button" appears in every element's text).
  const scores = scored.map(s => s.score).filter(s => s > 0);
  const medianScore = scores.length > 0
    ? scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)]
    : 0;
  // "Specifically scored" = above median (or above 1 if median is too low).
  // This prevents a single generic word from promoting ALL elements.
  const scoreThreshold = Math.max(medianScore, 1);

  const highScored = scored.filter(s => s.score > scoreThreshold);
  const rest = scored.filter(s => s.score <= scoreThreshold);

  // Sort high-scored by score descending (stable — same score keeps DOM order)
  highScored.sort((a, b) => b.score - a.score || a.domIndex - b.domIndex);

  // Rest keeps DOM order (these include score=0 AND low-scored generics)
  // Already in DOM order from the original loop

  // Allocate slots: high-scored get up to SCORED_SLOT_RATIO of limit
  const maxScoredSlots = Math.ceil(limit * SCORED_SLOT_RATIO);
  const scoredToTake = highScored.slice(0, maxScoredSlots);
  const remainingSlots = limit - scoredToTake.length;

  // Fill remaining from rest (DOM order) — includes unscored AND low-scored
  const domOrderFill = rest.slice(0, remainingSlots);

  // If high-scored overflow AND still space, append them
  if (domOrderFill.length < remainingSlots) {
    const overflowScored = highScored.slice(maxScoredSlots);
    for (const s of overflowScored) {
      if (domOrderFill.length >= remainingSlots) break;
      domOrderFill.push(s);
    }
  }

  // Merge: high-scored first, then DOM-order fill
  const result = [...scoredToTake, ...domOrderFill];
  return result.map(s => s.node);
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE MARKING: Add [N of M] and CONTEXT for disambiguation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mark duplicate-labeled elements with [N of M] suffixes and promote nearText
 * to (CONTEXT: ...) right after the label for strong disambiguation signal.
 * Mutates candidateText in-place.
 */
function markDuplicatesWithContext(
  candidates: Array<{ node: InteractiveNode; candidateText: string }>,
): void {
  const labelCounts = new Map<string, number>();
  for (const c of candidates) {
    const label = (c.node.labelText || c.node.ariaLabel || c.node.text || '').trim().toLowerCase();
    if (label) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  const labelIndex = new Map<string, number>();
  for (const c of candidates) {
    const label = (c.node.labelText || c.node.ariaLabel || c.node.text || '').trim().toLowerCase();
    if (label && (labelCounts.get(label) || 0) > 1) {
      const idx = (labelIndex.get(label) || 0) + 1;
      labelIndex.set(label, idx);

      // Promote nearText so the LLM sees disambiguating context (card name, row label)
      // IMMEDIATELY after the element label.
      if (c.node.nearText) {
        const nearSegment = `near: ${c.node.nearText}`;
        const textWithoutNear = c.candidateText
          .replace(` | ${nearSegment}`, '')
          .replace(nearSegment, '');
        const primaryLabel = c.node.labelText || c.node.ariaLabel || c.node.text || '';
        // Find end of container prefix "[section > Title]" — it's always followed by " | "
        // Use first "] |" to avoid matching state hints like [disabled] that appear later
        const containerEndMarker = textWithoutNear.indexOf('] |');
        const searchFrom = containerEndMarker >= 0 ? containerEndMarker : 0;
        const labelPos = primaryLabel ? textWithoutNear.indexOf(primaryLabel, searchFrom) : -1;
        if (labelPos >= 0) {
          const insertAt = labelPos + primaryLabel.length;
          c.candidateText = textWithoutNear.slice(0, insertAt)
            + ` (CONTEXT: ${c.node.nearText})`
            + textWithoutNear.slice(insertAt);
        } else {
          c.candidateText = textWithoutNear + ` (CONTEXT: ${c.node.nearText})`;
        }
      }

      c.candidateText += ` [${idx} of ${labelCounts.get(label)}]`;
    }
  }
}

/**
 * Sanitize user intent for LLM matching
 * Redacts step value if present in description
 * @param step - Intent step from user
 * @returns Sanitized intent text (max 500 chars)
 */
export function sanitizeIntent(step: IntentStep): string {
  const description = (step.description || '').trim();
  const value = (step.value || '').trim();
  let intent = description;

  // Redact value if accidentally included in description
  // Exception: for 'select' actions, keep the value in the description
  // because it's needed for semantic matching against dropdown trigger/options
  if (value.length > 0 && step.type !== 'select') {
    intent = intent.replace(new RegExp(escapeRegex(value), 'gi'), '[VALUE]');
  }

  return intent.trim().slice(0, MAX_INTENT_TEXT_LENGTH);
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ═══════════════════════════════════════════════════════════════════════════
// V14: JSON EXTRACTION UTILITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract first balanced JSON object from a string.
 * Handles nested objects (e.g. boundingBox inside the response).
 * Simple regex `\{.*?\}` fails on nested braces.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Tolerant wrapper around JSON.parse that recovers from common LLM
 * malformations before giving up.
 *
 * Why this exists: Gemini 2.5 Flash Lite in JSON mode occasionally emits
 * malformed escape sequences inside string values — typically when the
 * model interpolates non-ASCII text (e.g. Russian, emoji) and produces a
 * stray `\` that is not a valid JSON escape. The result is a valid-looking
 * JSON that throws "Bad escaped character at position N".
 *
 * Repair strategy (in order, each is a no-op when not applicable):
 *   1. Strict parse (happy path).
 *   2. Replace any backslash that is NOT followed by a JSON-legal escape
 *      character with a literal backslash (`\\`). This fixes the
 *      "Bad escaped character" class without touching legitimate `\n`,
 *      `\"`, `\\`, `\u0041`, etc.
 *   3. Strip control characters in string positions (rare).
 *
 * If all repairs fail we return null and the caller falls back to its
 * existing degraded path. We never throw — JSON parsing must not be a
 * source of unhandled exceptions in the resolution loop.
 */
function safeParseJsonResponse(jsonStr: string): unknown | null {
  try {
    return JSON.parse(jsonStr);
  } catch { /* fall through to repair */ }

  // Pass 2: escape stray backslashes. JSON allows: \" \\ \/ \b \f \n \r \t \uXXXX
  const repaired = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  try {
    const parsed = JSON.parse(repaired);
    logger.debug('[LLM_SELECT] Recovered from malformed escape via backslash-doubling');
    return parsed;
  } catch { /* fall through */ }

  // Pass 3: drop bare control characters that JSON disallows inside strings.
  const stripped = repaired.replace(/[\u0000-\u001f]/g, '');
  try {
    const parsed = JSON.parse(stripped);
    logger.debug('[LLM_SELECT] Recovered from control char via stripping');
    return parsed;
  } catch { /* give up */ }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI FLASH RESCUE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Vision-enhanced rescue when deterministic rules excluded ALL elements.
 * When screenshot is available, sends it to Gemini 2.5 Flash Vision for visual identification.
 * Falls back to text-only Gemini Flash when no screenshot is available.
 *
 * Uses a high-quality prompt with action-type semantics and multilingual awareness,
 * matching the quality bar of the LLM disambiguation service.
 */
async function rescueWithGeminiFlash(params: {
  intentText: string;
  actionType: IntentActionType;
  excludedNodes: InteractiveNode[];
  pageUrl: string;
  /** Phase 6: Optional screenshot for vision-enhanced rescue */
  screenshot?: string;
  /** Phase 6: Optional viewport for coordinate-based results */
  viewport?: { width: number; height: number };
}): Promise<{ ref: string; confidence: number; reason: string; boundingBox?: { x: number; y: number; width: number; height: number } } | null> {
  const { intentText, actionType, excludedNodes, pageUrl, screenshot, viewport } = params;

  // V8: Prioritize candidates by a11y richness (no hardcoded text matching — LLM decides).
  // Elements with more semantic info (labels, roles) are more useful for LLM to evaluate.
  const rescueCandidates = excludedNodes
    .filter(n => n.ref && n.isVisible !== false)
    .sort((a, b) => {
      const scoreNode = (n: InteractiveNode): number => {
        let score = 0;
        if (n.ariaLabel) score += 2;
        if (n.labelText) score += 2;
        if (n.title) score += 1;
        if (n.text) score += 1;
        if (n.role) score += 1;
        if (n.placeholder) score += 1;
        return score;
      };
      return scoreNode(b) - scoreNode(a);
    })
    .slice(0, 15);

  if (rescueCandidates.length === 0) return null;

  const candidateList = rescueCandidates.map((n, i) => {
    const attrs: string[] = [];
    if (n.labelText) attrs.push(`label="${n.labelText}"`);
    if (n.ariaLabel) attrs.push(`aria-label="${n.ariaLabel}"`);
    if (n.title) attrs.push(`title="${n.title}"`);
    if (n.isIconButton) attrs.push(`icon-button`);
    if (n.placeholder) attrs.push(`placeholder="${n.placeholder}"`);
    if (n.text && n.text.length <= 50) attrs.push(`text="${n.text}"`);
    if (n.name) attrs.push(`name="${n.name}"`);
    if (n.autocomplete) attrs.push(`autocomplete="${n.autocomplete}"`);
    if (n.type || n.inputType) attrs.push(`type="${n.type || n.inputType}"`);
    if (n.role) attrs.push(`role="${n.role}"`);
    return `${i + 1}. ref="${n.ref}" <${n.tag}> ${attrs.join(' ')}`;
  }).join('\n');

  const systemPrompt = `You are an AI element selector for a browser testing tool.

TASK: The user wants to perform a "${actionType}" action. Select the element that BEST matches their intent.

ACTION-TYPE SEMANTICS:
- type/fill: prefer <input>, <textarea>, or role=textbox. The element must be editable.
- click: prefer <button>, <a>, or elements with role=button/link/tab/menuitem.
- select: prefer <select>, role=combobox/listbox, or dropdown-trigger elements.
- check/uncheck/toggle: prefer checkbox/radio/switch controls.
- hover/press/scroll: prefer the closest matching interactive element.

RULES:
1. Match by semantic meaning of the intent to the element's label/aria-label/placeholder/text/title.
2. Consider action type — e.g., for "type", only editable fields are valid.
3. Use multilingual semantic understanding; do NOT translate literally.
4. ICON BUTTONS: Elements marked "icon-button" have no text — only an icon. To identify which icon:
   - Look at the "icon: …" visual hint (e.g. "icon: lucide-folder", "icon: mdi:star", "icon: folder-icon"). Match the hint token to the user's description.
   - Look at the "title:" or "label" field — icon libraries often expose semantic names there.
   - If multiple icon-buttons look identical (same "icon-button" tag, no icon hint, no label), DO NOT guess by position. Return ref: null with reason "icon-only buttons indistinguishable".
   - Common icon mappings: "eye" = show/hide password, "X" or "cross" = close, "trash"/"bin" = delete, "pencil" = edit, "folder" = folder/directory, "star" = favorite, "book" = bookmarks/library.
5. If multiple elements could match, pick the one whose label/text is semantically closest.
6. Only use refs from the provided list — never invent refs.
7. If no element is a confident match, return ref as null. NEVER return the first candidate as a default guess.
8. Respond ONLY with valid JSON, no markdown or extra text.

OUTPUT FORMAT:
{"ref":"eXX","confidence":0.0-1.0,"reason":"brief explanation"}
If none match: {"ref":null,"confidence":0,"reason":"no match"}`;

  const userPrompt = `USER INTENT: "${intentText}"
ACTION: ${actionType}
PAGE: ${pageUrl}

CANDIDATE ELEMENTS:
${candidateList}

Select the single best matching element. If unsure, return ref: null.`;

  try {
    let responseContent: string;

    // Phase 6: Use vision when screenshot is available for much better accuracy
    if (screenshot) {
      const visionPrompt = `${systemPrompt}\n\n${userPrompt}\n\nIMPORTANT: Look at the screenshot to visually identify the target element. If the element is visible in the screenshot but NOT in the candidate list, return ref as null and provide bounding box coordinates (x, y, width, height in pixels).\n\nCOORDINATE SPACE: All bounding box coordinates MUST be in screenshot image space — i.e. (0,0) is the top-left pixel of the image you see. Do NOT use page/document coordinates. The caller will translate image coords back to the live page.\n\nJSON format with optional boundingBox: {"ref":"eXX","confidence":0.0-1.0,"reason":"brief","boundingBox":{"x":0,"y":0,"width":0,"height":0}}`;

      // V14: Detect mime type from base64 header — JPEG starts with /9j/, PNG with iVBOR
      const mimeType: 'image/jpeg' | 'image/png' = screenshot.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
      const visionResponse = await generateTextWithGeminiVision({
        prompt: visionPrompt,
        imageBase64: screenshot,
        mimeType,
        model: AI_TASK_MODELS.visionElementResolution as any,
        temperature: 0,
        maxTokens: 200,
        timeout: 6000,
      });
      responseContent = visionResponse.content;

      logger.debug('[ELEMENT_RESOLVER] Vision-enhanced rescue response', {
        responsePreview: responseContent.slice(0, 150),
      });
    } else {
      // Fallback: text-only rescue
      const response = await generateText({
        prompt: `${systemPrompt}\n\n${userPrompt}`,
        task: 'fast',
        temperature: 0,
        maxTokens: 100,
        timeout: 3000,
      });
      responseContent = response.content;
    }

    // V14: Handle nested JSON objects (boundingBox is nested) — match balanced braces
    const jsonMatch = extractFirstJsonObject(responseContent);
    if (!jsonMatch) return null;

    const parsed = safeParseJsonResponse(jsonMatch) as any;
    if (!parsed) return null;

    // ref must be a non-empty string (null or absent = no match) OR have bounding box
    if ((!parsed.ref || typeof parsed.ref !== 'string') && !parsed.boundingBox) return null;

    // Validate ref against candidate list if present
    if (parsed.ref && typeof parsed.ref === 'string') {
      const validRefs = new Set(rescueCandidates.map(n => n.ref));
      if (!validRefs.has(parsed.ref)) {
        logger.warn('[ELEMENT_RESOLVER] Gemini rescue: hallucinated ref rejected', {
          ref: parsed.ref,
        });
        // If bounding box is present, still return it
        if (!parsed.boundingBox) return null;
        parsed.ref = null;
      }
    }

    // Handle confidence as number or numeric string (e.g., "0.85")
    const rawConfidence = typeof parsed.confidence === 'number'
      ? parsed.confidence
      : typeof parsed.confidence === 'string'
        ? parseFloat(parsed.confidence)
        : 0;
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;

    // V14: Use lower threshold for rescue (last-resort path) — 0.5 instead of default 0.7
    const rescueThreshold = Math.min(ELEMENT_RESOLVER_CONFIG.confidenceThreshold, 0.5);
    if (confidence < rescueThreshold) return null;

    return {
      ref: parsed.ref || '',
      confidence,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : (screenshot ? 'Vision rescue' : 'Gemini Flash rescue'),
      boundingBox: parsed.boundingBox || undefined,
    };
  } catch (error) {
    logger.warn('[ELEMENT_RESOLVER] Gemini rescue failed', {
      error: error instanceof Error ? error.message : String(error),
      usedVision: !!screenshot,
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM-BASED ELEMENT SELECTION
// ═══════════════════════════════════════════════════════════════════════════

const LLM_SELECT_TIMEOUT_MS = ELEMENT_RESOLVER_CONFIG.llmCircuitBreaker.timeoutMs;

let llmSelectFailures = 0;
let llmSelectBreakerOpenUntil = 0;
const LLM_SELECT_BREAKER_THRESHOLD = ELEMENT_RESOLVER_CONFIG.llmCircuitBreaker.failureThreshold;
const LLM_SELECT_BREAKER_COOLDOWN_MS = ELEMENT_RESOLVER_CONFIG.llmCircuitBreaker.cooldownMs;

function isLlmSelectBreakerOpen(): boolean {
  if (llmSelectFailures < LLM_SELECT_BREAKER_THRESHOLD) return false;
  if (Date.now() > llmSelectBreakerOpenUntil) {
    llmSelectFailures = 0;
    return false;
  }
  return true;
}

function recordLlmSelectFailure(): void {
  llmSelectFailures++;
  if (llmSelectFailures >= LLM_SELECT_BREAKER_THRESHOLD) {
    llmSelectBreakerOpenUntil = Date.now() + LLM_SELECT_BREAKER_COOLDOWN_MS;
  }
}

function recordLlmSelectSuccess(): void {
  llmSelectFailures = 0;
}

/** LLM selection result cache */
const llmSelectCache = new Map<string, { result: LlmSelectResult; createdAt: number }>();
const LLM_SELECT_CACHE_TTL_MS = ELEMENT_RESOLVER_CONFIG.llmCache.ttlMs;
const LLM_SELECT_CACHE_MAX_SIZE = ELEMENT_RESOLVER_CONFIG.llmCache.maxSize;

interface LlmSelectResult {
  status: 'resolved' | 'needs_clarification' | 'not_found';
  selectedRef: string | null;
  confidence: number;
  reason: string;
  alternativeRefs?: string[];
  latencyMs: number;
  cacheHit: boolean;
  /** @internal LLM prompt sent (for trace) */
  _prompt?: string;
  /** @internal LLM response received (for trace) */
  _response?: string;
  /** @internal Model used */
  _model?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// V22 — Prompts split into shared base + Apply variant + Heal variant.
//
// Why two prompts:
//   - Apply (preview:step:lint, preview:step:apply, preview:run:start)
//     happens when the user is AUTHORING a step. The intent text may be
//     vague/exploratory ("the gear icon"). We accept null when nothing
//     matches — user will refine the description.
//   - Heal (command-executor.ts on regression run, when compiled-shortcut
//     fails) happens when an EXISTING step that worked before suddenly
//     can't find its element. The element almost certainly still exists
//     in some form — null is the worst-case answer because it breaks the
//     regression. Heal prompt biases toward "find the closest match" and
//     leans HARD on `recordedFingerprint` data (id, testId, ancestorPath,
//     boundingBox) which is always present at heal time.
//
// V22 GAP CLOSURE — both prompts now explicitly explain:
//   - Identity priority hierarchy (id/testId/dataRowKey/childIconTestId
//     beat text/role beat coordinates)
//   - State-at-record semantics (expanded/invalid/current/valueNow)
//   - data-value as i18n-stable key for select options
//   - Bootstrap data-bs-toggle/data-bs-target combos
//   - aria-haspopup as popup-trigger marker
//   - ancestorPath as structural filter
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shared rules used by both Apply and Heal prompts. Covers the
 * stable-across-all-modes logic: i18n, action-type semantics, icon button
 * vocabulary, spatial layout, page state, disambiguation, ordinals, tables,
 * confidence scale, gibberish rejection.
 */
const LLM_SHARED_RULES = `RULES:
1. CROSS-LANGUAGE SEMANTIC MATCHING (intent and candidates can be in any language):
   - "войти" = "sign in" = "登录" = "iniciar sesión" = "kirish"
   - "поиск" = "search" = "搜索" = "buscar"
   - "корзина" = "cart" = "购物车" = "carrito"
   Match by meaning, not by literal characters.

2. ACTION-TYPE SEMANTICS:
   - click: prefer buttons, links, interactive elements
   - type: prefer inputs, textareas, [contenteditable=true]
   - select: prefer dropdowns (role=combobox / role=listbox), <select>, MenuItem
   - check/uncheck/toggle: prefer checkboxes, radios, switches (role=switch)
   - hover: prefer any interactive element
   - press: prefer focusable element (input is fine)

3. V22 IDENTITY SIGNAL PRIORITY (MOST → LEAST stable):
   When candidate carries any of these identity hints, weigh them in this order:
   ┌─ TIER 1 (almost always wins; treat as proof-of-identity):
   │   • testid: <value>            ← test-only attribute, never changes
   │   • id: <value>                ← DOM id (framework-generated ones are pre-filtered)
   │   • dataRowKey: <value>        ← stable table-row identity (AntD Table)
   │   • icon: <name>               ← lifted child icon testid (e.g. VisibilityOffOutlinedIcon)
   ├─ TIER 2 (strong signals):
   │   • value: <value>             ← <option value> — semantic key, survives i18n
   │   • bsToggle / bsTarget        ← Bootstrap trigger combo
   │   • activeDescendant: <ref>    ← currently-focused descendant of combobox
   │   • hasPopup: <kind>           ← popup-trigger marker (menu|listbox|dialog)
   ├─ TIER 3 (good signals — but locale-sensitive or layout-dependent):
   │   • text / labelText / ariaLabel / placeholder / title / alt
   │   • role + accessibleName combination
   ├─ TIER 4 (weak / shape-only — use only as tie-breakers):
   │   • cssClass / position @(x,y,wxh) / containerTitles / nearestLandmark
   When recorded fingerprint has a TIER 1 signal AND a candidate carries the
   exact same value, prefer that candidate even if its visible text differs.
   Conversely: if recorded fingerprint says id="login-submit" but no candidate
   has that id, the recorded element may have been renamed — fall back to TIER 2/3.

4. STATE-AT-RECORD AWARENESS:
   The fingerprint may include "stateAtRecord=[...]" reflecting how the
   element looked when the user recorded it:
   - expanded/collapsed → only relevant for togglable containers
   - pressed/not-pressed → for toggle buttons (aria-pressed)
   - checked/unchecked → for checkboxes/radios/switches
   - invalid → element had a validation error showing (red border)
   - current=page|step → Pagination/Stepper active marker
   - valueNow=<num> / valueText="<str>" → Slider/SpinButton/ProgressBar value
   When live candidates have explicit state markers ([expanded], [invalid],
   [current=page], value:<X>), prefer the candidate whose live state matches
   the recorded state. Different state usually means a different intent.

5. ICON BUTTONS without visible text:
   Match user's VISUAL description to the element's aria-label/title/icon hint:
   - "eye button" / "show/hide password" → "toggle password visibility" / VisibilityOffIcon
   - "X button" / "close" → "dismiss" / "close dialog" / CloseIcon
   - "hamburger menu" / "three lines" → "open navigation" / MenuIcon
   - "arrow back" → "go back" / ArrowBackIcon
   - "trash" / "delete icon" → "remove" / "delete item" / DeleteIcon
   - "pencil" / "edit icon" → "edit" / "modify" / EditIcon
   - "gear" / "cog" / "шестерёнка" → "settings" / SettingsIcon
   When candidate has "icon: SettingsIcon" in its hints, treat that as
   semantic name even though it's a class identifier.

6. VISUAL PROPERTIES (color, shape, icon-class):
   Elements may include [color] [shape] [icon: class] hints in square brackets.
   - "серая кнопка" / "grey button" → match [grey] or [light-grey]
   - "круглая иконка" / "round icon" → match [circle] or [rounded]
   - If user provides no visual hint, ignore these and rely on text/semantics.

7. SPATIAL LAYOUT AWARENESS:
   Position @(x,y,widthxheight). Use to detect overlay layers:
   - MODAL/DIALOG: cluster centered horizontally and vertically
   - DRAWER/SIDEBAR: cluster on RIGHT or LEFT edge
   - DROPDOWN/MENU: small group BELOW a trigger
   - TOOLTIP/POPOVER: small cluster near a specific element
   - TOAST/SNACKBAR: small element at TOP or BOTTOM edge
   When an overlay is present, ALWAYS prefer elements INSIDE it over background.

8. PAGE-STATE-DRIVEN selection:
   - [expanded] = container is OPEN; its children are visible candidates
   - [collapsed] = container is CLOSED; its children are NOT the target
   - [selected] = tab/option is active; content within is visible
   - [active-layer] = element is inside the foreground overlay
   - "clickable-row" = <tr> wired up as interactive without explicit role
   When user says "inside dropdown/menu/popup/dialog":
   - Find children of an [expanded]/[active-layer] container
   - The trigger (the [expanded] element itself) is NOT the target

9. ANCESTOR PATH HINT (V22):
   The fingerprint may include "ancestorPath=...header#layout-header > div.icon-group > svg"
   This is the DOM hierarchy of the recorded element from outer to inner.
   Use it as a SOFT structural filter — candidates whose container chain
   resembles this path (same outer landmark, same role progression) are
   stronger matches. Do NOT require exact equality (DOM evolves).

10. DUPLICATE ELEMENTS marked "[N of M]":
    Each duplicate carries "(CONTEXT: ...)" showing card/row/container content.
    - "X button on Y" / "X for Y" / "X у Y" / "X на Y" → match the duplicate
      whose CONTEXT contains "Y". This is the STRONGEST disambiguator.
    - "second delete" / "2nd" → pick [2 of M]
    - "first" / "last" → pick [1 of M] / [M of M]
    - If intent has NO context to distinguish duplicates → return alternatives.

11. PARTIAL / ABBREVIATED DESCRIPTIONS:
    Users shorten descriptions ("login" instead of "Login button").
    - Match the MOST SPECIFIC candidate, not the broadest.
    - When a keyword appears in BOTH a parent section AND a child element,
      prefer the CHILD — users name what they want to interact with.
    - [Section > Subsection] prefixes are LOCATION scope.

12. RELATIVE POSITIONING (directional, proximity, ordinal, table/grid):
    COORDINATE SYSTEM: @(x,y,wxh), x=left-to-right, y=top-to-bottom.
    DIRECTIONAL: "above/over/сверху" → smaller y; "below/снизу" → larger y;
    "left of/слева" → smaller x; "right of/справа" → larger x.
    PROXIMITY: "next to / near / рядом" → smallest Euclidean distance to
    the named reference element's bounding-box center.
    ORDINAL: "first/second/N-th/последний" → sort by DOM order, pick N-th.
    TABLE/GRID: "row N column M" → group by aligned Y for rows, aligned X
    for columns; "cell in Status column for John" → match near-text "John"
    AND X-aligned with Status header.
    MULTI-SIGNAL: combine ("grey button on the right" → [grey] AND x > vw/2).

13. CONFIDENCE SCALE (be honest, not optimistic):
    - 0.95-1.0: exact TIER 1 identity match (id/testId/dataRowKey/icon equal)
    - 0.85-0.95: TIER 2 match (value/bsToggle) OR exact text + role match
    - 0.7-0.85: TIER 3 match — strong text/aria but indirect
    - 0.5-0.7: plausible but uncertain (multiple candidates could fit)
    - below 0.5: weak guess — return alternatives, not a single pick
    NEVER return >0.8 when guessing between duplicates without context.

14. ONLY use refs from the provided list — never invent refs.
15. Respond ONLY with valid JSON, no markdown.

OUTPUT FORMAT:
- One match: {"ref":"eXX","confidence":0.0-1.0,"reason":"brief"}
- Ambiguous: {"ref":null,"confidence":0,"alternatives":["e1","e5"],"reason":"..."}`;

/**
 * Apply-mode prompt: user is AUTHORING a new step or refining one.
 * The intent text comes from the editor; user might be exploratory.
 * Returning null is the CORRECT answer when nothing matches — the user
 * will refine the description.
 */
const LLM_SELECT_APPLY_PROMPT = `You are an AI element selector for a browser testing tool.

MODE: APPLY — the user is authoring a test step. Pick the SINGLE element
that best matches their description, OR return null if nothing fits.

TASK: Given a user's intent (any language) and a list of candidate UI
elements, select the one that best matches OR null if no candidate
semantically describes any element.

${LLM_SHARED_RULES}

16. REJECT GIBBERISH / IRRELEVANT TEXT (Apply-mode safety):
    Return ref=null when the intent is:
    - Random/gibberish: "asdfgh", "ываыва", "xyzabc"
    - Copied content / random sentences (not element descriptions)
    - Has no semantic relationship to ANY candidate's label/text/role/icon
    Forcing a match on irrelevant input is WORSE than returning null —
    the user will see no-match feedback and refine their intent.

EXAMPLES (Apply-mode — diverse domains, calibrated confidence):

— TIER 1 dataValue exact match (high confidence 0.95) —
INTENT: "Казахстан"
CANDIDATES:
  1. ref="e10" <li> Kazakhstan [role: option] value: kz
  2. ref="e11" <li> Kyrgyzstan [role: option] value: kg
RECORDED HINTS: dataValue="kz"
EXPECTED: {"ref":"e10","confidence":0.95,"reason":"dataValue=kz exact match; UI text localized but key stable"}

— TIER 1 childTestId for icon-only button (high confidence 0.92) —
INTENT: "show password"
CANDIDATES:
  1. ref="e2" <input> placeholder: Email [type: email]
  2. ref="e3" <button> [role: button] icon: VisibilityOffOutlinedIcon
EXPECTED: {"ref":"e3","confidence":0.92,"reason":"icon: VisibilityOffIcon semantically matches \"show password\""}

— TIER 3 cross-language text-only match (medium confidence 0.78) —
INTENT: "Добавить в корзину"
CANDIDATES:
  1. ref="e15" <button> Add to cart [role: button]
  2. ref="e16" <button> Buy now [role: button]
  3. ref="e17" <a> View details [role: link]
EXPECTED: {"ref":"e15","confidence":0.78,"reason":"\"Добавить в корзину\"=\"Add to cart\" cross-language; no recorded id/testId, so confidence is medium not high"}

— Partial / ambiguous text — medium confidence (0.65) when uncertain —
INTENT: "submit"
CANDIDATES:
  1. ref="e1" <button> Submit form [role: button]
  2. ref="e2" <button> Submit & Continue [role: button]
  3. ref="e3" <input> [role: button] type: submit
EXPECTED: {"ref":"e1","confidence":0.65,"reason":"three plausible matches; pick shortest exact-prefix match but confidence is honest about ambiguity"}

— File upload trigger via aria-label (mixed signals, 0.82) —
INTENT: "upload avatar"
CANDIDATES:
  1. ref="e8" <button> [role: button] ariaLabel: "Upload profile picture" [icon: CloudUploadIcon]
  2. ref="e9" <input> type: file accept: image/*
EXPECTED: {"ref":"e8","confidence":0.82,"reason":"button with ariaLabel \"Upload profile picture\" semantically matches \"upload avatar\"; the hidden input is the actual <input type=file> but users click the styled button"}

— Reject gibberish —
INTENT: "ываыва asdfgh"
CANDIDATES: any list
EXPECTED: {"ref":null,"confidence":0,"reason":"intent is gibberish, no semantic relationship to any candidate"}

— Ambiguous duplicates — return alternatives, not guess —
INTENT: "Delete"
CANDIDATES:
  1. ref="e30" <button> Delete [1 of 3] (CONTEXT: Anna Lee, anna@x.com)
  2. ref="e31" <button> Delete [2 of 3] (CONTEXT: Bob Smith, bob@x.com)
  3. ref="e32" <button> Delete [3 of 3] (CONTEXT: Cara Jones, cara@x.com)
EXPECTED: {"ref":null,"confidence":0,"alternatives":["e30","e31","e32"],"reason":"3 identical Delete buttons; intent has no row context — refuse to guess"}

CONFIDENCE CALIBRATION REMINDER:
TIER 1 exact (id/testId/dataRowKey/childTestId) → 0.92-0.97
TIER 2 exact (dataValue/bsToggle combo) → 0.85-0.92
TIER 3 strong (exact text + role) → 0.80-0.88
TIER 3 indirect (cross-language / abbreviation) → 0.70-0.80
Medium uncertainty (multiple plausible) → 0.55-0.70 — return alternatives if ≥2 equally good
Weak guess → return alternatives, NOT a single low-confidence pick

OUTPUT (Apply-mode):
- No match: {"ref":null,"confidence":0,"reason":"description does not match any element"}
- One match: {"ref":"eXX","confidence":0.0-1.0,"reason":"..."}
- Ambiguous (2+ equally valid): {"ref":null,"confidence":0,"alternatives":["e1","e5"],"reason":"..."}`;

/**
 * Heal-mode prompt: an EXISTING step that worked before is failing now,
 * usually because the page changed (redesign, A/B test, locale switch).
 * The element almost always still exists in SOME form — the recorded
 * fingerprint is the strongest evidence. We bias HARD toward finding the
 * closest match rather than returning null.
 */
const LLM_SELECT_HEAL_PROMPT = `You are an AI element selector for a browser testing tool, in HEAL mode.

MODE: HEAL — an existing recorded test step that worked before is failing
now because the page changed. The same element almost certainly still
exists in some form. Use the RECORDED ELEMENT HINTS as the primary
evidence — those captured the element BEFORE it drifted.

CRITICAL HEAL DIRECTIVES (override the shared rules where they conflict):

A. PREFER ANY REASONABLE MATCH OVER NULL.
   The element existed once. Returning null breaks the regression test —
   that's strictly worse than picking a candidate with confidence 0.6.
   Only return null when ZERO candidates share even a TIER 3 signal with
   the recorded fingerprint.

B. RECORDED FINGERPRINT IS THE PRIMARY EVIDENCE.
   The user's intent text may now be misleading (e.g. recorded button
   said "Submit" but UI changed to "Continue"). Trust the fingerprint
   over the intent text when they conflict.

C. MATCH ON IDENTITY FIRST, SHAPE SECOND, TEXT LAST.
   Walk the TIER 1 → TIER 4 hierarchy from the shared rules:
     - Same testid in fingerprint and a live candidate? Pick that one.
     - Same id in fingerprint? Pick that candidate.
     - Same dataRowKey, childIconTestId, value? Pick.
     - Same role + same containerTitle (e.g. both inside form#login)? Pick.
     - Same recordedAt position (boundingBox roughly matches)? Pick.
     - Same TIER 3 text/aria-label match? Pick.
   Only fall through to "best-effort semantic match" when no signal aligns.

D. STATE DRIFT IS NORMAL.
   The recorded state (expanded/invalid/current=page) may not match the
   live state — that's fine. The state is a HINT for disambiguation, not
   a hard filter. Pick the right element by identity even if its state
   has changed.

E. POSITIONAL DRIFT IS NORMAL.
   recordedAt=(x,y,w,h) may be off by 200+ pixels after a redesign. Use
   it only as a tie-breaker among same-identity candidates, not as a
   filter.

${LLM_SHARED_RULES}

EXAMPLES (Heal-mode — element existed before, find closest match):

— TIER 1 id wins over text drift (high confidence 0.95) —
INTENT: "Submit"
RECORDED HINTS: id="login-submit-btn", role="button", labelText="Submit"
CANDIDATES:
  1. ref="e5" <button> Continue [role: button] id: login-submit-btn
  2. ref="e9" <button> Cancel [role: button]
EXPECTED: {"ref":"e5","confidence":0.95,"reason":"id=login-submit-btn matches recorded; text drifted Submit→Continue (UI redesign)"}

— Localization drift, id stays stable (high confidence 0.93) —
INTENT: "Login"
RECORDED HINTS: id="auth-login", labelText="Login"
CANDIDATES:
  1. ref="e1" <button> Войти [role: button] id: auth-login
  2. ref="e2" <a> Регистрация [role: link]
EXPECTED: {"ref":"e1","confidence":0.93,"reason":"id=auth-login matches; text drifted Login→Войти (locale switch)"}

— Position drifted, childTestId identifies (high confidence 0.90) —
INTENT: "settings gear"
RECORDED HINTS: childTestId="SettingsIcon", recordedAt=(1240,14,20x20)
CANDIDATES:
  1. ref="e7" <button> [role: button] icon: SettingsIcon @(310,800,32x32)
  2. ref="e8" <button> [role: button] icon: HomeIcon @(1240,14,20x20)
EXPECTED: {"ref":"e7","confidence":0.90,"reason":"childTestId=SettingsIcon matches; layout moved header→sidebar but icon identity stable"}

— ancestorPath disambiguates duplicates (medium-high 0.85) —
INTENT: "Save"
RECORDED HINTS: ariaLabel="Save changes", ancestorPath="form#profile > div.actions > button"
CANDIDATES:
  1. ref="e2" <button> Save [role: button] [ancestor: form#profile]
  2. ref="e3" <button> Save [role: button] [ancestor: dialog#confirm]
EXPECTED: {"ref":"e2","confidence":0.85,"reason":"two Save buttons; recorded ancestorPath has form#profile — pick that one"}

— Slider value drift within tolerance (medium 0.75) —
INTENT: "volume slider"
RECORDED HINTS: role="slider", stateAtRecord=[valueText="50%",valueNow=50]
CANDIDATES:
  1. ref="e3" <input> [role: slider] value: 48
  2. ref="e4" <input> [role: slider] value: 100
EXPECTED: {"ref":"e3","confidence":0.75,"reason":"valueNow=48 close to recorded 50; only one slider in similar value range"}

— Text-only heal, no identity signals — medium confidence (0.65) —
INTENT: "Continue"
RECORDED HINTS: text="Continue", role="button"
CANDIDATES:
  1. ref="e1" <button> Continue [role: button]
  2. ref="e2" <button> Cancel [role: button]
EXPECTED: {"ref":"e1","confidence":0.65,"reason":"only text+role to match; recorded had no id/testId so heal confidence is honest medium"}

— Honest null: live page lacks element entirely (rare but real) —
INTENT: "Apply discount code"
RECORDED HINTS: id="discount-apply", testId="discount-btn", text="Apply", role="button"
CANDIDATES (live page after redesign — discount feature was removed):
  1. ref="e1" <input> placeholder: "Search products" [role: textbox]
  2. ref="e2" <a> Cart [role: link]
  3. ref="e3" <button> Sign in [role: button]
EXPECTED: {"ref":null,"confidence":0,"reason":"zero candidates share recorded id/testId/text/aria; feature appears removed — heal cannot fabricate match"}

— Honest null: ambiguous heal (multiple equally-strong matches) —
INTENT: "Edit row"
RECORDED HINTS: childTestId="EditIcon", role="button"
CANDIDATES:
  1. ref="e1" <button> [role: button] icon: EditIcon (CONTEXT: row 1)
  2. ref="e2" <button> [role: button] icon: EditIcon (CONTEXT: row 2)
  3. ref="e3" <button> [role: button] icon: EditIcon (CONTEXT: row 3)
EXPECTED: {"ref":null,"confidence":0,"alternatives":["e1","e2","e3"],"reason":"three buttons with same recorded childTestId; recorded fingerprint has no row-distinguishing context"}

CONFIDENCE CALIBRATION REMINDER (Heal):
TIER 1 exact match → 0.90-0.97 (rare to hit ceiling — page changed for a reason)
TIER 2 / 1+structural match → 0.80-0.90
ancestorPath disambiguator → 0.80-0.88
state/value drift within tolerance → 0.70-0.80
text-only heal (no id/testId in recorded) → 0.60-0.75
Below 0.60 → STOP, return alternatives or null instead of low-confidence pick.

PREFERENCE ORDER when multiple options seem viable:
1. Pick the candidate with strongest TIER 1 match (id/testId/dataRowKey/childTestId).
2. If no TIER 1, prefer the one whose ancestorPath / containerTitles align with recorded.
3. If still tied — return alternatives (DO NOT guess silently).
4. Return null ONLY when zero candidates share any TIER 1-3 signal — the
   element genuinely seems removed, not just drifted.

OUTPUT (Heal-mode — bias toward picking when identity signals match):
- One match: {"ref":"eXX","confidence":0.0-1.0,"reason":"..."}
- No reasonable match (RARE — only when zero TIER 1-3 signals align):
  {"ref":null,"confidence":0,"reason":"no candidate shares any identity/shape/text signal with recorded fingerprint"}
- Ambiguous between equally-strong matches:
  {"ref":null,"confidence":0,"alternatives":["e1","e5"],"reason":"..."}`;

/**
 * LLM-based element selection: uses Gemini Flash Lite to pick the best candidate.
 * Uses gemini-2.5-flash-lite to directly select the best matching element from candidates.
 * Supports multilingual intent matching natively.
 */
async function selectElementWithLLM(params: {
  intentText: string;
  actionType: IntentActionType;
  candidates: Array<{ node: InteractiveNode; candidateText: string }>;
  pageUrl: string;
  pageSignature: string;
  /**
   * Optional fingerprint captured at recording time. When present, it is
   * rendered into the prompt as HINTS from the original interaction — the
   * stable structural properties (tag/role/containers) should still match,
   * while surface properties (text, exact position) may have drifted
   * because of redesign, localization, or A/B tests.
   */
  recordedFingerprint?: TargetFingerprint;
  /**
   * V22: which prompt to use.
   *   - 'apply' (default): user is authoring a step. Returning null on a
   *     no-match is correct — the user will refine the description.
   *   - 'heal': existing step is failing during regression. Bias toward
   *     finding the closest match using recordedFingerprint identity.
   */
  mode?: 'apply' | 'heal';
}): Promise<LlmSelectResult> {
  const { intentText, actionType, candidates, pageUrl, pageSignature, recordedFingerprint, mode = 'apply' } = params;
  const startTime = Date.now();

  // Check cache
  // V15: Include ALL candidate refs in cache key (not just top 5).
  // Truncating to 5 caused stale cache hits when the correct element was 6th+.
  // Include a fingerprint digest so that prompt-level hints never cause
  // cross-shape cache hits (e.g. the same intent for a different recorded
  // element should not reuse a prior selection).
  // V22: digest now includes all V22 identity attributes (id/name/href/etc.)
  // so a step recorded against a *different* element with same description
  // gets its own cache slot. Without this, two recordings with identical
  // intentText but distinct recordedFingerprints could share a stale cache entry.
  //
  // V22 Audit-fix C1: each value is escaped so embedded `:` (e.g. CSS
  // selectors in bsTarget like "#modal:not(.hidden)") cannot collide with
  // the `:` separator. We replace `:` and `\` in each segment before join.
  const dEsc = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    return String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\c');
  };
  const fpDigest = recordedFingerprint
    ? [
        dEsc(recordedFingerprint.tag),
        dEsc(recordedFingerprint.role),
        dEsc(recordedFingerprint.ariaLabel),
        dEsc(recordedFingerprint.labelText),
        dEsc(recordedFingerprint.testIdAttr),
        dEsc(recordedFingerprint.placeholder),
        dEsc(recordedFingerprint.nearestLandmark),
        dEsc(recordedFingerprint.elementId),
        dEsc(recordedFingerprint.name),
        dEsc(recordedFingerprint.href),
        dEsc(recordedFingerprint.ariaControls),
        dEsc(recordedFingerprint.cssClass),
        dEsc(recordedFingerprint.ancestorSummary),
        // V22 Pkg1 — childTestId + dataValue + current/valueNow/valueText
        // are all distinct identifiers, must contribute to cache key so a
        // re-recorded step with same description but different selected
        // option / slider value doesn't reuse a stale answer.
        dEsc((recordedFingerprint as any).childTestId),
        dEsc((recordedFingerprint as any).iconLabel),
        dEsc((recordedFingerprint as any).dataValue),
        // V22 Pkg2 — Bootstrap / activedescendant / row-key disambiguators.
        dEsc((recordedFingerprint as any).bsToggle),
        dEsc((recordedFingerprint as any).bsTarget),
        dEsc((recordedFingerprint as any).ariaHasPopup),
        dEsc((recordedFingerprint as any).ariaActiveDescendant),
        dEsc((recordedFingerprint as any).dataRowKey),
        // V22 Pkg5 — row text / sibling pos / disabled / arrow direction.
        // Each one shifts the right answer for descriptor-poor candidates,
        // so they all participate in the cache key.
        dEsc((recordedFingerprint as any).nearestRowText),
        dEsc((recordedFingerprint as any).siblingIndex),
        dEsc((recordedFingerprint as any).disabled),
        dEsc((recordedFingerprint as any).arrowDir),
        // ariaState compact form: e/p/c/i flags + (V22 Pkg1) current/valueNow/valueText.
        // Sub-fields joined with `|` (also escaped for safety).
        recordedFingerprint.ariaState
          ? `${recordedFingerprint.ariaState.expanded ?? '_'}${recordedFingerprint.ariaState.pressed ?? '_'}${recordedFingerprint.ariaState.checked ?? '_'}${recordedFingerprint.ariaState.invalid ?? '_'}|${dEsc((recordedFingerprint.ariaState as any).current)}|${dEsc((recordedFingerprint.ariaState as any).valueNow)}|${dEsc((recordedFingerprint.ariaState as any).valueText)}`
          : '',
        recordedFingerprint.boundingBox
          ? `${Math.round(recordedFingerprint.boundingBox.x)},${Math.round(recordedFingerprint.boundingBox.y)}`
          : '',
        (recordedFingerprint.containerTitles || []).join('|'),
      ].join(':')
    : '';
  // V22: include mode in cache key — apply-mode and heal-mode use different
  // prompts and may return different answers for the same inputs (heal
  // biases toward picking, apply allows null). Sharing cache slots between
  // them would leak heal's "always-pick" answers into apply (where null is
  // the right answer for gibberish) and vice versa.
  const cacheKey = `${mode}|${pageSignature}|${actionType}|${computeTextHash(intentText)}|${fpDigest}|${candidates.map(c => c.node.ref).join(',')}`;
  const cached = llmSelectCache.get(cacheKey);
  if (cached && (Date.now() - cached.createdAt) < LLM_SELECT_CACHE_TTL_MS) {
    cacheMetrics.inc('llm-select', 'hit');
    return { ...cached.result, cacheHit: true, latencyMs: Date.now() - startTime };
  }
  cacheMetrics.inc('llm-select', 'miss');

  // Build candidate list for prompt
  const candidateList = candidates
    .map((c, i) => {
      return `${i + 1}. ref="${c.node.ref}" <${c.node.tag}> ${c.candidateText}`;
    })
    .join('\n');

  // Build page scene summary for top-down context
  const sceneSummary = buildSceneSummary(candidates);
  const sceneContext = sceneSummary ? `\nPAGE STATE: ${sceneSummary}` : '';

  // Detect if duplicates exist (marked as [N of M] by the dedup logic above)
  const hasDuplicates = candidates.some(c => /\[\d+ of \d+\]/.test(c.candidateText));
  const dupHint = hasDuplicates
    ? `\nIMPORTANT: Multiple elements share the same label. Use the (CONTEXT: ...) text to match the user's intent. Phrases like "on X", "for X", "у X", "на X", "button on Card Name" mean: pick the element whose CONTEXT contains X.`
    : '';

  // Fingerprint hint section — rendered only when the step has recorded
  // structural properties. The prompt is deliberately soft: the wording
  // instructs the model to use this as a HINT (not a filter) so a minor
  // drift (text change, button restyled, moved by 50px) does not force a
  // null selection when a reasonable match still exists.
  // V22 Audit-fix M1: escape values that flow into LLM prompt text.
  // Newlines or unescaped quotes in recorded fp values (e.g. id with `\n`,
  // text with `"`) can break the prompt's hint structure or smuggle an
  // unintended directive. Cap at 200 chars per value to prevent token
  // bloat from a single oversized field.
  const fpEsc = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    let s = String(v);
    if (s.length > 200) s = s.slice(0, 200);
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  };
  const fpHintLines: string[] = [];
  if (recordedFingerprint) {
    // V22 Audit M1: every value flowing into a `key="${value}"` line gets
    // run through fpEsc to neutralize embedded quotes/newlines/backslashes.
    // ── Identity attributes (most stable; use as primary disambiguators) ──
    if (recordedFingerprint.tag) fpHintLines.push(`tag=<${fpEsc(recordedFingerprint.tag)}>`);
    if (recordedFingerprint.role) fpHintLines.push(`role="${fpEsc(recordedFingerprint.role)}"`);
    // V22: id is the strongest identity signal after testId — emit it FIRST
    // among the "stable identifiers" group so the LLM weighs it accordingly.
    if (recordedFingerprint.elementId) fpHintLines.push(`id="${fpEsc(recordedFingerprint.elementId)}"`);
    if (recordedFingerprint.testIdAttr) fpHintLines.push(`testId="${fpEsc(recordedFingerprint.testIdAttr)}"`);
    if (recordedFingerprint.name) fpHintLines.push(`name="${fpEsc(recordedFingerprint.name)}"`);

    // ── Descriptive attributes ──
    if (recordedFingerprint.ariaLabel) fpHintLines.push(`ariaLabel="${fpEsc(recordedFingerprint.ariaLabel)}"`);
    if (recordedFingerprint.labelText) fpHintLines.push(`labelText="${fpEsc(recordedFingerprint.labelText)}"`);
    if (recordedFingerprint.text) fpHintLines.push(`text="${fpEsc(recordedFingerprint.text)}"`);
    if (recordedFingerprint.placeholder) fpHintLines.push(`placeholder="${fpEsc(recordedFingerprint.placeholder)}"`);
    if (recordedFingerprint.title) fpHintLines.push(`title="${fpEsc(recordedFingerprint.title)}"`);
    if (recordedFingerprint.alt) fpHintLines.push(`alt="${fpEsc(recordedFingerprint.alt)}"`);
    if (recordedFingerprint.type) fpHintLines.push(`inputType="${fpEsc(recordedFingerprint.type)}"`);

    // ── Secondary locator signals (V22) ──
    if (recordedFingerprint.cssClass) fpHintLines.push(`cssClass="${fpEsc(recordedFingerprint.cssClass)}"`);
    if (recordedFingerprint.href) fpHintLines.push(`href="${fpEsc(recordedFingerprint.href)}"`);
    if (recordedFingerprint.ariaControls) fpHintLines.push(`ariaControls="${fpEsc(recordedFingerprint.ariaControls)}"`);

    // ── Spatial / structural context ──
    if (recordedFingerprint.nearestLandmark) fpHintLines.push(`inLandmark="${fpEsc(recordedFingerprint.nearestLandmark)}"`);
    if (recordedFingerprint.containerTitles?.length) {
      // JSON.stringify already escapes quotes; no fpEsc needed here.
      fpHintLines.push(`containers=${JSON.stringify(recordedFingerprint.containerTitles.slice(0, 3))}`);
    }
    if (recordedFingerprint.ancestorSummary) {
      fpHintLines.push(`ancestorPath="${fpEsc(recordedFingerprint.ancestorSummary)}"`);
    }
    if (recordedFingerprint.boundingBox) {
      const bb = recordedFingerprint.boundingBox;
      fpHintLines.push(`recordedAt=(${Math.round(bb.x)},${Math.round(bb.y)},${Math.round(bb.width)}x${Math.round(bb.height)})`);
    }

    // ── V22 Pkg1: child icon testid + data-value ──
    if ((recordedFingerprint as any).childTestId) {
      fpHintLines.push(`childIconTestId="${fpEsc((recordedFingerprint as any).childTestId)}"`);
    }
    // V22 Pkg4: semantic icon label (svg title / data-lucide / FA class).
    if ((recordedFingerprint as any).iconLabel) {
      fpHintLines.push(`iconLabel="${fpEsc((recordedFingerprint as any).iconLabel)}"`);
    }
    if ((recordedFingerprint as any).dataValue) {
      fpHintLines.push(`dataValue="${fpEsc((recordedFingerprint as any).dataValue)}"`);
    }

    // ── V22 Pkg2: Bootstrap / aria-haspopup / activedescendant / row key ──
    if ((recordedFingerprint as any).bsToggle) {
      fpHintLines.push(`bsToggle="${fpEsc((recordedFingerprint as any).bsToggle)}"`);
    }
    if ((recordedFingerprint as any).bsTarget) {
      fpHintLines.push(`bsTarget="${fpEsc((recordedFingerprint as any).bsTarget)}"`);
    }
    if ((recordedFingerprint as any).ariaHasPopup) {
      fpHintLines.push(`ariaHasPopup="${fpEsc((recordedFingerprint as any).ariaHasPopup)}"`);
    }
    if ((recordedFingerprint as any).ariaActiveDescendant) {
      fpHintLines.push(`activeDescendant="${fpEsc((recordedFingerprint as any).ariaActiveDescendant)}"`);
    }
    if ((recordedFingerprint as any).dataRowKey) {
      fpHintLines.push(`dataRowKey="${fpEsc((recordedFingerprint as any).dataRowKey)}"`);
    }

    // ── V22 Pkg5: row text + sibling pos + disabled state + arrow direction ──
    // nearestRowText is the headline disambiguator for table-row clicks
    // (the recorded checkbox/button gets "AO HABAR khabar 980640..." as
    // its row context). siblingIndex is 0-indexed in storage but emitted
    // 1-indexed in the prompt (more natural for the LLM).
    if ((recordedFingerprint as any).nearestRowText) {
      fpHintLines.push(`rowText="${fpEsc((recordedFingerprint as any).nearestRowText)}"`);
    }
    if (typeof (recordedFingerprint as any).siblingIndex === 'number') {
      fpHintLines.push(`siblingPos=${((recordedFingerprint as any).siblingIndex as number) + 1}`);
    }
    if ((recordedFingerprint as any).disabled === true) {
      fpHintLines.push('disabled=true');
    } else if ((recordedFingerprint as any).disabled === false) {
      fpHintLines.push('disabled=false');
    }
    if ((recordedFingerprint as any).arrowDir) {
      fpHintLines.push(`arrowDir="${fpEsc((recordedFingerprint as any).arrowDir)}"`);
    }

    // ── ARIA state at recording time (V22) ──
    // Distinguishes "click toggle when expanded" vs "when collapsed",
    // and "click invalid input with red border" vs "click freshly-cleared one".
    if (recordedFingerprint.ariaState) {
      const stateBits: string[] = [];
      const st = recordedFingerprint.ariaState;
      if (st.expanded === true) stateBits.push('expanded');
      else if (st.expanded === false) stateBits.push('collapsed');
      if (st.pressed === true) stateBits.push('pressed');
      else if (st.pressed === false) stateBits.push('not-pressed');
      if (st.checked === true) stateBits.push('checked');
      else if (st.checked === false) stateBits.push('unchecked');
      if (st.invalid === true) stateBits.push('invalid');
      // V22 Pkg1: current/valueNow/valueText state — Pagination/Slider fidelity
      if ((st as any).current) stateBits.push(`current=${(st as any).current}`);
      if (typeof (st as any).valueNow === 'number') stateBits.push(`valueNow=${(st as any).valueNow}`);
      if ((st as any).valueText) stateBits.push(`valueText="${(st as any).valueText}"`);
      if (stateBits.length > 0) fpHintLines.push(`stateAtRecord=[${stateBits.join(',')}]`);
    }
  }
  const fpHint = fpHintLines.length > 0
    ? `\nRECORDED ELEMENT HINTS (use as a guide, not a hard filter — surface text, exact coordinates or styling may have drifted):\n${fpHintLines.join('\n')}`
    : '';

  const userPrompt = `INTENT: "${intentText}"
ACTION: ${actionType}
PAGE: ${pageUrl}
VIEWPORT: ${PREVIEW_VIEWPORT.width}x${PREVIEW_VIEWPORT.height}${sceneContext}${dupHint}${fpHint}

ELEMENTS (${candidates.length}):
${candidateList}

Select the single best matching element, or return ref=null if the intent does not meaningfully describe any element.`;

  // Call LLM with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_SELECT_TIMEOUT_MS);

  // V22: pick prompt by mode. Heal-mode biases toward "find any reasonable
  // match" using recordedFingerprint as primary evidence; apply-mode allows
  // null when the description is gibberish or doesn't fit any candidate.
  const systemPrompt = mode === 'heal' ? LLM_SELECT_HEAL_PROMPT : LLM_SELECT_APPLY_PROMPT;

  try {
    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model: AI_TASK_MODELS.disambiguation,
        temperature: 0.1,
        // 200 tokens was too tight: Gemini Flash Lite in JSON mode occasionally
        // hit MAX_TOKENS before closing the JSON object, producing an empty
        // response (finishReason=MAX_TOKENS). 500 gives enough headroom for
        // the {ref,confidence,reason,alternatives?} shape without blowing up cost.
        max_tokens: 500,
        response_format: { type: 'json_object' },
        abortSignal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    // Parse response
    // V15: Use balanced-brace parser instead of greedy regex.
    // Greedy /\{[\s\S]*\}/ captures from FIRST '{' to LAST '}', which fails
    // when LLM returns multiple JSON objects or thinking text with braces.
    const content = response?.content || '';
    const jsonStr = extractFirstJsonObject(content);
    if (!jsonStr) {
      logger.warn('[LLM_SELECT] No JSON in response', { preview: content.slice(0, 200) });
      throw new Error('No JSON in LLM response');
    }

    const parsed = safeParseJsonResponse(jsonStr) as {
      ref?: string | null;
      confidence?: number;
      reason?: string;
      alternatives?: string[];
    } | null;
    if (!parsed) {
      // Repair attempts exhausted — surface as a soft failure so the caller
      // falls into the rule-based degraded path with full context.
      logger.warn('[LLM_SELECT] Unrecoverable JSON parse failure', {
        contentPreview: content.slice(0, 200),
        jsonPreview: jsonStr.slice(0, 200),
      });
      throw new Error('LLM response could not be parsed as JSON');
    }

    // Validate ref against candidate list
    const validRefs = new Set(candidates.map(c => c.node.ref));

    let result: LlmSelectResult;

    if (parsed.ref && validRefs.has(parsed.ref)) {
      const confidence = Math.min(1, Math.max(0, parsed.confidence ?? 0.8));
      // Reject low-confidence matches — likely nonsense/irrelevant descriptions
      if (confidence < 0.4) {
        result = {
          status: 'not_found',
          selectedRef: null,
          confidence: 0,
          reason: (parsed.reason || 'description does not match any element').slice(0, 200),
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        };
      } else {
        // Single element selected with sufficient confidence
        result = {
          status: 'resolved',
          selectedRef: parsed.ref,
          confidence,
          reason: (parsed.reason || '').slice(0, 200),
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        };
      }
    } else if (parsed.alternatives && Array.isArray(parsed.alternatives) && parsed.alternatives.length > 0) {
      // Ambiguous — multiple valid options
      const validAlts = parsed.alternatives.filter(r => validRefs.has(r));
      if (validAlts.length > 0) {
        result = {
          status: 'needs_clarification',
          selectedRef: null,
          confidence: 0,
          reason: (parsed.reason || '').slice(0, 200),
          alternativeRefs: validAlts,
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        };
      } else {
        result = {
          status: 'not_found',
          selectedRef: null,
          confidence: 0,
          reason: 'LLM suggested alternatives with invalid refs',
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        };
      }
    } else {
      // Nothing matches or invalid ref
      result = {
        status: parsed.ref === null ? 'not_found' : 'not_found',
        selectedRef: null,
        confidence: 0,
        reason: (parsed.reason || 'no matching element').slice(0, 200),
        latencyMs: Date.now() - startTime,
        cacheHit: false,
      };
    }

    // Cache result
    if (llmSelectCache.size >= LLM_SELECT_CACHE_MAX_SIZE) {
      const now = Date.now();
      for (const [k, v] of llmSelectCache) {
        if (now - v.createdAt > LLM_SELECT_CACHE_TTL_MS) llmSelectCache.delete(k);
      }
      if (llmSelectCache.size >= LLM_SELECT_CACHE_MAX_SIZE) {
        const oldest = Array.from(llmSelectCache.entries())
          .sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (const [k] of oldest.slice(0, Math.floor(LLM_SELECT_CACHE_MAX_SIZE / 4))) {
          llmSelectCache.delete(k);
        }
      }
    }
    llmSelectCache.set(cacheKey, { result, createdAt: Date.now() });

    recordLlmSelectSuccess();

    // Attach LLM trace for diagnostics (not cached, only on fresh calls)
    result._prompt = userPrompt;
    result._response = content;
    result._model = AI_TASK_MODELS.disambiguation;

    logger.info('[LLM_SELECT] Element selection complete', {
      event: 'llm_select_complete',
      status: result.status,
      selectedRef: result.selectedRef,
      confidence: result.confidence,
      latencyMs: result.latencyMs,
      candidateCount: candidates.length,
      actionType,
    });

    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    recordLlmSelectFailure();

    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn('[LLM_SELECT] Failed', {
      event: 'llm_select_failed',
      error: errorMsg,
      candidateCount: candidates.length,
      latencyMs: Date.now() - startTime,
    });

    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve step using LLM-first element selection with deterministic pre-filter.
 *
 * Pipeline:
 * 1. Build HardAllowed/SoftAllowed sets via structural rules (visibility, tag/role)
 * 2. Count-based decision:
 *    - 0 allowed → Gemini Flash rescue (vision-enhanced)
 *    - 1+ allowed → LLM selection (gemini-2.5-flash-lite)
 * 3. Vision second opinion for visual elements (img/svg/canvas) if LLM can't match
 *
 * @returns LintResult with resolution metrics
 */
/**
 * V15: Screenshot-space coordinate mapping.
 * When the screenshot is a clipped viewport (intent-step-lint.service.ts clips to
 * scrollY-100 .. scrollY+viewportH+200 in PAGE space), vision returns bbox coordinates
 * in SCREENSHOT space (0-based from clip origin). To map back to DOM, we need the
 * page-Y of the screenshot's top edge so we can offset vision coords before comparing
 * to `node.boundingBox` — which is VIEWPORT-space (from getBoundingClientRect).
 * clipPageTop = page-Y of the screenshot's pixel (0,0).
 * scrollY = current viewport scroll. To map vision y (screenshot-space) to node.boundingBox y
 * (viewport-space): viewportY = visionY + clipPageTop - scrollY.
 * Back-compat: plain base64 string is treated as full-viewport screenshot (clipPageTop = scrollY).
 */
export type ScreenshotResult = string | { base64: string; clipPageTop?: number; scrollY?: number };

interface NormalizedScreenshot {
  base64: string;
  /** page Y of the screenshot's pixel (0,0). Default: 0 (assume full page / top of viewport). */
  clipPageTop: number;
  /** current scroll Y when screenshot was taken. Default: 0. */
  scrollY: number;
}

/** Resolve ScreenshotResult or lazy callback to a normalized { base64, clipPageTop, scrollY }. */
async function resolveScreenshot(
  src: ScreenshotResult | (() => Promise<ScreenshotResult | null>) | undefined
): Promise<NormalizedScreenshot | undefined> {
  if (!src) return undefined;
  let raw: ScreenshotResult | null;
  if (typeof src === 'function') {
    try { raw = await src(); } catch { return undefined; }
  } else {
    raw = src;
  }
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    // Back-compat: assume screenshot == viewport, no offset needed
    return { base64: raw, clipPageTop: 0, scrollY: 0 };
  }
  return {
    base64: raw.base64,
    clipPageTop: typeof raw.clipPageTop === 'number' ? raw.clipPageTop : 0,
    scrollY: typeof raw.scrollY === 'number' ? raw.scrollY : 0,
  };
}

/**
 * Map a vision-returned bounding box (screenshot pixel space) to viewport space
 * that matches `node.boundingBox` (from getBoundingClientRect).
 * viewportY = screenshotY + clipPageTop - scrollY.
 */
function mapVisionBboxToViewport(
  bb: { x: number; y: number; width: number; height: number },
  shot: NormalizedScreenshot
): { x: number; y: number; width: number; height: number } {
  const dy = shot.clipPageTop - shot.scrollY;
  return { x: bb.x, y: bb.y + dy, width: bb.width, height: bb.height };
}

/**
 * Sanity-check a vision bbox BEFORE mapping. Gemini occasionally returns page-space
 * or otherwise absurd coordinates despite the prompt instruction. We require the bbox
 * to sit within the screenshot bounds (with a small overflow tolerance). The actual
 * screenshot height isn't available here without decoding the JPEG, so we approximate:
 * the clip height is at most scrollY_delta (up to 300px beyond viewport) — a reasonable
 * ceiling. Also reject NaN/negative values.
 */
function isVisionBboxReasonable(
  bb: { x: number; y: number; width: number; height: number } | undefined
): boolean {
  if (!bb) return false;
  const { x, y, width, height } = bb;
  if (![x, y, width, height].every(v => typeof v === 'number' && Number.isFinite(v))) return false;
  if (width <= 0 || height <= 0) return false;
  // Screenshot space is 0-based. Allow small negative overflow (-50) for rounding.
  if (x < -50 || y < -50) return false;
  // Upper bound: generous — viewport widths up to 4K, clip heights up to full-page snapshot.
  // Better to accept a too-large bbox and let containment fail cleanly than reject valid
  // coords from a big screen. 10000 is safely above any realistic viewport.
  if (x > 10000 || y > 10000 || width > 10000 || height > 10000) return false;
  return true;
}

export async function resolveElement(params: {
  previewSessionId: string;
  stepDraft: IntentStep;
  domNodes: InteractiveNode[];
  pageUrl: string;
  /** When true, include candidates in result (for Show Alternatives) */
  includeAlternatives?: boolean;
  /** Phase 6: Screenshot for vision-enhanced rescue (base64 JPEG/PNG or lazy callback) */
  screenshot?: ScreenshotResult | (() => Promise<ScreenshotResult | null>);
  /**
   * V22: caller mode. 'apply' (default) for editor authoring + preview run;
   * 'heal' for command-executor.ts auto-heal during regression. Routes to
   * the appropriate LLM prompt and cache slot. The legacy convention of
   * `previewSessionId === 'background'` indicating heal-mode is honored
   * automatically when this flag isn't set.
   */
  mode?: 'apply' | 'heal';
}): Promise<LintResult> {
  const {
    previewSessionId,
    stepDraft,
    domNodes,
    pageUrl,
    includeAlternatives = false,
    screenshot: screenshotOrFnRaw,
  } = params;
  // V22: derive heal-mode from explicit param OR the legacy
  // `previewSessionId === 'background'` convention used by command-executor.
  const resolveMode: 'apply' | 'heal' =
    params.mode ?? (previewSessionId === 'background' ? 'heal' : 'apply');
  const startTime = Date.now();

  // V15: Memoize screenshot capture within this resolveElement call.
  // The lazy callback is consumed by up to 3 paths (allowedCount===0 rescue,
  // proactive-vision for blind icons, vision second-opinion after text LLM). Calling
  // page.screenshot()+page.evaluate() 3× in the same resolver invocation is wasteful
  // AND unsafe: scroll position or DOM could mutate between calls, giving divergent
  // clipPageTop/scrollY values that desync the bbox→viewport mapping.
  // Capture ONCE, reuse. Null result is also memoized (don't retry a failing callback).
  let cachedShot: NormalizedScreenshot | undefined | null = undefined;
  const screenshotOrFn: typeof screenshotOrFnRaw | undefined = (() => {
    if (!screenshotOrFnRaw) return undefined;
    if (typeof screenshotOrFnRaw !== 'function') return screenshotOrFnRaw;
    return async (): Promise<ScreenshotResult | null> => {
      if (cachedShot !== undefined) {
        // cachedShot was already resolved (null = prior attempt failed)
        return cachedShot === null ? null : { base64: cachedShot.base64, clipPageTop: cachedShot.clipPageTop, scrollY: cachedShot.scrollY };
      }
      try {
        const raw = await (screenshotOrFnRaw as () => Promise<ScreenshotResult | null>)();
        if (!raw) { cachedShot = null; return null; }
        if (typeof raw === 'string') {
          cachedShot = { base64: raw, clipPageTop: 0, scrollY: 0 };
        } else {
          cachedShot = {
            base64: raw.base64,
            clipPageTop: typeof raw.clipPageTop === 'number' ? raw.clipPageTop : 0,
            scrollY: typeof raw.scrollY === 'number' ? raw.scrollY : 0,
          };
        }
        return { base64: cachedShot.base64, clipPageTop: cachedShot.clipPageTop, scrollY: cachedShot.scrollY };
      } catch {
        cachedShot = null;
        return null;
      }
    };
  })();

  logger.debug('[ELEMENT_RESOLVER] Starting resolution', {
    previewSessionId,
    stepType: stepDraft.type,
    description: stepDraft.description.slice(0, 50),
    nodeCount: domNodes.length,
  });

  // Non-targeting actions don't need element resolution
  if (['navigate', 'wait', 'wait_for', 'ai_check', 'switch_tab'].includes(stepDraft.type)) {
    return {
      status: 'resolved',
      message: `Action "${stepDraft.type}" does not require element targeting`,
      confidence: 1,
      candidates: [],
      highlight: [],
    };
  }

  if (domNodes.length === 0) {
    return {
      status: 'not_found',
      message: 'No interactive elements found on page',
      confidence: 0,
      candidates: [],
      highlight: [],
      needsAiFallback: true,
      _ruleTrace: [],
      _hardAllowedCount: 0,
      _softAllowedCount: 0,
    };
  }

  // Step 1: Prepare intent text
  const intentText = sanitizeIntent(stepDraft);

  // Step 2: Build HardAllowed/SoftAllowed sets via deterministic DOM-structural rules (sync)
  const allowedResult = buildAllowedSets(domNodes, stepDraft.type);
  const { hardAllowed, softAllowed, ruleTrace } = allowedResult;
  
  // Diagnostic fields for trace logging
  const _diag = {
    _ruleTrace: ruleTrace,
    _hardAllowedCount: hardAllowed.length,
    _softAllowedCount: softAllowed.length,
  };

  // Combine allowed sets (hardAllowed first, then softAllowed)
  const allAllowed = [...hardAllowed, ...softAllowed];
  const allowedCount = allAllowed.length;

  logger.debug('[ELEMENT_RESOLVER] Allowed sets built', {
    previewSessionId,
    hardAllowedCount: hardAllowed.length,
    softAllowedCount: softAllowed.length,
    totalAllowed: allowedCount,
  });

  // Step 3: Handle case of 0 allowed elements
  // V5: Before giving up, try Gemini Flash rescue on excluded-but-visible nodes
  if (allowedCount === 0) {
    const allowedRefs = new Set([...hardAllowed, ...softAllowed].map(n => n.ref));
    const excludedNodes = domNodes.filter(n => n.ref && !allowedRefs.has(n.ref));

    // V14: Resolve screenshot lazily — only capture when we actually need vision rescue
    // V15: Normalized — carries clipPageTop/scrollY for correct bbox-to-viewport mapping
    const shot = await resolveScreenshot(screenshotOrFn);

    const rescueResult = await rescueWithGeminiFlash({
      intentText,
      actionType: stepDraft.type,
      excludedNodes,
      pageUrl,
      screenshot: shot?.base64,
    });

    if (rescueResult) {
      // V14: Handle both ref-based and boundingBox-only results
      const rescuedNode = rescueResult.ref ? domNodes.find(n => n.ref === rescueResult.ref) : undefined;

      if (rescuedNode) {
        logger.info('[ELEMENT_RESOLVER] Gemini Flash rescue succeeded', {
          event: 'gemini_rescue',
          previewSessionId,
          ref: rescueResult.ref,
          confidence: rescueResult.confidence,
          totalLatencyMs: Date.now() - startTime,
        });

        const lintCandidate: LintCandidate = {
          ref: rescuedNode.ref,
          label: rescuedNode.labelText || rescuedNode.ariaLabel || rescuedNode.text || rescuedNode.placeholder || `<${rescuedNode.tag}>`,
          reason: `AI rescue: ${rescueResult.reason}`,
          confidence: rescueResult.confidence,
          boundingBox: rescuedNode.boundingBox,
          node: rescuedNode,
        };

        return {
          status: 'resolved',
          message: `Element found by AI: ${rescueResult.reason}`,
          confidence: rescueResult.confidence,
          candidates: [lintCandidate],
          highlight: [{ ref: rescuedNode.ref, boundingBox: rescuedNode.boundingBox, type: 'success' }],
          cacheHit: false,
          degradedMode: false,
          ..._diag,
        };
      }

      // V14: BoundingBox-only result — vision found element by coordinates but not in DOM list.
      // Search ALL domNodes (not just excluded) — vision coordinates may match any element.
      if (rescueResult.boundingBox && isVisionBboxReasonable(rescueResult.boundingBox)) {
        // V15: Vision returns coords in SCREENSHOT space (0-based from clip origin).
        // `node.boundingBox` is VIEWPORT space (getBoundingClientRect). Map before comparing.
        const bb = shot ? mapVisionBboxToViewport(rescueResult.boundingBox, shot) : rescueResult.boundingBox;
        const bbCenterX = bb.x + bb.width / 2;
        const bbCenterY = bb.y + bb.height / 2;

        let bestNode: InteractiveNode | undefined;
        let bestDist = Infinity;
        let isContainmentMatch = false;

        for (const node of domNodes) {
          if (!node.ref || !node.boundingBox || node.isVisible === false) continue;
          const nb = node.boundingBox;
          // Check if vision center falls inside this node's bounding box
          if (bbCenterX >= nb.x && bbCenterX <= nb.x + nb.width &&
              bbCenterY >= nb.y && bbCenterY <= nb.y + nb.height) {
            // Prefer smallest element that contains the point (most specific)
            const area = nb.width * nb.height;
            if (area < bestDist) { bestDist = area; bestNode = node; isContainmentMatch = true; }
          }
        }

        // Fallback: nearest center-to-center if no containment match (100px threshold)
        if (!bestNode) {
          bestDist = Infinity;
          isContainmentMatch = false;
          for (const node of domNodes) {
            if (!node.ref || !node.boundingBox || node.isVisible === false) continue;
            const nb = node.boundingBox;
            const nCenterX = nb.x + nb.width / 2;
            const nCenterY = nb.y + nb.height / 2;
            const dist = Math.sqrt((bbCenterX - nCenterX) ** 2 + (bbCenterY - nCenterY) ** 2);
            if (dist < bestDist && dist < 100) { bestDist = dist; bestNode = node; }
          }
        }

        if (bestNode) {
          // V8: Vision already did semantic matching (Gemini saw the screenshot and
          // identified the element). The coordinate mapping to DOM is a spatial lookup.
          // Penalize confidence based on distance — farther = less reliable mapping.
          // Containment match = reliable (vision center inside element). Center-to-center = less reliable.
          const distancePenalty = isContainmentMatch ? 0 : Math.min(0.3, bestDist / 300);
          const adjustedConfidence = Math.min(rescueResult.confidence, 0.85) - distancePenalty;

          if (adjustedConfidence >= 0.3) {
            logger.info('[ELEMENT_RESOLVER] Vision rescue: matched by bounding box', {
              event: 'gemini_rescue_bbox',
              previewSessionId,
              ref: bestNode.ref,
              visionBBox: bb,
              nodeBBox: bestNode.boundingBox,
              distance: bestDist,
              isContainmentMatch,
              adjustedConfidence,
              totalLatencyMs: Date.now() - startTime,
            });

            const lintCandidate: LintCandidate = {
              ref: bestNode.ref,
              label: bestNode.labelText || bestNode.ariaLabel || bestNode.text || bestNode.placeholder || `<${bestNode.tag}>`,
              reason: `Vision rescue (coordinates): ${rescueResult.reason}`,
              confidence: adjustedConfidence,
              boundingBox: bestNode.boundingBox,
              node: bestNode,
            };

            // High distance = low confidence → return as needs_clarification instead of resolved
            const status: LintStatus = adjustedConfidence >= 0.5 ? 'resolved' : 'needs_clarification';

            return {
              status,
              message: status === 'resolved'
                ? `Element found by vision coordinates: ${rescueResult.reason}`
                : `Vision found a possible match but confidence is low. Is this the right element?`,
              confidence: adjustedConfidence,
              candidates: [lintCandidate],
              highlight: [{ ref: bestNode.ref, boundingBox: bestNode.boundingBox, type: status === 'resolved' ? 'success' : 'warning' }],
              cacheHit: false,
              degradedMode: false,
              ...(status === 'needs_clarification' ? { alternativesIncluded: true } : {}),
              ..._diag,
            };
          }

          // Too far from vision target — unreliable coordinate mapping
          logger.info('[ELEMENT_RESOLVER] Vision rescue: bbox match rejected (low confidence after distance penalty)', {
            event: 'gemini_rescue_bbox_rejected',
            previewSessionId,
            ref: bestNode.ref,
            distance: bestDist,
            adjustedConfidence,
            totalLatencyMs: Date.now() - startTime,
          });
        }
      }
    }

    logger.info('[ELEMENT_RESOLVER] Zero allowed elements (rescue failed)', {
      event: 'lint_decision',
      previewSessionId,
      stepType: stepDraft.type,
      status: 'not_found',
      rulesApplied: ruleTrace.length,
      totalLatencyMs: Date.now() - startTime,
    });

    // V8: Include nearby suggestions so the user sees "Did you mean?" instead of dead end.
    // Gather visible elements with labels as suggestions (regardless of tag compatibility).
    const suggestions: LintCandidate[] = domNodes
      .filter(n => n.ref && n.isVisible !== false && (n.labelText || n.ariaLabel || n.text))
      .slice(0, 5)
      .map(n => ({
        ref: n.ref,
        label: n.labelText || n.ariaLabel || n.text || n.placeholder || `<${n.tag}>`,
        reason: 'Visible element on page',
        confidence: 0,
        boundingBox: n.boundingBox,
        node: n,
      }));

    return {
      status: 'not_found',
      message: 'No elements match your description on this page',
      confidence: 0,
      candidates: suggestions,
      highlight: [],
      needsAiFallback: true,
      degradedMode: false,
      // V8: Signal to frontend to show suggestions as "Did you mean?" list
      ...(suggestions.length > 0 ? { alternativesIncluded: true } : {}),
      ..._diag,
    };
  }

  // Step 5: Handle case of exactly 1 allowed element
  // V8 FIX: Do NOT auto-resolve — always send to LLM for semantic verification.
  // Without this, user types "login" but only 1 element passes tag filter (e.g. logo <a>)
  // → system returns "Found element" with 0.9 confidence on a completely wrong element.
  // LLM call is fast (~200ms via gemini-2.5-flash-lite) and can:
  //   - Confirm match (including cross-language: "войти" = "login")
  //   - Return not_found if the single element truly doesn't match
  if (allowedCount === 1) {
    logger.debug('[ELEMENT_RESOLVER] Single allowed element — sending to LLM for verification', {
      previewSessionId,
      ref: allAllowed[0].ref,
      intentText: intentText.slice(0, 50),
      nodeLabel: (allAllowed[0].labelText || allAllowed[0].ariaLabel || allAllowed[0].text || '').slice(0, 50),
    });
    // Falls through to Step 6 (LLM selection) below
  }

  // Step 6: Multiple allowed elements → pre-score sort + LLM selection
  // Pre-score: rank elements by text overlap with intent so the most relevant
  // elements always land in the LLM batch, regardless of DOM position.
  // This is a SORT, not a FILTER — score=0 elements still fill remaining slots.
  const rankedAllowed = preScoreAndSort(allAllowed, intentText, MAX_CANDIDATES_FOR_LLM);
  const primaryBatch = rankedAllowed.slice(0, MAX_CANDIDATES_FOR_LLM);
  const overflowBatch = rankedAllowed.slice(MAX_CANDIDATES_FOR_LLM);

  const candidatesToProcess: Array<{ node: InteractiveNode; candidateText: string }> = [];
  for (const node of primaryBatch) {
    const candidateText = buildCandidateText(node);
    candidatesToProcess.push({ node, candidateText });
  }

  // Mark duplicate elements with [N of M] and promote CONTEXT for disambiguation
  markDuplicatesWithContext(candidatesToProcess);

  // V15: Proactive vision escalation for indistinguishable icon-only buttons.
  // Trigger when EVERY candidate is an icon-button with no semantic label AND no icon hint —
  // i.e. text LLM provably cannot tell them apart. In that case skip the text LLM (which would
  // fall back to DOM order and pick the wrong one) and go straight to vision.
  // We only fire when ALL primary candidates are blind, not just "2+ blind among labeled peers"
  // — because if even one candidate has a label, the text LLM can eliminate the blind ones and
  // match the labeled one, or return null. Gating on "all blind" prevents needless vision calls.
  const iconOnlyBlind = candidatesToProcess.filter(c => {
    const n = c.node;
    if (!n.isIconButton) return false;
    const hasLabel = !!(n.ariaLabel || n.title || n.labelText || (n.text && n.text.trim().length > 0));
    const hasIconHint = !!(n.iconClasses && n.iconClasses.trim().length > 0);
    return !hasLabel && !hasIconHint;
  });
  const allCandidatesBlind =
    candidatesToProcess.length >= 2 &&
    iconOnlyBlind.length === candidatesToProcess.length;
  if (allCandidatesBlind && screenshotOrFn) {
    logger.info('[ELEMENT_RESOLVER] Proactive vision — all candidates are blind icon-only buttons', {
      previewSessionId,
      blindIconCount: iconOnlyBlind.length,
      totalCandidates: candidatesToProcess.length,
      intentText: intentText.slice(0, 50),
    });
    const shot = await resolveScreenshot(screenshotOrFn);
    if (shot) {
      const visionResult = await rescueWithGeminiFlash({
        intentText,
        actionType: stepDraft.type,
        // Pass the blind icon candidates so vision matches among them (name is legacy;
        // `rescueWithGeminiFlash` treats these as the candidate pool, not exclusions).
        excludedNodes: iconOnlyBlind.map(c => c.node),
        pageUrl,
        screenshot: shot.base64,
      });

      // Path 1: Vision returned a ref directly
      if (visionResult && visionResult.ref) {
        const pickedNode = iconOnlyBlind.find(c => c.node.ref === visionResult.ref)?.node
          || domNodes.find(n => n.ref === visionResult.ref);
        if (pickedNode) {
          logger.info('[ELEMENT_RESOLVER] Proactive vision resolved icon-only tab (by ref)', {
            event: 'proactive_vision',
            previewSessionId,
            ref: pickedNode.ref,
            confidence: visionResult.confidence,
            reason: visionResult.reason,
            totalLatencyMs: Date.now() - startTime,
          });
          const lintCandidate: LintCandidate = {
            ref: pickedNode.ref,
            label: pickedNode.labelText || pickedNode.ariaLabel || pickedNode.text || `<${pickedNode.tag}>`,
            reason: `Vision match (icon-only): ${visionResult.reason}`,
            confidence: visionResult.confidence,
            boundingBox: pickedNode.boundingBox,
            node: pickedNode,
          };
          return {
            status: visionResult.confidence >= 0.5 ? 'resolved' as LintStatus : 'needs_clarification' as LintStatus,
            message: `Icon identified by visual analysis: ${visionResult.reason}`,
            confidence: visionResult.confidence,
            candidates: [lintCandidate],
            highlight: [{
              ref: pickedNode.ref,
              boundingBox: pickedNode.boundingBox,
              type: visionResult.confidence >= 0.5 ? 'success' : 'warning',
            }],
            cacheHit: false,
            degradedMode: false,
            ..._diag,
          };
        }
      }

      // Path 2: Vision returned only a boundingBox — map screenshot space → viewport space
      // and pick the smallest containing node among the blind icons.
      if (visionResult && visionResult.boundingBox && isVisionBboxReasonable(visionResult.boundingBox)) {
        const vbb = mapVisionBboxToViewport(visionResult.boundingBox, shot);
        const cx = vbb.x + vbb.width / 2;
        const cy = vbb.y + vbb.height / 2;
        let best: InteractiveNode | undefined;
        let bestArea = Infinity;
        for (const c of iconOnlyBlind) {
          const nb = c.node.boundingBox;
          if (!nb) continue;
          if (cx >= nb.x && cx <= nb.x + nb.width && cy >= nb.y && cy <= nb.y + nb.height) {
            const area = nb.width * nb.height;
            if (area < bestArea) { bestArea = area; best = c.node; }
          }
        }
        if (best) {
          logger.info('[ELEMENT_RESOLVER] Proactive vision resolved icon-only tab (by bbox)', {
            event: 'proactive_vision_bbox',
            previewSessionId,
            ref: best.ref,
            confidence: visionResult.confidence,
            visionBBox: visionResult.boundingBox,
            mappedBBox: vbb,
            totalLatencyMs: Date.now() - startTime,
          });
          const confidence = Math.min(visionResult.confidence, 0.8);
          const lintCandidate: LintCandidate = {
            ref: best.ref,
            label: best.labelText || best.ariaLabel || best.text || `<${best.tag}>`,
            reason: `Vision match by coordinates: ${visionResult.reason}`,
            confidence,
            boundingBox: best.boundingBox,
            node: best,
          };
          return {
            status: confidence >= 0.5 ? 'resolved' as LintStatus : 'needs_clarification' as LintStatus,
            message: `Icon identified by visual coordinates: ${visionResult.reason}`,
            confidence,
            candidates: [lintCandidate],
            highlight: [{ ref: best.ref, boundingBox: best.boundingBox, type: confidence >= 0.5 ? 'success' : 'warning' }],
            cacheHit: false,
            degradedMode: false,
            ..._diag,
          };
        }
      }

      // Vision explicitly could not disambiguate — don't waste a second LLM call on the same
      // problem. Return needs_clarification so the user can pick manually.
      logger.info('[ELEMENT_RESOLVER] Proactive vision inconclusive on blind icons — stopping', {
        previewSessionId,
        visionReason: visionResult?.reason?.slice(0, 120),
      });
      const altCandidates: LintCandidate[] = iconOnlyBlind.map(c => ({
        ref: c.node.ref,
        label: c.node.labelText || c.node.ariaLabel || c.node.text || `<${c.node.tag}>`,
        reason: 'Icon-only button — no semantic label, vision could not disambiguate',
        confidence: 0.3,
        boundingBox: c.node.boundingBox,
        node: c.node,
      }));
      return {
        status: 'needs_clarification',
        message: 'Multiple icon-only buttons with no distinguishing labels — please pick the right one.',
        confidence: 0,
        candidates: includeAlternatives ? altCandidates : [],
        highlight: includeAlternatives
          ? altCandidates.map(c => ({ ref: c.ref, boundingBox: c.boundingBox, type: 'warning' as const }))
          : [],
        cacheHit: false,
        degradedMode: false,
        ...(altCandidates.length > 0 ? { alternativesIncluded: true } : {}),
        ..._diag,
      };
    }
  }

  // Compute page signature for cache
  const pageSignature = computePageSignature(pageUrl, domNodes);

  let cacheHit = false;

  // ── LLM-based element selection ──
  // gemini-2.5-flash-lite natively handles multilingual matching, context understanding,
  // and disambiguation in a single call.
  if (!isLlmSelectBreakerOpen()) {
    try {
      const llmResult = await selectElementWithLLM({
        intentText,
        actionType: stepDraft.type,
        candidates: candidatesToProcess,
        pageUrl,
        pageSignature,
        // V22: prefer the recording-time fingerprint (set by recorder at
        // capture). Falls back to the apply-time fingerprint embedded in
        // the compiled plan (only present after the FIRST successful apply).
        // Without this fallback, the very first apply ran fingerprint-blind
        // even though the recorder had already gathered all the data.
        recordedFingerprint: stepDraft.recordedFingerprint || stepDraft.compiled?.targetFingerprint,
        // V22: route to apply / heal prompt — derived from previewSessionId
        // legacy convention or explicit caller flag, see resolveMode above.
        mode: resolveMode,
      });

      cacheHit = llmResult.cacheHit;

      // Build LLM trace for diagnostics
      const llmTrace = llmResult._prompt ? {
        model: llmResult._model || 'unknown',
        prompt: llmResult._prompt,
        response: llmResult._response || '',
        latencyMs: llmResult.latencyMs,
        path: 'selectElementWithLLM' as const,
      } : undefined;

      if (llmResult.status === 'resolved' && llmResult.selectedRef) {
        // LLM selected a single element
        const selectedNode = candidatesToProcess.find(c => c.node.ref === llmResult.selectedRef);
        if (selectedNode) {
          const lintCandidate: LintCandidate = {
            ref: selectedNode.node.ref,
            label: selectedNode.node.labelText || selectedNode.node.ariaLabel || selectedNode.node.text || selectedNode.node.placeholder || `<${selectedNode.node.tag}>`,
            reason: `AI match: ${llmResult.reason}`,
            confidence: llmResult.confidence,
            boundingBox: selectedNode.node.boundingBox,
            node: selectedNode.node,
          };

          const totalLatencyMs = Date.now() - startTime;
          logger.info('[ELEMENT_RESOLVER] LLM resolution complete', {
            event: 'lint_decision',
            previewSessionId,
            stepType: stepDraft.type,
            status: 'resolved',
            selectedRef: llmResult.selectedRef,
            confidence: llmResult.confidence,
            allowedCount,
            latencyMs: llmResult.latencyMs,
            totalLatencyMs,
            cacheHit,
          });

          return {
            status: 'resolved',
            message: 'Element found by AI',
            confidence: llmResult.confidence,
            candidates: [lintCandidate],
            highlight: [{
              ref: selectedNode.node.ref,
              boundingBox: selectedNode.node.boundingBox,
              type: 'success',
            }],
            cacheHit,
            degradedMode: false,
            ..._diag,
            _llmTrace: llmTrace,
          };
        }
      } else if (llmResult.status === 'needs_clarification' && llmResult.alternativeRefs?.length) {
        // LLM found multiple equally valid options
        const altCandidates = llmResult.alternativeRefs
          .map(ref => candidatesToProcess.find(c => c.node.ref === ref))
          .filter((c): c is { node: InteractiveNode; candidateText: string } => !!c);

        if (altCandidates.length > 0) {
          const lintCandidates: LintCandidate[] = altCandidates.map(c => ({
            ref: c.node.ref,
            label: c.node.labelText || c.node.ariaLabel || c.node.text || c.node.placeholder || `<${c.node.tag}>`,
            reason: `AI: ${llmResult.reason}`,
            confidence: 0.5,
            boundingBox: c.node.boundingBox,
            node: c.node,
          }));

          const highlight = includeAlternatives
            ? altCandidates.map(c => ({
                ref: c.node.ref,
                boundingBox: c.node.boundingBox,
                type: 'warning' as const,
              }))
            : [];

          const totalLatencyMs = Date.now() - startTime;
          logger.info('[ELEMENT_RESOLVER] LLM needs_clarification', {
            event: 'lint_decision',
            previewSessionId,
            stepType: stepDraft.type,
            status: 'needs_clarification',
            alternatives: llmResult.alternativeRefs,
            allowedCount,
            latencyMs: llmResult.latencyMs,
            totalLatencyMs,
            cacheHit,
          });

          return {
            status: 'needs_clarification',
            message: llmResult.reason || 'Multiple matching elements',
            confidence: 0,
            candidates: includeAlternatives ? lintCandidates : [],
            highlight,
            cacheHit,
            degradedMode: false,
            ..._diag,
            _llmTrace: llmTrace,
          };
        }
      }

      // LLM returned not_found — try Vision rescue as second opinion
      // V8: When LLM can't match by text (e.g. user says "image with apple" but <img> has no alt),
      // Vision can look at the actual screenshot and identify visual content.
      if (llmResult.status === 'not_found' || (llmResult.status === 'resolved' && llmResult.confidence < 0.5)) {
        // Check if candidates include visual elements that might need screenshot analysis
        const VISUAL_TAGS = new Set(['img', 'canvas', 'svg', 'video', 'picture']);
        const hasVisualCandidates = candidatesToProcess.some(
          c => VISUAL_TAGS.has(c.node.tag) || c.node.isIconButton
        );

        if (hasVisualCandidates && screenshotOrFn) {
          logger.debug('[ELEMENT_RESOLVER] LLM inconclusive with visual elements — trying Vision rescue', {
            previewSessionId,
            llmStatus: llmResult.status,
            llmConfidence: llmResult.confidence,
            visualCandidateCount: candidatesToProcess.filter(c => VISUAL_TAGS.has(c.node.tag) || c.node.isIconButton).length,
          });

          // Capture screenshot for vision analysis (normalized with clipPageTop/scrollY)
          const visionShot = await resolveScreenshot(screenshotOrFn);

          if (visionShot) {
            // Pass visual candidates as the node list for vision to match against
            const visualNodes = candidatesToProcess
              .filter(c => VISUAL_TAGS.has(c.node.tag) || c.node.isIconButton)
              .map(c => c.node);

            const visionResult = await rescueWithGeminiFlash({
              intentText,
              actionType: stepDraft.type,
              excludedNodes: visualNodes.length > 0 ? visualNodes : allAllowed,
              pageUrl,
              screenshot: visionShot.base64,
            });

            if (visionResult && visionResult.ref) {
              // Search in candidatesToProcess first, then fall back to allAllowed
              const visionNode = candidatesToProcess.find(c => c.node.ref === visionResult.ref)
                || (allAllowed.find(n => n.ref === visionResult.ref) ? { node: allAllowed.find(n => n.ref === visionResult.ref)!, candidateText: '' } : undefined);
              if (visionNode) {
                logger.info('[ELEMENT_RESOLVER] Vision second opinion resolved visual element', {
                  event: 'vision_second_opinion',
                  previewSessionId,
                  ref: visionResult.ref,
                  confidence: visionResult.confidence,
                  reason: visionResult.reason,
                  totalLatencyMs: Date.now() - startTime,
                });

                const lintCandidate: LintCandidate = {
                  ref: visionNode.node.ref,
                  label: visionNode.node.labelText || visionNode.node.ariaLabel || visionNode.node.text || visionNode.node.placeholder || `<${visionNode.node.tag}>`,
                  reason: `Vision match: ${visionResult.reason}`,
                  confidence: visionResult.confidence,
                  boundingBox: visionNode.node.boundingBox,
                  node: visionNode.node,
                };

                return {
                  status: visionResult.confidence >= 0.5 ? 'resolved' as LintStatus : 'needs_clarification' as LintStatus,
                  message: `Element found by visual analysis: ${visionResult.reason}`,
                  confidence: visionResult.confidence,
                  candidates: [lintCandidate],
                  highlight: [{
                    ref: visionNode.node.ref,
                    boundingBox: visionNode.node.boundingBox,
                    type: visionResult.confidence >= 0.5 ? 'success' : 'warning',
                  }],
                  cacheHit: false,
                  degradedMode: false,
                  ..._diag,
                };
              }
            }
          }
        }
      }

      // LLM returned not_found (and vision didn't help)
      // Try overflow batch before giving up — the element may be outside the primary batch
      if (llmResult.status === 'not_found') {
        if (overflowBatch.length > 0) {
          logger.info('[ELEMENT_RESOLVER] Primary batch not_found, trying overflow batch', {
            previewSessionId,
            primaryBatchSize: primaryBatch.length,
            overflowBatchSize: overflowBatch.length,
          });

          const overflowCandidates: Array<{ node: InteractiveNode; candidateText: string }> = [];
          for (const node of overflowBatch.slice(0, MAX_CANDIDATES_FOR_LLM)) {
            overflowCandidates.push({ node, candidateText: buildCandidateText(node) });
          }

          // Apply same duplicate marking logic to overflow batch
          markDuplicatesWithContext(overflowCandidates);

          const overflowResult = await selectElementWithLLM({
            intentText,
            actionType: stepDraft.type,
            candidates: overflowCandidates,
            pageUrl,
            pageSignature: pageSignature + ':overflow',
            // V22: prefer the recording-time fingerprint (set by recorder at
            // capture). Falls back to the apply-time fingerprint embedded in
            // the compiled plan (only present after the FIRST successful apply).
            // Without this fallback, the very first apply ran fingerprint-blind
            // even though the recorder had already gathered all the data.
            recordedFingerprint: stepDraft.recordedFingerprint || stepDraft.compiled?.targetFingerprint,
            // V22: route to apply / heal prompt (overflow path inherits parent mode).
            mode: resolveMode,
          });

          if (overflowResult.status === 'resolved' && overflowResult.selectedRef) {
            const selectedNode = overflowCandidates.find(c => c.node.ref === overflowResult.selectedRef);
            if (selectedNode) {
              logger.info('[ELEMENT_RESOLVER] Overflow batch resolved element', {
                event: 'lint_decision',
                previewSessionId,
                ref: overflowResult.selectedRef,
                confidence: overflowResult.confidence,
                overflowBatchSize: overflowBatch.length,
                totalLatencyMs: Date.now() - startTime,
              });

              const lintCandidate: LintCandidate = {
                ref: selectedNode.node.ref,
                label: selectedNode.node.labelText || selectedNode.node.ariaLabel || selectedNode.node.text || selectedNode.node.placeholder || `<${selectedNode.node.tag}>`,
                reason: `AI match (overflow): ${overflowResult.reason}`,
                confidence: overflowResult.confidence,
                boundingBox: selectedNode.node.boundingBox,
                node: selectedNode.node,
              };

              return {
                status: 'resolved',
                message: 'Element found by AI (extended search)',
                confidence: overflowResult.confidence,
                candidates: [lintCandidate],
                highlight: [{ ref: selectedNode.node.ref, boundingBox: selectedNode.node.boundingBox, type: 'success' }],
                cacheHit: false,
                degradedMode: false,
                ..._diag,
                _llmTrace: overflowResult._prompt ? {
                  model: overflowResult._model || 'unknown',
                  prompt: overflowResult._prompt,
                  response: overflowResult._response || '',
                  latencyMs: overflowResult.latencyMs,
                  path: 'selectElementWithLLM' as const,
                } : undefined,
              };
            }
          }
        }

        const totalLatencyMs = Date.now() - startTime;
        logger.info('[ELEMENT_RESOLVER] LLM selection returned not_found', {
          event: 'lint_decision',
          previewSessionId,
          stepType: stepDraft.type,
          status: 'not_found',
          reason: llmResult.reason,
          allowedCount,
          overflowAttempted: overflowBatch.length > 0,
          totalLatencyMs,
        });

        // V8: Include top candidates as suggestions so user sees "Did you mean?"
        const llmNotFoundSuggestions: LintCandidate[] = candidatesToProcess
          .slice(0, 5)
          .map(c => ({
            ref: c.node.ref,
            label: c.node.labelText || c.node.ariaLabel || c.node.text || c.node.placeholder || `<${c.node.tag}>`,
            reason: 'Available on page',
            confidence: 0,
            boundingBox: c.node.boundingBox,
            node: c.node,
          }));

        // UX: when every visible candidate is inside an active modal, the real target
        // is likely in the backing page and was hard-excluded by the snapshot collector.
        // Surface this to the user instead of the generic "description does not match".
        const allInsideModal = candidatesToProcess.length > 0
          && candidatesToProcess.every(c => c.node.isInsideActiveModal === true);
        const notFoundMessage = allInsideModal
          ? 'Active modal is blocking the page — close it or pick an element inside the modal.'
          : (llmResult.reason || 'No matching element found by AI');

        return {
          status: 'not_found',
          message: notFoundMessage,
          confidence: 0,
          candidates: llmNotFoundSuggestions,
          highlight: [],
          cacheHit,
          degradedMode: false,
          needsAiFallback: true,
          ...(llmNotFoundSuggestions.length > 0 ? { alternativesIncluded: true } : {}),
          ..._diag,
          _llmTrace: llmTrace,
        };
      }

    } catch (llmError) {
      const llmErrorMsg = llmError instanceof Error ? llmError.message : String(llmError);
      const totalLatencyMs = Date.now() - startTime;
      logger.warn('[ELEMENT_RESOLVER] LLM selection failed', {
        previewSessionId,
        error: llmErrorMsg,
        totalLatencyMs,
      });

      return {
        status: 'not_found',
        message: 'Element resolution failed (LLM error)',
        confidence: 0,
        candidates: [],
        highlight: [],
        degradedMode: true,
        degradedReason: 'llm_error',
        needsAiFallback: true,
        ..._diag,
      };
    }
  } else {
    // Circuit breaker open — return degraded
    const totalLatencyMs = Date.now() - startTime;
    logger.warn('[ELEMENT_RESOLVER] LLM circuit breaker open', {
      previewSessionId,
      totalLatencyMs,
    });

    return {
      status: 'not_found',
      message: 'Element resolution temporarily unavailable (circuit breaker)',
      confidence: 0,
      candidates: [],
      highlight: [],
      degradedMode: true,
      degradedReason: 'circuit_breaker_open',
      needsAiFallback: true,
      ..._diag,
    };
  }

  // Should not reach here — all branches above return
  return {
    status: 'not_found',
    message: 'Unexpected resolution state',
    confidence: 0,
    candidates: [],
    highlight: [],
    ..._diag,
  };
}
