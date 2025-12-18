import {
  GraphEdge,
  GraphNode,
  NodeType,
  ParserOptions,
  PlaywrightStep,
  PlaywrightStepType,
  TestGraph
} from '@/types/playwright.types';
import { logger } from '../core/logger';

/**
 * Parses Playwright test steps into a graph structure for visualization
 * Handles all step types including conditionals, loops, and nested blocks
 */
export function parsePlaywrightTestSteps(
  testSteps: PlaywrightStep[],
  options: ParserOptions = {}
): TestGraph {
  // Validate input
  if (!testSteps || !Array.isArray(testSteps)) {
    logger.warn('[PLAYWRIGHT_PARSER] Invalid testSteps: expected array', { testSteps });
    return {
      nodes: [],
      edges: [],
      metadata: {
        totalSteps: 0,
        conditionalBranches: 0,
        loops: 0,
        assertions: 0,
      },
    };
  }

  // Filter out invalid steps
  const validSteps = testSteps.filter((step, idx) => {
    if (!step || typeof step !== 'object') {
      logger.warn('[PLAYWRIGHT_PARSER] Invalid step at index', { index: idx, step });
      return false;
    }
    if (!step.type || typeof step.type !== 'string') {
      logger.warn('[PLAYWRIGHT_PARSER] Step missing type at index', { index: idx, step });
      return false;
    }
    return true;
  });

  if (validSteps.length === 0) {
    logger.warn('[PLAYWRIGHT_PARSER] No valid steps to parse');
    return {
      nodes: [],
      edges: [],
      metadata: {
        totalSteps: 0,
        conditionalBranches: 0,
        loops: 0,
        assertions: 0,
      },
    };
  }

  const {
    includeStartEnd = true,
    autoLayout = false,
    addButtons = true,
  } = options;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const metadata = {
    totalSteps: 0,
    conditionalBranches: 0,
    loops: 0,
    assertions: 0,
  };

  let nodeIdCounter = 0;
  let edgeIdCounter = 0;

  // Generate unique IDs
  const generateNodeId = () => `node_${++nodeIdCounter}`;
  const generateEdgeId = () => `edge_${++edgeIdCounter}`;

  // Add start node if needed
  let currentNodeId: string | null = null;
  if (includeStartEnd) {
    const startNode: GraphNode = {
      id: generateNodeId(),
      type: 'start',
      label: 'Start',
      meta: {
        color: '#4CAF50',
        buttons: [],
      },
    };
    nodes.push(startNode);
    currentNodeId = startNode.id;
  }

  /**
   * Process a single step and convert to node
   */
  function processStep(
    step: PlaywrightStep,
    group?: string,
    parentId?: string
  ): { nodeId: string; lastNodeId: string } {
    // Validate step
    if (!step || typeof step !== 'object') {
      logger.warn('[PLAYWRIGHT_PARSER] Invalid step in processStep', { step });
      const fallbackId = generateNodeId();
      return { nodeId: fallbackId, lastNodeId: fallbackId };
    }

    const nodeId = (step.id && typeof step.id === 'string') ? step.id : generateNodeId();
    const nodeType = getNodeType(step.type);

    metadata.totalSteps++;
    if (isAssertionType(step.type)) metadata.assertions++;

    // Create node
    const node: GraphNode = {
      id: nodeId,
      type: nodeType,
      stepType: step.type,
      label: (step.label && typeof step.label === 'string') ? step.label : step.type || 'Unknown',
      selector: (step.selector && typeof step.selector === 'string') ? step.selector : undefined,
      value: step.value !== undefined ? step.value : undefined,
      group: (group && typeof group === 'string') ? group : undefined,
      meta: {
        ...(step.meta && typeof step.meta === 'object' ? step.meta : {}),
        icon: getStepIcon(step.type),
        color: getStepColor(step.type),
        buttons: addButtons ? getNodeButtons(step.type) : [],
      },
    };

    nodes.push(node);

    // Connect to previous node
    if (parentId) {
      edges.push({
        id: generateEdgeId(),
        source: parentId,
        target: nodeId,
        type: 'normal',
      });
    }

    // Handle conditional blocks (if/else)
    if (step.type === 'if' && step.children) {
      metadata.conditionalBranches++;
      return handleConditional(step, nodeId, group);
    }

    // Handle loops
    if (['loop', 'while', 'forEach'].includes(step.type) && step.children) {
      metadata.loops++;
      return handleLoop(step, nodeId, group);
    }

    return { nodeId, lastNodeId: nodeId };
  }

  /**
   * Handle if/else conditional blocks
   */
  function handleConditional(
    step: PlaywrightStep,
    conditionNodeId: string,
    parentGroup?: string
  ): { nodeId: string; lastNodeId: string } {
    const ifGroup = `${parentGroup ? parentGroup + '_' : ''}if_${conditionNodeId}`;
    const elseGroup = `${parentGroup ? parentGroup + '_' : ''}else_${conditionNodeId}`;

    let ifLastNodeId = conditionNodeId;
    let elseLastNodeId = conditionNodeId;

    // Process IF branch
    if (step.children && step.children.length > 0) {
      const ifBranchNodes = processStepList(
        step.children,
        conditionNodeId,
        ifGroup
      );
      if (ifBranchNodes.length > 0) {
        // Connect condition to first if node
        edges.push({
          id: generateEdgeId(),
          source: conditionNodeId,
          target: ifBranchNodes[0],
          type: 'branch',
          label: 'true',
          meta: { color: '#4CAF50', style: 'solid' },
        });
        ifLastNodeId = ifBranchNodes[ifBranchNodes.length - 1];
      }
    }

    // Process ELSE branch
    if (step.else && step.else.length > 0) {
      const elseBranchNodes = processStepList(
        step.else,
        conditionNodeId,
        elseGroup
      );
      if (elseBranchNodes.length > 0) {
        // Connect condition to first else node
        edges.push({
          id: generateEdgeId(),
          source: conditionNodeId,
          target: elseBranchNodes[0],
          type: 'branch',
          label: 'false',
          meta: { color: '#F44336', style: 'solid' },
        });
        elseLastNodeId = elseBranchNodes[elseBranchNodes.length - 1];
      }
    }

    // Create merge node to join branches
    const mergeNodeId = generateNodeId();
    const mergeNode: GraphNode = {
      id: mergeNodeId,
      type: 'merge',
      label: 'Continue',
      group: parentGroup,
      meta: {
        color: '#9E9E9E',
        icon: 'merge',
      },
    };
    nodes.push(mergeNode);

    // Connect both branches to merge node
    if (ifLastNodeId !== conditionNodeId) {
      edges.push({
        id: generateEdgeId(),
        source: ifLastNodeId,
        target: mergeNodeId,
        type: 'merge',
      });
    }
    if (elseLastNodeId !== conditionNodeId && step.else && step.else.length > 0) {
      edges.push({
        id: generateEdgeId(),
        source: elseLastNodeId,
        target: mergeNodeId,
        type: 'merge',
      });
    } else if (!step.else) {
      // No else branch, connect condition directly to merge
      edges.push({
        id: generateEdgeId(),
        source: conditionNodeId,
        target: mergeNodeId,
        type: 'branch',
        label: 'false',
        meta: { color: '#F44336', style: 'dashed' },
      });
    }

    return { nodeId: conditionNodeId, lastNodeId: mergeNodeId };
  }

  /**
   * Handle loop blocks
   */
  function handleLoop(
    step: PlaywrightStep,
    loopNodeId: string,
    parentGroup?: string
  ): { nodeId: string; lastNodeId: string } {
    const loopGroup = `${parentGroup ? parentGroup + '_' : ''}loop_${loopNodeId}`;

    if (!step.children || step.children.length === 0) {
      return { nodeId: loopNodeId, lastNodeId: loopNodeId };
    }

    // Process loop body
    const loopBodyNodes = processStepList(step.children, loopNodeId, loopGroup);

    if (loopBodyNodes.length > 0) {
      // Connect loop start to first body node
      edges.push({
        id: generateEdgeId(),
        source: loopNodeId,
        target: loopBodyNodes[0],
        type: 'loop',
        label: 'iterate',
        meta: { color: '#2196F3', style: 'solid', animated: true },
      });

      const lastBodyNode = loopBodyNodes[loopBodyNodes.length - 1];

      // Connect last body node back to loop start
      edges.push({
        id: generateEdgeId(),
        source: lastBodyNode,
        target: loopNodeId,
        type: 'return',
        label: 'repeat',
        meta: { color: '#2196F3', style: 'dashed', animated: true },
      });
    }

    // Create exit node
    const exitNodeId = generateNodeId();
    const exitNode: GraphNode = {
      id: exitNodeId,
      type: 'merge',
      label: 'Exit Loop',
      group: parentGroup,
      meta: {
        color: '#9E9E9E',
        icon: 'exit',
      },
    };
    nodes.push(exitNode);

    // Connect loop to exit
    edges.push({
      id: generateEdgeId(),
      source: loopNodeId,
      target: exitNodeId,
      type: 'branch',
      label: 'done',
      meta: { color: '#9E9E9E', style: 'solid' },
    });

    return { nodeId: loopNodeId, lastNodeId: exitNodeId };
  }

  /**
   * Process a list of steps sequentially
   * Returns array of node IDs created
   */
  function processStepList(
    steps: PlaywrightStep[],
    parentId: string,
    group?: string
  ): string[] {
    const nodeIds: string[] = [];
    let currentId = parentId;

    for (const step of steps) {
      const { nodeId, lastNodeId } = processStep(step, group, currentId);
      if (!nodeIds.includes(nodeId)) {
        nodeIds.push(nodeId);
      }
      currentId = lastNodeId;
    }

    return nodeIds;
  }

  // Process all steps
  const processedNodeIds = processStepList(validSteps, currentNodeId || '', undefined);

  // Add end node if needed
  if (includeStartEnd && processedNodeIds.length > 0) {
    const endNodeId = generateNodeId();
    const endNode: GraphNode = {
      id: endNodeId,
      type: 'end',
      label: 'End',
      meta: {
        color: '#F44336',
        buttons: [],
      },
    };
    nodes.push(endNode);

    // Connect last node to end
    const lastNodeId = processedNodeIds[processedNodeIds.length - 1];
    edges.push({
      id: generateEdgeId(),
      source: lastNodeId,
      target: endNodeId,
      type: 'normal',
    });
  }

  // Auto-layout if requested
  if (autoLayout) {
    calculateLayout(nodes, edges);
  }

  return {
    nodes,
    edges,
    metadata,
  };
}

