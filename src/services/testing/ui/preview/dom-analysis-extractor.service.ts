/**
 * DOM Analysis Extractor Service
 * Extracts and normalizes interactive nodes from page snapshots
 * for storage in intelligent_page_visits.dom_analysis
 */

import type { LiteElement, LiteSnapshot } from '@/agent/core/lite/lite-types';
import { logger } from '@/utils/core/logger';
import type { DomAnalysisData, InteractiveNode } from './preview.types';

// Constants
// P2 FIX: Increased from 200 to 500 for complex enterprise dashboards
// Modern admin panels, data grids, and dashboards routinely have 300+ interactive elements
const MAX_INTERACTIVE_NODES = 500; // Limit to prevent huge payloads
const MAX_TEXT_LENGTH = 100; // Truncate text content
const MAX_PARENT_CHAIN_LENGTH = 6; // Limit parent chain depth
const DOM_ANALYSIS_VERSION = '2.0'; // V2: ARIA state, validation, labels, hierarchy

// Dynamic ID patterns (UUIDs, random strings, timestamps)
const DYNAMIC_ID_PATTERNS = [
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, // UUID
  /^[a-f0-9]{24,}$/i, // MongoDB ObjectId or similar
  /^[0-9a-z]{20,}$/i, // Random alphanumeric strings
  /^\d{10,}$/, // Timestamps
  /^react-select-\d+-/i, // React Select
  /^ember\d+$/i, // Ember IDs
  /^_\w{8,}$/i, // Underscore + random
  /:r[a-z0-9]+:$/i, // React 18 IDs
];

/**
 * Check if an ID looks like a dynamic/random value
 */
function isDynamicId(id: string | undefined): boolean {
  if (!id) return false;
  return DYNAMIC_ID_PATTERNS.some(pattern => pattern.test(id));
}

/**
 * Truncate text to max length
 */
function truncateText(text: string | undefined, maxLength: number = MAX_TEXT_LENGTH): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.substring(0, maxLength - 3) + '...';
}

/**
 * Convert LiteElement to InteractiveNode
 * Strips sensitive data and normalizes fields
 * V2: Includes ARIA state, validation, labels, hierarchy
 */
