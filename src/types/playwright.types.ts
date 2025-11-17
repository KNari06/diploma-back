// Playwright test visualization types
//
// NOTE: This type is used for TEST VISUALIZATION (graph generation, UI display)
// It includes control flow types (if, loop, etc.) that are NOT executable actions
//
// For executable commands, see PlaywrightActionType in index.ts
// PlaywrightActionType is a subset of PlaywrightStepType (without control flow)

// All possible step types for visualization
export type PlaywrightStepType =
  // Navigation
  | 'goto'              // Navigate to URL
  | 'goBack'            // Navigate back in history
  | 'goForward'         // Navigate forward in history
  | 'reload'            // Reload current page
  // Interactions
  | 'click'             // Click element
  | 'dblclick'          // Double-click element
  | 'fill'              // Fill input field (fast)
  | 'type'              // Type text (with events)
  | 'hover'             // Hover over element
  | 'check'             // Check checkbox
  | 'uncheck'           // Uncheck checkbox
  | 'select'            // Select from dropdown (alias, maps to selectOption)
  | 'selectOption'      // Select option from dropdown/select element
  | 'press'             // Press keyboard key
  | 'focus'             // Focus element
  | 'blur'              // Blur element
  // Drag & Drop / Touch (Mobile)
  | 'dragAndDrop'       // Drag and drop element
  | 'swipe'             // Swipe gesture (mobile)
  | 'tap'               // Tap gesture (mobile)
  // Wait & Scroll
  | 'wait'              // Wait for timeout (ms)
  | 'waitForSelector'   // Wait for element to appear
  | 'waitForTimeout'    // Wait for specific timeout (alias for wait)
  | 'waitForLoadState'  // Wait for page load state
  | 'waitForNavigation' // Wait for page navigation
  | 'scroll'            // Scroll page/element
  | 'scrollIntoView'    // Scroll element into view
  // File operations
  | 'upload'            // Upload file
  | 'download'          // Download file (read-only)
  | 'screenshot'        // Take screenshot
  // Assertions
  | 'assert'            // Generic assertion (visualization only)
  | 'expect'            // Generic expectation (visualization only)
  | 'assertVisible'     // Assert element is visible
  | 'assertHidden'      // Assert element is hidden
  | 'assertEnabled'     // Assert element is enabled
  | 'assertDisabled'    // Assert element is disabled
  | 'assertText'        // Assert element contains text
  | 'assertValue'       // Assert input has value
  | 'assertUrl'         // Assert current URL matches
  | 'assertCount'       // Assert number of elements
  // Data extraction & evaluation
  | 'extract'           // Extract data from element
  | 'evaluate'          // Execute JS in browser context
  | 'script'            // Execute custom script (alias for evaluate)
  // Control flow (VISUALIZATION ONLY - not executable)
  | 'if'                // Conditional branch (if statement)
  | 'else'              // Else branch (not a standalone action)
  | 'loop'              // Loop block
  | 'while'             // While loop
  | 'forEach'           // ForEach loop
  // Custom/Unknown (for visualization of unsupported actions)
  | 'custom'            // Custom/unknown action

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
