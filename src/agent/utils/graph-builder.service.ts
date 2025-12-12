/**
 * GraphBuilder Service
 * Incrementally builds test execution graph for real-time visualization
 */

import { GraphEdge, GraphNode, NodeType, PlaywrightStepType } from '@/types/playwright.types';
import { logger } from '@/utils/logger';
import { getActionIcon } from '@/websocket/types';
import { DynamicAction } from '../types/intelligent-testing.types';

/**
 * Action result for graph building
 * ✅ ENHANCED: Now includes rich metadata for modal display
 */
export interface GraphActionResult {
  success: boolean;
  error?: string;
  durationMs?: number;
  urlChanged?: boolean;
  urlBefore?: string;
  urlAfter?: string;
  retryCount?: number;
  isTimeout?: boolean;

  // ✅ NEW: Screenshots
  // Note: During test execution these are base64 strings.
  // After test completion, they are uploaded to storage and replaced with public URLs.
  screenshot?: string; // Base64 during execution, public URL after upload
  screenshotBefore?: string; // Base64 during execution, public URL after upload
  screenshotAfter?: string; // Base64 during execution, public URL after upload

  // ✅ NEW: DOM snapshot
  domSnapshot?: string;

  // ✅ NEW: Console logs
  consoleLogs?: Array<{
    type: 'log' | 'warn' | 'error' | 'info';
    message: string;
    timestamp: string;
    source?: string;
  }>;

  // ✅ NEW: Network info
  networkRequests?: number;
  networkErrors?: Array<{
    url: string;
    status: number;
    error: string;
    timestamp: string;
  }>;

  // ✅ NEW: Validation result
  validation?: {
    expected: string;
    actual: string;
    passed: boolean;
    message?: string;
  };
}

/**
 * Graph update for incremental streaming
 */
export interface GraphUpdate {
  type: 'full' | 'incremental';
  newNode?: GraphNode;
  newEdge?: GraphEdge;
  updatedNode?: GraphNode;
  fullGraph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    metadata: {
      totalSteps: number;
      completedSteps: number;
      failedSteps: number;
    };
  };
}

/**
 * Builds test execution graph incrementally for real-time streaming
 */
export class GraphBuilder {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private nodeCounter = 0;
  private edgeCounter = 0;
  private lastNodeId: string | null = null;
  private startTime: number;
  private completedSteps = 0;
  private failedSteps = 0;

  constructor() {
    this.startTime = Date.now();
  }

  private getIconName(stepType?: PlaywrightStepType, phase?: string): string | undefined {
    return getActionIcon(stepType, phase);
  }

  /**
   * Add start node and return initial graph
   */
  addStartNode(): GraphUpdate {
    const id = this.generateNodeId();
    const node: GraphNode = {
      id,
      type: 'start',
      label: 'Test Started',
      meta: {
        color: '#4CAF50',
        icon: '▶️',
        iconName: this.getIconName(undefined, 'initialization'),
        timestamp: Date.now(),
      },
    };

    this.nodes.push(node);
    this.lastNodeId = id;

    logger.info('[GRAPH_BUILDER] Start node added', { nodeId: id });

    return {
      type: 'full',
      fullGraph: {
        nodes: [...this.nodes],
        edges: [...this.edges],
        metadata: {
          totalSteps: 0,
          completedSteps: 0,
          failedSteps: 0,
        },
      },
    };
  }

