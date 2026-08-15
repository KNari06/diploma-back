/**
 * Preview DevTools Collector Service
 * Collects Console, Network, and provides on-demand HTML/Accessibility data
 *
 * Features:
 * - Console: Ring buffer of messages, push updates
 * - Network: Incremental request/response tracking, push metadata
 * - HTML: On-demand full HTML content
 * - Accessibility: On-demand accessibility tree
 */

import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import type { Namespace } from 'socket.io';
import type {
  PreviewConsoleEntry,
  PreviewConsoleUpdatePayload,
  PreviewNetworkItem,
  PreviewNetworkUpdatePayload,
  PreviewNetworkDetailPayload,
  PreviewHtmlUpdatePayload,
  PreviewAccessibilityNode,
  PreviewAccessibilityUpdatePayload,
} from '@/websocket/types/types';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEVTOOLS_CONFIG = {
  // Console
  consoleBufferSize: 1000,      // Max console entries to keep
  consoleBatchDelayMs: 100,     // Batch console messages
  consolePushMaxItems: 50,      // Max items per push

  // Network
  networkBufferSize: 500,       // Max network requests to keep
  networkBatchDelayMs: 150,     // Batch network updates
  networkPushMaxItems: 20,      // Max items per push
  networkBodyMaxBytes: 64 * 1024, // 64KB max body size for detail
  networkIgnorePatterns: [      // Ignore only analytics (keep static assets for CSS/Img/Font tabs)
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /facebook\.net/i,
    /doubleclick\.net/i,
  ],

  // HTML/Accessibility
  htmlMaxBytes: 30 * 1024,               // 30KB max — larger causes React render freeze in <pre> tag
  accessibilityMaxNodes: 1000,          // Max accessibility nodes
};

// ============================================================================
// CONSOLE COLLECTOR
// ============================================================================

/**
 * Collects browser console messages for DevTools Console tab
 */
export class PreviewConsoleCollector {
  private entries: PreviewConsoleEntry[] = [];
  private seq = 0;
  private page: Page | null = null;
  private nsp: Namespace | null = null;
  private room: string;
  private previewSessionId: string;
  private batchTimeout: NodeJS.Timeout | null = null;
  private pendingEntries: PreviewConsoleEntry[] = [];
  private isStarted = false;

  // Handler references for cleanup
  private consoleHandler: ((msg: any) => void) | null = null;
  private pageErrorHandler: ((error: Error) => void) | null = null;

  constructor(previewSessionId: string, room: string) {
    this.previewSessionId = previewSessionId;
    this.room = room;
  }

  /**
   * Start collecting console messages
   */
  start(page: Page, nsp: Namespace): void {
    if (this.isStarted) return;

    this.page = page;
    this.nsp = nsp;
    this.isStarted = true;

    // Create and store handler references for cleanup
    this.consoleHandler = (msg) => {
      if (!this.isStarted) return; // Guard against late events
      const entry: PreviewConsoleEntry = {
        level: this.mapConsoleLevel(msg.type()),
        text: msg.text(),
        location: msg.location()?.url
          ? `${msg.location()?.url}:${msg.location()?.lineNumber || 0}`
          : undefined,
        timestamp: new Date().toISOString(),
      };

      this.addEntry(entry);
    };

    this.pageErrorHandler = (error) => {
      if (!this.isStarted) return; // Guard against late events
      const entry: PreviewConsoleEntry = {
        level: 'error',
        text: error.message,
        timestamp: new Date().toISOString(),
      };

      this.addEntry(entry);
    };

    // Listen to console events
    page.on('console', this.consoleHandler);

    // Listen to page errors
    page.on('pageerror', this.pageErrorHandler);

    logger.debug('[PREVIEW_CONSOLE] Started collecting', { previewSessionId: this.previewSessionId });
  }

  /**
   * Map Playwright console type to our level
   */
  private mapConsoleLevel(type: string): PreviewConsoleEntry['level'] {
    switch (type) {
      case 'warning': return 'warn';
      case 'error': return 'error';
      case 'debug': return 'debug';
      case 'info': return 'info';
      default: return 'log';
    }
  }

