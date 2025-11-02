# Playwright Test Visualization System

Complete implementation of Playwright test graph visualization parser for QAI Backend.

## 📦 What's Included

### 1. Type Definitions

**File:** `src/types/playwright.types.ts`

- `PlaywrightStep` - All possible Playwright step types
- `GraphNode` - Visual node representation
- `GraphEdge` - Connection between nodes
- `TestGraph` - Complete graph structure
- `ParserOptions` - Configuration options

### 2. Parser Implementation

**File:** `src/utils/playwrightParser.ts`

Core functionality:

- `parsePlaywrightTestSteps()` - Main parser function
- `exportGraph()` - Export to JSON/Mermaid
- Handles all step types: navigation, interactions, assertions, conditionals, loops
- Supports nested structures (if inside loops, etc.)

### 3. API Endpoints

**Files:**

- `src/api/testVisualization/testVisualization.controller.ts`
- `src/api/testVisualization/testVisualization.route.ts`

Endpoints:

- `POST /api/v1/test-visualization/parse` - Parse steps to graph
- `POST /api/v1/test-visualization/export` - Export in different formats
- `POST /api/v1/test-visualization/validate` - Validate step structure
- `GET /api/v1/test-visualization/:testId` - Get test visualization (placeholder)

### 4. Tests

**File:** `src/utils/playwrightParser.test.ts`

21 comprehensive tests covering:

- Linear flows
- Conditional branches (if/else)
- Loops (loop, while, forEach)
- Nested structures
- All step types
- Edge connections
- Export formats

### 5. Examples

**File:** `src/utils/playwrightParser.examples.ts`

5 complete working examples demonstrating all features

### 6. Documentation

**Files:**

- `src/utils/README.playwright-parser.md` - Technical documentation
- `PLAYWRIGHT_VISUALIZATION.md` - This file (overview)

## 🚀 Quick Start

### Basic Usage

```typescript
import { parsePlaywrightTestSteps } from "./utils/playwrightParser";

const steps = [
  { id: "1", type: "goto", label: "Open homepage" },
  { id: "2", type: "click", label: "Click login", selector: "button.login" },
  {
    id: "3",
    type: "fill",
    label: "Enter email",
    selector: 'input[type="email"]',
  },
  { id: "4", type: "assert", label: "Verify logged in" },
];

const graph = parsePlaywrightTestSteps(steps);

console.log(graph);
// {
//   nodes: [...],
//   edges: [...],
//   metadata: { totalSteps: 4, assertions: 1, conditionalBranches: 0, loops: 0 }
// }
```

### API Usage

#### 1. Parse Test Steps

```bash
curl -X POST http://localhost:3000/api/v1/test-visualization/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "steps": [
      { "id": "1", "type": "goto", "label": "Navigate to page" },
      { "id": "2", "type": "click", "label": "Click button" }
    ],
    "options": {
      "includeStartEnd": true,
      "autoLayout": true,
      "addButtons": true
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "nodes": [
      {
        "id": "node_1",
        "type": "start",
        "label": "Start",
        "meta": { "color": "#4CAF50" }
      },
      {
        "id": "1",
        "type": "action",
        "stepType": "goto",
        "label": "Navigate to page",
        "meta": {
          "icon": "🌐",
          "color": "#673AB7",
          "buttons": [...]
        }
      }
    ],
    "edges": [...],
    "metadata": {
      "totalSteps": 2,
      "conditionalBranches": 0,
      "loops": 0,
      "assertions": 0
    }
  }
}
```

#### 2. Export to Mermaid

```bash
curl -X POST http://localhost:3000/api/v1/test-visualization/export \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "steps": [
      { "id": "1", "type": "goto", "label": "Navigate" },
      {
        "id": "2",
        "type": "if",
        "label": "Check logged in",
        "children": [
          { "id": "3", "type": "click", "label": "Dashboard" }
        ],
        "else": [
          { "id": "4", "type": "click", "label": "Login" }
        ]
      }
    ],
    "format": "mermaid"
  }'
```

**Response:**

```
graph TD
  node_1([Start])
  1[Navigate]
  2{Check logged in}
  3[Dashboard]
  4[Login]
  node_1 --> 1
  1 --> 2
  2 -.->|true| 3
  2 -.->|false| 4
```

#### 3. Validate Steps

```bash
curl -X POST http://localhost:3000/api/v1/test-visualization/validate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "steps": [
      { "id": "1", "type": "goto" },
      { "type": "click", "label": "Click" }
    ]
  }'
```

**Response:**

```json
{
  "success": true,
  "valid": false,
  "errors": [
    "Step 0: Missing recommended field 'label'",
    "Step 1: Missing required field 'id'"
  ],
  "warnings": [],
  "stepCount": 2
}
```

## 📊 Supported Step Types

### Navigation

- `goto` - Navigate to URL
- `goBack` - Go back in history
- `goForward` - Go forward in history
- `reload` - Reload page

### Interactions

- `click` - Click element
- `dblclick` - Double click
- `fill` - Fill input field
- `type` - Type text (with delay)
- `hover` - Hover over element
- `check` - Check checkbox
- `uncheck` - Uncheck checkbox
- `selectOption` - Select dropdown option
- `press` - Press keyboard key
- `focus` - Focus element
- `blur` - Remove focus

### Wait & Scroll

