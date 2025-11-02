# 🚀 Quick Start: Playwright Visualization

## Install & Test

```bash
# Run tests
npm test -- playwrightParser.test.ts

# Run examples
npx ts-node src/utils/playwrightParser.examples.ts

# Start server
npm run dev
```

## Basic Usage

```typescript
import { parsePlaywrightTestSteps } from "@/utils/playwrightParser";

const graph = parsePlaywrightTestSteps([
  { id: "1", type: "goto", label: "Open page" },
  { id: "2", type: "click", label: "Click button" },
  { id: "3", type: "assert", label: "Verify result" },
]);

console.log(graph);
```

## API Examples

### Parse Steps

```bash
curl -X POST http://localhost:3000/api/v1/test-visualization/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "steps": [
      { "id": "1", "type": "goto", "label": "Navigate" },
      { "id": "2", "type": "click", "label": "Click" }
    ]
  }'
```

### Export to Mermaid

```bash
curl -X POST http://localhost:3000/api/v1/test-visualization/export \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "steps": [...],
    "format": "mermaid"
  }'
```

### Validate Steps

```bash
curl -X POST http://localhost:3000/api/v1/test-visualization/validate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "steps": [...]
  }'
```

## Conditional Example

```typescript
const steps = [
  {
    id: "1",
    type: "if",
    label: "Check logged in",
    children: [{ id: "2", type: "click", label: "Dashboard" }],
    else: [{ id: "3", type: "click", label: "Login" }],
  },
];

const graph = parsePlaywrightTestSteps(steps);
// Creates: condition node → if branch → else branch → merge
```

## Loop Example

```typescript
const steps = [
  {
    id: "1",
    type: "loop",
    label: "Process items",
    value: 5,
    children: [
      { id: "2", type: "click", label: "Click item" },
      { id: "3", type: "assert", label: "Verify" },
    ],
  },
];

const graph = parsePlaywrightTestSteps(steps);
// Creates: loop node → body steps → return edge → exit
```

## Options

```typescript
parsePlaywrightTestSteps(steps, {
  includeStartEnd: true, // Add start/end nodes
  autoLayout: true, // Calculate positions
  groupNesting: true, // Group nested blocks
  addButtons: true, // Add action buttons
});
```

## Docs

- Technical: `src/utils/README.playwright-parser.md`
- Overview: `PLAYWRIGHT_VISUALIZATION.md`
- Summary: `IMPLEMENTATION_SUMMARY.md`
- Swagger: `http://localhost:3000/api/docs`

## Files

- Types: `src/types/playwright.types.ts`
- Parser: `src/utils/playwrightParser.ts`
- Tests: `src/utils/playwrightParser.test.ts`
- Examples: `src/utils/playwrightParser.examples.ts`
- API: `src/api/testVisualization/`

## Status

✅ 21/21 tests passing
✅ TypeScript strict mode
✅ No linter errors
✅ Production ready