  /**
   * Add entry and schedule batch push
   */
  private addEntry(entry: PreviewConsoleEntry): void {
    // Add to buffer (ring buffer)
    this.entries.push(entry);
    if (this.entries.length > DEVTOOLS_CONFIG.consoleBufferSize) {
      this.entries.shift();
    }

    // Add to pending batch
    this.pendingEntries.push(entry);

    // Schedule batch push
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => this.pushBatch(), DEVTOOLS_CONFIG.consoleBatchDelayMs);
    }
  }

  /**
   * Push batched entries to clients
   */
  private pushBatch(): void {
    this.batchTimeout = null;

    if (this.pendingEntries.length === 0 || !this.nsp) return;

    // Limit batch size
    const batch = this.pendingEntries.slice(0, DEVTOOLS_CONFIG.consolePushMaxItems);
    this.pendingEntries = this.pendingEntries.slice(DEVTOOLS_CONFIG.consolePushMaxItems);

    this.seq++;
    const payload: PreviewConsoleUpdatePayload = {
      previewSessionId: this.previewSessionId,
      seq: this.seq,
      entries: batch,
    };

    this.nsp.to(this.room).emit('preview:console:update', payload);

    // If more pending, schedule another batch
    if (this.pendingEntries.length > 0) {
      this.batchTimeout = setTimeout(() => this.pushBatch(), DEVTOOLS_CONFIG.consoleBatchDelayMs);
    }
  }

  /**
   * Get all entries (for initial load)
   */
  getEntries(): PreviewConsoleEntry[] {
    return [...this.entries];
  }

  /**
   * Stop collecting
   */
  stop(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    // Remove event listeners to prevent memory leaks
    if (this.page && this.consoleHandler) {
      try {
        this.page.off('console', this.consoleHandler);
      } catch {
        // Ignore - page may already be closed
      }
    }
    if (this.page && this.pageErrorHandler) {
      try {
        this.page.off('pageerror', this.pageErrorHandler);
      } catch {
        // Ignore - page may already be closed
      }
    }

    this.consoleHandler = null;
    this.pageErrorHandler = null;
    this.isStarted = false;
    this.page = null;
    this.nsp = null;
  }
}

// ============================================================================
// NETWORK COLLECTOR
// ============================================================================

/**
 * Network request info stored during collection
 */
interface NetworkRequestInfo {
  item: PreviewNetworkItem;
  requestBody?: string;
  responseBody?: string;
  requestObject?: any; // Store request object for correlation
}

/**
 * Collects network requests/responses for DevTools Network tab
 */
export class PreviewNetworkCollector {
  private requests = new Map<string, NetworkRequestInfo>();
  private requestToId = new WeakMap<any, string>(); // Map Request object to ID
  private orderedIds: string[] = [];
  private seq = 0;
  private page: Page | null = null;
  private nsp: Namespace | null = null;
  private room: string;
  private previewSessionId: string;
  private batchTimeout: NodeJS.Timeout | null = null;
  private pendingItems: PreviewNetworkItem[] = [];
  private isStarted = false;

  // Handler references for cleanup
  private requestHandler: ((request: any) => void) | null = null;
  private responseHandler: ((response: any) => Promise<void>) | null = null;
  private requestFailedHandler: ((request: any) => void) | null = null;

  constructor(previewSessionId: string, room: string) {
    this.previewSessionId = previewSessionId;
    this.room = room;
  }