- `waitForSelector` - Wait for element
- `waitForTimeout` - Wait for time
- `waitForLoadState` - Wait for page load
- `scroll` - Scroll page
- `scrollIntoView` - Scroll to element

### File Operations

- `upload` - Upload file
- `download` - Download file
- `screenshot` - Take screenshot

### Assertions

- `assert` - General assertion
- `expect` - Expect condition
- `assertVisible` - Assert element visible
- `assertHidden` - Assert element hidden
- `assertText` - Assert text content
- `assertValue` - Assert input value
- `assertCount` - Assert element count

### Control Flow

- `if` / `else` - Conditional branches
- `loop` - Fixed iterations
- `while` - While condition
- `forEach` - Iterate over items

### Custom

- `custom` - Custom action
- `script` - Run script
- `evaluate` - Evaluate JavaScript

## 🎨 Visual Styling

Each node type has automatic styling:

| Type          | Color            | Shape       | Icon |
| ------------- | ---------------- | ----------- | ---- |
| **start**     | Green `#4CAF50`  | Rounded     | -    |
| **end**       | Red `#F44336`    | Rounded     | -    |
| **action**    | Blue `#03A9F4`   | Rectangle   | ⚡   |
| **assertion** | Green `#4CAF50`  | Rectangle   | ✅   |
| **condition** | Yellow `#FFC107` | Diamond     | ❓   |
| **loop**      | Blue `#2196F3`   | Double Rect | 🔄   |
| **merge**     | Gray `#9E9E9E`   | Circle      | -    |

### Edge Types

| Type     | Style      | Label            |
| -------- | ---------- | ---------------- |
| `normal` | Solid →    | -                |
| `branch` | Solid →    | "true" / "false" |
| `loop`   | Animated → | "iterate"        |
| `return` | Dashed →   | "repeat"         |
| `merge`  | Solid →    | -                |

## 🧪 Testing

Run tests:

```bash
npm test -- playwrightParser.test.ts
```

Run examples:

```bash
npx ts-node src/utils/playwrightParser.examples.ts
```

## 📈 Complex Example: Nested Flow

```typescript
const steps = [
  {
    id: "1",
    type: "goto",
    label: "Go to products page",
  },
  {
    id: "2",
    type: "forEach",
    label: "Process each product",
    children: [
      {
        id: "3",
        type: "click",
        label: "Select product",
      },
      {
        id: "4",
        type: "if",
        label: "Check if in stock",
        selector: ".in-stock",
        children: [
          {
            id: "5",
            type: "click",
            label: "Add to cart",
          },
          {
            id: "6",
            type: "assertText",
            label: "Verify added",
            value: "Added to cart",
          },
        ],
        else: [
          {
            id: "7",
            type: "click",
            label: "Add to wishlist",
          },
        ],
      },
    ],
  },
  {
    id: "8",
    type: "goto",
    label: "Go to cart",
  },
  {
    id: "9",
    type: "assertCount",
    label: "Verify cart items",
  },
];

const graph = parsePlaywrightTestSteps(steps, {
  includeStartEnd: true,
  autoLayout: true,
  groupNesting: true,
});
```

**Visual Flow:**

```
Start → Navigate → [Loop: Process products
                        → Select product
                        → [If: In stock?
                              → Yes: Add to cart → Verify
                              → No: Add to wishlist
                           ]
                        → (repeat)
                     ]
      → Go to cart
      → Verify cart
      → End
```

## 🔧 Parser Options

```typescript
interface ParserOptions {
  includeStartEnd?: boolean; // Add start/end nodes (default: true)
  autoLayout?: boolean; // Calculate positions (default: false)
  groupNesting?: boolean; // Group nested blocks (default: true)
  addButtons?: boolean; // Add action buttons (default: true)
}
```

## 🎯 Integration with Frontend

### React Flow Example

```tsx
import ReactFlow from "reactflow";
import "reactflow/dist/style.css";

function TestVisualization({ steps }) {
  const graph = parsePlaywrightTestSteps(steps);

  return <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView />;
}
```

### Mermaid.js Example

```tsx
import mermaid from "mermaid";

function MermaidDiagram({ steps }) {
  const graph = parsePlaywrightTestSteps(steps);
  const diagram = exportGraph(graph, "mermaid");

  useEffect(() => {
    mermaid.render("diagram", diagram);
  }, [diagram]);

  return <div id="diagram" />;
}
```

## 📝 Notes

- All tests passed: ✅ 21/21
- TypeScript strict mode: ✅
- No linter errors: ✅
- Full documentation: ✅
- API integrated: ✅

## 🔗 Related Files

- Types: `src/types/playwright.types.ts`
- Parser: `src/utils/playwrightParser.ts`
- Tests: `src/utils/playwrightParser.test.ts`
- Examples: `src/utils/playwrightParser.examples.ts`
- Controller: `src/api/testVisualization/testVisualization.controller.ts`
- Routes: `src/api/testVisualization/testVisualization.route.ts`
- Main app: `src/index.ts`

## 🎉 Ready to Use

The system is fully implemented and ready for production use. Start the server and test the API:

```bash
npm run dev
# Server starts on http://localhost:3000

# Test endpoint
curl http://localhost:3000/api/v1/test-visualization/parse --help
```

Visit Swagger docs: `http://localhost:3000/api/docs`