/**
 * Determine node type based on step type
 */
function getNodeType(stepType: PlaywrightStepType): NodeType {
  if (stepType === 'if') return 'condition';
  if (['loop', 'while', 'forEach'].includes(stepType)) return 'loop';
  if (isAssertionType(stepType)) return 'assertion';
  return 'action';
}

/**
 * Check if step is an assertion
 */
function isAssertionType(stepType: PlaywrightStepType): boolean {
  return stepType.startsWith('assert') || stepType === 'expect';
}

/**
 * Get icon for step type
 */
function getStepIcon(stepType: PlaywrightStepType): string {
  const iconMap: Record<string, string> = {
    goto: '🌐',
    click: '👆',
    dblclick: '👆👆',
    fill: '✏️',
    type: '⌨️',
    hover: '👋',
    check: '☑️',
    uncheck: '⬜',
    assert: '✅',
    expect: '🔍',
    screenshot: '📸',
    upload: '📤',
    download: '📥',
    scroll: '📜',
    if: '❓',
    loop: '🔄',
    while: '🔁',
    forEach: '🔂',
    waitForSelector: '⏳',
    waitForTimeout: '⏱️',
  };
  return iconMap[stepType] || '⚡';
}

/**
 * Get color for step type
 */
function getStepColor(stepType: PlaywrightStepType): string {
  if (stepType === 'if') return '#FFC107';
  if (['loop', 'while', 'forEach'].includes(stepType)) return '#2196F3';
  if (isAssertionType(stepType)) return '#4CAF50';
  if (stepType.startsWith('wait')) return '#9E9E9E';
  if (['goto', 'goBack', 'goForward', 'reload'].includes(stepType)) return '#673AB7';
  return '#03A9F4';
}