  /**
   * Add action node and return incremental update
   */
  addActionNode(
    action: DynamicAction,
    result?: GraphActionResult
  ): GraphUpdate {
    const id = this.generateNodeId();
    const actionType = action.action as PlaywrightStepType;

    // Determine success state
    const isSuccess = result?.success !== false;
    const isFailed = result?.success === false;
    const isRetry = result?.retryCount && result.retryCount > 0;
    // ✅ FIX: More accurate timeout detection
    const isTimeout = result?.isTimeout ||
                      (result?.error?.toLowerCase().includes('timeout') ?? false) ||
                      (result?.error?.toLowerCase().includes('timed out') ?? false);

    if (isSuccess) {
      this.completedSteps++;
    } else {
      this.failedSteps++;
    }

    // ✅ NEW: Detect if this is a repeated action (same selector as previous)
    const isRepeated = this.isRepeatedAction(action);

    // ✅ NEW: Determine appropriate color based on state
    let nodeColor = this.getActionColor(actionType);
    if (isFailed) {
      nodeColor = '#F44336'; // Red for failed
    } else if (isTimeout) {
      nodeColor = '#FF9800'; // Orange for timeout
    } else if (isRetry && isSuccess) {
      nodeColor = '#FFC107'; // Yellow for successful retry
    } else if (isRepeated) {
      nodeColor = '#FF9800'; // Orange for repeated action (warning)
    }

    // ✅ NEW: Build label with retry/repeat indicators
    let label = action.description || action.action;
    if (isRetry) {
      label = `🔄 ${label} (retry ${result.retryCount})`;
    } else if (isRepeated) {
      label = `⚠️ ${label} (repeated)`;
    }

    // Create node
    const node: GraphNode = {
      id,
      type: this.getNodeType(actionType),
      stepType: actionType,
      label,
      selector: action.selector,
      value: action.value,
      meta: {
        // Visual
        icon: this.getActionIcon(actionType),
        color: nodeColor,

        // Execution
        success: isSuccess,
        durationMs: result?.durationMs,
        errorMessage: result?.error,
        urlChanged: result?.urlChanged,
        urlBefore: result?.urlBefore,
        urlAfter: result?.urlAfter,
        timestamp: Date.now(),
        elapsedTime: Date.now() - this.startTime,
        retryCount: result?.retryCount,
        isTimeout,
        isRepeated,
        warning: isRepeated ? 'Action repeated - possible cycle' : undefined,

        // ✅ NEW: Rich metadata for modal display (without screenshots in real-time)
        // Screenshots are excluded from real-time updates to reduce payload size
        // They will be uploaded after test completion and replaced with public URLs
        domSnapshot: result?.domSnapshot,
        consoleLogs: result?.consoleLogs,
        networkRequests: result?.networkRequests,
        networkErrors: result?.networkErrors,
        validation: result?.validation,
      },
    };

    this.nodes.push(node);

    // Create edge from previous node
    let edge: GraphEdge | undefined;
    if (this.lastNodeId) {
      edge = {
        id: this.generateEdgeId(),
        source: this.lastNodeId,
        target: id,
        type: 'normal',
        meta: {
          animated: false,
        },
      };
      this.edges.push(edge);
    }

    this.lastNodeId = id;

    logger.info('[GRAPH_BUILDER] Action node added', {
      nodeId: id,
      action: action.action,
      success: isSuccess,
      totalNodes: this.nodes.length,
    });

    return {
      type: 'incremental',
      newNode: node,
      newEdge: edge,
    };
  }

  /**
   * Add page navigation node
   * ✅ ENHANCED: Now accepts pageContext with screenshots and analysis
   */
  addPageNode(
    url: string,
    pageType: string,
    pageContext?: {
      screenshot?: string;
      title?: string;
      metaDescription?: string;
      dom?: {
        formsCount?: number;
        buttonsCount?: number;
        linksCount?: number;
        inputsCount?: number;
      };
      loadTime?: number;
      networkRequests?: number;
    }
  ): GraphUpdate {
    const id = this.generateNodeId();

    const node: GraphNode = {
      id,
      type: 'action',
      stepType: 'goto',
      label: `Navigate to ${this.truncateUrl(url)}`,
      value: url,
      meta: {
        icon: '🌐',
        iconName: this.getIconName('goto', 'execution'),
        color: '#673AB7',
        pageType,
        timestamp: Date.now(),
        elapsedTime: Date.now() - this.startTime,

        // ✅ NEW: Page analysis data
        screenshot: pageContext?.screenshot,
        pageAnalysis: {
          title: pageContext?.title,
          metaDescription: pageContext?.metaDescription,
          formsCount: pageContext?.dom?.formsCount,
          buttonsCount: pageContext?.dom?.buttonsCount,
          linksCount: pageContext?.dom?.linksCount,
          inputsCount: pageContext?.dom?.inputsCount,
          loadTime: pageContext?.loadTime,
        },
        networkRequests: pageContext?.networkRequests,
      },
    };

    this.nodes.push(node);

    let edge: GraphEdge | undefined;
    if (this.lastNodeId) {
      edge = {
        id: this.generateEdgeId(),
        source: this.lastNodeId,
        target: id,
        type: 'normal',
      };
      this.edges.push(edge);
    }

    this.lastNodeId = id;

    logger.info('[GRAPH_BUILDER] Page node added', {
      nodeId: id,
      url: this.truncateUrl(url),
    });

    return {
      type: 'incremental',
      newNode: node,
      newEdge: edge,
    };
  }

  /**
   * Add end node and return final graph
   * ✅ ENHANCED: Now accepts test statistics
   */
  addEndNode(
    success: boolean,
    summary?: string,
    stats?: {
      pagesVisited?: number;
      actionsTaken?: number;
      successRate?: string;
      duration?: string;
      cost?: string;
      finalScreenshot?: string;
    }
  ): GraphUpdate {
    const id = this.generateNodeId();

    const node: GraphNode = {
      id,
      type: 'end',
      label: success ? 'Test Completed ✅' : 'Test Failed ❌',
      meta: {
        color: success ? '#4CAF50' : '#F44336',
        icon: success ? '✅' : '❌',
        iconName: this.getIconName(undefined, 'finalization'),
        success,
        summary,
        timestamp: Date.now(),

        // ✅ NEW: Test summary statistics
        testSummary: stats ? {
          pagesVisited: stats.pagesVisited,
          actionsTaken: stats.actionsTaken,
          successRate: stats.successRate,
          duration: stats.duration,
          cost: stats.cost,
        } : undefined,
        screenshot: stats?.finalScreenshot,
        totalDuration: Date.now() - this.startTime,
      },
    };

    this.nodes.push(node);

    let edge: GraphEdge | undefined;
    if (this.lastNodeId) {
      edge = {
        id: this.generateEdgeId(),
        source: this.lastNodeId,
        target: id,
        type: 'normal',
      };
      this.edges.push(edge);
    }

    logger.info('[GRAPH_BUILDER] End node added', {
      nodeId: id,
      success,
      totalNodes: this.nodes.length,
      totalEdges: this.edges.length,
    });

    return {
      type: 'full',
      newNode: node,
      newEdge: edge,
      fullGraph: {
        nodes: [...this.nodes],
        edges: [...this.edges],
        metadata: {
          totalSteps: this.nodes.length - 2, // Exclude start/end
          completedSteps: this.completedSteps,
          failedSteps: this.failedSteps,
        },
      },
    };
  }