function elementToInteractiveNode(element: LiteElement): InteractiveNode {
  const node: InteractiveNode = {
    tag: element.tag,
  };

  // Add ref if available
  if (element.ref) {
    node.ref = element.ref;
  }

  // Add role
  if (element.role && element.role !== element.tag) {
    node.role = element.role;
  }

  // Add type for inputs
  if (element.type) {
    node.type = element.type;
    node.inputType = element.type;
  }

  // Add text content (truncated, no values for security)
  if (element.name) {
    node.text = truncateText(element.name);
  }

  // Add placeholder
  if (element.placeholder) {
    node.placeholder = truncateText(element.placeholder);
  }

  // Add autocomplete hint
  if (element.autocomplete) {
    node.autocomplete = element.autocomplete;
  }

  // Add HTML name attribute
  if (element.htmlName) {
    node.name = element.htmlName;
  }

  // Add HTML id (with dynamic check)
  if (element.htmlId) {
    node.id = element.htmlId;
    node.isDynamicId = isDynamicId(element.htmlId);
  }

  // Add visibility flags
  node.isVisible = element.visible !== false;
  node.isInteractive = true; // By definition (we only extract interactive elements)
  node.isDisabled = element.disabled === true;

  // Add bounding box if available
  if (element.bounds) {
    node.boundingBox = {
      x: Math.round(element.bounds.x),
      y: Math.round(element.bounds.y),
      width: Math.round(element.bounds.width),
      height: Math.round(element.bounds.height),
    };
  }

  // Add isTopMostAtCenter if available
  if (element.isTopMostAtCenter !== undefined) {
    node.isTopMostAtCenter = element.isTopMostAtCenter;
  }

  // Add isInsideActiveModal if available
  if (element.isInsideActiveModal) {
    node.isInsideActiveModal = true;
  }

  // Add context as container hints (legacy compatibility)
  if (element.context) {
    // Parse context string like "inside: Form 'Login'"
    const match = element.context.match(/inside:\s*(\w+)(?:\s*["'](.+)["'])?/);
    if (match) {
      node.containerHints = {
        formGroupTitle: match[2] || undefined,
        parentClassTokens: [match[1].toLowerCase()],
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: ARIA state
  // ═══════════════════════════════════════════════════════════════════════════
  if (element.checked !== undefined) {
    node.checked = element.checked;
  }
  if (element.ariaExpanded !== undefined) {
    node.ariaExpanded = element.ariaExpanded;
  }
  if (element.ariaPressed !== undefined) {
    node.ariaPressed = element.ariaPressed;
  }
  if (element.ariaSelected !== undefined) {
    node.ariaSelected = element.ariaSelected;
  }
  if (element.ariaChecked !== undefined) {
    node.ariaChecked = element.ariaChecked;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Validation state
  // ═══════════════════════════════════════════════════════════════════════════
  if (element.required) {
    node.required = element.required;
  }
  if (element.readOnly) {
    node.readOnly = element.readOnly;
  }
  if (element.invalid) {
    node.invalid = element.invalid;
  }
  if (element.hasValue) {
    node.hasValue = element.hasValue;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Labels (separate from text)
  // ═══════════════════════════════════════════════════════════════════════════
  if (element.ariaLabel) {
    node.ariaLabel = truncateText(element.ariaLabel);
  }
  if (element.labelText) {
    node.labelText = truncateText(element.labelText);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Hierarchy (parent chain for disambiguation)
  // ═══════════════════════════════════════════════════════════════════════════
  if (element.parentRefChain && element.parentRefChain.length > 0) {
    // Limit to MAX_PARENT_CHAIN_LENGTH
    node.parentRefChain = element.parentRefChain.slice(0, MAX_PARENT_CHAIN_LENGTH);
  }
  if (element.containerRef) {
    node.containerRef = element.containerRef;
  }
  if (element.containerTitles && element.containerTitles.length > 0) {
    node.containerTitles = element.containerTitles.map(t => truncateText(t, 50)).filter(Boolean) as string[];
  }

  return node;
}

/**
 * Extract interactive nodes from a LiteSnapshot
 * Returns normalized nodes suitable for storage
 */
export function extractInteractiveNodes(snapshot: LiteSnapshot): InteractiveNode[] {
  if (!snapshot.elements || snapshot.elements.length === 0) {
    return [];
  }

  const nodes: InteractiveNode[] = [];

  for (const element of snapshot.elements) {
    // Skip if disabled and not visible
    if (element.disabled && !element.visible) {
      continue;
    }

    // Convert to interactive node
    const node = elementToInteractiveNode(element);
    nodes.push(node);

    // Limit total nodes
    if (nodes.length >= MAX_INTERACTIVE_NODES) {
      logger.debug('[DOM_ANALYSIS_EXTRACTOR] Reached max interactive nodes limit', {
        limit: MAX_INTERACTIVE_NODES,
        totalElements: snapshot.elements.length,
      });
      break;
    }
  }

  return nodes;
}

/**
 * Create DomAnalysisData from a LiteSnapshot
 */
export function createDomAnalysis(snapshot: LiteSnapshot): DomAnalysisData {
  const interactiveNodes = extractInteractiveNodes(snapshot);

  return {
    interactiveNodes,
    url: snapshot.url,
    title: snapshot.title,
    capturedAt: snapshot.timestamp,
    version: DOM_ANALYSIS_VERSION,
  };
}

/**
 * DomAnalysisExtractor Service class
 * For use in IntelligentTestStorageService
 */
export class DomAnalysisExtractorService {
  /**
   * Extract DOM analysis from a snapshot
   * @param snapshot - LiteSnapshot from page collection
   * @returns DomAnalysisData for storage
   */
  static extract(snapshot: LiteSnapshot): DomAnalysisData {
    return createDomAnalysis(snapshot);
  }

  /**
   * Extract interactive nodes only
   * @param snapshot - LiteSnapshot from page collection
   * @returns Array of InteractiveNode
   */
  static extractNodes(snapshot: LiteSnapshot): InteractiveNode[] {
    return extractInteractiveNodes(snapshot);
  }

  /**
   * Get version of the DOM analysis format
   */
  static getVersion(): string {
    return DOM_ANALYSIS_VERSION;
  }
}

export default DomAnalysisExtractorService;
