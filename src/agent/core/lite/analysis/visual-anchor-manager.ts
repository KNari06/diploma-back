/**
 * VisualAnchorManager (Manus Style)
 *
 * Spatial-based element lookup for sites with dynamic IDs/classes.
 * Uses geometric relationships and stable anchor elements instead of selectors.
 *
 * When to use:
 * - Fallback when data-agent-ref lookup fails
 * - Sites like Facebook, Google Ads where IDs change on every reload
 * - SPA frameworks with obfuscated class names
 *
 * How it works:
 * 1. Create signature: Find stable neighbors (headings, labels) around target
 * 2. Find by signature: Match element by its spatial relationship to anchors
 * 3. Confidence scoring: Accept match only if confidence >= 0.7
 */

import { logger } from '@/utils/core/logger';
import type {
  AnchorDirection,
  AnchorType,
  LiteElement,
  VisualAnchor,
  VisualSignature,
} from '../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum distance in pixels to consider an element as a neighbor anchor */
const MAX_ANCHOR_DISTANCE = 300;

/** Maximum number of anchors to store in a signature */
const MAX_ANCHORS = 5;

/** Minimum confidence score to accept a match */
export const MIN_CONFIDENCE_THRESHOLD = 0.7;

// ═══════════════════════════════════════════════════════════════════════════
// VISUAL ANCHOR MANAGER
// ═══════════════════════════════════════════════════════════════════════════

export class VisualAnchorManager {
  /**
   * Create a visual signature for an element based on its spatial neighbors.
   * Called AFTER successful action execution to remember the element.
   *
   * @param target Element to create signature for
   * @param allElements All elements on the page (for finding anchors)
   * @returns VisualSignature that can be used to re-find the element later
   */
  static createSignature(
    target: LiteElement,
    allElements: LiteElement[]
  ): VisualSignature {
    const anchors: VisualAnchor[] = [];

    // Find stable anchor elements within MAX_ANCHOR_DISTANCE
    for (const el of allElements) {
      // Skip self
      if (el.ref === target.ref) continue;

      // Skip if not a stable anchor
      if (!this.isStableAnchor(el)) continue;

      // Skip if no bounds (shouldn't happen, but safety check)
      if (!target.bounds || !el.bounds) continue;

      // Calculate distance
      const distance = this.getDistance(target, el);
      if (distance > MAX_ANCHOR_DISTANCE) continue;

      // Create anchor
      anchors.push({
        type: this.getAnchorType(el),
        value: el.name || '',
        direction: this.getDirection(target, el),
        distance: Math.round(distance),
      });
    }

    // Sort by distance (closest first) and take top MAX_ANCHORS
    anchors.sort((a, b) => a.distance - b.distance);
    const topAnchors = anchors.slice(0, MAX_ANCHORS);

    const signature: VisualSignature = {
      ownText: target.name || '',
      tag: target.tag,
      type: target.type,
      anchors: topAnchors,
      createdAt: Date.now(),
    };

    logger.debug('[VISUAL_ANCHOR] Created signature', {
      ref: target.ref,
      tag: signature.tag,
      anchorCount: topAnchors.length,
      ownText: signature.ownText.slice(0, 30),
    });

    return signature;
  }

  /**
   * Find an element on the current page using its visual signature.
   * Called when ref-based lookup fails.
   *
   * @param signature Previously created signature
   * @param currentElements Current page elements
   * @returns Best matching element and confidence score
   */
  static findBySignature(
    signature: VisualSignature,
    currentElements: LiteElement[]
  ): { element: LiteElement | null; confidence: number } {
    let bestMatch: LiteElement | null = null;
    let highestScore = 0;

    for (const candidate of currentElements) {
      // Must match tag
      if (candidate.tag !== signature.tag) continue;

      // Must match type if signature has type
      if (signature.type && candidate.type !== signature.type) continue;

      // Calculate confidence score
      const score = this.calculateConfidence(signature, candidate, currentElements);

      if (score > highestScore) {
        highestScore = score;
        bestMatch = candidate;
      }
    }

    if (bestMatch && highestScore >= MIN_CONFIDENCE_THRESHOLD) {
      logger.info('[VISUAL_ANCHOR] Found element by signature', {
        ref: bestMatch.ref,
        confidence: highestScore.toFixed(2),
        ownText: signature.ownText.slice(0, 30),
      });
    } else {
      logger.debug('[VISUAL_ANCHOR] No confident match found', {
        highestScore: highestScore.toFixed(2),
        threshold: MIN_CONFIDENCE_THRESHOLD,
        candidateCount: currentElements.length,
      });
    }

    return {
      element: highestScore >= MIN_CONFIDENCE_THRESHOLD ? bestMatch : null,
      confidence: highestScore,
    };
  }

