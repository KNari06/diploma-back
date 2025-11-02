// Playwright test visualization types

// All possible step types
export type PlaywrightStepType =
  // Navigation
  | 'goto'
  | 'goBack'
  | 'goForward'
  | 'reload'
  // Interactions
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'type'
  | 'hover'
  | 'check'
  | 'uncheck'
  | 'selectOption'
  | 'press'
  | 'focus'
  | 'blur'
  // Drag & Drop / Touch
  | 'dragAndDrop'
  | 'swipe'
  | 'tap'
  // Wait & Scroll
  | 'waitForSelector'
  | 'waitForTimeout'
  | 'waitForLoadState'
  | 'waitForNavigation'
  | 'scroll'
  | 'scrollIntoView'
  // File operations
  | 'upload'
  | 'download'
  | 'screenshot'
  // Assertions
  | 'assert'
  | 'expect'
  | 'assertVisible'
  | 'assertHidden'
  | 'assertEnabled'
  | 'assertDisabled'
  | 'assertText'
  | 'assertValue'
  | 'assertCount'
  // Control flow
  | 'if'
  | 'else'
  | 'loop'
  | 'while'
  | 'forEach'
  // Custom
  | 'custom'
  | 'script'
  | 'evaluate';

// Base step interface
export interface PlaywrightStep {
  id: string;
  type: PlaywrightStepType;
  label: string;
  selector?: string;
  value?: string | number | boolean;
  timeout?: number;
  meta?: Record<string, any>;
  children?: PlaywrightStep[]; // For if/loop blocks
  else?: PlaywrightStep[]; // For else branch
}

// Conditional step (if/else)
export interface ConditionalStep extends PlaywrightStep {
  type: 'if';
  condition: string;
  children: PlaywrightStep[]; // if branch
  else?: PlaywrightStep[]; // else branch
}

// Loop step
export interface LoopStep extends PlaywrightStep {
  type: 'loop' | 'while' | 'forEach';
  iterations?: number;
  condition?: string;
  children: PlaywrightStep[];
}

// Graph node types
export type NodeType =
  | 'start'
  | 'end'
  | 'action'
  | 'assertion'
  | 'condition'
  | 'loop'
  | 'merge';

// Graph node
export interface GraphNode {
  id: string;
  type: NodeType;
  stepType?: PlaywrightStepType;
  label: string;
  selector?: string;
  value?: any;
  group?: string; // For nested blocks (if/loop)
  meta?: {
    position?: { x: number; y: number };
    icon?: string;
    color?: string;
    buttons?: NodeButton[];
    [key: string]: any;
  };
}

// Node action buttons
export interface NodeButton {
  id: string;
  label: string;
  icon?: string;
  action: 'run' | 'rerun' | 'info' | 'like' | 'edit' | 'delete';
}

// Edge types
export type EdgeType =
  | 'normal'    // Regular flow
  | 'branch'    // Conditional branch (if/else)
  | 'loop'      // Loop iteration
  | 'return'    // Return to main flow
  | 'merge';    // Merge branches back

// Graph edge
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string; // e.g., "true", "false", "iteration"
  meta?: {
    color?: string;
    style?: 'solid' | 'dashed' | 'dotted';
    animated?: boolean;
    [key: string]: any;
  };
}

// Parser output
export interface TestGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    totalSteps: number;
    conditionalBranches: number;
    loops: number;
    assertions: number;
  };
}

// Parser options
export interface ParserOptions {
  includeStartEnd?: boolean; // Add start/end nodes
  autoLayout?: boolean; // Auto-calculate positions
  groupNesting?: boolean; // Group nested blocks
  addButtons?: boolean; // Add action buttons to nodes
}