  /**
   * Get current graph state
   */
  getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: [...this.nodes],
      edges: [...this.edges],
    };
  }

  /**
   * ✅ NEW: Get complete graph with metadata for storage in DB
   */
  getFullGraph(): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    metadata: {
      totalNodes: number;
      totalEdges: number;
      totalActions: number;
      completedSteps: number;
      failedSteps: number;
      startNodeId: string | null;
      endNodeId: string | null;
      generatedAt: string;
      version: string;
    };
  } {
    const startNode = this.nodes.find(n => n.type === 'start');
    const endNode = this.nodes.find(n => n.type === 'end');
    const actionNodes = this.nodes.filter(n => n.type === 'action');

    return {
      nodes: [...this.nodes],
      edges: [...this.edges],
      metadata: {
        totalNodes: this.nodes.length,
        totalEdges: this.edges.length,
        totalActions: actionNodes.length,
        completedSteps: this.completedSteps,
        failedSteps: this.failedSteps,
        startNodeId: startNode?.id || null,
        endNodeId: endNode?.id || null,
        generatedAt: new Date().toISOString(),
        version: '1.0',
      },
    };
  }

  /**
   * Get metadata
   */
  getMetadata() {
    return {
      totalSteps: this.nodes.length,
      completedSteps: this.completedSteps,
      failedSteps: this.failedSteps,
      totalDuration: Date.now() - this.startTime,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private generateNodeId(): string {
    return `node_${++this.nodeCounter}`;
  }

  private generateEdgeId(): string {
    return `edge_${++this.edgeCounter}`;
  }

  private getNodeType(actionType: PlaywrightStepType): NodeType {
    if (actionType === 'if') return 'condition';
    if (['loop', 'while', 'forEach'].includes(actionType)) return 'loop';
    if (this.isAssertionType(actionType)) return 'assertion';
    return 'action';
  }

  private isAssertionType(stepType: PlaywrightStepType): boolean {
    const assertionTypes = [
      'assert',
      'expect',
      'assertVisible',
      'assertHidden',
      'assertEnabled',
      'assertDisabled',
      'assertText',
      'assertValue',
      'assertUrl',
      'assertCount',
    ];
    return assertionTypes.includes(stepType);
  }

  private getActionIcon(stepType: PlaywrightStepType): string {
    const iconMap: Record<string, string> = {
      goto: '🌐',
      click: '👆',
      dblclick: '👆👆',
      fill: '✏️',
      type: '⌨️',
      hover: '👋',
      check: '☑️',
      uncheck: '⬜',
      select: '📋',
      press: '⌨️',
      wait: '⏱️',
      waitForSelector: '⏳',
      waitForTimeout: '⏱️',
      scroll: '📜',
      screenshot: '📸',
      assert: '✅',
      expect: '🔍',
      assertVisible: '👁️',
      assertText: '📝',
      assertValue: '🔢',
      assertUrl: '🔗',
    };
    return iconMap[stepType] || '⚡';
  }

  private getActionColor(stepType: PlaywrightStepType): string {
    if (stepType === 'if') return '#FFC107';
    if (['loop', 'while', 'forEach'].includes(stepType)) return '#2196F3';
    if (this.isAssertionType(stepType)) return '#4CAF50';
    if (stepType.startsWith('wait')) return '#9E9E9E';
    if (['goto', 'goBack', 'goForward', 'reload'].includes(stepType)) return '#673AB7';
    return '#03A9F4';
  }

  private truncateUrl(url: string, maxLength: number = 50): string {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
  }

  /**
   * Check if action is repeated (same selector as previous action)
   */
  private isRepeatedAction(action: DynamicAction): boolean {
    if (!action.selector || this.nodes.length < 2) {
      return false;
    }

    // Check last 3 nodes for same selector
    const recentNodes = this.nodes.slice(-3);
    const sameSelector = recentNodes.filter(
      node => node.selector === action.selector && node.stepType === action.action
    );

    return sameSelector.length >= 2; // If 2+ previous nodes have same selector → repeated
  }
}