  /**
   * Calculate confidence score for a candidate element matching a signature.
   *
   * Scoring breakdown:
   * - Own text match: 40%
   * - Tag match: 10% (already filtered, but partial credit for type)
   * - Anchor matches: 50% (distributed across anchors)
   */
  private static calculateConfidence(
    signature: VisualSignature,
    candidate: LiteElement,
    allElements: LiteElement[]
  ): number {
    let score = 0;

    // 1. Own text match (40% weight)
    if (signature.ownText && candidate.name) {
      if (candidate.name === signature.ownText) {
        score += 0.4;
      } else if (
        candidate.name.toLowerCase().includes(signature.ownText.toLowerCase()) ||
        signature.ownText.toLowerCase().includes(candidate.name.toLowerCase())
      ) {
        score += 0.2; // Partial match
      }
    } else if (!signature.ownText && !candidate.name) {
      // Both empty - small bonus for matching emptiness
      score += 0.1;
    }

    // 2. Type match bonus (10% weight) - already filtered by tag
    if (signature.type && candidate.type === signature.type) {
      score += 0.1;
    } else if (!signature.type) {
      score += 0.05; // Small bonus if no type to match
    }

    // 3. Anchor matches (50% weight, distributed across anchors)
    if (signature.anchors.length > 0) {
      const anchorWeight = 0.5 / signature.anchors.length;

      for (const anchor of signature.anchors) {
        const matchFound = this.findMatchingAnchor(anchor, candidate, allElements);
        if (matchFound) {
          score += anchorWeight;
        }
      }
    } else {
      // No anchors in signature - small penalty
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Find if an anchor from the signature exists near the candidate element
   * with the correct direction.
   */
  private static findMatchingAnchor(
    anchor: VisualAnchor,
    candidate: LiteElement,
    allElements: LiteElement[]
  ): boolean {
    for (const el of allElements) {
      // Skip candidate itself
      if (el.ref === candidate.ref) continue;

      // Must be same type
      if (this.getAnchorType(el) !== anchor.type) continue;

      // Must have matching value (text content)
      if (!el.name || el.name !== anchor.value) continue;

      // Must be in correct direction from candidate
      if (!candidate.bounds || !el.bounds) continue;
      const direction = this.getDirection(candidate, el);
      if (direction !== anchor.direction) continue;

      // Distance should be within 2x of original (allowing for layout shifts)
      const distance = this.getDistance(candidate, el);
      if (distance > anchor.distance * 2) continue;

      // Found matching anchor!
      return true;
    }

    return false;
  }

  /**
   * Check if element is a stable anchor (unlikely to change between reloads).
   * Stable elements: headings, labels, icons with aria-label, text with real content.
   */
  private static isStableAnchor(el: LiteElement): boolean {
    // Headings are very stable
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tag)) {
      return true;
    }

    // Labels are stable
    if (el.tag === 'label') {
      return true;
    }

    // Icons with aria-label are stable
    if ((el.tag === 'svg' || el.tag === 'img') && el.name && el.name.length > 0) {
      return true;
    }

    // Text elements with meaningful content (not dynamic IDs)
    if (el.name && el.name.length > 3 && !this.looksLikeDynamicId(el.name)) {
      return true;
    }

    return false;
  }

  /**
   * Check if text looks like a dynamic ID (e.g., "_a1b2c3", "btn-123xyz").
   * These are unstable and should not be used as anchors.
   */
  private static looksLikeDynamicId(text: string): boolean {
    // Pattern: starts with _ or -, followed by alphanumeric junk
    if (/^[_-][a-z0-9]+$/i.test(text)) return true;

    // Pattern: mostly numbers with few letters
    const digits = (text.match(/\d/g) || []).length;
    const letters = (text.match(/[a-zA-Z]/g) || []).length;
    if (digits > letters && digits >= 4) return true;

    // Pattern: hash-like string (6+ alphanumeric)
    if (/^[a-z0-9]{6,}$/i.test(text)) return true;

    return false;
  }

  /**
   * Get anchor type based on element properties.
   */
  private static getAnchorType(el: LiteElement): AnchorType {
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tag)) {
      return 'heading';
    }
    if (el.tag === 'label') {
      return 'label';
    }
    if (el.tag === 'svg' || el.tag === 'img' || el.role === 'img') {
      return 'icon';
    }
    return 'text';
  }

  /**
   * Calculate Euclidean distance between element centers.
   */
  private static getDistance(a: LiteElement, b: LiteElement): number {
    if (!a.bounds || !b.bounds) return Infinity;

    const aCenterX = a.bounds.x + a.bounds.width / 2;
    const aCenterY = a.bounds.y + a.bounds.height / 2;
    const bCenterX = b.bounds.x + b.bounds.width / 2;
    const bCenterY = b.bounds.y + b.bounds.height / 2;

    return Math.sqrt(
      Math.pow(aCenterX - bCenterX, 2) + Math.pow(aCenterY - bCenterY, 2)
    );
  }

  /**
   * Determine relative direction from target to anchor.
   * Returns which direction the anchor is from the target's perspective.
   */
  private static getDirection(target: LiteElement, anchor: LiteElement): AnchorDirection {
    if (!target.bounds || !anchor.bounds) return 'top'; // Default fallback

    const targetCenterX = target.bounds.x + target.bounds.width / 2;
    const targetCenterY = target.bounds.y + target.bounds.height / 2;
    const anchorCenterX = anchor.bounds.x + anchor.bounds.width / 2;
    const anchorCenterY = anchor.bounds.y + anchor.bounds.height / 2;

    const dx = anchorCenterX - targetCenterX;
    const dy = anchorCenterY - targetCenterY;

    // Determine primary direction based on which axis has larger delta
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? 'right' : 'left';
    } else {
      return dy > 0 ? 'bottom' : 'top';
    }
  }
}
