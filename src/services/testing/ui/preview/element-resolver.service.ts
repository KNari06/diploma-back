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
import type {
    IntentActionType,
    IntentStep,
    InteractiveNode,
    LintCandidate,
    LintResult,
    LintStatus,
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
  click: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg', 'summary', 'nav', 'header', 'footer', 'section', 'article'],
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

  // ARIA state hints (helps LLM match "selected tab", "expanded menu", "pressed toggle")
  const stateHints: string[] = [];
  if (node.ariaSelected === true) stateHints.push('selected');
  if (node.ariaPressed === true) stateHints.push('pressed');
  if (node.ariaExpanded === true) stateHints.push('expanded');
  else if (node.ariaExpanded === false) stateHints.push('collapsed');
  if (node.ariaChecked === true || node.checked === true) stateHints.push('checked');
  else if (node.ariaChecked === 'mixed') stateHints.push('indeterminate');
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

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI FLASH RESCUE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Vision-enhanced rescue when deterministic rules excluded ALL elements.
 * When screenshot is available, sends it to Gemini 2.0 Flash Vision for visual identification.
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
4. ICON BUTTONS: Elements marked "icon-button" have no text — only an icon. Match the user's visual description to the semantic label (e.g., "eye button" = "toggle password visibility", "X" = "close", "trash" = "delete").
5. If multiple elements could match, pick the one whose label/text is semantically closest.
6. Only use refs from the provided list — never invent refs.
7. If no element is a confident match, return ref as null.
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
      const visionPrompt = `${systemPrompt}\n\n${userPrompt}\n\nIMPORTANT: Look at the screenshot to visually identify the target element. If the element is visible in the screenshot but NOT in the candidate list, return ref as null and provide bounding box coordinates (x, y, width, height in pixels).\n\nJSON format with optional boundingBox: {"ref":"eXX","confidence":0.0-1.0,"reason":"brief","boundingBox":{"x":0,"y":0,"width":0,"height":0}}`;

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

    const parsed = JSON.parse(jsonMatch);

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

const LLM_SELECT_SYSTEM_PROMPT = `You are an AI element selector for a browser testing tool.

TASK: Given a user's intent (ANY language) and a list of candidate UI elements with their positions, select the SINGLE best matching element.

RULES:
1. Match semantically, not literally. Cross-language matching is critical:
   - "войти" = "sign in" = "登录" = "iniciar sesión"
   - "поиск" = "search" = "搜索" = "buscar"
   - "корзина" = "cart" = "购物车" = "carrito"
2. Use action-type semantics:
   - click: prefer buttons, links, interactive elements
   - type: prefer inputs, textareas, editable fields
   - select: prefer dropdowns, select elements, listboxes
   - check/uncheck/toggle: prefer checkboxes, radios, switches
   - hover: prefer any interactive element
3. Consider: label text, aria-label, placeholder, visible text, title attribute, container context
4. ICON BUTTONS: Elements marked "icon-button" have no visible text — only an icon (SVG/image).
   Match the user's VISUAL description of the icon to the element's semantic aria-label or title:
   - "eye button" / "show/hide password" = "toggle password visibility"
   - "X button" / "close" = "dismiss" / "close dialog"
   - "hamburger menu" / "three lines" = "open navigation" / "menu"
   - "arrow" / "back" = "go back" / "navigate back"
   - "trash" / "delete icon" = "remove" / "delete item"
   - "pencil" / "edit icon" = "edit" / "modify"
5. VISUAL PROPERTIES: Elements may include [color, shape, icon: class] hints in square brackets.
   - "серая кнопка" / "grey button" → match [grey] or [light-grey] color
   - "круглая иконка" / "round icon" → match [circle] or [rounded] shape
   - "иконка шестерёнки" / "gear icon" → match [icon: fa-gear] or [icon: settings]
   - If no visual hints are present, rely on text/semantic matching only
6. SPATIAL LAYOUT AWARENESS: Each element has position @(x,y,widthxheight).
   Use positions to understand the page layout and detect overlay layers:
   - MODAL/DIALOG: group of elements clustered in the CENTER of the viewport
   - DRAWER/SIDEBAR: group of elements clustered on the RIGHT or LEFT edge
   - DROPDOWN/MENU: small group of elements appearing BELOW a trigger
   - TOOLTIP/POPOVER: small cluster near a specific element
   - TOAST/SNACKBAR: small element at TOP or BOTTOM edge
   When an overlay is present, ALWAYS prefer elements INSIDE the overlay over background elements.
   Overlay elements cluster together spatially and appear ON TOP of the main content.
   Background elements are spread across the full page and are NOT the user's target.
6. PAGE STATE AWARENESS: Use the PAGE STATE line and element state hints to understand the live page:
   - [expanded] = container/dropdown/menu is currently OPEN — its children are visible targets
   - [collapsed] = container is CLOSED — its children are NOT the target
   - [selected] = tab/option is currently active — content within is visible
   - [active-layer] = element is inside the foreground modal/popup/overlay (if detected)
   When the user says "inside dropdown/menu/popup/dialog":
   - Find elements that are CHILDREN of an expanded/open container (check [container] prefixes)
   - Prefer [active-layer] elements over background elements
   - The trigger element (the one with [expanded]) is NOT the target — the content INSIDE is
7. PARTIAL / ABBREVIATED DESCRIPTIONS: Users often shorten element descriptions:
   - Match the MOST SPECIFIC candidate, not the broadest
   - If a keyword appears in both a parent section/tab AND a child element, prefer the CHILD —
     users describe what they want to interact with, using the parent as scope
   - [Section > Subsection] prefixes are LOCATION context: "X inside Y" = find X within Y container
8. DISAMBIGUATION when 2+ candidates share a keyword:
   - Prefer candidates with more context overlap with the intent
   - Prefer deeper-nested [A > B > C] elements over shallow [A] — more specific
   - Prefer action-oriented text ("Create", "Add", "Delete", "Edit") for click/hover actions
   - Prefer elements inside overlays or [active-layer] over background elements
   - Use spatial position to disambiguate: if the intent mentions an element visible in an overlay, pick the overlay element
9. DUPLICATE ELEMENTS: When multiple elements have the same label, they are marked [N of M].
   Each duplicate has "near:" context showing neighboring text (row/card content).
   - If the intent mentions context that matches ONE element's "near:" text → pick THAT one confidently
   - "second delete" / "2nd remove" / "второй удалить" → pick [2 of M]
   - "first/last" → pick [1 of M] / [M of M]
   - If intent has NO context to distinguish duplicates → MUST return alternatives, NEVER guess
10. HONEST CONFIDENCE — be accurate, not optimistic:
   - 0.9-1.0: exact or near-exact text/semantic match, no ambiguity
   - 0.7-0.9: strong semantic match but indirect (cross-language, abbreviation, partial match)
   - 0.5-0.7: plausible match but uncertain (multiple candidates could fit)
   - below 0.5: weak guess — return alternatives instead
   NEVER return confidence > 0.8 when guessing between duplicates without distinguishing context
11. If 2+ elements are equally valid, return alternatives (not a single pick)
12. ONLY use refs from the provided list — never invent refs
13. Respond ONLY with valid JSON, no markdown

OUTPUT FORMAT:
{"ref":"eXX","confidence":0.0-1.0,"reason":"brief explanation"}

If ambiguous (2+ equally valid):
{"ref":null,"confidence":0,"alternatives":["e1","e5"],"reason":"..."}

If nothing matches:
{"ref":null,"confidence":0,"reason":"no matching element"}`;

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
}): Promise<LlmSelectResult> {
  const { intentText, actionType, candidates, pageUrl, pageSignature } = params;
  const startTime = Date.now();

  // Check cache
  const cacheKey = `${pageSignature}|${actionType}|${computeTextHash(intentText)}|${candidates.slice(0, 5).map(c => c.node.ref).join(',')}`;
  const cached = llmSelectCache.get(cacheKey);
  if (cached && (Date.now() - cached.createdAt) < LLM_SELECT_CACHE_TTL_MS) {
    return { ...cached.result, cacheHit: true, latencyMs: Date.now() - startTime };
  }

  // Build candidate list for prompt
  const candidateList = candidates
    .map((c, i) => {
      return `${i + 1}. ref="${c.node.ref}" <${c.node.tag}> ${c.candidateText}`;
    })
    .join('\n');

  // Build page scene summary for top-down context
  const sceneSummary = buildSceneSummary(candidates);
  const sceneContext = sceneSummary ? `\nPAGE STATE: ${sceneSummary}` : '';

  const userPrompt = `INTENT: "${intentText}"
ACTION: ${actionType}
PAGE: ${pageUrl}
VIEWPORT: ${PREVIEW_VIEWPORT.width}x${PREVIEW_VIEWPORT.height}${sceneContext}

ELEMENTS (${candidates.length}):
${candidateList}

Select the single best matching element.`;

  // Call LLM with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_SELECT_TIMEOUT_MS);

  try {
    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: LLM_SELECT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      {
        model: AI_TASK_MODELS.disambiguation, // gemini-2.5-flash-lite
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        abortSignal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    // Parse response
    const content = response?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[LLM_SELECT] No JSON in response', { preview: content.slice(0, 200) });
      throw new Error('No JSON in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      ref?: string | null;
      confidence?: number;
      reason?: string;
      alternatives?: string[];
    };

    // Validate ref against candidate list
    const validRefs = new Set(candidates.map(c => c.node.ref));

    let result: LlmSelectResult;

    if (parsed.ref && validRefs.has(parsed.ref)) {
      // Single element selected
      result = {
        status: 'resolved',
        selectedRef: parsed.ref,
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.8)),
        reason: (parsed.reason || '').slice(0, 200),
        latencyMs: Date.now() - startTime,
        cacheHit: false,
      };
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
export async function resolveElement(params: {
  previewSessionId: string;
  stepDraft: IntentStep;
  domNodes: InteractiveNode[];
  pageUrl: string;
  /** When true, include candidates in result (for Show Alternatives) */
  includeAlternatives?: boolean;
  /** Phase 6: Screenshot for vision-enhanced rescue (base64 JPEG/PNG or lazy callback) */
  screenshot?: string | (() => Promise<string | null>);
}): Promise<LintResult> {
  const {
    previewSessionId,
    stepDraft,
    domNodes,
    pageUrl,
    includeAlternatives = false,
    screenshot: screenshotOrFn,
  } = params;
  const startTime = Date.now();

  logger.debug('[ELEMENT_RESOLVER] Starting resolution', {
    previewSessionId,
    stepType: stepDraft.type,
    description: stepDraft.description.slice(0, 50),
    nodeCount: domNodes.length,
  });

  // Non-targeting actions don't need element resolution
  if (['navigate', 'wait', 'wait_for', 'ai_check'].includes(stepDraft.type)) {
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
    let screenshot: string | undefined;
    if (typeof screenshotOrFn === 'function') {
      try { screenshot = (await screenshotOrFn()) ?? undefined; } catch { /* non-critical */ }
    } else {
      screenshot = screenshotOrFn;
    }

    const rescueResult = await rescueWithGeminiFlash({
      intentText,
      actionType: stepDraft.type,
      excludedNodes,
      pageUrl,
      screenshot,
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
      if (rescueResult.boundingBox) {
        const bb = rescueResult.boundingBox;
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

  // Step 6: Multiple allowed elements → LLM selection
  const candidatesToProcess: Array<{ node: InteractiveNode; candidateText: string }> = [];
  for (const node of allAllowed.slice(0, MAX_CANDIDATES_FOR_LLM)) {
    const candidateText = buildCandidateText(node);
    candidatesToProcess.push({ node, candidateText });
  }

  // Mark duplicate elements with [N of M] so LLM can disambiguate
  // e.g. two "Delete" buttons → "Delete [1 of 2]", "Delete [2 of 2]"
  const labelCounts = new Map<string, number>();
  for (const c of candidatesToProcess) {
    const label = (c.node.labelText || c.node.ariaLabel || c.node.text || '').trim().toLowerCase();
    if (label) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }
  // Only mark elements that appear more than once
  const labelIndex = new Map<string, number>();
  for (const c of candidatesToProcess) {
    const label = (c.node.labelText || c.node.ariaLabel || c.node.text || '').trim().toLowerCase();
    if (label && (labelCounts.get(label) || 0) > 1) {
      const idx = (labelIndex.get(label) || 0) + 1;
      labelIndex.set(label, idx);
      c.candidateText += ` [${idx} of ${labelCounts.get(label)}]`;
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

          // Capture screenshot for vision analysis
          let visionScreenshot: string | undefined;
          if (typeof screenshotOrFn === 'function') {
            try { visionScreenshot = (await screenshotOrFn()) ?? undefined; } catch { /* non-critical */ }
          } else {
            visionScreenshot = screenshotOrFn;
          }

          if (visionScreenshot) {
            // Pass visual candidates as the node list for vision to match against
            const visualNodes = candidatesToProcess
              .filter(c => VISUAL_TAGS.has(c.node.tag) || c.node.isIconButton)
              .map(c => c.node);

            const visionResult = await rescueWithGeminiFlash({
              intentText,
              actionType: stepDraft.type,
              excludedNodes: visualNodes.length > 0 ? visualNodes : allAllowed,
              pageUrl,
              screenshot: visionScreenshot,
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
      if (llmResult.status === 'not_found') {
        const totalLatencyMs = Date.now() - startTime;
        logger.info('[ELEMENT_RESOLVER] LLM selection returned not_found', {
          event: 'lint_decision',
          previewSessionId,
          stepType: stepDraft.type,
          status: 'not_found',
          reason: llmResult.reason,
          allowedCount,
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

        return {
          status: 'not_found',
          message: llmResult.reason || 'No matching element found by AI',
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