/**
 * Get action buttons for node
 */
function getNodeButtons(stepType: PlaywrightStepType): any[] {
  const buttons = [
    { id: 'run', label: 'Run', icon: '▶️', action: 'run' },
    { id: 'info', label: 'Info', icon: 'ℹ️', action: 'info' },
  ];

  // Add re-run for certain types
  if (!['if', 'loop', 'while', 'forEach'].includes(stepType)) {
    buttons.push({ id: 'rerun', label: 'Re-run', icon: '🔄', action: 'rerun' });
  }

  return buttons;
}

/**
 * Calculate layout positions for nodes (simple hierarchical layout)
 */
function calculateLayout(nodes: GraphNode[], edges: GraphEdge[]): void {
  const HORIZONTAL_SPACING = 200;
  const VERTICAL_SPACING = 100;
  const visited = new Set<string>();

  // Build adjacency map
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) {
      adjacency.set(edge.source, []);
    }
    adjacency.get(edge.source)!.push(edge.target);
  }

  // Find start node
  const startNode = nodes.find(n => n.type === 'start') || nodes[0];
  if (!startNode) return;

  const queue: Array<{ nodeId: string; level: number; offset: number }> = [
    { nodeId: startNode.id, level: 0, offset: 0 },
  ];

  while (queue.length > 0) {
    const { nodeId, level, offset } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      if (!node.meta) node.meta = {};
      node.meta.position = {
        x: level * HORIZONTAL_SPACING,
        y: offset * VERTICAL_SPACING,
      };
    }

    // Add children to queue
    const children = adjacency.get(nodeId) || [];
    children.forEach((childId, idx) => {
      if (!visited.has(childId)) {
        queue.push({
          nodeId: childId,
          level: level + 1,
          offset: offset + idx,
        });
      }
    });
  }
}