  /**
   * Start collecting network requests
   */
  start(page: Page, nsp: Namespace): void {
    if (this.isStarted) return;

    this.page = page;
    this.nsp = nsp;
    this.isStarted = true;

    // Create and store handler references for cleanup
    this.requestHandler = (request) => {
      if (!this.isStarted) return;
      const url = request.url();

      // Filter out ignored patterns
      if (this.shouldIgnore(url)) return;

      const id = this.generateRequestId();
      const startTimeMs = Date.now();
      
      // Parse URL for domain/path
      let domain: string | undefined;
      let path: string | undefined;
      try {
        const urlObj = new URL(url);
        domain = urlObj.hostname;
        path = urlObj.pathname + urlObj.search;
      } catch {
        // Invalid URL, leave undefined
      }

      // Map resourceType to tab category
      const tab = this.mapResourceTypeToTab(request.resourceType());

      const item: PreviewNetworkItem = {
        id,
        phase: 'request',
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        startTs: new Date().toISOString(),
        requestHeaders: request.headers(),
        domain,
        path,
        tab,
        startTimeMs,
      };

      const info: NetworkRequestInfo = {
        item,
        requestBody: request.postData() || undefined,
        requestObject: request,
      };

      // Store request object -> ID mapping
      this.requestToId.set(request, id);

      this.addRequest(id, info);
    };

    this.responseHandler = async (response) => {
      if (!this.isStarted) return;
      const url = response.url();
      if (this.shouldIgnore(url)) return;

      // Find matching request by request object (more reliable than URL)
      const request = response.request();
      const id = this.requestToId.get(request);
      if (!id) return;

      const info = this.requests.get(id);
      if (!info) return;

      const endTimeMs = Date.now();
      info.item.phase = 'response';
      info.item.status = response.status();
      info.item.statusText = response.statusText();
      info.item.endTs = new Date(endTimeMs).toISOString();
      info.item.responseHeaders = response.headers();
      info.item.endTimeMs = endTimeMs;

      // Get content-type from response headers
      const contentType = response.headers()['content-type'] || response.headers()['Content-Type'];
      if (contentType) {
        info.item.contentType = contentType;
      }

      // Calculate duration
      if (info.item.startTimeMs) {
        info.item.durationMs = endTimeMs - info.item.startTimeMs;
      }

      // Try to get response size and body
      try {
        const body = await response.body().catch(() => null);
        if (body) {
          info.item.size = body.length;
          info.responseBody = body.toString('utf-8').slice(0, DEVTOOLS_CONFIG.networkBodyMaxBytes);
        }
      } catch {
        // Ignore body fetch errors
      }

      this.addPendingUpdate(info.item);
    };

    this.requestFailedHandler = (request) => {
      if (!this.isStarted) return;
      const url = request.url();
      if (this.shouldIgnore(url)) return;

      // Find matching request by request object
      const id = this.requestToId.get(request);
      if (!id) return;

      const info = this.requests.get(id);
      if (!info) return;

      const endTimeMs = Date.now();
      info.item.phase = 'error';
      info.item.error = request.failure()?.errorText || 'Request failed';
      info.item.endTs = new Date(endTimeMs).toISOString();
      info.item.endTimeMs = endTimeMs;

      // Calculate duration
      if (info.item.startTimeMs) {
        info.item.durationMs = endTimeMs - info.item.startTimeMs;
      }

      this.addPendingUpdate(info.item);
    };

    // Listen to events
    page.on('request', this.requestHandler);
    page.on('response', this.responseHandler);
    page.on('requestfailed', this.requestFailedHandler);

    logger.debug('[PREVIEW_NETWORK] Started collecting', { previewSessionId: this.previewSessionId });
  }

