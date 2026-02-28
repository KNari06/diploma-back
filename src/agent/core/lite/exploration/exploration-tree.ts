/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION TREE — In-memory page graph for discovered flows
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stores pages as nodes and navigation actions as edges.
 * Entry points (testable flows) are attached to their source page node.
 *
 * Features:
 * - URL + content hash deduplication (SPA support)
 * - Entry point deduplication via Jaccard similarity on goal text
 * - Max depth enforcement
 * - Same-template detection (pagination/list pages)
 */

import type {
  ExplorationNode,
  ExplorationEdge,
  EntryPoint,
  NavigationAction,
} from './types';
import type { LiteSnapshot } from '../lite-types';

/** Max depth for BFS traversal */
const MAX_TREE_DEPTH = 3;

/** Jaccard similarity threshold for entry point deduplication */
const ENTRY_POINT_DEDUP_THRESHOLD = 0.7;

/** Max consecutive same-template pages before stopping that branch */
const MAX_SAME_TEMPLATE_PAGES = 3;

export class ExplorationTree {
  private nodes: Map<string, ExplorationNode> = new Map();
  private visitedUrls: Set<string> = new Set();
  private visitedContentHashes: Set<string> = new Set();
  private allEntryPoints: Map<string, EntryPoint> = new Map();
  private consecutiveTemplateCount: Map<string, number> = new Map();
  private nodeIdCounter: number = 0;

  // ═══════════════════════════════════════════════════════════════════════
  // NODE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add a new page node to the tree.
   * Returns the node ID, or null if the page was deduplicated (already visited).
   */
  addNode(params: {
    url: string;
    title: string;
    pageType: string;
    snapshot: LiteSnapshot;
    entryPoints: EntryPoint[];
    depth: number;
    requiresAuth: boolean;
    error?: string;
  }): string | null {
    const normalizedUrl = this.normalizeUrl(params.url);
    const contentHash = this.computeContentHash(params.snapshot);

    // URL dedup
    if (this.visitedUrls.has(normalizedUrl)) {
      return null;
    }

    // Content hash dedup (SPA: same content, different URL)
    if (this.visitedContentHashes.has(contentHash)) {
      return null;
    }

    // Depth check
    if (params.depth > MAX_TREE_DEPTH) {
      return null;
    }

    const nodeId = `page-${this.nodeIdCounter++}`;

    // Deduplicate entry points against existing ones
    const dedupedEntryPoints = this.deduplicateEntryPoints(params.entryPoints);

    const node: ExplorationNode = {
      id: nodeId,
      url: params.url,
      title: params.title,
      pageType: params.pageType,
      entryPoints: dedupedEntryPoints,
      children: [],
      depth: params.depth,
      requiresAuth: params.requiresAuth,
      contentHash,
      surveyedAt: Date.now(),
      error: params.error,
    };

    this.nodes.set(nodeId, node);
    this.visitedUrls.add(normalizedUrl);
    this.visitedContentHashes.add(contentHash);

    // Register entry points globally
    for (const ep of dedupedEntryPoints) {
      this.allEntryPoints.set(ep.id, ep);
    }

    return nodeId;
  }

  /**
   * Add a navigation edge between two nodes.
   */
  addEdge(parentNodeId: string, childNodeId: string, action: NavigationAction): void {
    const parent = this.nodes.get(parentNodeId);
    if (!parent) return;

    const edge: ExplorationEdge = {
      action,
      targetNodeId: childNodeId,
    };
    parent.children.push(edge);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════════════

  getNode(nodeId: string): ExplorationNode | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodes(): ExplorationNode[] {
    return Array.from(this.nodes.values());
  }

  getAllEntryPoints(): EntryPoint[] {
    return Array.from(this.allEntryPoints.values());
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  isVisited(url: string): boolean {
    return this.visitedUrls.has(this.normalizeUrl(url));
  }

  isContentVisited(snapshot: LiteSnapshot): boolean {
    const hash = this.computeContentHash(snapshot);
    return this.visitedContentHashes.has(hash);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SAME-TEMPLATE DETECTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Check if a page is a template repeat (e.g., product list pages)
   * and register it. Returns true if we've seen 3+ pages with the
   * same structure in this branch.
   *
   * NOTE: This method has side effects (increments counter).
   * Only call once per page during survey, not speculatively.
   */
  registerAndCheckSameTemplate(parentNodeId: string, snapshot: LiteSnapshot): boolean {
    const templateKey = this.computeTemplateKey(snapshot);
    const branchKey = `${parentNodeId}:${templateKey}`;
    const count = (this.consecutiveTemplateCount.get(branchKey) || 0) + 1;
    this.consecutiveTemplateCount.set(branchKey, count);
    return count > MAX_SAME_TEMPLATE_PAGES;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  toJSON(): ExplorationNode[] {
    return this.getAllNodes();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL: deduplication helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Normalize URL: remove query params, fragments, trailing slashes.
   * Groups same-origin paths together.
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Keep origin + pathname, remove query + hash
      let pathname = parsed.pathname;
      // Remove trailing slash (except root)
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      return `${parsed.origin}${pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Compute content hash from snapshot.
   * Uses element structure (tags + roles) rather than content to detect
   * SPA pages that have different URLs but same layout.
   */
  private computeContentHash(snapshot: LiteSnapshot): string {
    if (!snapshot.elements || snapshot.elements.length === 0) {
      return `empty:${snapshot.url}`;
    }

    // Build a structural fingerprint from interactive elements
    // Uses Sets for efficient lookup and comprehensive coverage of all interactive element types
    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
      'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
      'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'tab', 'option', 'treeitem',
    ]);
    const INTERACTIVE_TAGS = new Set([
      'form', 'a', 'input', 'select', 'textarea', 'button',
      'details', 'dialog', 'meter', 'output',
    ]);
    const interactive = snapshot.elements
      .filter((el) => el.visible && (
        INTERACTIVE_ROLES.has(el.role || '') ||
        INTERACTIVE_TAGS.has(el.tag)
      ))
      .map((el) => `${el.tag}:${el.role}:${el.name?.slice(0, 20) || ''}`)
      .sort();

    return this.simpleHash(interactive.join('|'));
  }

  /**
   * Compute template key for same-template detection.
   * Uses tag distribution rather than specific content.
   */
  private computeTemplateKey(snapshot: LiteSnapshot): string {
    const tagCounts: Record<string, number> = {};
    for (const el of snapshot.elements) {
      if (!el.visible) continue;
      tagCounts[el.tag] = (tagCounts[el.tag] || 0) + 1;
    }
    return Object.entries(tagCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => `${tag}:${count}`)
      .join(',');
  }

  /**
   * Deduplicate entry points against already known ones.
   * Uses Jaccard similarity on tokenized goal text.
   */
  private deduplicateEntryPoints(newPoints: EntryPoint[]): EntryPoint[] {
    const result: EntryPoint[] = [];

    for (const point of newPoints) {
      const isDuplicate = Array.from(this.allEntryPoints.values()).some(
        (existing) => this.jaccardSimilarity(existing.goal, point.goal) >= ENTRY_POINT_DEDUP_THRESHOLD,
      );

      if (!isDuplicate) {
        result.push(point);
      }
    }

    return result;
  }

  /**
   * Jaccard similarity on tokenized words.
   */
  private jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.toLowerCase().split(/\s+/));
    const tokensB = new Set(b.toLowerCase().split(/\s+/));

    let intersection = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) intersection++;
    }

    const union = tokensA.size + tokensB.size - intersection;
    if (union === 0) return 1;
    return intersection / union;
  }

  /**
   * Simple string hash (djb2).
   */
  private simpleHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }
}