/**
 * Export graph to various formats
 */
export function exportGraph(graph: TestGraph, format: 'json' | 'mermaid' = 'json'): string {
  if (format === 'mermaid') {
    return exportToMermaid(graph);
  }
  return JSON.stringify(graph, null, 2);
}

/**
 * Export to Mermaid diagram syntax
 */
function exportToMermaid(graph: TestGraph): string {
  // Validate input
  if (!graph || !graph.nodes || !Array.isArray(graph.nodes)) {
    logger.warn('[PLAYWRIGHT_PARSER] Invalid graph for Mermaid export');
    return 'graph TD\n';
  }

  let mermaid = 'graph TD\n';

  // Add nodes with safe label escaping
  for (const node of graph.nodes) {
    if (!node || !node.id) continue;

    const shape = getNodeShape(node.type || 'action');
    // Escape special Mermaid characters in labels
    const safeLabel = (node.label || node.id || 'Node')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/\n/g, ' ')
      .replace(/[{}[\]()]/g, '');

    mermaid += `  ${node.id}${shape[0]}"${safeLabel}"${shape[1]}\n`;
  }

  // Add edges with validation
  if (!graph.edges || !Array.isArray(graph.edges)) {
    logger.warn('[PLAYWRIGHT_PARSER] Invalid edges array for Mermaid export');
    return mermaid;
  }

  for (const edge of graph.edges) {
    if (!edge || !edge.source || !edge.target) continue;

    const arrow = edge.type === 'branch' ? '-.->|' : '-->';
    if (edge.label && typeof edge.label === 'string') {
      // Escape label for Mermaid
      const safeLabel = edge.label.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      mermaid += `  ${edge.source} ${arrow}|"${safeLabel}"| ${edge.target}\n`;
    } else {
      mermaid += `  ${edge.source} ${arrow} ${edge.target}\n`;
    }
  }

  return mermaid;
}

/**
 * Get Mermaid shape syntax for node type
 */
function getNodeShape(nodeType: NodeType): [string, string] {
  switch (nodeType) {
    case 'start':
    case 'end':
      return ['([', '])'];
    case 'condition':
      return ['{', '}'];
    case 'action':
    case 'assertion':
      return ['[', ']'];
    case 'loop':
      return ['[[', ']]'];
    case 'merge':
      return ['((', '))'];
    default:
      return ['[', ']'];
  }
}