  /**
   * Check if URL should be ignored
   */
  private shouldIgnore(url: string): boolean {
    return DEVTOOLS_CONFIG.networkIgnorePatterns.some((pattern) => pattern.test(url));
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Map Playwright resourceType to Network tab category
   */
  private mapResourceTypeToTab(resourceType: string): PreviewNetworkItem['tab'] {
    const type = resourceType.toLowerCase();
    
    if (type === 'xhr' || type === 'fetch') return 'xhr';
    if (type === 'script') return 'js';
    if (type === 'stylesheet') return 'css';
    if (type === 'image') return 'img';
    if (type === 'media') return 'media';
    if (type === 'font') return 'font';
    if (type === 'document') return 'doc';
    if (type === 'websocket') return 'ws';
    if (type === 'manifest') return 'manifest';
    
    return 'other';
  }

  /**
   * Add new request
   */
  private addRequest(id: string, info: NetworkRequestInfo): void {
    // Ring buffer
    if (this.orderedIds.length >= DEVTOOLS_CONFIG.networkBufferSize) {
      const oldId = this.orderedIds.shift();
      if (oldId) this.requests.delete(oldId);
    }

    this.requests.set(id, info);
    this.orderedIds.push(id);
    this.addPendingUpdate(info.item);
  }

  /**
   * Add item to pending batch
   */
  private addPendingUpdate(item: PreviewNetworkItem): void {
    this.pendingItems.push(item);

    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => this.pushBatch(), DEVTOOLS_CONFIG.networkBatchDelayMs);
    }
  }

  /**
   * Push batched items to clients
   */
  private pushBatch(): void {
    this.batchTimeout = null;

    if (this.pendingItems.length === 0 || !this.nsp) return;

    const batch = this.pendingItems.slice(0, DEVTOOLS_CONFIG.networkPushMaxItems);
    this.pendingItems = this.pendingItems.slice(DEVTOOLS_CONFIG.networkPushMaxItems);

    this.seq++;
    const payload: PreviewNetworkUpdatePayload = {
      previewSessionId: this.previewSessionId,
      seq: this.seq,
      items: batch,
    };

    this.nsp.to(this.room).emit('preview:network:update', payload);

    if (this.pendingItems.length > 0) {
      this.batchTimeout = setTimeout(() => this.pushBatch(), DEVTOOLS_CONFIG.networkBatchDelayMs);
    }
  }

  /**
   * Get request detail (on-demand)
   */
  getRequestDetail(id: string): PreviewNetworkDetailPayload | null {
    const info = this.requests.get(id);
    if (!info) return null;

    // Determine if response is text-based
    const contentType = info.item.contentType || '';
    const isText = contentType.includes('text/') || 
                   contentType.includes('application/json') ||
                   contentType.includes('application/javascript') ||
                   contentType.includes('application/xml');

    return {
      previewSessionId: this.previewSessionId,
      id,
      requestHeaders: info.item.requestHeaders,
      responseHeaders: info.item.responseHeaders,
      requestBody: info.requestBody,
      responseBody: info.responseBody,
      truncated: (info.responseBody?.length || 0) >= DEVTOOLS_CONFIG.networkBodyMaxBytes,
      contentType: info.item.contentType,
      isText,
    };
  }

  /**
   * Get all items (for initial load)
   */
  getItems(): PreviewNetworkItem[] {
    return this.orderedIds.map((id) => this.requests.get(id)!.item).filter(Boolean);
  }

  /**
   * Stop collecting
   */
  stop(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    // Remove event listeners to prevent memory leaks
    if (this.page) {
      try {
        if (this.requestHandler) this.page.off('request', this.requestHandler);
        if (this.responseHandler) this.page.off('response', this.responseHandler);
        if (this.requestFailedHandler) this.page.off('requestfailed', this.requestFailedHandler);
      } catch {
        // Ignore - page may already be closed
      }
    }

    this.requestHandler = null;
    this.responseHandler = null;
    this.requestFailedHandler = null;
    this.isStarted = false;
    this.page = null;
    this.nsp = null;
  }
}

// ============================================================================
// HTML FETCHER (on-demand)
// ============================================================================

/**
 * Fetch HTML content on-demand
 */
export async function fetchHtml(
  page: Page,
  previewSessionId: string,
  domVersion: number
): Promise<PreviewHtmlUpdatePayload> {
  try {
    let html = await page.content();
    let truncated = false;

    if (html.length > DEVTOOLS_CONFIG.htmlMaxBytes) {
      html = html.slice(0, DEVTOOLS_CONFIG.htmlMaxBytes);
      truncated = true;
    }

    return {
      previewSessionId,
      domVersion,
      html,
      truncated,
    };
  } catch (error) {
    logger.warn('[PREVIEW_HTML] Failed to fetch HTML', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      previewSessionId,
      domVersion,
      html: '<!-- Error fetching HTML -->',
      truncated: false,
    };
  }
}

// ============================================================================
// ACCESSIBILITY FETCHER (on-demand)
// ============================================================================

/**
 * Fetch accessibility tree on-demand via CDP
 */
