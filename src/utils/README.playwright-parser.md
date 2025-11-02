# Playwright Test Graph Parser

Universal parser for converting Playwright test steps into interactive graph visualization.

## Quick Start

```typescript
import { parsePlaywrightTestSteps } from "./playwrightParser";
import { PlaywrightStep } from "../types/playwright.types";

const steps: PlaywrightStep[] = [
  { id: "1", type: "goto", label: "Navigate to Homepage" },
  { id: "2", type: "click", label: "Click Login", selector: "button.login" },
  { id: "3", type: "assert", label: "Verify logged in" },
];

const graph = parsePlaywrightTestSteps(steps);
// Returns: { nodes: [...], edges: [...], metadata: {...} }
```

## Supported Step Types

### Navigation

- `goto`, `goBack`, `goForward`, `reload`

### Interactions

- `click`, `dblclick`, `fill`, `type`, `hover`
- `check`, `uncheck`, `selectOption`, `press`
- `focus`, `blur`

### Drag & Touch

- `dragAndDrop`, `swipe`, `tap`

### Wait & Scroll

- `waitForSelector`, `waitForTimeout`, `waitForLoadState`, `waitForNavigation`
- `scroll`, `scrollIntoView`

### File Operations

- `upload`, `download`, `screenshot`

### Assertions

- `assert`, `expect`
- `assertVisible`, `assertHidden`, `assertEnabled`, `assertDisabled`
- `assertText`, `assertValue`, `assertCount`

### Control Flow

- `if` / `else` - Conditional branches
- `loop`, `while`, `forEach` - Iterations

### Custom

- `custom`, `script`, `evaluate`

## Examples

### 1. Linear Flow

```typescript
const steps = [
  { id: "1", type: "goto", label: "Open page" },
  { id: "2", type: "fill", label: "Enter text", selector: "input" },
  { id: "3", type: "click", label: "Submit", selector: "button" },
];

const graph = parsePlaywrightTestSteps(steps, {
  includeStartEnd: true,
  autoLayout: true,
});
```

### 2. Conditional (if/else)

```typescript
const steps = [
  { id: "1", type: "goto", label: "Open page" },
  {
    id: "2",
    type: "if",
    label: "Check if logged in",
    selector: ".user-profile",
    children: [{ id: "3", type: "click", label: "Go to dashboard" }],
    else: [
      { id: "4", type: "click", label: "Show login form" },
      { id: "5", type: "fill", label: "Enter credentials" },
    ],
  },
  { id: "6", type: "assert", label: "Verify final state" },
];
```

**Visual representation:**

```
1 → 2
2 → 3 (if true)
2 → 4 (if false)
4 → 5
3 → 6 (merge)
5 → 6 (merge)
```

### 3. Loop

```typescript
const steps = [
  { id: "1", type: "goto", label: "Open products" },
  {
    id: "2",
    type: "loop",
    label: "Check each product",
    value: 5,
    children: [
      { id: "3", type: "click", label: "Open product" },
      { id: "4", type: "assert", label: "Verify details" },
      { id: "5", type: "goBack", label: "Return to list" },
    ],
  },
  { id: "6", type: "screenshot", label: "Final screenshot" },
];
```

### 4. Nested (Loop + Conditional)

```typescript
const steps = [
  {
    id: "1",
    type: "forEach",
    label: "Process items",
    children: [
      {
        id: "2",
        type: "if",
        label: "Check availability",
        children: [{ id: "3", type: "click", label: "Add to cart" }],
        else: [{ id: "4", type: "click", label: "Add to wishlist" }],
      },
    ],
  },
];
```

## Parser Options

```typescript
interface ParserOptions {
  includeStartEnd?: boolean; // Add start/end nodes (default: true)
  autoLayout?: boolean; // Auto-calculate positions (default: false)
  groupNesting?: boolean; // Group nested blocks (default: true)
  addButtons?: boolean; // Add action buttons (default: true)
}
```

## Output Structure

```typescript
interface TestGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    totalSteps: number;
    conditionalBranches: number;
    loops: number;
    assertions: number;
  };
}
```

### Node Structure

```typescript
interface GraphNode {
  id: string;
  type:
    | "start"
    | "end"
    | "action"
    | "assertion"
    | "condition"
    | "loop"
    | "merge";
  stepType?: PlaywrightStepType;
  label: string;
  selector?: string;
  value?: any;
  group?: string; // For nested blocks
  meta?: {
    position?: { x: number; y: number };
    icon?: string;
    color?: string;
    buttons?: NodeButton[];
  };
}
```

### Edge Structure

```typescript
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: "normal" | "branch" | "loop" | "return" | "merge";
  label?: string;
  meta?: {
    color?: string;
    style?: "solid" | "dashed" | "dotted";
    animated?: boolean;
  };
}
```

## Export Formats

### JSON

```typescript
import { exportGraph } from "./playwrightParser";

const json = exportGraph(graph, "json");
```

### Mermaid

```typescript
const mermaid = exportGraph(graph, "mermaid");
console.log(mermaid);
// Output:
// graph TD
//   node_1([Start])
//   node_2[Navigate to Homepage]
//   node_1 --> node_2
//   ...
```

## Visual Styling

Each node type has automatic styling:

| Type      | Color  | Icon | Shape            |
| --------- | ------ | ---- | ---------------- |
| start     | Green  | -    | Rounded          |
| end       | Red    | -    | Rounded          |
| action    | Blue   | ⚡   | Rectangle        |
| assertion | Green  | ✅   | Rectangle        |
| condition | Yellow | ❓   | Diamond          |
| loop      | Blue   | 🔄   | Double Rectangle |
| merge     | Gray   | -    | Circle           |

## Integration

Use with visualization libraries:

- **React Flow**: Direct mapping to nodes/edges
- **D3.js**: Convert to D3 hierarchy
- **Cytoscape**: Map to Cytoscape elements
- **Mermaid**: Use built-in export

## Examples File

See `playwrightParser.examples.ts` for complete working examples.

Run examples:

```bash
npx ts-node src/utils/playwrightParser.examples.ts
```