export async function fetchAccessibility(
  page: Page,
  previewSessionId: string,
  domVersion: number
): Promise<PreviewAccessibilityUpdatePayload> {
  try {
    // Use Playwright's built-in accessibility snapshot API instead of raw CDP.
    // Raw CDP (Accessibility.enable + getFullAXTree) creates a separate CDP session
    // that can conflict with the video screencast CDP session, causing video to freeze.
    const snapshot = await page.accessibility.snapshot({ interestingOnly: false });

    if (!snapshot) {
      return { previewSessionId, domVersion, tree: [], truncated: false };
    }

    // Transform Playwright's tree format to our PreviewAccessibilityNode format
    const tree: PreviewAccessibilityNode[] = [];
    const maxNodes = DEVTOOLS_CONFIG.accessibilityMaxNodes;

    const walk = (node: any): PreviewAccessibilityNode | null => {
      if (tree.length >= maxNodes) return null;
      const result: PreviewAccessibilityNode = {
        role: String(node.role || 'unknown'),
        name: node.name || undefined,
        value: node.value || undefined,
        description: node.description || undefined,
      };
      if (node.children && Array.isArray(node.children)) {
        const children: PreviewAccessibilityNode[] = [];
        for (const child of node.children) {
          if (tree.length + children.length >= maxNodes) break;
          const mapped = walk(child);
          if (mapped) children.push(mapped);
        }
        if (children.length > 0) result.children = children;
      }
      tree.push(result);
      return result;
    };

    walk(snapshot);

    return {
      previewSessionId,
      domVersion,
      tree,
      truncated: tree.length >= maxNodes,
    };
  } catch (error) {
    logger.warn('[PREVIEW_ACCESSIBILITY] Failed to fetch accessibility tree', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      previewSessionId,
      domVersion,
      tree: [],
      truncated: false,
    };
  }
}

/**
 * Transform CDP accessibility nodes to our format
 */
function transformAccessibilityTree(
  nodes: any[],
  maxNodes: number
): PreviewAccessibilityNode[] {
  if (!nodes || nodes.length === 0) return [];

  // Build parent-child map
  const childrenMap = new Map<string, any[]>();
  const rootNodes: any[] = [];

  for (const node of nodes.slice(0, maxNodes)) {
    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId) || [];
      siblings.push(node);
      childrenMap.set(node.parentId, siblings);
    } else {
      rootNodes.push(node);
    }
  }

  // Recursive transform
  function transform(node: any, depth: number): PreviewAccessibilityNode | null {
    if (depth > 10) return null; // Depth limit

    const result: PreviewAccessibilityNode = {
      role: node.role?.value || 'unknown',
      name: node.name?.value,
      value: node.value?.value,
      description: node.description?.value,
    };

    // Add children
    const children = childrenMap.get(node.nodeId);
    if (children && children.length > 0) {
      result.children = children
        .map((child) => transform(child, depth + 1))
        .filter((c): c is PreviewAccessibilityNode => c !== null);
    }

    return result;
  }

  return rootNodes
    .map((node) => transform(node, 0))
    .filter((n): n is PreviewAccessibilityNode => n !== null);
}

// ============================================================================
// COMBINED COLLECTOR SERVICE
// ============================================================================

/**
 * Combined DevTools collector for a preview session
 */
export class PreviewDevToolsCollector {
  private consoleCollector: PreviewConsoleCollector;
  private networkCollector: PreviewNetworkCollector;
  private previewSessionId: string;
  private room: string;
  private page: Page | null = null;

  constructor(previewSessionId: string, room: string) {
    this.previewSessionId = previewSessionId;
    this.room = room;
    this.consoleCollector = new PreviewConsoleCollector(previewSessionId, room);
    this.networkCollector = new PreviewNetworkCollector(previewSessionId, room);
  }

  /**
   * Start all collectors
   */
  start(page: Page, nsp: Namespace): void {
    this.page = page;
    this.consoleCollector.start(page, nsp);
    this.networkCollector.start(page, nsp);
    logger.debug('[PREVIEW_DEVTOOLS] Started collectors', { previewSessionId: this.previewSessionId });
  }

  /**
   * Stop all collectors
   */
  stop(): void {
    this.consoleCollector.stop();
    this.networkCollector.stop();
    this.page = null;
    logger.debug('[PREVIEW_DEVTOOLS] Stopped collectors', { previewSessionId: this.previewSessionId });
  }

  /**
   * Get console entries
   */
  getConsoleEntries(): PreviewConsoleEntry[] {
    return this.consoleCollector.getEntries();
  }

  /**
   * Epoch ms marking the boundary between the PREVIOUS editor step and this
   * one. Lives here because it is the only per-session object that survives
   * across `applyStep` calls (applyStep is static and stateless).
   *
   * `undefined` = no boundary recorded yet (the first console assertion of a
   * session), which callers must treat as "whole session", NOT as "nothing".
   */
  private stepBoundaryMs: number | undefined;

  /**
   * Record that a step just finished, so the NEXT console assertion knows
   * which slice of console history belongs to the step before it.
   */
  markStepBoundary(): void {
    this.stepBoundaryMs = Date.now();
  }

  /**
   * Console entries since the previous step boundary.
   *
   * WHY THE WINDOW STARTS AT THE PREVIOUS BOUNDARY, NOT AT THIS STEP'S START:
   * an `ai_check` / `assert_no_console_errors` step performs no page action of
   * its own — it is a pure observation that runs immediately after the step
   * that DID act. A window opening at this step's own start would therefore be
   * empty almost every time, and the assertion would report a clean console
   * for a page that had just thrown. The interesting errors are the ones the
   * PREVIOUS step produced.
   *
   * Timestamps are ISO strings on `PreviewConsoleEntry`, so they are parsed
   * rather than compared numerically. An unparseable timestamp is KEPT: an
   * error we cannot place in time must not vanish from an assertion.
   */
  getConsoleEntriesSinceStepBoundary(): PreviewConsoleEntry[] {
    const boundary = this.stepBoundaryMs;
    if (boundary === undefined) return this.consoleCollector.getEntries();
    return this.consoleCollector.getEntries().filter((e) => {
      const t = Date.parse(e.timestamp);
      return Number.isNaN(t) ? true : t >= boundary;
    });
  }

  /** True once a step boundary has been recorded for this session. */
  hasStepBoundary(): boolean {
    return this.stepBoundaryMs !== undefined;
  }

  /**
   * Get network items
   */
  getNetworkItems(): PreviewNetworkItem[] {
    return this.networkCollector.getItems();
  }

  /**
   * Get network request detail
   */
  getNetworkDetail(id: string): PreviewNetworkDetailPayload | null {
    return this.networkCollector.getRequestDetail(id);
  }

  /**
   * Fetch HTML (on-demand)
   */
  async fetchHtml(domVersion: number): Promise<PreviewHtmlUpdatePayload | null> {
    if (!this.page) return null;
    return fetchHtml(this.page, this.previewSessionId, domVersion);
  }

  /**
   * Fetch accessibility tree (on-demand)
   */
  async fetchAccessibility(domVersion: number): Promise<PreviewAccessibilityUpdatePayload | null> {
    if (!this.page) return null;
    return fetchAccessibility(this.page, this.previewSessionId, domVersion);
  }
}

// ============================================================================
// REGISTRY
// ============================================================================

/**
 * Registry to manage DevTools collectors
 */
export class PreviewDevToolsRegistry {
  private static instance: PreviewDevToolsRegistry;
  private collectors = new Map<string, PreviewDevToolsCollector>();

  private constructor() {}

  static getInstance(): PreviewDevToolsRegistry {
    if (!PreviewDevToolsRegistry.instance) {
      PreviewDevToolsRegistry.instance = new PreviewDevToolsRegistry();
    }
    return PreviewDevToolsRegistry.instance;
  }

  /**
   * Start DevTools collection for a session
   */
  start(previewSessionId: string, room: string, page: Page, nsp: Namespace): void {
    this.stop(previewSessionId); // Stop existing if any

    const collector = new PreviewDevToolsCollector(previewSessionId, room);
    collector.start(page, nsp);
    this.collectors.set(previewSessionId, collector);
  }

  /**
   * Stop DevTools collection for a session
   */
  stop(previewSessionId: string): void {
    const collector = this.collectors.get(previewSessionId);
    if (collector) {
      collector.stop();
      this.collectors.delete(previewSessionId);
    }
  }

  /**
   * Get collector for a session
   */
  get(previewSessionId: string): PreviewDevToolsCollector | undefined {
    return this.collectors.get(previewSessionId);
  }

  /**
   * Stop all collectors
   */
  stopAll(): void {
    for (const [id] of this.collectors) {
      this.stop(id);
    }
  }
}

// Export singleton getter
export const getPreviewDevToolsRegistry = () => PreviewDevToolsRegistry.getInstance();
